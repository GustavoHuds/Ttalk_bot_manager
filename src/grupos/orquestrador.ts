import type { Logger } from 'pino'
import type { RepoGrupos } from '../db/grupos.js'
import type { Repositorio } from '../db/repositorio.js'
import { acharComando, interpretar, type Comando } from './comandos.js'
import { processarComando } from './motor.js'
import { chaveTelefone, pessoaDoJid, usuarioDoJid, vinculosDeLid } from './pessoas.js'
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

/** Mesma pessoa repetindo o mesmo comando comum neste chat: ignorado se mais rápido que isto. */
const JANELA_REPETICAO_REMETENTE_MS = 60 * 1000
/** Qualquer pessoa repetindo o mesmo comando comum neste chat: ignorado se mais rápido que isto. */
const JANELA_REPETICAO_CHAT_MS = 15 * 1000
/** Tamanho máximo da memória do freio antes de descartar entradas antigas. */
const LIMITE_MEMORIA_REPETICAO = 5000

const FALHA = 'Não consegui concluir esse comando agora. Tente de novo em instantes.'

/**
 * Liga os comandos ao motor. Tudo que depende do WhatsApp (LID → telefone, dados do grupo)
 * acontece antes; depois, dedupe + mudanças + respostas + auditoria vão numa transação só.
 * Se o processo cair antes dela, o comando não aconteceu e o gestor manda de novo.
 */
export class OrquestradorGrupos {
  private filas = new Map<string, Promise<void>>()
  private readonly relogio: () => number
  /** Último horário em que (número, chat, remetente, comando) foi aceito. */
  private readonly ultimoPorRemetente = new Map<string, number>()
  /** Último horário em que (número, chat, comando) foi aceito, de qualquer remetente. */
  private readonly ultimoPorChat = new Map<string, number>()

  constructor(private readonly d: DependenciasGrupos) {
    this.relogio = d.relogio ?? Date.now
  }

  /**
   * Comandos do mesmo chat são tratados em ordem; chats diferentes não esperam uns pelos outros.
   * Comando comum (não de gestor) repetido rápido demais no mesmo grupo é descartado aqui mesmo,
   * antes de entrar na fila: nem dedupe, nem resposta — só um freio contra spam, não contra reenvio.
   */
  receber(m: MensagemGrupo): void {
    const cmd = interpretar(m.texto, m.mencionados, m.citada)
    if (cmd && m.ehGrupo) {
      const def = acharComando(cmd.nome)
      if (def && !def.gestor && !this.podeProcessar(m, cmd, this.relogio())) {
        this.d.log.debug({ mensagem: m.id, numero: m.numeroId }, 'comando comum ignorado por repetição rápida')
        return
      }
    }
    const chave = `${m.numeroId}:${m.chat}`
    const anterior = this.filas.get(chave) ?? Promise.resolve()
    const proxima = anterior
      .then(() => this.tratar(m, cmd))
      .catch((err) => this.d.log.error({ err, mensagem: m.id, numero: m.numeroId }, 'falha inesperada no comando'))
      .finally(() => {
        if (this.filas.get(chave) === proxima) this.filas.delete(chave)
      })
    this.filas.set(chave, proxima)
  }

  /** Decide e, se aceitar, já marca o horário (false não marca: permite tentar de novo logo). */
  private podeProcessar(m: MensagemGrupo, cmd: Comando, agora: number): boolean {
    const chaveRemetente = `${m.numeroId}:${m.chat}:${m.remetente.jid}:${cmd.nome}`
    const chaveChat = `${m.numeroId}:${m.chat}:${cmd.nome}`
    const ultimoRemetente = this.ultimoPorRemetente.get(chaveRemetente)
    if (ultimoRemetente !== undefined && agora - ultimoRemetente < JANELA_REPETICAO_REMETENTE_MS) return false
    const ultimoChat = this.ultimoPorChat.get(chaveChat)
    if (ultimoChat !== undefined && agora - ultimoChat < JANELA_REPETICAO_CHAT_MS) return false
    this.marcarRepeticao(this.ultimoPorRemetente, chaveRemetente, agora, JANELA_REPETICAO_REMETENTE_MS)
    this.marcarRepeticao(this.ultimoPorChat, chaveChat, agora, JANELA_REPETICAO_CHAT_MS)
    return true
  }

