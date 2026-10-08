import { semAcento } from '../conversa/textos.js'
import type { Midia } from '../db/bots-grupos.js'
import { COMANDOS, acharComando, interpretar, type Comando, type DefComando } from './comandos.js'
import { acharFuncionario, formatarTelefone, telefoneDigitado, usuarioDoJid } from './pessoas.js'
import type { AcaoGrupo, ContextoGrupos, Entrada, GrupoDoBot, MembroGrupo, Pessoa, Sessao } from './tipos.js'

/** Quanto dura a escolha do grupo (e o que o bot perguntou) numa conversa com o gestor. */
export const DURACAO_SESSAO_MS = 15 * 60 * 1000
/** Intervalo mínimo entre duas menções a todos no mesmo grupo (menção em massa é o que mais chama atenção do WhatsApp). */
export const INTERVALO_MENCAO_EM_MASSA_MS = 60 * 1000
export const MAX_HORARIOS = 10
export const MAX_PALAVRAS = 100

const TEXTO_ALL_GRUPO = '📢 Todos do grupo mencionados!'

function responder(texto: string, mencoes?: string[]): AcaoGrupo[] {
  return [{ tipo: 'responder', texto, ...(mencoes?.length ? { mencoes } : {}) }]
}

/** "8", "8h", "08:30", "8h30" → "08:30". */
export function horario(token: string): string | null {
  const m = /^(\d{1,2})(?:[:h](\d{2})?)?h?$/i.exec(token.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2] ?? '0')
  if (h > 23 || min > 59) return null
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

/** Horários soltos num texto ("08:00 18:30", "8h, 12h"), sem repetir, em ordem. null se algum termo não for horário. */
export function horarios(texto: string): string[] | null {
  const termos = texto.split(/\s*[,;]\s*|\s+e\s+|\s+/).filter(Boolean)
  if (termos.length === 0) return []
  const lista = termos.map(horario)
  if (lista.some((h) => h === null)) return null
  return [...new Set(lista as string[])].sort()
}

/** Minutos desde a meia-noite em Brasília. */
export function minutoBR(ms: number): number {
  const d = new Date(ms - 3 * 60 * 60 * 1000)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}

const emMinutos = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))

/** Dentro da janela [inicio, fim) — que pode passar da meia-noite (22:00 → 06:00). Sem horário = sempre. */
export function dentroDoSilencio(inicio: string | null, fim: string | null, agora: number): boolean {
  if (!inicio || !fim) return true
  const m = minutoBR(agora)
  const a = emMinutos(inicio)
  const b = emMinutos(fim)
  return a < b ? m >= a && m < b : m >= a || m < b
}

/** Palavras proibidas como o bot compara: minúsculas, sem acento, espaços simples. */
export function palavraLimpa(p: string): string {
  return semAcento(p).replace(/\s+/g, ' ').trim()
}

/** A primeira palavra proibida que aparece no texto como palavra inteira (não como pedaço de outra). */
export function palavraProibida(texto: string, palavras: string[]): string | null {
  if (palavras.length === 0) return null
  const t = ` ${semAcento(texto).replace(/[^\p{L}\p{N}]+/gu, ' ')} `
  return palavras.find((p) => t.includes(` ${p.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `)) ?? null
}

/** Onde um comando age: no grupo, nele; no privado, no grupo escolhido (ou no único, se só houver um). */
export function alvoDe(ehGrupo: boolean, chat: string, grupos: GrupoDoBot[], sessao: Sessao | null): GrupoDoBot | null {
  if (ehGrupo) return grupos.find((g) => g.jid === chat) ?? null
  if (sessao?.grupo) {
    const g = grupos.find((x) => x.jid === sessao.grupo)
    if (g) return g
  }
  return grupos.length === 1 ? grupos[0]! : null
}

