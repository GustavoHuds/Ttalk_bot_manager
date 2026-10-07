import type { Logger } from 'pino'
import type { RepoGrupos } from '../db/grupos.js'
import { LimitePorMinuto } from '../whatsapp/limite.js'
import type { ConexaoGrupos, EnvioGrupo } from './tipos.js'

export interface OpcoesExpedidorGrupos {
  numeroId: number
  grupos: RepoGrupos
  conexao: ConexaoGrupos
  log: Logger
  intervaloPorChatMs?: number
  limitePorMinuto?: number
  relogio?: () => number
  esperar?: (ms: number) => Promise<void>
}

const MAX_TENTATIVAS = 5

/**
 * Resposta a comando que ficou parada na fila (número desconectado, reenvios) por mais que isto
 * já não faz sentido no grupo: é descartada em vez de chegar fora de contexto.
 */
export const VALIDADE_SAIDA_GRUPO_MS = 30 * 60_000

/** "Digitando..." curto: entre 1 e 2 segundos. */
export function duracaoDigitandoGrupo(texto: string): number {
  return Math.min(2000, Math.max(1000, texto.length * 20))
}

/**
 * Esvazia a caixa de saída de um número de grupos. Sem a regra de janela do recrutamento
 * (o bot de grupos responde a comandos e, depois, publica avisos), mas com ritmo mais lento:
 * 3 s ou mais entre mensagens do mesmo chat e no máximo 10 por minuto no número.
 */
export class ExpedidorGrupos {
  private ativos = new Set<string>()
  private ultimoPorJid = new Map<string, number>()
  private timer: NodeJS.Timeout | null = null
  private parado = false
  private readonly relogio: () => number
  private readonly esperar: (ms: number) => Promise<void>
  private readonly intervalo: number
  private readonly limite: LimitePorMinuto

  constructor(private readonly o: OpcoesExpedidorGrupos) {
    this.relogio = o.relogio ?? Date.now
    this.esperar = o.esperar ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.intervalo = o.intervaloPorChatMs ?? 3000
    this.limite = new LimitePorMinuto(o.limitePorMinuto ?? 10, this.relogio, this.esperar)
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

  /** Nunca rejeita: uma linha ruim ou qualquer outro erro ao acordar só vai para o log. */
  async acordar(): Promise<void> {
    try {
      if (this.parado || !this.o.conexao.pronta()) return
      const novos = this.o.grupos.jidsComSaida(this.o.numeroId, this.relogio()).filter((j) => !this.ativos.has(j))
      await Promise.all(novos.map((jid) => this.drenar(jid)))
    } catch (err) {
      this.o.log.error({ err, numero: this.o.numeroId }, 'falha ao acordar o expedidor de grupos')
    }
  }

  private async drenar(jid: string): Promise<void> {
    this.ativos.add(jid)
    try {
      for (;;) {
        if (this.parado || !this.o.conexao.pronta()) return
        const item = this.o.grupos.proximaSaida(this.o.numeroId, jid)
        if (!item || item.proximaEm > this.relogio()) return
        if (this.relogio() - item.criadaEm > VALIDADE_SAIDA_GRUPO_MS) {
          this.o.log.warn({ saida: item.id, numero: this.o.numeroId }, 'mensagem ao grupo descartada: ficou tempo demais na fila')
          this.o.grupos.removerSaida(item.id)
          continue
        }
        await this.limite.reservar()
        // A espera pela vaga pode ser longa; se a conexão caiu nesse meio-tempo, não envia.
        if (this.parado || !this.o.conexao.pronta()) return
        try {
          const envio = JSON.parse(item.conteudo) as EnvioGrupo
          await this.o.conexao.digitando(jid)
          await this.esperar(duracaoDigitandoGrupo(envio.texto))
          const falta = (this.ultimoPorJid.get(jid) ?? 0) + this.intervalo - this.relogio()
          if (falta > 0) await this.esperar(falta)
          await this.o.conexao.enviarTexto(jid, envio.texto, envio.mencoes)
          this.ultimoPorJid.set(jid, this.relogio())
          this.o.grupos.removerSaida(item.id)
        } catch (err) {
          // Caiu durante o próprio envio: não é falha da mensagem, não gasta tentativa.
          if (!this.o.conexao.pronta()) return
          if (item.tentativas + 1 >= MAX_TENTATIVAS) {
            this.o.log.error({ err, saida: item.id, numero: this.o.numeroId }, 'envio ao grupo abandonado após várias tentativas')
            this.o.grupos.removerSaida(item.id)
          } else {
            const espera = 5000 * 2 ** item.tentativas
            this.o.log.warn({ err, saida: item.id, numero: this.o.numeroId, espera }, 'falha no envio ao grupo, nova tentativa agendada')
            this.o.grupos.adiarSaida(item.id, this.relogio() + espera)
          }
          return
        }
      }
    } finally {
      this.ativos.delete(jid)
      const corte = this.relogio() - 60_000
      for (const [j, t] of this.ultimoPorJid) if (t < corte) this.ultimoPorJid.delete(j)
    }
  }
}