  /** Grava o horário; se a memória cresceu demais, aproveita para jogar fora quem já saiu da janela. */
  private marcarRepeticao(mapa: Map<string, number>, chave: string, agora: number, janela: number): void {
    mapa.set(chave, agora)
    if (mapa.size <= LIMITE_MEMORIA_REPETICAO) return
    for (const [k, v] of mapa) {
      if (agora - v > janela) mapa.delete(k)
    }
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

  private async tratar(m: MensagemGrupo, cmd: Comando | null): Promise<void> {
    const atraso = this.relogio() - m.recebidaEm
    if (atraso > JANELA_COMANDO_MS) {
      this.d.log.debug({ mensagem: m.id, atraso }, 'comando antigo (fila ao reconectar) ignorado')
      return
    }
    if (this.d.grupos.comandoVisto(m.numeroId, m.id)) return
    if (!cmd) return
    const conexao = this.d.conexao(m.numeroId)
    const def = acharComando(cmd.nome)
    const precisaMembros = !!def?.precisaMembros

    let remetente = await this.completar(conexao, m.remetente)
    const mencionados = await Promise.all(m.mencionados.map((j) => this.completar(conexao, pessoaDoJid(j))))
    const citada = m.citada ? await this.completar(conexao, pessoaDoJid(m.citada)) : null
    const membros = m.ehGrupo ? await this.lerGrupo(conexao, m, precisaMembros) : null

    // Daqui em diante é síncrono: o retrato do banco e a gravação não se intercalam com outro comando.
    const agora = this.relogio()
    const g = this.d.grupos
    const funcionarios = g.funcionarios()
    // O WhatsApp pode não informar o telefone do LID desta vez; se a pessoa já está no cadastro
    // com esse LID (de uma mensagem anterior), usa o telefone de lá em vez de identificar pelo LID cru.
    if (!remetente.telefone && remetente.lid) {
      const porLid = funcionarios.find((f) => f.lid === remetente.lid)
      if (porLid?.telefone) remetente = { ...remetente, telefone: porLid.telefone }
    }
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
      membros: precisaMembros ? membros : null,
      auditoria: this.d.repo.auditoriaRecente(30),
      conectadoDesde: this.d.conectadoDesde?.(m.numeroId) ?? null
    }
    const acoes = processarComando(ctx, cmd)
    // Comando ignorado (silêncio) não muda nada no banco além do dedupe: nem liga LID.
    const vistos = [remetente, ...mencionados, ...(citada ? [citada] : []), ...(ctx.membros ?? [])]
    const vinculos = acoes.length > 0 ? vinculosDeLid(funcionarios, vistos) : []
    const usuario = `wa:${remetente.telefone ?? remetente.lid ?? usuarioDoJid(remetente.jid)}`
    let enfileirou = false
    try {
      enfileirou = this.aplicar(m, acoes, vinculos, usuario, agora)
    } catch (err) {
      this.d.log.error({ err, mensagem: m.id, numero: m.numeroId }, 'erro ao executar comando')
      if (acoes.length > 0) enfileirou = this.aplicar(m, [{ tipo: 'responder', texto: FALHA }], [], usuario, agora)
    }
    // Fora do try: um erro do próprio avisador não deve disparar a resposta de falha por engano.
    if (enfileirou) this.d.aoEnfileirar?.(m.numeroId)
  }

  /** Descobre o telefone por trás do LID quando o WhatsApp sabe (de qualquer país, sem assumir Brasil). */
  private async completar(conexao: ConexaoGrupos | null, p: Pessoa): Promise<Pessoa> {
    const telefone = chaveTelefone(p.telefone)
    if (telefone || !p.lid || !conexao) return { ...p, telefone }
    try {
      return { ...p, telefone: chaveTelefone(await conexao.telefoneDoLid(p.lid)) }
    } catch {
      return { ...p, telefone: null }
    }
  }

  /**
   * Grupo desconhecido (evento perdido) é lido e gravado uma vez. A lista de participantes
   * só é buscada (e cada um só é completado com o LID→telefone) quando o comando precisa dela.
   */
  private async lerGrupo(conexao: ConexaoGrupos | null, m: MensagemGrupo, precisaMembros: boolean): Promise<MembroGrupo[] | null> {
    const conhecido = this.d.grupos.grupo(m.numeroId, m.chat)
    if (!conexao || (conhecido?.ativo && !precisaMembros)) return null
    try {
      const md = await conexao.metadados(m.chat)
      this.d.grupos.salvarGrupo(m.numeroId, md.jid, md.nome, md.botAdmin, this.relogio())
      if (!precisaMembros) return null
      return await Promise.all(md.membros.map(async (x) => ({ ...(await this.completar(conexao, x)), admin: x.admin })))
    } catch (err) {
      this.d.log.warn({ err, numero: m.numeroId }, 'não foi possível ler os dados do grupo')
      return null
    }
  }

  /** Devolve true se algo foi enfileirado para sair (quem chama avisa o remetente depois, fora da transação). */
  private aplicar(m: MensagemGrupo, acoes: AcaoGrupo[], vinculos: { id: number; lid: string }[], usuario: string, agora: number): boolean {
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
    return enfileirou
  }
}
