import type { Logger } from 'pino'
import type { BotGrupos, RepoBotsGrupos } from '../db/bots-grupos.js'
import type { Funcionario, RepoGrupos } from '../db/grupos.js'
import type { Repositorio } from '../db/repositorio.js'
import { comandosDoBot } from './catalogo.js'
import { acharComando, interpretar, type Comando } from './comandos.js'
import { processarComando } from './motor.js'
import { pessoaDoJid, chaveTelefoneDeJid, usuarioDoJid, vinculosDeLid } from './pessoas.js'
import type {
  AcaoGrupo,
  ConexaoGrupos,
  ContextoGrupos,
  EnvioGrupo,
  EventoGrupos,
  GrupoDoBot,
  MembroGrupo,
  MensagemGrupo,
  Pessoa
} from './tipos.js'

export interface DependenciasGrupos {
  /** Auditoria e transações. */
  repo: Repositorio
  grupos: RepoGrupos
  bots: RepoBotsGrupos
  /** Conexão do número; null se estiver desativado. */
  conexao: (numeroId: number) => ConexaoGrupos | null
  log: Logger
  relogio?: () => number
  conectadoDesde?: (numeroId: number) => number | null
  /** Telefone conectado no número (para o link wa.me que acompanha o código de gestor). */
  telefoneDoNumero?: (numeroId: number) => string | null
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

/** Códigos errados de /confirmar aceitos por hora antes do silêncio: por pessoa e no bot inteiro. */
export const ERROS_CODIGO_POR_PESSOA = 5
export const ERROS_CODIGO_POR_BOT = 30
const JANELA_ERROS_CODIGO_MS = 60 * 60 * 1000

const FALHA = 'Não consegui concluir esse comando agora. Tente de novo em instantes.'

/**
 * Liga os comandos ao motor. Cada número atende o bot de grupos ligado a ele, e só nos grupos que o
 * bot tem como ativos: fora deles, nada é lido nem guardado. Tudo que depende do WhatsApp
 * (LID → telefone, dados do grupo) acontece antes; depois, dedupe + mudanças + respostas + auditoria
 * vão numa transação só. Se o processo cair antes dela, o comando não aconteceu e o gestor manda de novo.
 */
export class OrquestradorGrupos {
  private filas = new Map<string, Promise<void>>()
  private readonly relogio: () => number
  /** Último horário em que (número, chat, remetente, comando) foi aceito. */
  private readonly ultimoPorRemetente = new Map<string, number>()
  /** Último horário em que (número, chat, comando) foi aceito, de qualquer remetente. */
  private readonly ultimoPorChat = new Map<string, number>()
  /** Horários dos códigos errados de /confirmar, por "bot:remetente" e por "bot". */
  private readonly errosCodigo = new Map<string, number[]>()
  private sincronizando = new Map<number, Promise<void>>()

  constructor(private readonly d: DependenciasGrupos) {
    this.relogio = d.relogio ?? Date.now
  }

  /**
   * Comandos do mesmo chat são tratados em ordem; chats diferentes não esperam uns pelos outros.
   * Comando comum (não de gestor) repetido rápido demais no mesmo grupo é descartado aqui mesmo,
   * antes de entrar na fila: nem dedupe, nem resposta — só um freio contra spam, não contra reenvio.
   */
  receber(m: MensagemGrupo): void {
    const bot = this.d.bots.botDoNumero(m.numeroId)
    if (!bot) return
    // Grupo que o bot não tem como ativo: silêncio total, sem nem a linha de dedupe.
    if (m.ehGrupo && !this.d.bots.grupoAtivo(bot.id, m.chat)) return
    const cmd = interpretar(m.texto, m.mencionados, m.citada)
    const agora = this.relogio()
    if (cmd && m.ehGrupo && this.comandoComum(bot.id, cmd) && !this.podeProcessar(m, cmd, agora)) {
      this.d.log.debug({ mensagem: m.id, numero: m.numeroId }, 'comando comum ignorado por repetição rápida')
      return
    }
    if (cmd?.nome === 'confirmar' && !m.ehGrupo && this.codigoBloqueado(bot.id, m.remetente.jid, agora)) {
      this.d.log.warn({ mensagem: m.id, numero: m.numeroId, bot: bot.id }, 'tentativas de código demais: /confirmar ignorado')
      return
    }
    const chave = `${m.numeroId}:${m.chat}`
    const anterior = this.filas.get(chave) ?? Promise.resolve()
    const proxima = anterior
      .then(() => this.tratar(m, cmd, bot.id))
      .catch((err) => this.d.log.error({ err, mensagem: m.id, numero: m.numeroId }, 'falha inesperada no comando'))
      .finally(() => {
        if (this.filas.get(chave) === proxima) this.filas.delete(chave)
      })
    this.filas.set(chave, proxima)
  }

