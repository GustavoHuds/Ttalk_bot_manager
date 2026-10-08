import type { Logger } from 'pino'
import type { ArmazemArquivos } from '../arquivos.js'
import type { BotGrupos, Midia, RepoBotsGrupos } from '../db/bots-grupos.js'
import type { Funcionario, RepoGrupos } from '../db/grupos.js'
import type { Repositorio } from '../db/repositorio.js'
import { acharComando, ehComando, interpretar, type DefComando, type NomeComando } from './comandos.js'
import { alvoDe, palavraProibida, processar } from './motor.js'
import { acharFuncionario, chaveTelefoneDeJid, pessoaDoJid, usuarioDoJid, vinculosDeLid } from './pessoas.js'
import type {
  AcaoGrupo,
  ConexaoGrupos,
  ContextoGrupos,
  Entrada,
  EnvioGrupo,
  EventoGrupos,
  GrupoDoBot,
  MembroGrupo,
  MensagemGrupo,
  Pessoa,
  Sessao
} from './tipos.js'

export interface DependenciasGrupos {
  /** Auditoria e transações. */
  repo: Repositorio
  grupos: RepoGrupos
  bots: RepoBotsGrupos
  armazem: ArmazemArquivos
  /** Conexão do número; null se estiver desligado. */
  conexao: (numeroId: number) => ConexaoGrupos | null
  log: Logger
  relogio?: () => number
  /** Número pausado: conectado, mas o bot não lê nada. */
  pausado?: (numeroId: number) => boolean
  /** Avisado quando há algo novo na caixa de saída do número. */
  aoEnfileirar?: (numeroId: number) => void
  /** Avisado quando um /mutegroup ou /unmute mudou o horário de um grupo (o agendador aplica na hora). */
  aoMudarSilencio?: () => void
}

/** Comando mais velho que isso (fila do WhatsApp ao reconectar) não é executado. */
export const JANELA_COMANDO_MS = 10 * 60 * 1000

/** Códigos errados de /confirmar aceitos por hora antes do silêncio: por pessoa e no bot inteiro. */
export const ERROS_CODIGO_POR_PESSOA = 5
export const ERROS_CODIGO_POR_BOT = 30
const JANELA_ERROS_CODIGO_MS = 60 * 60 * 1000

const FALHA = 'Não consegui concluir esse comando agora. Tente de novo em instantes.'

/** Comandos que, mandados no privado com uma foto (ou citando uma), levam a mídia para o grupo. */
const LEVAM_MIDIA = new Set<NomeComando>(['all', 'todos', 'mencionar'])

/**
 * Liga as mensagens ao motor. Cada número atende o bot de grupos ligado a ele, e só nos grupos que o
 * bot tem como ativos: fora deles, nada é lido nem guardado. Do que chega de um grupo ativo, só comandos,
 * respostas que o bot está esperando e mensagens com palavra proibida passam daqui — o resto é descartado
 * na hora, sem banco e sem log. Tudo que depende do WhatsApp (LID → telefone, participantes, mídia)
 * acontece antes; depois, dedupe + mudanças + envios + auditoria vão numa transação só.
 */
export class OrquestradorGrupos {
  private filas = new Map<string, Promise<void>>()
  private readonly relogio: () => number
  /** Horários dos códigos errados de /confirmar, por "bot:remetente" e por "bot". */
  private readonly errosCodigo = new Map<string, number[]>()
  /** Conversa com cada gestor, por "bot:chat:remetente". */
  private readonly sessoes = new Map<string, Sessao>()
  /** Última menção a todos, por "bot:grupo". */
  private readonly mencoesEmMassa = new Map<string, number>()

  constructor(private readonly d: DependenciasGrupos) {
    this.relogio = d.relogio ?? Date.now
  }

