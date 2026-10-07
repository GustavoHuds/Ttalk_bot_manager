import { cp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import makeWASocket, {
  Browsers,
  BufferJSON,
  DisconnectReason,
  decryptPollVote,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  jidNormalizedUser,
  normalizeMessageContent,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
  proto
} from '@whiskeysockets/baileys'
import type { Logger } from 'pino'
import type { MensagemRecebida } from '../conversa/orquestrador.js'
import type { Papel } from '../db/numeros.js'
import type { Repositorio } from '../db/repositorio.js'
import { ehComando } from '../grupos/comandos.js'
import type { ConexaoGrupos, EventoGrupos, InfoGrupo, MensagemGrupo, MetadadosGrupo } from '../grupos/tipos.js'
import type { ConexaoEnvio } from './expedidor.js'
import {
  entradaDaMensagem,
  identidade,
  infoDoGrupo,
  jidIgnorado,
  jidIgnoradoGrupos,
  membrosDoGrupo,
  mencoesDaMensagem,
  opcoesVotadas,
  origemComando,
  paraNumero,
  souEu,
  telefoneDoJid,
  textoDaMensagem
} from './normalizar.js'

export type StatusConexao = 'iniciando' | 'aguardando_qr' | 'conectado' | 'reconectando' | 'desconectado'

export interface EstadoConexao {
  status: StatusConexao
  /** Texto do QR atual, enquanto aguarda leitura. */
  qr: string | null
  desde: number
  numero: string | null
  /** Motivo quando a sessão foi encerrada e o bot parou de tentar. */
  motivo: string | null
}

export interface OpcoesBaileys {
  /** Número (tabela numeros) desta conexão. */
  numeroId: number
  /** Recrutamento ignora grupos; grupos só repassa comandos. */
  papel: Papel
  pastaSessao: string
  repo: Repositorio
  log: Logger
  /** Mensagens mais velhas que isso (ao reconectar) são ignoradas. */
  janelaMs: number
  aoReceber: (m: MensagemRecebida) => void
  aoComando?: (m: MensagemGrupo) => void
  aoEventoGrupos?: (e: EventoGrupos) => void
  aoMudarEstado?: (e: EstadoConexao) => void
}

/** Formato do erro de desconexão do Baileys (Boom), sem depender do pacote. */
type ErroDesconexao = { output?: { statusCode?: number } }

const ESPERA_MAXIMA_MS = 5 * 60 * 1000

/**
 * Única parte do sistema que conhece o Baileys. Trocar para Evolution API ou para
 * a API oficial é escrever outra classe com os mesmos métodos.
 */
export class ConexaoBaileys implements ConexaoEnvio, ConexaoGrupos {
  private sock: WASocket | null = null
  private tentativas = 0
  private timerReconexao: NodeJS.Timeout | null = null
  private parado = false
  private estado: EstadoConexao = { status: 'iniciando', qr: null, desde: Date.now(), numero: null, motivo: null }

  constructor(private readonly o: OpcoesBaileys) {}

  get estadoAtual(): EstadoConexao {
    return this.estado
  }

  pronta(): boolean {
    return this.estado.status === 'conectado' && this.sock !== null
  }

  async iniciar(): Promise<void> {
    this.parado = false
    await mkdir(this.o.pastaSessao, { recursive: true, mode: 0o700 })
    const { state, saveCreds } = await useMultiFileAuthState(this.o.pastaSessao)
    let version: [number, number, number] | undefined
    try {
      const v = await fetchLatestWaWebVersion()
      if (v.isLatest) version = v.version
    } catch {
      // sem internet para consultar: usa a versão embutida no Baileys
    }

    const logBaileys = this.o.log.child({ modulo: 'baileys' }, { level: 'warn' })
    const sock = makeWASocket({
      auth: state,
      ...(version ? { version } : {}),
      logger: logBaileys as never,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldIgnoreJid: (jid) => (this.o.papel === 'grupos' ? jidIgnoradoGrupos(jid) : jidIgnorado(jid)),
      getMessage: async (key) => {
        const conteudo = key.id ? this.o.repo.enviada(this.o.numeroId, key.id) : null
        return conteudo ? (JSON.parse(conteudo, BufferJSON.reviver) as proto.IMessage) : undefined
      }
    })
    this.sock = sock

    sock.ev.on('creds.update', saveCreds)
    sock.ev.on('connection.update', (u) => {
      if (u.qr) this.mudar({ status: 'aguardando_qr', qr: u.qr })
      if (u.connection === 'open') {
        this.tentativas = 0
        this.mudar({ status: 'conectado', qr: null, motivo: null, numero: telefoneDoJid(jidNormalizedUser(sock.user?.id)) })
        this.o.log.info('conectado ao WhatsApp')
        if (this.o.papel === 'grupos') void this.sincronizarGrupos()
      }
      if (u.connection === 'close') this.aoFechar(u.lastDisconnect?.error as ErroDesconexao | undefined)
    })
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return
      for (const msg of messages) {
        const tratar = this.o.papel === 'grupos' ? this.tratarComando(msg) : this.tratarRecebida(msg)
        tratar.catch((err) => this.o.log.error({ err }, 'erro ao ler mensagem recebida'))
      }
    })
    if (this.o.papel === 'grupos') this.ouvirGrupos(sock)
  }

  private aoFechar(erro: ErroDesconexao | undefined): void {
    const codigo = erro?.output?.statusCode
    this.sock = null
    if (this.parado) return
    if (codigo === DisconnectReason.loggedOut || codigo === DisconnectReason.connectionReplaced || codigo === DisconnectReason.forbidden) {
      const motivo =
        codigo === DisconnectReason.loggedOut
          ? 'sessão encerrada pelo celular (aparelho desconectado)'
          : codigo === DisconnectReason.connectionReplaced
            ? 'outra conexão assumiu esta sessão'
            : 'número bloqueado ou restringido pelo WhatsApp'
      this.o.log.error({ codigo }, `conexão encerrada: ${motivo}`)
      this.mudar({ status: 'desconectado', qr: null, motivo })
      return
    }
    // Espera crescente: 2 s, 4 s, 8 s... até 5 min. Reinício pedido pelo servidor é imediato.
    const espera = codigo === DisconnectReason.restartRequired ? 0 : Math.min(ESPERA_MAXIMA_MS, 2000 * 2 ** this.tentativas)
    this.tentativas++
    this.o.log.warn({ codigo, espera }, 'conexão caiu, reconectando')
    this.mudar({ status: 'reconectando', qr: null })
    this.timerReconexao = setTimeout(() => {
      this.iniciar().catch((err) => {
        this.o.log.error({ err }, 'falha ao reconectar')
        this.aoFechar(undefined)
      })
    }, espera)
  }

  private mudar(parcial: Partial<EstadoConexao>): void {
    const mudouStatus = parcial.status && parcial.status !== this.estado.status
    this.estado = { ...this.estado, ...parcial, ...(mudouStatus ? { desde: Date.now() } : {}) }
    this.o.aoMudarEstado?.(this.estado)
  }

  private async tratarRecebida(msg: WAMessage): Promise<void> {
    if (msg.key.fromMe || !msg.key.id || !msg.message) return
    const quem = identidade(msg)
    if (!quem) return
    const recebidaEm = (paraNumero(msg.messageTimestamp) ?? Math.floor(Date.now() / 1000)) * 1000
    if (Date.now() - recebidaEm > this.o.janelaMs) return

    const conteudo = normalizeMessageContent(msg.message)
    const entrada = conteudo?.pollUpdateMessage ? this.lerVoto(msg) : entradaDaMensagem(msg)
    if (!entrada) return

    // sem mapeamento, o motor pergunta o telefone no fim
    if (!quem.telefone && quem.lid) quem.telefone = await this.telefoneDoLid(quem.lid)

    const m: MensagemRecebida = {
      numeroId: this.o.numeroId,
      id: msg.key.id,
      jid: quem.jid,
      telefone: quem.telefone,
      lid: quem.lid,
      recebidaEm,
      entrada,
      ...(entrada.tipo === 'arquivo' ? { bruto: JSON.stringify(msg, BufferJSON.replacer) } : {})
    }
    this.o.aoReceber(m)
    if (entrada.tipo !== 'voto') {
      await this.sock?.readMessages([msg.key]).catch(() => undefined)
    }
  }

  /** Baileys 7 não decifra votos sozinho: usa o segredo guardado quando a enquete foi enviada. */
  private lerVoto(msg: WAMessage): MensagemRecebida['entrada'] | null {
    const pu = normalizeMessageContent(msg.message)?.pollUpdateMessage
    const idEnquete = pu?.pollCreationMessageKey?.id
    if (!pu?.vote || !idEnquete) return null
    const enquete = this.o.repo.enquete(this.o.numeroId, idEnquete)
    if (!enquete) return null

    const eu = [this.sock?.user?.id, this.sock?.user?.lid].filter((j): j is string => !!j).map((j) => jidNormalizedUser(j))
    const votantes = [msg.key.remoteJid, msg.key.remoteJidAlt, msg.key.participant, msg.key.participantAlt]
      .filter((j): j is string => !!j)
      .map((j) => jidNormalizedUser(j))
    for (const criador of eu) {
      for (const votante of votantes) {
        try {
          const voto = decryptPollVote(pu.vote, {
            pollCreatorJid: criador,
            pollMsgId: idEnquete,
            pollEncKey: enquete.segredo,
            voterJid: votante
          })
          return { tipo: 'voto', chave: enquete.chave, opcoes: opcoesVotadas(voto.selectedOptions ?? [], enquete.opcoes) }
        } catch {
          // combinação de identidades errada; tenta a próxima
        }
      }
    }
    this.o.log.warn({ enquete: idEnquete }, 'não foi possível decifrar o voto')
    return null
  }

  /** Bot de grupos: só comandos passam. A conversa comum do grupo é descartada aqui, sem tocar no banco nem no log. */
  private async tratarComando(msg: WAMessage): Promise<void> {
    if (msg.key.fromMe || !msg.key.id || !msg.message) return
    const texto = textoDaMensagem(msg)
    if (!texto || !ehComando(texto)) return
    const origem = origemComando(msg)
    if (!origem) return
    const recebidaEm = (paraNumero(msg.messageTimestamp) ?? Math.floor(Date.now() / 1000)) * 1000
    this.o.aoComando?.({ numeroId: this.o.numeroId, id: msg.key.id, ...origem, texto, ...mencoesDaMensagem(msg), recebidaEm })
  }

  /** JIDs do próprio bot (telefone e LID), sem dispositivo. */
  private eu(): string[] {
    return [this.sock?.user?.id, this.sock?.user?.lid].filter((j): j is string => !!j).map((j) => jidNormalizedUser(j))
  }

  private ouvirGrupos(sock: WASocket): void {
    const emitir = (e: EventoGrupos) => this.o.aoEventoGrupos?.(e)
    sock.ev.on('groups.upsert', (gs) => emitir({ tipo: 'entrou', grupos: gs.map((g) => infoDoGrupo(g, this.eu())) }))
    sock.ev.on('groups.update', (us) => {
      for (const u of us) if (u.id && u.subject) emitir({ tipo: 'renomeado', jid: u.id, nome: u.subject })
    })
    sock.ev.on('group-participants.update', (u) => {
      if (!u.participants.some((p) => souEu(this.eu(), p))) return
      if (u.action === 'remove') emitir({ tipo: 'saiu', jid: u.id })
      else if (u.action === 'promote' || u.action === 'demote') emitir({ tipo: 'admin', jid: u.id, admin: u.action === 'promote' })
      else if (u.action === 'add') {
        this.metadados(u.id)
          .then((md) => emitir({ tipo: 'entrou', grupos: [md] }))
          .catch((err) => this.o.log.warn({ err }, 'não foi possível ler o grupo novo'))
      }
    })
  }

  private async sincronizarGrupos(): Promise<void> {
    try {
      this.o.aoEventoGrupos?.({ tipo: 'lista', grupos: await this.listarGrupos() })
    } catch (err) {
      this.o.log.warn({ err }, 'não foi possível listar os grupos')
    }
  }

  // --- envio -------------------------------------------------------------------------

  private exigirSocket(): WASocket {
    if (!this.sock || !this.pronta()) throw new Error('WhatsApp desconectado')
    return this.sock
  }

  async digitando(jid: string): Promise<void> {
    await this.exigirSocket().sendPresenceUpdate('composing', jid)
  }

  async enviarTexto(jid: string, texto: string, mencoes?: string[]): Promise<void> {
    const enviada = await this.exigirSocket().sendMessage(jid, mencoes?.length ? { text: texto, mentions: mencoes } : { text: texto })
    this.guardarEnviada(enviada)
  }

  async listarGrupos(): Promise<InfoGrupo[]> {
    const todos = await this.exigirSocket().groupFetchAllParticipating()
    return Object.values(todos).map((g) => infoDoGrupo(g, this.eu()))
  }

  async metadados(jid: string): Promise<MetadadosGrupo> {
    const g = await this.exigirSocket().groupMetadata(jid)
    return { ...infoDoGrupo(g, this.eu()), membros: membrosDoGrupo(g, this.eu()) }
  }

  async telefoneDoLid(lid: string): Promise<string | null> {
    if (!this.sock) return null
    try {
      const pn = await this.sock.signalRepository.lidMapping.getPNForLID(lid)
      return telefoneDoJid(pn ? jidNormalizedUser(pn) : null)
    } catch {
      return null
    }
  }

  async enviarEnquete(jid: string, chave: string, pergunta: string, opcoes: string[]): Promise<void> {
    const enviada = await this.exigirSocket().sendMessage(jid, { poll: { name: pergunta, values: opcoes, selectableCount: 1 } })
    this.guardarEnviada(enviada)
    const segredo = enviada?.message?.messageContextInfo?.messageSecret
    if (enviada?.key.id && segredo) this.o.repo.salvarEnquete(this.o.numeroId, enviada.key.id, jid, chave, opcoes, segredo, Date.now())
    else this.o.log.warn('enquete enviada sem segredo; só respostas digitadas serão aceitas')
  }

  private guardarEnviada(m: WAMessage | undefined): void {
    if (m?.key.id && m.message) this.o.repo.salvarEnviada(this.o.numeroId, m.key.id, JSON.stringify(m.message, BufferJSON.replacer), Date.now())
  }

  async baixarMidia(bruto: string): Promise<Buffer> {
    const msg = JSON.parse(bruto, BufferJSON.reviver) as WAMessage
    const sock = this.exigirSocket()
    let ultimoErro: unknown
    for (let i = 0; i < 3; i++) {
      try {
        return await downloadMediaMessage(
          msg,
          'buffer',
          {},
          { logger: this.o.log.child({ modulo: 'midia' }, { level: 'warn' }) as never, reuploadRequest: sock.updateMediaMessage }
        )
      } catch (err) {
        ultimoErro = err
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)))
      }
    }
    throw ultimoErro
  }

  // --- operação ----------------------------------------------------------------------

  /**
   * Depois de um logout, começa uma sessão nova (novo QR). A sessão antiga é
   * copiada antes, porque a migração para LID não tem volta.
   */
  async novaSessao(): Promise<void> {
    await this.parar()
    const copia = `${this.o.pastaSessao}-antiga-${new Date().toISOString().replace(/[:.]/g, '-')}`
    await cp(this.o.pastaSessao, copia, { recursive: true }).catch(() => undefined)
    await rm(this.o.pastaSessao, { recursive: true, force: true })
    this.tentativas = 0
    await this.iniciar()
  }

  async parar(): Promise<void> {
    this.parado = true
    if (this.timerReconexao) clearTimeout(this.timerReconexao)
    this.sock?.end(undefined)
    this.sock = null
    this.mudar({ status: 'desconectado', qr: null })
  }
}

export function pastaSessao(dados: string): string {
  return join(dados, 'sessao')
}
