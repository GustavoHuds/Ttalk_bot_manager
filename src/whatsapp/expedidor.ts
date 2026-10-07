import type { Logger } from 'pino'
import type { Envio } from '../conversa/orquestrador.js'
import type { Repositorio } from '../db/repositorio.js'
import { LimitePorMinuto } from './limite.js'

/** O que o expedidor precisa de uma conexão de WhatsApp (Baileys hoje, outra amanhã). */
export interface ConexaoEnvio {
  pronta(): boolean
  digitando(jid: string): Promise<void>
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
  intervaloPorConversaMs?: number
  limitePorMinuto?: number
  relogio?: () => number
  esperar?: (ms: number) => Promise<void>
}

const MAX_TENTATIVAS = 5

/** "Digitando..." proporcional ao texto, entre 1 e 4 segundos. */
export function duracaoDigitando(texto: string): number {
  return Math.min(4000, Math.max(1000, texto.length * 35))
}

/**
 * Esvazia a caixa de saída imitando um atendente: marca "digitando", respeita
 * 1,5 s entre mensagens da mesma conversa e no máximo 20 envios por minuto por número.
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

  constructor(private readonly o: OpcoesExpedidor) {
    this.relogio = o.relogio ?? Date.now
    this.esperar = o.esperar ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.intervalo = o.intervaloPorConversaMs ?? 1500
    this.limite = new LimitePorMinuto(o.limitePorMinuto ?? 20, this.relogio, this.esperar)
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
      if (this.parado || !this.o.conexao.pronta()) return
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
        if (this.parado || !this.o.conexao.pronta()) return
        const item = this.o.repo.proximaSaida(this.o.numeroId, jid)
        if (!item || item.proximaEm > this.relogio()) return

        const conversa = this.o.repo.conversa(this.o.numeroId, jid)
        if (!conversa || this.relogio() - conversa.ultimaRecebida > this.o.janelaMs) {
          // Nunca iniciar conversa: resposta atrasada demais é descartada.
          this.o.log.warn({ saida: item.id }, 'resposta fora da janela descartada')
          this.o.repo.removerSaida(item.id)
          continue
        }

        await this.limite.reservar()
        // A espera pela vaga pode ser longa; se a conexão caiu nesse meio-tempo, não envia.
        if (this.parado || !this.o.conexao.pronta()) return
        try {
          const envio = JSON.parse(item.conteudo) as Envio
          await this.o.conexao.digitando(jid)
          await this.esperar(duracaoDigitando(envio.tipo === 'texto' ? envio.texto : envio.pergunta))
          const falta = (this.ultimoPorJid.get(jid) ?? 0) + this.intervalo - this.relogio()
          if (falta > 0) await this.esperar(falta)
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