  /** Mensagens do mesmo chat são tratadas em ordem; chats diferentes não esperam uns pelos outros. */
  receber(m: MensagemGrupo): void {
    if (this.d.pausado?.(m.numeroId)) return
    const bot = this.d.bots.botDoNumero(m.numeroId)
    if (!bot) return
    // Grupo que o bot não tem como ativo: silêncio total, sem nem a linha de dedupe.
    if (m.ehGrupo && !this.d.bots.grupoAtivo(bot.id, m.chat)) return
    const agora = this.relogio()
    let tarefa: () => Promise<void>
    if (ehComando(m.texto)) {
      const cmd = interpretar(m.texto)
      if (acharComando(cmd?.nome ?? '')?.nome === 'confirmar' && !m.ehGrupo && this.codigoBloqueado(bot.id, m.remetente.jid, agora)) {
        this.d.log.warn({ mensagem: m.id, numero: m.numeroId, bot: bot.id }, 'tentativas de código demais: /confirmar ignorado')
        return
      }
      tarefa = () => this.tratar(m, { tipo: 'comando', texto: m.texto }, bot.id, false)
    } else if (this.sessao(this.chaveSessao(bot.id, m), agora)?.aguardando) {
      tarefa = () => this.tratar(m, { tipo: 'resposta', texto: m.texto.trim() }, bot.id, false)
    } else if (m.ehGrupo && palavraProibida(m.texto, this.d.bots.palavras(bot.id, m.chat))) {
      tarefa = () => this.moderar(m, bot.id)
    } else return
    const chave = `${m.numeroId}:${m.chat}`
    const anterior = this.filas.get(chave) ?? Promise.resolve()
    const proxima = anterior
      .then(tarefa)
      .catch((err) => this.d.log.error({ err, mensagem: m.id, numero: m.numeroId }, 'falha inesperada no bot de grupos'))
      .finally(() => {
        if (this.filas.get(chave) === proxima) this.filas.delete(chave)
      })
    this.filas.set(chave, proxima)
  }

  /** Espera todas as filas terminarem (testes e desligamento). */
  async ocioso(): Promise<void> {
    while (this.filas.size > 0) await Promise.all([...this.filas.values()])
  }

  /** Mantém a lista geral de grupos igual ao que o WhatsApp informa. */
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

  // --- sessões ----------------------------------------------------------------------

  private chaveSessao(botId: number, m: MensagemGrupo): string {
    return `${botId}:${m.chat}:${m.remetente.jid}`
  }

  private sessao(chave: string, agora: number): Sessao | null {
    const s = this.sessoes.get(chave)
    if (!s) return null
    if (s.ate > agora) return s
    this.sessoes.delete(chave)
    return null
  }

  private guardarSessao(chave: string, s: Sessao | null): void {
    if (s) this.sessoes.set(chave, s)
    else this.sessoes.delete(chave)
    if (this.sessoes.size > 2000) {
      const agora = this.relogio()
      for (const [k, v] of this.sessoes) if (v.ate <= agora) this.sessoes.delete(k)
    }
  }

  // --- limite de tentativas de código ----------------------------------------------

  private errosRecentes(chave: string, agora: number): number[] {
    const lista = (this.errosCodigo.get(chave) ?? []).filter((t) => agora - t < JANELA_ERROS_CODIGO_MS)
    if (lista.length) this.errosCodigo.set(chave, lista)
    else this.errosCodigo.delete(chave)
    return lista
  }

  /** Contra adivinhação do código: poucas tentativas erradas por hora, por pessoa e no bot inteiro. */
  private codigoBloqueado(botId: number, remetente: string, agora: number): boolean {
    return (
      this.errosRecentes(`${botId}:${remetente}`, agora).length >= ERROS_CODIGO_POR_PESSOA ||
      this.errosRecentes(`${botId}`, agora).length >= ERROS_CODIGO_POR_BOT
    )
  }

  private registrarErroCodigo(botId: number, remetente: string, agora: number): void {
    for (const chave of [`${botId}:${remetente}`, `${botId}`]) this.errosCodigo.set(chave, [...this.errosRecentes(chave, agora), agora])
  }

  // --- tratamento ---------------------------------------------------------------------

