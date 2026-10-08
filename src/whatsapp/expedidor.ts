import type { Logger } from 'pino'
import type { Envio } from '../conversa/orquestrador.js'
import type { Repositorio } from '../db/repositorio.js'
import { LimitePorMinuto, duracaoDigitando, sortear } from './limite.js'

/** O que o expedidor precisa de uma conexão de WhatsApp (Baileys hoje, outra amanhã). */
export interface ConexaoEnvio {
  pronta(): boolean
  presenca(jid: string, estado: 'composing' | 'paused'): Promise<void>
  enviarTexto(jid: string, texto: string): Promise<void>
  enviarEnquete(jid: string, chave: string, pergunta: string, opcoes: string[]): Promise<void>
}

export interface OpcoesExpedidor {
  numeroId: number
  repo: Repositorio
  conexao: ConexaoEnvio
  log: Logger
  /** Só responde se o contato escreveu dentro desta janela. */
  janelaMs: number
  /** Intervalo mínimo entre mensagens da mesma conversa; o real é sorteado entre ele e o dobro. */
  intervaloPorConversaMs?: number
  limitePorMinuto?: number
  limitePorHora?: number
  /** Pausado: nada sai (o número continua conectado). */
  pausado?: () => boolean
  relogio?: () => number
  esperar?: (ms: number) => Promise<void>
  aleatorio?: () => number
}

const MAX_TENTATIVAS = 5

/**
 * Esvazia a caixa de saída imitando um atendente: marca "digitando" pelo tempo que o texto levaria
 * para ser digitado (sorteado), para de digitar, envia; entre mensagens da mesma conversa espera de
 * 1,5 a 3 s (sorteado); no máximo 20 envios por minuto e 300 por hora por número.
 */
export class Expedidor {
  private ativos = new Set<string>()
  private ultimoPorJid = new Map<string, number>()
  private timer: NodeJS.Timeout | null = null
  private parado = false
  private readonly relogio: () => number
  private readonly esperar: (ms: number) => Promise<void>
  private readonly intervalo: number
  private readonly limite: LimitePorMinuto
  private readonly limiteHora: LimitePorMinuto
  private readonly aleatorio: () => number

  constructor(private readonly o: OpcoesExpedidor) {
    this.relogio = o.relogio ?? Date.now
    this.esperar = o.esperar ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.aleatorio = o.aleatorio ?? Math.random
    this.intervalo = o.intervaloPorConversaMs ?? 1500
    this.limite = new LimitePorMinuto(o.limitePorMinuto ?? 20, this.relogio, this.esperar)
    this.limiteHora = new LimitePorMinuto(o.limitePorHora ?? 300, this.relogio, this.esperar, 60 * 60_000)
  }

  /** Parado, pausado ou sem conexão: nada sai agora. */
  private travado(): boolean {
    return this.parado || !!this.o.pausado?.() || !this.o.conexao.pronta()
  }

  iniciar(): void {
    if (this.timer) return
    this.parado = false
    this.timer = setInterval(() => void this.acordar(), 1000)
  }

  parar(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.parado = true
  }

  /** Começa a drenar as conversas com mensagens prontas. Nunca rejeita. */
  async acordar(): Promise<void> {
    try {
      if (this.travado()) return
      const novas = this.o.repo.jidsComSaida(this.o.numeroId, this.relogio()).filter((j) => !this.ativos.has(j))
      await Promise.all(novas.map((jid) => this.drenar(jid)))
    } catch (err) {
      this.o.log.error({ err, numero: this.o.numeroId }, 'falha ao acordar o expedidor')
    }
  }

  private async drenar(jid: string): Promise<void> {
    this.ativos.add(jid)
    try {
      for (;;) {
        if (this.travado()) return
        const item = this.o.repo.proximaSaida(this.o.numeroId, jid)
        if (!item || item.proximaEm > this.relogio()) return

        const conversa = this.o.repo.conversa(this.o.numeroId, jid)
        if (!conversa || this.relogio() - conversa.ultimaRecebida > this.o.janelaMs) {
          // Nunca iniciar conversa: resposta atrasada demais é descartada.
          this.o.log.warn({ saida: item.id }, 'resposta fora da janela descartada')
          this.o.repo.removerSaida(item.id)
          continue
        }

        await this.limiteHora.reservar()
        await this.limite.reservar()
        // A espera pela vaga pode ser longa; se a conexão caiu nesse meio-tempo, não envia.
        if (this.travado()) return
        try {
          const envio = JSON.parse(item.conteudo) as Envio
          const falta = (this.ultimoPorJid.get(jid) ?? 0) + sortear(this.intervalo, this.intervalo * 2, this.aleatorio) - this.relogio()
          if (falta > 0) await this.esperar(falta)
          await this.o.conexao.presenca(jid, 'composing')
          await this.esperar(duracaoDigitando(envio.tipo === 'texto' ? envio.texto : envio.pergunta, this.aleatorio))
          await this.o.conexao.presenca(jid, 'paused').catch(() => undefined)
          if (envio.tipo === 'texto') await this.o.conexao.enviarTexto(jid, envio.texto)
          else await this.o.conexao.enviarEnquete(jid, envio.chave, envio.pergunta, envio.opcoes)
          this.ultimoPorJid.set(jid, this.relogio())
          this.o.repo.removerSaida(item.id)
        } catch (err) {
          // Caiu durante o próprio envio: não é falha da mensagem, não gasta tentativa.
          if (!this.o.conexao.pronta()) return
          if (item.tentativas + 1 >= MAX_TENTATIVAS) {
            this.o.log.error({ err, saida: item.id }, 'envio abandonado após várias tentativas')
            this.o.repo.removerSaida(item.id)
          } else {
            const espera = 5000 * 2 ** item.tentativas
            this.o.log.warn({ err, saida: item.id, espera }, 'falha no envio, nova tentativa agendada')
            this.o.repo.adiarSaida(item.id, this.relogio() + espera)
          }
          return
        }
      }
    } finally {
      this.ativos.delete(jid)
      this.limparMapa()
    }
  }

  private limparMapa(): void {
    const corte = this.relogio() - 60_000
    for (const [jid, t] of this.ultimoPorJid) if (t < corte) this.ultimoPorJid.delete(jid)
  }
}
