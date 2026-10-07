import type { Logger } from 'pino'
import type { RepoGrupos } from '../db/grupos.js'
import type { Repositorio } from '../db/repositorio.js'
import { acharComando, interpretar } from './comandos.js'
import { processarComando } from './motor.js'
import { pessoaDoJid, telefoneCanonico, usuarioDoJid, vinculosDeLid } from './pessoas.js'
import type { AcaoGrupo, ConexaoGrupos, ContextoGrupos, EnvioGrupo, EventoGrupos, MembroGrupo, MensagemGrupo, Pessoa } from './tipos.js'

export interface DependenciasGrupos {
  /** Auditoria e transações. */
  repo: Repositorio
  grupos: RepoGrupos
  /** Conexão do número; null se estiver desativado. */
  conexao: (numeroId: number) => ConexaoGrupos | null
  log: Logger
  relogio?: () => number
  conectadoDesde?: (numeroId: number) => number | null
  /** Avisado quando há algo novo na caixa de saída do número. */
  aoEnfileirar?: (numeroId: number) => void
}

/** Comando mais velho que isso (fila do WhatsApp ao reconectar) não é executado. */
export const JANELA_COMANDO_MS = 10 * 60 * 1000

const FALHA = 'Não consegui concluir esse comando agora. Tente de novo em instantes.'

/**
 * Liga os comandos ao motor. Tudo que depende do WhatsApp (LID → telefone, dados do grupo)
 * acontece antes; depois, dedupe + mudanças + respostas + auditoria vão numa transação só.
 * Se o processo cair antes dela, o comando não aconteceu e o gestor manda de novo.
 */
export class OrquestradorGrupos {
  private filas = new Map<string, Promise<void>>()
  private readonly relogio: () => number

  constructor(private readonly d: DependenciasGrupos) {
    this.relogio = d.relogio ?? Date.now
  }

  /** Comandos do mesmo chat são tratados em ordem; chats diferentes não esperam uns pelos outros. */
  receber(m: MensagemGrupo): void {
    const chave = `${m.numeroId}:${m.chat}`
    const anterior = this.filas.get(chave) ?? Promise.resolve()
    const proxima = anterior
      .then(() => this.tratar(m))
      .catch((err) => this.d.log.error({ err, mensagem: m.id, numero: m.numeroId }, 'falha inesperada no comando'))
      .finally(() => {
        if (this.filas.get(chave) === proxima) this.filas.delete(chave)
      })
    this.filas.set(chave, proxima)
  }

  /** Espera todas as filas esvaziarem (testes e desligamento). */
  async ocioso(): Promise<void> {
    while (this.filas.size > 0) await Promise.all([...this.filas.values()])
  }

  /** Mantém a tabela de grupos igual ao que o WhatsApp informa. */
  eventoGrupos(numeroId: number, e: EventoGrupos): void {
    const g = this.d.grupos
    const agora = this.relogio()
    try {
      this.d.repo.transacao(() => {
        switch (e.tipo) {
          case 'lista':
            for (const x of e.grupos) g.salvarGrupo(numeroId, x.jid, x.nome, x.botAdmin, agora)
            g.desativarAusentes(numeroId, e.grupos.map((x) => x.jid), agora)
            return
          case 'entrou':
            for (const x of e.grupos) g.salvarGrupo(numeroId, x.jid, x.nome, x.botAdmin, agora)
            return
          case 'renomeado':
            return g.renomearGrupo(numeroId, e.jid, e.nome, agora)
          case 'admin':
            return g.definirBotAdmin(numeroId, e.jid, e.admin, agora)
          case 'saiu':
            return g.desativarGrupo(numeroId, e.jid, agora)
        }
      })
    } catch (err) {
      this.d.log.error({ err, numero: numeroId, evento: e.tipo }, 'falha ao atualizar grupos')
    }
  }

