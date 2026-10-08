import type { Logger } from 'pino'
import type { ArmazemArquivos } from '../arquivos.js'
import type { RepoGrupos } from '../db/grupos.js'
import { LimitePorMinuto, duracaoDigitando, sortear } from '../whatsapp/limite.js'
import type { ConexaoGrupos, EnvioGrupo } from './tipos.js'

export interface OpcoesExpedidorGrupos {
  numeroId: number
  grupos: RepoGrupos
  armazem: ArmazemArquivos
  conexao: ConexaoGrupos
  log: Logger
  /** Intervalo mínimo entre mensagens do mesmo chat; o real é sorteado entre ele e mais 4 s. */
  intervaloPorChatMs?: number
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
 * Item que ficou parado na fila (número desconectado, reenvios) por mais que isto já não faz sentido no
 * grupo: é descartado em vez de chegar fora de contexto.
 */
export const VALIDADE_SAIDA_GRUPO_MS = 30 * 60_000

/**
 * Esvazia a caixa de saída de um número de grupos com ritmo de gente: "digitando" pelo tempo que o
 * texto levaria (sorteado), "parou", envia; de 3 a 7 s entre mensagens do mesmo chat; no máximo 12 por
 * minuto e 200 por hora no número. Remover, fechar e apagar não "digitam", mas também esperam a vez.
 */
export class ExpedidorGrupos {
  private ativos = new Set<string>()
  private ultimoPorJid = new Map<string, number>()
  private timer: NodeJS.Timeout | null = null
  private parado = false
  private readonly relogio: () => number
  private readonly esperar: (ms: number) => Promise<void>
  private readonly aleatorio: () => number
  private readonly intervalo: number
  private readonly limite: LimitePorMinuto
  private readonly limiteHora: LimitePorMinuto

  constructor(private readonly o: OpcoesExpedidorGrupos) {
    this.relogio = o.relogio ?? Date.now
    this.esperar = o.esperar ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.aleatorio = o.aleatorio ?? Math.random
    this.intervalo = o.intervaloPorChatMs ?? 3000
    this.limite = new LimitePorMinuto(o.limitePorMinuto ?? 12, this.relogio, this.esperar)
    this.limiteHora = new LimitePorMinuto(o.limitePorHora ?? 200, this.relogio, this.esperar, 60 * 60_000)
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

  /** Parado, pausado ou sem conexão: nada sai agora. */
  private travado(): boolean {
    return this.parado || !!this.o.pausado?.() || !this.o.conexao.pronta()
  }

  /** Nunca rejeita: uma linha ruim ou qualquer outro erro ao acordar só vai para o log. */
  async acordar(): Promise<void> {
    try {
      if (this.travado()) return
      const novos = this.o.grupos.jidsComSaida(this.o.numeroId, this.relogio()).filter((j) => !this.ativos.has(j))
      await Promise.all(novos.map((jid) => this.drenar(jid)))
    } catch (err) {
      this.o.log.error({ err, numero: this.o.numeroId }, 'falha ao acordar o expedidor de grupos')
    }
  }

  /** Mídia mandada pelo privado é apagada depois de sair (ou de desistir dela). */
  private async descartar(envio: EnvioGrupo | null): Promise<void> {
    if (envio?.tipo === 'midia' && envio.temporaria) await this.o.armazem.apagar(envio.midia.caminho).catch(() => undefined)
  }

  private async executar(jid: string, envio: EnvioGrupo): Promise<void> {
    const c = this.o.conexao
    switch (envio.tipo) {
      case 'texto':
        await c.presenca(jid, 'composing')
        await this.esperar(duracaoDigitando(envio.texto, this.aleatorio))
        await c.presenca(jid, 'paused').catch(() => undefined)
        return c.enviarTexto(jid, envio.texto, envio.mencoes)
      case 'midia': {
        const dados = await this.o.armazem.ler(envio.midia.caminho)
        await c.presenca(jid, envio.midia.tipo === 'audio' ? 'recording' : 'composing')
        await this.esperar(duracaoDigitando(envio.legenda ?? '', this.aleatorio) + sortear(500, 1500, this.aleatorio))
        await c.presenca(jid, 'paused').catch(() => undefined)
        return c.enviarMidia(jid, envio.midia, dados, envio.legenda, envio.mencoes)
      }
      case 'remover':
        return c.removerParticipantes(jid, envio.participantes)
      case 'fechar':
        return c.fecharGrupo(jid, envio.fechado)
      case 'apagar':
        return c.apagar(envio.chave)
    }
  }

  private async drenar(jid: string): Promise<void> {
    this.ativos.add(jid)
    try {
      for (;;) {
        if (this.travado()) return
        const item = this.o.grupos.proximaSaida(this.o.numeroId, jid)
        if (!item || item.proximaEm > this.relogio()) return
        let envio: EnvioGrupo | null = null
        try {
          envio = JSON.parse(item.conteudo) as EnvioGrupo
        } catch {
          envio = null
        }
        if (!envio || this.relogio() - Math.max(item.criadaEm, item.proximaEm) > VALIDADE_SAIDA_GRUPO_MS) {
          this.o.log.warn({ saida: item.id, numero: this.o.numeroId }, 'item da fila do grupo descartado: inválido ou velho demais')
          this.o.grupos.removerSaida(item.id)
          await this.descartar(envio)
          continue
        }
        const conversa = envio.tipo === 'texto' || envio.tipo === 'midia'
        await this.limiteHora.reservar()
        await this.limite.reservar()
        // A espera pela vaga pode ser longa; se a conexão caiu nesse meio-tempo, não envia.
        if (this.travado()) return
        try {
          const pausa = conversa ? sortear(this.intervalo, this.intervalo + 4000, this.aleatorio) : sortear(800, 2500, this.aleatorio)
          const falta = (this.ultimoPorJid.get(jid) ?? 0) + pausa - this.relogio()
          if (falta > 0) await this.esperar(falta)
          await this.executar(jid, envio)
          this.ultimoPorJid.set(jid, this.relogio())
          this.o.grupos.removerSaida(item.id)
          await this.descartar(envio)
        } catch (err) {
          // Caiu durante o próprio envio: não é falha do item, não gasta tentativa.
          if (!this.o.conexao.pronta()) return
          if (item.tentativas + 1 >= MAX_TENTATIVAS) {
            this.o.log.error({ err, saida: item.id, numero: this.o.numeroId }, 'envio ao grupo abandonado após várias tentativas')
            this.o.grupos.removerSaida(item.id)
            await this.descartar(envio)
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