/** Termos que são telefone ("83 99999-0000" junto, ou "+55..."), tirados do texto. */
function separarTelefones(texto: string): { telefones: string[]; resto: string } {
  const telefones: string[] = []
  const resto = texto
    .replace(/(^|\s)(\+?\(?\d[\d ().-]{8,}\d)(?=\s|$)/g, (inteiro, antes: string, bruto: string) => {
      const t = telefoneDigitado(bruto)
      if (!t) return inteiro
      telefones.push(t)
      return antes
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim()
  return { telefones, resto }
}

function mesmaPessoa(m: MembroGrupo, p: Pessoa): boolean {
  return m.jid === p.jid || (!!p.telefone && m.telefone === p.telefone) || (!!p.lid && m.lid === p.lid)
}

const negrito = (t: string) => `*${t}*`

/**
 * Regras do bot de grupos. Puro: recebe o retrato do momento e devolve ações;
 * não toca no WhatsApp, no banco nem no relógio.
 */
export function processar(ctx: ContextoGrupos, e: Entrada): AcaoGrupo[] {
  const autor = acharFuncionario(ctx.pessoas, ctx.remetente)
  const gestor = !!autor && autor.ativo && ctx.gestores.has(autor.id)
  if (e.tipo === 'resposta') return gestor ? resposta(ctx, e.texto) : []
  const cmd = interpretar(e.texto)
  if (!cmd) return []
  const def = acharComando(cmd.nome)
  // /confirmar é o único comando de quem ainda não tem poder nenhum (o gestor indicado).
  if (def?.nome === 'confirmar') return confirmar(ctx, cmd)
  // Quem não é gestor confirmado não recebe nada, nem no grupo nem no privado.
  if (!gestor) return []
  if (!def) return responder('Não conheço esse comando. Mande /menu para ver a lista.')
  if (!def.fixo && ctx.desligados.has(def.nome)) return responder(`O /${def.nome} está desligado neste bot.`)
  if (def.soPrivado && ctx.ehGrupo) return responder(`Use /${def.nome} no privado comigo.`)
  if (def.nome === 'menu') return menu(ctx)
  if (def.nome === 'grupo') return escolherGrupo(ctx, cmd.args)
  if (!ctx.alvo) {
    if (ctx.grupos.length === 0) return responder('Este bot ainda não tem nenhum grupo ativo.')
    return perguntarGrupo(ctx, e.texto)
  }
  if (def.precisaAdmin && !ctx.alvo.botAdmin) return responder(`Preciso ser admin do grupo ${negrito(ctx.alvo.nome)} para isso.`)
  if (def.precisaMembros && !ctx.membros) return responder('Não consegui ler os participantes agora. Tente de novo em instantes.')
  return [...manterSessao(ctx), ...new Execucao(ctx, cmd, def, ctx.alvo).rodar()]
}

/** Usar o privado renova a escolha do grupo. */
function manterSessao(ctx: ContextoGrupos): AcaoGrupo[] {
  if (ctx.ehGrupo || !ctx.alvo) return []
  return [{ tipo: 'sessao', sessao: { grupo: ctx.alvo.jid, aguardando: null, pendente: null, ate: ctx.agora + DURACAO_SESSAO_MS } }]
}

function listaDeGrupos(ctx: ContextoGrupos): string {
  return ctx.grupos.map((g, i) => `${i + 1}. ${g.nome}`).join('\n')
}

function perguntarGrupo(ctx: ContextoGrupos, pendente: string | null): AcaoGrupo[] {
  return [
    { tipo: 'sessao', sessao: { grupo: null, aguardando: 'grupo', pendente, ate: ctx.agora + DURACAO_SESSAO_MS } },
    ...responder(`Em qual grupo? Responda com o número:\n${listaDeGrupos(ctx)}`)
  ]
}

function escolherGrupo(ctx: ContextoGrupos, args: string): AcaoGrupo[] {
  if (ctx.grupos.length === 0) return responder('Este bot ainda não tem nenhum grupo ativo.')
  if (!args) return perguntarGrupo(ctx, null)
  return selecionar(ctx, args, null)
}

function selecionar(ctx: ContextoGrupos, texto: string, pendente: string | null): AcaoGrupo[] {
  const n = /^\d{1,3}$/.test(texto.trim()) ? Number(texto.trim()) : NaN
  const g = ctx.grupos[n - 1]
  if (!g) return responder(`Responda com um número de 1 a ${ctx.grupos.length}, ou "cancelar".`)
  const sessao: Sessao = { grupo: g.jid, aguardando: null, pendente: null, ate: ctx.agora + DURACAO_SESSAO_MS }
  // O comando que esperava a escolha roda agora, já com o grupo (o orquestrador monta o retrato de novo).
  if (pendente) return [{ tipo: 'sessao', sessao }, { tipo: 'executar', texto: pendente }]
  return [{ tipo: 'sessao', sessao }, ...responder(`📍 Grupo escolhido: ${negrito(g.nome)}. Agora é só mandar o comando.`)]
}

/** Algo que não é comando, mandado enquanto o bot esperava uma resposta deste gestor. */
function resposta(ctx: ContextoGrupos, texto: string): AcaoGrupo[] {
  const s = ctx.sessao
  if (!s?.aguardando) return []
  if (['cancelar', 'cancela', 'sair', '0'].includes(semAcento(texto))) {
    return [{ tipo: 'sessao', sessao: s.grupo ? { ...s, aguardando: null, pendente: null } : null }, ...responder('Cancelado.')]
  }
  if (s.aguardando === 'grupo') return selecionar(ctx, texto, s.pendente)
  // aguardando 'repeat'
  if (!ctx.alvo) return [{ tipo: 'sessao', sessao: null }]
  const hs = horarios(texto)
  const conteudo = ctx.citada && (ctx.citada.texto || ctx.citada.midia) ? ctx.citada : null
  if (!hs?.length || !conteudo) {
    return responder('Responda *citando* a mensagem que devo repetir, com os horários. Ex.: 08:00 18:30 (ou "cancelar").')
  }
  return [
    { tipo: 'sessao', sessao: ctx.ehGrupo ? null : { ...s, aguardando: null, pendente: null, ate: ctx.agora + DURACAO_SESSAO_MS } },
    ...repetir(ctx, ctx.alvo, hs, conteudo.texto, conteudo.midia)
  ]
}

function repetir(ctx: ContextoGrupos, alvo: GrupoDoBot, hs: string[], texto: string | null, midia: Midia | null): AcaoGrupo[] {
  if (hs.length > MAX_HORARIOS) return responder(`No máximo ${MAX_HORARIOS} horários.`)
  return [
    { tipo: 'repetir', jid: alvo.jid, horarios: hs, texto, midia },
    { tipo: 'auditar', acao: 'repetir', detalhe: `${alvo.nome}: ${hs.join(' ')}` },
    ...responder(`🔁 Vou repetir a mensagem em ${negrito(alvo.nome)} todo dia às ${hs.join(', ')}.\n/repeat stop para parar.`)
  ]
}

/**
 * "/confirmar 123456" no privado: o código liga o WhatsApp de quem mandou ao gestor indicado — mas só
 * se for o mesmo WhatsApp do cadastro (telefone ou LID). Código certo vindo de outro WhatsApp não dá
 * poder: fica guardado como divergência para alguém conferir no painel. No grupo, nunca olha o código.
 */
function confirmar(ctx: ContextoGrupos, cmd: Comando): AcaoGrupo[] {
  if (ctx.ehGrupo) return responder('Use /confirmar no privado comigo.')
  const codigo = cmd.args.replace(/\D/g, '')
  const pendente = /^\d{6}$/.test(codigo)
    ? ctx.pendentes.find((p) => p.codigo === codigo && p.expiraEm !== null && p.expiraEm > ctx.agora)
    : undefined
  const f = pendente ? ctx.pessoas.find((x) => x.id === pendente.funcionarioId) : undefined
  if (!f) return [{ tipo: 'codigo_errado' }, ...responder('Código inválido ou vencido. Peça um novo código a quem cadastrou você.')]
  const r = ctx.remetente
  const mesmo = (!!r.telefone && f.telefone === r.telefone) || (!!r.lid && f.lid === r.lid)
  if (mesmo) {
    return [
      { tipo: 'confirmar_gestor', funcionarioId: f.id, pessoa: r },
      { tipo: 'auditar', acao: 'gestor_confirmado', detalhe: `${f.nome} no ${ctx.bot.nome}`, funcionarioId: f.id },
      ...responder(`✅ Pronto, ${f.nome}! Você agora é gestor(a) do ${ctx.bot.nome}.\nMande /menu para ver os comandos.`)
    ]
  }
  const origem = r.telefone ? formatarTelefone(r.telefone) : 'contato sem telefone visível'
  return [
    { tipo: 'divergencia', funcionarioId: f.id, pessoa: r },
    { tipo: 'auditar', acao: 'gestor_divergente', detalhe: `${f.nome} no ${ctx.bot.nome}: veio de ${origem}`, funcionarioId: f.id },
    ...responder(`Recebido. Este WhatsApp é diferente do cadastro de ${f.nome}; quem administra o painel precisa conferir.`)
  ]
}

function menu(ctx: ContextoGrupos): AcaoGrupo[] {
  const linhas = COMANDOS.filter((d) => !d.oculto && (d.fixo || !ctx.desligados.has(d.nome)) && !(d.soPrivado && ctx.ehGrupo)).map(
    (d) => `${d.uso} — ${d.descricao}`
  )
  const alvo = ctx.ehGrupo ? null : alvoDe(false, ctx.chat, ctx.grupos, ctx.sessao)
  const onde = ctx.ehGrupo ? '' : `\n\n📍 Grupo: ${alvo ? negrito(alvo.nome) : 'nenhum escolhido (/grupo)'}`
  return responder(`📖 *Comandos*\n${linhas.join('\n')}${onde}`)
}

class Execucao {
  /** No grupo, a resposta vai para o próprio grupo; no privado, confirma o que foi feito e onde. */
  private readonly privado: boolean

  constructor(
    private readonly ctx: ContextoGrupos,
    private readonly cmd: Comando,
    private readonly def: DefComando,
    private readonly alvo: GrupoDoBot
  ) {
    this.privado = !ctx.ehGrupo
  }

  rodar(): AcaoGrupo[] {
    const nome = this.def.nome
    switch (nome) {
      case 'all':
        return this.mencionarTodos(false)
      case 'todos':
        return this.mencionarTodos(true)
      case 'mencionar':
        return this.mencionar()
      case 'remove':
        return this.remover()
      case 'banword':
        return this.banword()
      case 'mutegroup':
        return this.mutar()
      case 'unmute':
        return this.desmutar()
      case 'repeat':
        return this.repetir()
      case 'menu':
      case 'grupo':
      case 'confirmar':
        return []
      default: {
        const faltando: never = nome
        throw new Error(`comando sem regra: ${String(faltando)}`)
      }
    }
  }

  private uso(): AcaoGrupo[] {
    return responder(`Uso: ${this.def.uso}`)
  }

  private aqui(): string {
    return negrito(this.alvo.nome)
  }

  /** No grupo, apaga o comando do gestor (fica só a mensagem do bot). Só dá se o número for admin. */
  private apagarComando(): AcaoGrupo[] {
    if (this.privado || !this.alvo.botAdmin) return []
    return [{ tipo: 'enviar', jid: this.ctx.chat, envio: { tipo: 'apagar', chave: this.ctx.mensagem } }]
  }

  private freioMencao(): AcaoGrupo[] | null {
    const ultima = this.ctx.ultimaMencaoEmMassa
    if (ultima === null || this.ctx.agora - ultima >= INTERVALO_MENCAO_EM_MASSA_MS) return null
    const falta = Math.ceil((ultima + INTERVALO_MENCAO_EM_MASSA_MS - this.ctx.agora) / 1000)
    return responder(`Espere ${falta}s para mencionar todos de novo em ${this.aqui()}.`)
  }

  /** Mídia mandada junto (no privado): a da própria mensagem ou a da mensagem citada. */
  private midia(): Midia | null {
    if (!this.privado) return null
    return this.ctx.midia ?? this.ctx.citada?.midia ?? null
  }

  private mensagem(texto: string, mencoes: string[]): AcaoGrupo {
    const midia = this.midia()
    return {
      tipo: 'enviar',
      jid: this.alvo.jid,
      envio: midia ? { tipo: 'midia', midia, legenda: texto || null, mencoes, temporaria: true } : { tipo: 'texto', texto, mencoes }
    }
  }

  private mencionarTodos(visivel: boolean): AcaoGrupo[] {
    const freio = this.freioMencao()
    if (freio) return freio
    const membros = this.ctx.membros!
    if (membros.length === 0) return responder(`Não há participantes para mencionar em ${this.aqui()}.`)
    const corpo = this.cmd.bruto
    if (this.privado && !corpo && !this.midia()) return this.uso()
    const jids = membros.map((m) => m.jid)
    const marcas = membros.map((m) => `@${usuarioDoJid(m.jid)}`).join(' ')
    const texto = visivel ? [corpo, marcas].filter(Boolean).join('\n\n') : corpo || (this.midia() ? '' : TEXTO_ALL_GRUPO)
    return [
      ...this.apagarComando(),
      this.mensagem(texto, jids),
      { tipo: 'mencao_em_massa', jid: this.alvo.jid },
      { tipo: 'auditar', acao: visivel ? 'mencionar_todos_visivel' : 'mencionar_todos', detalhe: `${this.alvo.nome}: ${jids.length} pessoas` },
      ...(this.privado ? responder(`✅ Enviado em ${this.aqui()}, com ${jids.length} pessoa(s) mencionada(s).`) : [])
    ]
  }

  /** Alvos do comando: menções e citada (no grupo) ou telefones digitados (no privado), achados entre os participantes. */
  private pessoasDoGrupo(telefones: string[]): { achados: MembroGrupo[]; faltando: number } {
    const membros = this.ctx.membros ?? []
    const procurados: Pessoa[] = [
      ...this.ctx.mencionados,
      ...(this.def.nome === 'remove' && this.ctx.citada?.autor ? [this.ctx.citada.autor] : []),
      ...telefones.map((t) => ({ jid: `${t}@s.whatsapp.net`, telefone: t, lid: null }))
    ]
    const achados: MembroGrupo[] = []
    let faltando = 0
    for (const p of procurados) {
      const m = membros.find((x) => mesmaPessoa(x, p))
      if (!m) faltando++
      else if (!achados.includes(m)) achados.push(m)
    }
    return { achados, faltando }
  }

  private mencionar(): AcaoGrupo[] {
    const { telefones, resto } = this.privado ? separarTelefones(this.cmd.bruto) : { telefones: [], resto: this.cmd.bruto }
    const { achados, faltando } = this.pessoasDoGrupo(telefones)
    if (achados.length === 0) return faltando ? responder(`Não achei essa pessoa em ${this.aqui()}.`) : this.uso()
    if (!resto && !this.midia()) return this.uso()
    return [
      ...this.apagarComando(),
      this.mensagem(resto, achados.map((m) => m.jid)),
      { tipo: 'auditar', acao: 'mencionar', detalhe: `${this.alvo.nome}: ${achados.length} pessoa(s)` },
      ...(this.privado ? responder(`✅ Enviado em ${this.aqui()}${faltando ? ` (${faltando} não está no grupo)` : ''}.`) : [])
    ]
  }

  private remover(): AcaoGrupo[] {
    const { telefones } = this.privado ? separarTelefones(this.cmd.bruto) : { telefones: [] }
    const { achados, faltando } = this.pessoasDoGrupo(telefones)
    if (achados.length === 0) return faltando ? responder(`Não achei essa pessoa em ${this.aqui()}.`) : this.uso()
    const admins = achados.filter((m) => m.admin)
    const sair = achados.filter((m) => !m.admin)
    const avisos = [
      admins.length ? `${admins.length} é admin do grupo e ficou.` : '',
      faltando ? `${faltando} não está no grupo.` : ''
    ].filter(Boolean)
    if (sair.length === 0) return responder(`Ninguém removido. ${avisos.join(' ')}`.trim())
    return [
      { tipo: 'enviar', jid: this.alvo.jid, envio: { tipo: 'remover', participantes: sair.map((m) => m.jid) } },
      { tipo: 'auditar', acao: 'remover_participantes', detalhe: `${this.alvo.nome}: ${sair.length} pessoa(s)` },
      ...responder([`✅ ${sair.length} pessoa(s) removida(s) de ${this.aqui()}.`, ...avisos].join(' '))
    ]
  }

  private banword(): AcaoGrupo[] {
    const args = this.cmd.args
    const atuais = this.ctx.palavras
    const lista = (ps: string[]) => (ps.length ? ps.join(', ') : 'nenhuma')
    if (!args) return responder(`🚫 Palavras proibidas em ${this.aqui()}: ${lista(atuais)}`)
    const s = semAcento(args)
    if (s === 'limpar' || s === 'nenhuma') {
      return [
        { tipo: 'palavras_remover', jid: this.alvo.jid, palavras: null },
        { tipo: 'auditar', acao: 'palavras_limpas', detalhe: this.alvo.nome },
        ...responder(`🚫 Nenhuma palavra proibida em ${this.aqui()} agora.`)
      ]
    }
    const remover = /^(remover|tirar|-)\s*/.exec(s)
    const palavras = [...new Set((remover ? args.slice(remover[0].length) : args).split(',').map(palavraLimpa).filter(Boolean))]
    if (palavras.length === 0) return this.uso()
    if (palavras.some((p) => p.length < 2 || p.length > 40)) return responder('Cada palavra precisa ter de 2 a 40 letras.')
    if (remover) {
      const ficam = atuais.filter((p) => !palavras.includes(p))
      return [
        { tipo: 'palavras_remover', jid: this.alvo.jid, palavras },
        { tipo: 'auditar', acao: 'palavras_removidas', detalhe: `${this.alvo.nome}: ${palavras.join(', ')}` },
        ...responder(`🚫 Palavras proibidas em ${this.aqui()}: ${lista(ficam)}`)
      ]
    }
    const todas = [...new Set([...atuais, ...palavras])].sort()
    if (todas.length > MAX_PALAVRAS) return responder(`No máximo ${MAX_PALAVRAS} palavras por grupo.`)
    const semAdmin = this.alvo.botAdmin ? '' : '\n⚠ Preciso ser admin do grupo para apagar as mensagens.'
    return [
      { tipo: 'palavras', jid: this.alvo.jid, adicionar: palavras },
      { tipo: 'auditar', acao: 'palavras_proibidas', detalhe: `${this.alvo.nome}: ${palavras.join(', ')}` },
      ...responder(`🚫 Palavras proibidas em ${this.aqui()}: ${lista(todas)}${semAdmin}`)
    ]
  }

  private mutar(): AcaoGrupo[] {
    const args = this.cmd.args
    if (!args) {
      return [
        { tipo: 'silencio', jid: this.alvo.jid, inicio: null, fim: null },
        { tipo: 'auditar', acao: 'fechar_grupo', detalhe: this.alvo.nome },
        ...responder(`🔇 ${this.aqui()} fechado: só admins mandam mensagem. /unmute para abrir.`)
      ]
    }
    const partes = args.split(/\s*(?:\/|-|–|\s+a\s+|\s+as\s+|\s+às\s+|\s+ate\s+|\s+até\s+|\s+)\s*/i).filter(Boolean)
    const [inicio, fim] = partes.map(horario)
    if (partes.length !== 2 || !inicio || !fim || inicio === fim) return this.uso()
    return [
      { tipo: 'silencio', jid: this.alvo.jid, inicio, fim },
      { tipo: 'auditar', acao: 'fechar_grupo_horario', detalhe: `${this.alvo.nome}: ${inicio} às ${fim}` },
      ...responder(`🔇 ${this.aqui()} fecha todo dia das ${inicio} às ${fim}. /unmute para cancelar.`)
    ]
  }

  private desmutar(): AcaoGrupo[] {
    return [
      { tipo: 'silencio_remover', jid: this.alvo.jid },
      { tipo: 'enviar', jid: this.alvo.jid, envio: { tipo: 'fechar', fechado: false } },
      { tipo: 'auditar', acao: 'abrir_grupo', detalhe: this.alvo.nome },
      ...responder(`🔊 ${this.aqui()} aberto: todos podem mandar mensagem.`)
    ]
  }

  private repetir(): AcaoGrupo[] {
    const s = semAcento(this.cmd.args)
    if (['stop', 'parar', 'off', 'cancelar'].includes(s)) {
      return [
        { tipo: 'repetir_parar', jid: this.alvo.jid },
        { tipo: 'auditar', acao: 'repetir_parar', detalhe: this.alvo.nome },
        ...responder(`⏹ Repetições paradas em ${this.aqui()}.`)
      ]
    }
    const hs = horarios(this.cmd.args)
    if (hs === null) return this.uso()
    const conteudo = this.ctx.citada && (this.ctx.citada.texto || this.ctx.citada.midia) ? this.ctx.citada : null
    if (hs.length && conteudo) return repetir(this.ctx, this.alvo, hs, conteudo.texto, conteudo.midia)
    const sessao: Sessao = {
      grupo: this.privado ? this.alvo.jid : null,
      aguardando: 'repeat',
      pendente: null,
      ate: this.ctx.agora + DURACAO_SESSAO_MS
    }
    return [
      { tipo: 'sessao', sessao },
      ...responder(`🔁 Responda *citando* a mensagem que devo repetir em ${this.aqui()}, com os horários. Ex.: 08:00 18:30`)
    ]
  }
}
