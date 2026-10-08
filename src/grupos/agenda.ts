import type { Logger } from 'pino'
import type { BotGrupos, Programada, RepoBotsGrupos } from '../db/bots-grupos.js'
import type { RepoGrupos } from '../db/grupos.js'
import type { Repositorio } from '../db/repositorio.js'
import { sortear } from '../whatsapp/limite.js'
import { dentroDoSilencio } from './motor.js'
import type { ConexaoGrupos, EnvioGrupo } from './tipos.js'

export interface DependenciasAgenda {
  repo: Repositorio
  grupos: RepoGrupos
  bots: RepoBotsGrupos
  conexao: (numeroId: number) => ConexaoGrupos | null
  pausado: (numeroId: number) => boolean
  log: Logger
  aoEnfileirar?: (numeroId: number) => void
  relogio?: () => number
  aleatorio?: () => number
}

/** Horário que passou com o número fora do ar por mais que isto não é mandado atrasado. */
export const TOLERANCIA_ATRASO_MS = 10 * 60_000
/** Cada envio programado sai num momento sorteado até isto depois do horário (nunca no segundo exato). */
export const ESPALHAR_MS = 45_000

const FUSO_MS = 3 * 60 * 60 * 1000

/** "AAAA-MM-DD" e dia da semana (0 = domingo) em Brasília. */
export function diaBR(ms: number): { data: string; semana: number } {
  const d = new Date(ms - FUSO_MS)
  return { data: d.toISOString().slice(0, 10), semana: d.getUTCDay() }
}

/** Instante (ms) de "HH:MM" no dia `data` de Brasília. */
export function instanteBR(data: string, hhmm: string): number {
  const [a, m, d] = data.split('-').map(Number)
  return Date.UTC(a!, m! - 1, d!, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3))) + FUSO_MS
}

/** O horário de hoje que já chegou e ainda não foi mandado (o mais recente), ou null. */
export function horarioDevido(p: Programada, agora: number): number | null {
  const hoje = diaBR(agora)
  if (p.data ? p.data !== hoje.data : !p.dias.includes(hoje.semana)) return null
  let devido: number | null = null
  for (const h of p.horarios) {
    const t = instanteBR(hoje.data, h)
    if (t <= agora && agora - t < TOLERANCIA_ATRASO_MS && t > (p.ultimoEnvio ?? 0)) devido = Math.max(devido ?? 0, t)
  }
  return devido
}

/** Variação da vez: a primeira, ou (variando) uma sorteada diferente da última. */
export function escolherVariacao(p: Programada, aleatorio: () => number): number {
  const n = p.variacoes.length
  if (!p.variar || n < 2) return 0
  const opcoes = [...Array(n).keys()].filter((i) => i !== p.ultimaVariacao)
  return opcoes[Math.floor(aleatorio() * opcoes.length)] ?? 0
}

/**
 * Relógio do bot de grupos: a cada volta põe na caixa de saída as mensagens programadas (e os
 * /repeat) cujo horário chegou, e abre ou fecha os grupos do /mutegroup. Número pausado ou fora do ar
 * fica de fora; o que passou com ele parado por mais de 10 min é pulado, não mandado atrasado.
 */
export class AgendaGrupos {
  private timer: NodeJS.Timeout | null = null
  private rodando: Promise<void> | null = null
  private readonly relogio: () => number
  private readonly aleatorio: () => number

  constructor(private readonly d: DependenciasAgenda) {
    this.relogio = d.relogio ?? Date.now
    this.aleatorio = d.aleatorio ?? Math.random
  }

  iniciar(intervaloMs = 20_000): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.rodar(), intervaloMs)
  }

  parar(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Uma volta. Chamadas ao mesmo tempo esperam a mesma volta. Nunca rejeita. */
  rodar(): Promise<void> {
    if (this.rodando) return this.rodando
    this.rodando = this.volta()
      .catch((err) => this.d.log.error({ err }, 'falha no agendador dos grupos'))
      .finally(() => {
        this.rodando = null
      })
    return this.rodando
  }

  private async volta(): Promise<void> {
    for (const bot of this.d.bots.bots()) {
      if (!bot.ativo || bot.numeroId === null || this.d.pausado(bot.numeroId)) continue
      const conexao = this.d.conexao(bot.numeroId)
      if (!conexao?.pronta()) continue
      try {
        const n = this.silencios(bot, bot.numeroId) + (await this.programadas(bot, bot.numeroId, conexao))
        if (n > 0) this.d.aoEnfileirar?.(bot.numeroId)
      } catch (err) {
        this.d.log.error({ err, bot: bot.id }, 'falha no agendador de um bot de grupos')
      }
    }
  }

  private silencios(bot: BotGrupos, numeroId: number): number {
    const agora = this.relogio()
    let n = 0
    for (const s of this.d.bots.silencios(bot.id)) {
      const fechar = dentroDoSilencio(s.inicio, s.fim, agora)
      if (s.fechado === fechar) continue
      // Sem admin o WhatsApp recusa; tenta de novo quando o número virar admin.
      if (!this.d.grupos.grupo(numeroId, s.jid)?.botAdmin) continue
      const envio: EnvioGrupo = { tipo: 'fechar', fechado: fechar }
      this.d.repo.transacao(() => {
        this.d.grupos.enfileirarSaida(numeroId, s.jid, JSON.stringify(envio), agora)
        this.d.bots.marcarSilencioAplicado(bot.id, s.jid, fechar)
      })
      n++
    }
    return n
  }

  private async programadas(bot: BotGrupos, numeroId: number, conexao: ConexaoGrupos): Promise<number> {
    let n = 0
    for (const p of this.d.bots.programadas(bot.id)) {
      if (!p.ativa || p.variacoes.length === 0) continue
      const slot = horarioDevido(p, this.relogio())
      if (slot === null) continue
      let mencoes: string[] | undefined
      if (p.mencionar) {
        try {
          mencoes = (await conexao.metadados(p.jid)).membros.map((m) => m.jid)
        } catch (err) {
          this.d.log.warn({ err, bot: bot.id, programada: p.id }, 'sem participantes para mencionar; a mensagem sai sem menções')
        }
      }
      const i = escolherVariacao(p, this.aleatorio)
      const v = p.variacoes[i]!
      const envio: EnvioGrupo = v.midia
        ? { tipo: 'midia', midia: v.midia, legenda: v.texto, ...(mencoes ? { mencoes } : {}) }
        : { tipo: 'texto', texto: v.texto ?? '', ...(mencoes ? { mencoes } : {}) }
      const agora = this.relogio()
      this.d.repo.transacao(() => {
        this.d.grupos.enfileirarSaida(numeroId, p.jid, JSON.stringify(envio), agora, agora + sortear(0, ESPALHAR_MS, this.aleatorio))
        // Uma vez só: encerra depois do último horário do dia marcado.
        this.d.bots.marcarEnvio(p.id, slot, i, p.data !== null && slot >= instanteBR(p.data, p.horarios.at(-1)!))
      })
      n++
    }
    return n
  }
}