  /** Grupos ativos do bot com nome e admin da lista geral do número atual. */
  private gruposDoBot(bot: BotGrupos): GrupoDoBot[] {
    const geral = new Map((bot.numeroId ? this.d.grupos.grupos(bot.numeroId) : []).map((x) => [x.jid, x]))
    return this.d.bots
      .gruposAtivos(bot.id)
      .map((a) => {
        const x = geral.get(a.jid)
        return { jid: a.jid, nome: x?.nome ?? 'Grupo', botAdmin: x?.botAdmin ?? false }
      })
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
  }

  /** Gestores do bot (confirmados ou pendentes) com o cadastro. */
  private pessoasDoBot(botId: number): { pessoas: Funcionario[]; gestores: ReturnType<RepoBotsGrupos['gestores']> } {
    const gestores = this.d.bots.gestores(botId)
    const pessoas = gestores.flatMap((x) => {
      const f = this.d.grupos.funcionario(x.funcionarioId)
      return f ? [f] : []
    })
    return { pessoas, gestores }
  }

  /** Descobre o telefone por trás do LID quando o WhatsApp sabe (de qualquer país, sem assumir Brasil). */
  private async completar(conexao: ConexaoGrupos | null, p: Pessoa): Promise<Pessoa> {
    const telefone = chaveTelefoneDeJid(p.telefone)
    if (telefone || !p.lid || !conexao) return { ...p, telefone }
    try {
      return { ...p, telefone: chaveTelefoneDeJid(await conexao.telefoneDoLid(p.lid)) }
    } catch {
      return { ...p, telefone: null }
    }
  }

  /** Participantes do grupo (do cache da conexão). Também atualiza nome e admin na lista geral. */
  private async lerMembros(conexao: ConexaoGrupos | null, numeroId: number, jid: string, comTelefone: boolean): Promise<MembroGrupo[] | null> {
    if (!conexao?.pronta()) return null
    try {
      const md = await conexao.metadados(jid)
      this.d.grupos.salvarGrupo(numeroId, md.jid, md.nome, md.botAdmin, this.relogio())
      if (!comTelefone) return md.membros.map((x) => ({ ...x, telefone: chaveTelefoneDeJid(x.telefone) }))
      return await Promise.all(md.membros.map(async (x) => ({ ...(await this.completar(conexao, x)), admin: x.admin })))
    } catch (err) {
      this.d.log.warn({ err, numero: numeroId }, 'não foi possível ler os participantes do grupo')
      return null
    }
  }

  /** Baixa e guarda a mídia de uma mensagem. Falha vira null (o comando segue sem a mídia, ou responde o erro). */
  private async baixar(conexao: ConexaoGrupos | null, bruto: string | null): Promise<Midia | null> {
    if (!bruto || !conexao?.pronta()) return null
    try {
      const { dados, midia, ext } = await conexao.baixarMidiaGrupo(bruto)
      return { ...midia, caminho: await this.d.armazem.salvarMidia(ext, dados) }
    } catch (err) {
      this.d.log.warn({ err }, 'não foi possível baixar a mídia da mensagem')
      return null
    }
  }