  private async tratar(m: MensagemGrupo): Promise<void> {
    if (this.relogio() - m.recebidaEm > JANELA_COMANDO_MS) return
    if (this.d.grupos.comandoVisto(m.numeroId, m.id)) return
    const cmd = interpretar(m.texto, m.mencionados, m.citada)
    if (!cmd) return
    const conexao = this.d.conexao(m.numeroId)
    const def = acharComando(cmd.nome)

    const remetente = await this.completar(conexao, m.remetente)
    const mencionados = await Promise.all(m.mencionados.map((j) => this.completar(conexao, pessoaDoJid(j))))
    const citada = m.citada ? await this.completar(conexao, pessoaDoJid(m.citada)) : null
    const membros = m.ehGrupo ? await this.lerGrupo(conexao, m, !!def?.precisaMembros) : null

    // Daqui em diante é síncrono: o retrato do banco e a gravação não se intercalam com outro comando.
    const agora = this.relogio()
    const g = this.d.grupos
    const funcionarios = g.funcionarios()
    const ctx: ContextoGrupos = {
      agora,
      chat: m.chat,
      ehGrupo: m.ehGrupo,
      remetente,
      mencionados,
      citada,
      funcionarios,
      gestores: new Set(g.gestores()),
      grupo: m.ehGrupo ? g.grupo(m.numeroId, m.chat) : null,
      grupos: g.grupos(m.numeroId),
      membros: def?.precisaMembros ? membros : null,
      auditoria: this.d.repo.auditoriaRecente(30),
      conectadoDesde: this.d.conectadoDesde?.(m.numeroId) ?? null
    }
    const acoes = processarComando(ctx, cmd)
    const vistos = [remetente, ...mencionados, ...(citada ? [citada] : []), ...(membros ?? [])]
    const vinculos = vinculosDeLid(funcionarios, vistos)
    const usuario = `wa:${remetente.telefone ?? remetente.lid ?? usuarioDoJid(remetente.jid)}`
    try {
      this.aplicar(m, acoes, vinculos, usuario, agora)
    } catch (err) {
      this.d.log.error({ err, mensagem: m.id, numero: m.numeroId }, 'erro ao executar comando')
      if (acoes.length > 0) this.aplicar(m, [{ tipo: 'responder', texto: FALHA }], [], usuario, agora)
    }
  }

  /** Descobre o telefone por trás do LID quando o WhatsApp sabe. */
  private async completar(conexao: ConexaoGrupos | null, p: Pessoa): Promise<Pessoa> {
    const telefone = telefoneCanonico(p.telefone)
    if (telefone || !p.lid || !conexao) return { ...p, telefone }
    try {
      return { ...p, telefone: telefoneCanonico(await conexao.telefoneDoLid(p.lid)) }
    } catch {
      return { ...p, telefone: null }
    }
  }

  /**
   * Grupo desconhecido (evento perdido) é lido e gravado uma vez. A lista de participantes
   * só é buscada quando o comando precisa dela.
   */
  private async lerGrupo(conexao: ConexaoGrupos | null, m: MensagemGrupo, precisaMembros: boolean): Promise<MembroGrupo[] | null> {
    const conhecido = this.d.grupos.grupo(m.numeroId, m.chat)
    if (!conexao || (conhecido?.ativo && !precisaMembros)) return null
    try {
      const md = await conexao.metadados(m.chat)
      this.d.grupos.salvarGrupo(m.numeroId, md.jid, md.nome, md.botAdmin, this.relogio())
      return await Promise.all(md.membros.map(async (x) => ({ ...(await this.completar(conexao, x)), admin: x.admin })))
    } catch (err) {
      this.d.log.warn({ err, numero: m.numeroId }, 'não foi possível ler os dados do grupo')
      return null
    }
  }

  private aplicar(m: MensagemGrupo, acoes: AcaoGrupo[], vinculos: { id: number; lid: string }[], usuario: string, agora: number): void {
    const g = this.d.grupos
    let enfileirou = false
    this.d.repo.transacao(() => {
      // Outra entrega da mesma mensagem pode ter passado enquanto esta esperava o WhatsApp.
      if (!g.registrarComando(m.numeroId, m.id, m.chat, m.recebidaEm)) return
      for (const v of vinculos) g.vincularLid(v.id, v.lid, agora)
      for (const a of acoes) {
        switch (a.tipo) {
          case 'responder': {
            const envio: EnvioGrupo = { tipo: 'texto', texto: a.texto, ...(a.mencoes ? { mencoes: a.mencoes } : {}) }
            g.enfileirarSaida(m.numeroId, m.chat, JSON.stringify(envio), agora)
            enfileirou = true
            break
          }
          case 'salvar_funcionario':
            g.salvarFuncionario(a.id, a.dados, agora)
            break
          case 'gestor':
            if (a.ativo) g.adicionarGestor(a.funcionarioId, usuario, agora)
            else g.removerGestor(a.funcionarioId)
            break
          case 'auditar':
            this.d.repo.auditar(usuario, a.acao, a.detalhe, agora)
            break
        }
      }
    })
    if (enfileirou) this.d.aoEnfileirar?.(m.numeroId)
  }
}