  /** Comando que qualquer um pode mandar (pronto não-gestor ou personalizado "todos"): passa pelo freio. */
  private comandoComum(botId: number, cmd: Comando): boolean {
    const def = acharComando(cmd.nome)
    if (def) return !def.gestor
    const p = this.d.bots.comandos(botId).get(cmd.nome)
    return !!p?.personalizado && p.quem === 'todos'
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

  /** Espera todas as filas e sincronizações terminarem (testes e desligamento). */
  async ocioso(): Promise<void> {
    while (this.filas.size > 0 || this.sincronizando.size > 0) {
      await Promise.all([...this.filas.values(), ...this.sincronizando.values()])
    }
  }

  /** Mantém a lista geral de grupos igual ao que o WhatsApp informa, e os participantes dos grupos ativos. */
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
          case 'participantes':
            return this.mudarParticipantes(numeroId, e)
        }
      })
    } catch (err) {
      this.d.log.error({ err, numero: numeroId, evento: e.tipo }, 'falha ao atualizar grupos')
    }
    // Ao conectar, os participantes guardados podem estar velhos (mudanças com o número desligado).
    if (e.tipo === 'lista') void this.sincronizarParticipantes(numeroId)
  }

  private mudarParticipantes(numeroId: number, e: Extract<EventoGrupos, { tipo: 'participantes' }>): void {
    const bot = this.d.bots.botDoNumero(numeroId)
    if (!bot || !this.d.bots.grupoAtivo(bot.id, e.jid)) return
    const b = this.d.bots
    switch (e.acao) {
      case 'add':
        return b.adicionarParticipantes(bot.id, e.jid, e.membros)
      case 'remove':
        return b.removerParticipantes(bot.id, e.jid, e.membros.map((x) => x.jid))
      case 'promote':
      case 'demote':
        for (const x of e.membros) b.definirAdminParticipante(bot.id, e.jid, x.jid, e.acao === 'promote')
    }
  }

  /** Relê os participantes de todos os grupos ativos do bot deste número, um grupo por vez. */
  sincronizarParticipantes(numeroId: number): Promise<void> {
    const emAndamento = this.sincronizando.get(numeroId)
    if (emAndamento) return emAndamento
    const tarefa = (async () => {
      const bot = this.d.bots.botDoNumero(numeroId)
      if (!bot) return
      for (const g of this.d.bots.gruposAtivos(bot.id)) {
        try {
          await this.sincronizarGrupo(bot.id, g.jid)
        } catch (err) {
          this.d.log.warn({ err, numero: numeroId }, 'não foi possível reler os participantes de um grupo ativo')
        }
      }
    })().finally(() => this.sincronizando.delete(numeroId))
    this.sincronizando.set(numeroId, tarefa)
    return tarefa
  }

  /**
   * Relê um grupo ativo e guarda os participantes. Devolve false se o número do bot não está
   * conectado agora (o painel avisa que a leitura fica para quando conectar). Erros do WhatsApp sobem.
   */
  async sincronizarGrupo(botId: number, jid: string): Promise<boolean> {
    const bot = this.d.bots.bot(botId)
    const conexao = bot?.numeroId ? this.d.conexao(bot.numeroId) : null
    if (!bot?.numeroId || !conexao?.pronta()) return false
    const md = await conexao.metadados(jid)
    const membros = await Promise.all(md.membros.map(async (x) => ({ ...(await this.completar(conexao, x)), admin: x.admin })))
    const numeroId = bot.numeroId
    this.d.repo.transacao(() => {
      this.d.grupos.salvarGrupo(numeroId, md.jid, md.nome, md.botAdmin, this.relogio())
      // Pode ter sido desativado enquanto o WhatsApp respondia: aí não guarda nada.
      if (this.d.bots.grupoAtivo(botId, jid)) this.d.bots.substituirParticipantes(botId, jid, membros)
    })
    return true
  }

  private async tratar(m: MensagemGrupo, cmd: Comando | null, botId: number): Promise<void> {
    const atraso = this.relogio() - m.recebidaEm
    if (atraso > JANELA_COMANDO_MS) {
      this.d.log.debug({ mensagem: m.id, atraso }, 'comando antigo (fila ao reconectar) ignorado')
      return
    }
    if (this.d.grupos.comandoVisto(m.numeroId, m.id)) return
    if (!cmd) return
    const bot = this.d.bots.bot(botId)
    if (!bot?.ativo || bot.numeroId !== m.numeroId) return
    const conexao = this.d.conexao(m.numeroId)
    const def = acharComando(cmd.nome)
    const precisaMembros = !!def?.precisaMembros

    let remetente = await this.completar(conexao, m.remetente)
    const mencionados = await Promise.all(m.mencionados.map((j) => this.completar(conexao, pessoaDoJid(j))))
    const citada = m.citada ? await this.completar(conexao, pessoaDoJid(m.citada)) : null
    const membros = m.ehGrupo ? await this.lerGrupo(conexao, m, bot.id, precisaMembros) : null

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
    const grupos = this.gruposDoBot(bot)
    const gestores = this.d.bots.gestores(bot.id)
    const ctx: ContextoGrupos = {
      agora,
      bot: { id: bot.id, nome: bot.nome },
      comandos: comandosDoBot(this.d.bots.comandos(bot.id)),
      chat: m.chat,
      ehGrupo: m.ehGrupo,
      remetente,
      mencionados,
      citada,
      funcionarios,
      gestores: new Set(gestores.filter((x) => x.confirmadoEm !== null).map((x) => x.funcionarioId)),
      pendentes: gestores
        .filter((x) => x.confirmadoEm === null)
        .map((x) => ({ funcionarioId: x.funcionarioId, codigo: x.codigo, expiraEm: x.codigoExpiraEm })),
      grupo: m.ehGrupo ? (grupos.find((x) => x.jid === m.chat) ?? null) : null,
      grupos,
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
      enfileirou = this.aplicar(m, bot, acoes, vinculos, funcionarios, usuario, agora)
    } catch (err) {
      this.d.log.error({ err, mensagem: m.id, numero: m.numeroId }, 'erro ao executar comando')
      if (acoes.length > 0) enfileirou = this.aplicar(m, bot, [{ tipo: 'responder', texto: FALHA }], [], funcionarios, usuario, agora)
    }
    if (acoes.some((a) => a.tipo === 'codigo_errado')) this.registrarErroCodigo(bot.id, m.remetente.jid, agora)
    // Fora do try: um erro do próprio avisador não deve disparar a resposta de falha por engano.
    if (enfileirou) this.d.aoEnfileirar?.(m.numeroId)
  }

  /** Grupos ativos do bot com nome e admin da lista geral do número atual. */
  private gruposDoBot(bot: BotGrupos): GrupoDoBot[] {
    const geral = new Map((bot.numeroId ? this.d.grupos.grupos(bot.numeroId) : []).map((x) => [x.jid, x]))
    return this.d.bots
      .gruposAtivos(bot.id)
      .map((a) => {
        const x = geral.get(a.jid)
        return { jid: a.jid, nome: x?.nome ?? a.jid, botAdmin: x?.botAdmin ?? false, loja: a.loja, setor: a.setor }
      })
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
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

  /**
   * Grupo desconhecido (evento perdido) é lido e gravado uma vez. Participantes vêm do que está
   * guardado (mantido pelos eventos); só quando ainda não há nada guardado o grupo é lido do WhatsApp.
   */
  private async lerGrupo(conexao: ConexaoGrupos | null, m: MensagemGrupo, botId: number, precisaMembros: boolean): Promise<MembroGrupo[] | null> {
    const conhecido = this.d.grupos.grupo(m.numeroId, m.chat)
    const guardados = precisaMembros ? this.d.bots.participantes(botId, m.chat) : []
    if (conhecido?.ativo && (!precisaMembros || guardados.length > 0)) return precisaMembros ? guardados : null
    if (!conexao) return null
    try {
      const md = await conexao.metadados(m.chat)
      const membros = precisaMembros
        ? await Promise.all(md.membros.map(async (x) => ({ ...(await this.completar(conexao, x)), admin: x.admin })))
        : null
      this.d.repo.transacao(() => {
        this.d.grupos.salvarGrupo(m.numeroId, md.jid, md.nome, md.botAdmin, this.relogio())
        if (membros && this.d.bots.grupoAtivo(botId, m.chat)) this.d.bots.substituirParticipantes(botId, m.chat, membros)
      })
      return membros
    } catch (err) {
      this.d.log.warn({ err, numero: m.numeroId }, 'não foi possível ler os dados do grupo')
      return null
    }
  }

  /** Devolve true se algo foi enfileirado para sair (quem chama avisa o remetente depois, fora da transação). */
  private aplicar(
    m: MensagemGrupo,
    bot: BotGrupos,
    acoes: AcaoGrupo[],
    vinculos: { id: number; lid: string }[],
    funcionarios: Funcionario[],
    usuario: string,
    agora: number
  ): boolean {
    const g = this.d.grupos
    const b = this.d.bots
    let enfileirou = false
    const enviar = (jid: string, envio: EnvioGrupo) => {
      g.enfileirarSaida(m.numeroId, jid, JSON.stringify(envio), agora)
      enfileirou = true
    }
    this.d.repo.transacao(() => {
      // Outra entrega da mesma mensagem pode ter passado enquanto esta esperava o WhatsApp.
      if (!g.registrarComando(m.numeroId, m.id, m.chat, m.recebidaEm)) return
      for (const v of vinculos) g.vincularLid(v.id, v.lid, agora)
      for (const a of acoes) {
        switch (a.tipo) {
          case 'responder':
            enviar(m.chat, { tipo: 'texto', texto: a.texto, ...(a.mencoes ? { mencoes: a.mencoes } : {}) })
            break
          case 'salvar_funcionario':
            g.salvarFuncionario(a.id, a.dados, agora)
            break
          case 'indicar_gestor': {
            const codigo = b.indicarGestor(bot.id, a.funcionarioId, usuario, agora)
            const nome = funcionarios.find((f) => f.id === a.funcionarioId)?.nome ?? 'a pessoa'
            // O código nunca vai para o grupo: só para o privado de quem indicou, que repassa.
            enviar(a.avisar.jid, { tipo: 'texto', texto: this.mensagemCodigo(bot, nome, codigo) })
            break
          }
          case 'remover_gestor':
            b.removerGestor(bot.id, a.funcionarioId)
            break
          case 'confirmar_gestor':
            this.confirmar(bot.id, a.funcionarioId, a.pessoa, funcionarios, agora)
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
    return enfileirou
  }

  /** Confirma e completa o cadastro com o que a confirmação provou (telefone ou LID que faltavam). */
  private confirmar(botId: number, funcionarioId: number, p: Pessoa, funcionarios: Funcionario[], agora: number): void {
    const g = this.d.grupos
    this.d.bots.confirmarGestor(botId, funcionarioId, p.jid, agora)
    g.confirmarFuncionario(funcionarioId, agora)
    const f = funcionarios.find((x) => x.id === funcionarioId)
    if (!f) return
    const livre = (campo: 'telefone' | 'lid', valor: string) => !funcionarios.some((x) => x.id !== f.id && x[campo] === valor)
    if (!f.telefone && p.telefone && livre('telefone', p.telefone)) g.definirTelefone(f.id, p.telefone, agora)
    if (!f.lid && p.lid && livre('lid', p.lid)) g.definirLid(f.id, p.lid, agora)
  }

  private mensagemCodigo(bot: BotGrupos, nome: string, codigo: string): string {
    const telefone = bot.numeroId ? this.d.telefoneDoNumero?.(bot.numeroId) : null
    const link = telefone ? `\nOu mande este link para ${nome}: https://wa.me/${telefone}?text=%2Fconfirmar%20${codigo}` : ''
    return (
      `🔐 Código para ${nome} virar gestor(a) do ${bot.nome}: ${codigo}\n` +
      `Vale por 48 horas. Peça para ${nome} mandar no meu privado:\n/confirmar ${codigo}${link}`
    )
  }
}