  private async tratar(m: MensagemGrupo, entrada: Entrada, botId: number, reexecucao: boolean): Promise<void> {
    const atraso = this.relogio() - m.recebidaEm
    if (atraso > JANELA_COMANDO_MS) {
      this.d.log.debug({ mensagem: m.id, atraso }, 'comando antigo (fila ao reconectar) ignorado')
      return
    }
    if (!reexecucao && this.d.grupos.comandoVisto(m.numeroId, m.id)) return
    const bot = this.d.bots.bot(botId)
    if (!bot?.ativo || bot.numeroId !== m.numeroId) return
    const conexao = this.d.conexao(m.numeroId)
    const chaveSessao = this.chaveSessao(bot.id, m)
    const sessao = this.sessao(chaveSessao, this.relogio())
    const grupos = this.gruposDoBot(bot)
    const alvo = alvoDe(m.ehGrupo, m.chat, grupos, sessao)
    const def: DefComando | null = entrada.tipo === 'comando' ? acharComando(interpretar(entrada.texto)?.nome ?? '') : null

    // Só quem é gestor confirmado faz o bot trabalhar (ler participantes, baixar mídia).
    const { pessoas, gestores } = this.pessoasDoBot(bot.id)
    let remetente = await this.completar(conexao, m.remetente)
    if (!remetente.telefone && remetente.lid) {
      const porLid = pessoas.find((f) => f.lid === remetente.lid)
      if (porLid?.telefone) remetente = { ...remetente, telefone: porLid.telefone }
    }
    const autor = acharFuncionario(pessoas, remetente)
    const confirmados = new Set(gestores.filter((x) => x.confirmadoEm !== null).map((x) => x.funcionarioId))
    const ehGestor = !!autor?.ativo && confirmados.has(autor.id)

    const mencionados = await Promise.all(m.mencionados.map((j) => this.completar(conexao, pessoaDoJid(j))))
    const autorCitada = m.citada?.autor ? await this.completar(conexao, pessoaDoJid(m.citada.autor)) : null
    const precisaMembros = ehGestor && !!def?.precisaMembros && !!alvo
    const comTelefone = !m.ehGrupo && (def?.nome === 'mencionar' || def?.nome === 'remove')
    const membros = precisaMembros ? await this.lerMembros(conexao, m.numeroId, alvo!.jid, comTelefone) : null

    const repetindo = def?.nome === 'repeat' || (entrada.tipo === 'resposta' && sessao?.aguardando === 'repeat')
    const levaMidia = !m.ehGrupo && !!def && LEVAM_MIDIA.has(def.nome)
    const midia = ehGestor && levaMidia ? await this.baixar(conexao, m.midia) : null
    const midiaCitada = ehGestor && (repetindo || (levaMidia && !midia)) ? await this.baixar(conexao, m.citada?.midia ?? null) : null

    // Daqui em diante é síncrono: o retrato do banco e a gravação não se intercalam com outro comando.
    const agora = this.relogio()
    const ctx: ContextoGrupos = {
      agora,
      bot: { id: bot.id, nome: bot.nome },
      desligados: this.d.bots.desligados(bot.id) as Set<NomeComando>,
      chat: m.chat,
      ehGrupo: m.ehGrupo,
      mensagem: { chat: m.chat, id: m.id, participante: m.ehGrupo ? m.remetente.jid : null },
      remetente,
      mencionados,
      citada: m.citada ? { autor: autorCitada, texto: m.citada.texto, midia: midiaCitada } : null,
      midia,
      pessoas,
      gestores: confirmados,
      pendentes: gestores
        .filter((x) => x.confirmadoEm === null)
        .map((x) => ({ funcionarioId: x.funcionarioId, codigo: x.codigo, expiraEm: x.codigoExpiraEm })),
      grupos,
      sessao,
      alvo,
      membros,
      palavras: alvo ? this.d.bots.palavras(bot.id, alvo.jid) : [],
      ultimaMencaoEmMassa: alvo ? (this.mencoesEmMassa.get(`${bot.id}:${alvo.jid}`) ?? null) : null
    }
    const acoes = processar(ctx, entrada)
    const vistos = [remetente, ...mencionados, ...(autorCitada ? [autorCitada] : [])]
    const vinculos = acoes.length > 0 ? vinculosDeLid(pessoas, vistos) : []
    const usuario = `wa:${remetente.telefone ?? remetente.lid ?? usuarioDoJid(remetente.jid)}`
    let r: Resultado = { enfileirou: false, executar: null, silencio: false, midiasUsadas: new Set(), soltas: [] }
    try {
      r = this.aplicar(m, bot, acoes, vinculos, pessoas, usuario, agora, chaveSessao, reexecucao)
    } catch (err) {
      this.d.log.error({ err, mensagem: m.id, numero: m.numeroId }, 'erro ao executar comando')
      if (acoes.length > 0) r = this.aplicar(m, bot, [{ tipo: 'responder', texto: FALHA }], [], pessoas, usuario, agora, chaveSessao, reexecucao)
    }
    if (acoes.some((a) => a.tipo === 'codigo_errado')) this.registrarErroCodigo(bot.id, m.remetente.jid, agora)
    for (const x of [midia, midiaCitada]) if (x && !r.midiasUsadas.has(x.caminho)) r.soltas.push(x.caminho)
    for (const caminho of r.soltas) await this.d.armazem.apagar(caminho).catch(() => undefined)
    if (acoes.length > 0 && conexao?.pronta()) {
      await conexao.marcarLida({ chat: m.chat, id: m.id, participante: m.ehGrupo ? m.remetente.jid : null }).catch(() => undefined)
    }
    // Fora do try: um erro do próprio avisador não deve disparar a resposta de falha por engano.
    if (r.enfileirou) this.d.aoEnfileirar?.(m.numeroId)
    if (r.silencio) this.d.aoMudarSilencio?.()
    if (r.executar && !reexecucao) await this.tratar(m, { tipo: 'comando', texto: r.executar }, bot.id, true)
  }

  /** Mensagem com palavra proibida, de quem não é gestor nem admin do grupo: apagada (se o número for admin). */
  private async moderar(m: MensagemGrupo, botId: number): Promise<void> {
    if (this.relogio() - m.recebidaEm > JANELA_COMANDO_MS) return
    if (this.d.grupos.comandoVisto(m.numeroId, m.id)) return
    const bot = this.d.bots.bot(botId)
    if (!bot?.ativo || bot.numeroId !== m.numeroId) return
    const conexao = this.d.conexao(m.numeroId)
    if (!conexao?.pronta()) return
    let md
    try {
      md = await conexao.metadados(m.chat)
    } catch (err) {
      this.d.log.warn({ err, numero: m.numeroId }, 'não foi possível ler o grupo para moderar')
      return
    }
    if (!md.botAdmin) return
    const autor = md.membros.find((x) => x.jid === m.remetente.jid || (!!m.remetente.lid && x.lid === m.remetente.lid))
    if (autor?.admin) return
    const remetente = await this.completar(conexao, m.remetente)
    const { pessoas, gestores } = this.pessoasDoBot(bot.id)
    const f = acharFuncionario(pessoas, remetente)
    if (f && gestores.some((x) => x.funcionarioId === f.id && x.confirmadoEm !== null)) return
    const agora = this.relogio()
    const envio: EnvioGrupo = { tipo: 'apagar', chave: { chat: m.chat, id: m.id, participante: m.remetente.jid } }
    let enfileirou = false
    this.d.repo.transacao(() => {
      if (!this.d.grupos.registrarComando(m.numeroId, m.id, m.chat, m.recebidaEm)) return
      this.d.grupos.enfileirarSaida(m.numeroId, m.chat, JSON.stringify(envio), agora)
      this.d.repo.auditar('bot', 'mensagem_apagada', `${md.nome}: palavra proibida`, agora)
      enfileirou = true
    })
    if (enfileirou) this.d.aoEnfileirar?.(m.numeroId)
  }

  private aplicar(
    m: MensagemGrupo,
    bot: BotGrupos,
    acoes: AcaoGrupo[],
    vinculos: { id: number; lid: string }[],
    pessoas: Funcionario[],
    usuario: string,
    agora: number,
    chaveSessao: string,
    reexecucao: boolean
  ): Resultado {
    const g = this.d.grupos
    const b = this.d.bots
    const r: Resultado = { enfileirou: false, executar: null, silencio: false, midiasUsadas: new Set(), soltas: [] }
    const enviar = (jid: string, envio: EnvioGrupo) => {
      g.enfileirarSaida(m.numeroId, jid, JSON.stringify(envio), agora)
      if (envio.tipo === 'midia') r.midiasUsadas.add(envio.midia.caminho)
      r.enfileirou = true
    }
    const sessoes: (Sessao | null)[] = []
    const mencoes: string[] = []
    this.d.repo.transacao(() => {
      // Outra entrega da mesma mensagem pode ter passado enquanto esta esperava o WhatsApp.
      if (!reexecucao && !g.registrarComando(m.numeroId, m.id, m.chat, m.recebidaEm)) return
      for (const v of vinculos) g.vincularLid(v.id, v.lid, agora)
      for (const a of acoes) {
        switch (a.tipo) {
          case 'responder':
            enviar(m.chat, { tipo: 'texto', texto: a.texto, ...(a.mencoes ? { mencoes: a.mencoes } : {}) })
            break
          case 'enviar':
            enviar(a.jid, a.envio)
            break
          case 'sessao':
            sessoes.push(a.sessao)
            break
          case 'executar':
            r.executar = a.texto
            break
          case 'mencao_em_massa':
            mencoes.push(a.jid)
            break
          case 'palavras':
            b.adicionarPalavras(bot.id, a.jid, a.adicionar)
            break
          case 'palavras_remover':
            b.removerPalavras(bot.id, a.jid, a.palavras)
            break
          case 'silencio':
            b.definirSilencio(bot.id, a.jid, a.inicio, a.fim, usuario, agora)
            r.silencio = true
            break
          case 'silencio_remover':
            b.removerSilencio(bot.id, a.jid)
            r.silencio = true
            break
          case 'repetir':
            b.salvarProgramada(
              null,
              bot.id,
              {
                jid: a.jid,
                origem: 'repeat',
                horarios: a.horarios,
                dias: [0, 1, 2, 3, 4, 5, 6],
                data: null,
                variar: false,
                mencionar: false,
                variacoes: [{ texto: a.texto, midia: a.midia }]
              },
              usuario,
              agora
            )
            if (a.midia) r.midiasUsadas.add(a.midia.caminho)
            break
          case 'repetir_parar':
            r.soltas.push(...b.excluirRepeticoes(bot.id, a.jid).midias.filter((x) => !b.midiasEmUso().has(x)))
            break
          case 'confirmar_gestor':
            this.confirmar(bot.id, a.funcionarioId, a.pessoa, pessoas, agora)
            break
          case 'divergencia':
            b.registrarDivergencia(bot.id, a.funcionarioId, a.pessoa.jid, a.pessoa.telefone, agora)
            break
          case 'codigo_errado':
            break
          case 'auditar':
            this.d.repo.auditar(usuario, a.acao, a.detalhe, agora, a.funcionarioId ?? null)
            break
        }
      }
    })
    // Memória só depois da transação: se ela falhou, nada disto vale.
    for (const s of sessoes) this.guardarSessao(chaveSessao, s)
    for (const jid of mencoes) this.mencoesEmMassa.set(`${bot.id}:${jid}`, agora)
    return r
  }

  /** Confirma e completa o cadastro com o que a confirmação provou (telefone ou LID que faltavam). */
  private confirmar(botId: number, funcionarioId: number, p: Pessoa, pessoas: Funcionario[], agora: number): void {
    const g = this.d.grupos
    this.d.bots.confirmarGestor(botId, funcionarioId, p.jid, agora)
    g.confirmarFuncionario(funcionarioId, agora)
    const f = pessoas.find((x) => x.id === funcionarioId)
    if (!f) return
    const todos = g.funcionarios()
    const livre = (campo: 'telefone' | 'lid', valor: string) => !todos.some((x) => x.id !== f.id && x[campo] === valor)
    if (!f.telefone && p.telefone && livre('telefone', p.telefone)) g.definirTelefone(f.id, p.telefone, agora)
    if (!f.lid && p.lid && livre('lid', p.lid)) g.definirLid(f.id, p.lid, agora)
  }
}

interface Resultado {
  enfileirou: boolean
  executar: string | null
  silencio: boolean
  /** Mídias baixadas que ficaram em uso (num envio ou numa repetição). */
  midiasUsadas: Set<string>
  /** Arquivos que podem ser apagados. */
  soltas: string[]
}
