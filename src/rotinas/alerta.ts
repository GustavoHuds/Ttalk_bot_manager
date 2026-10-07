import nodemailer from 'nodemailer'
import type { Logger } from 'pino'

export interface ConfigAlerta {
  smtpUrl?: string | undefined
  de?: string | undefined
  para?: string | undefined
}

/** Envia e-mail de alerta. Sem SMTP configurado, só registra no log. */
export class Alertas {
  private readonly transporte

  constructor(
    private readonly c: ConfigAlerta,
    private readonly log: Logger
  ) {
    this.transporte = c.smtpUrl && c.para ? nodemailer.createTransport(c.smtpUrl) : null
  }

  get ativo(): boolean {
    return this.transporte !== null
  }

  async enviar(assunto: string, texto: string): Promise<void> {
    this.log.warn({ assunto }, 'alerta')
    if (!this.transporte) return
    try {
      await this.transporte.sendMail({ from: this.c.de ?? this.c.para, to: this.c.para, subject: `[Ttalk] ${assunto}`, text: texto })
    } catch (err) {
      this.log.error({ err }, 'falha ao enviar e-mail de alerta')
    }
  }
}

const LIMITE_QUEDA_MS = 10 * 60 * 1000

/**
 * Observa a conexão: avisa quando fica fora por mais de 10 min ou quando a sessão
 * é encerrada, e avisa de novo quando volta.
 */
export class VigiaConexao {
  private avisado = false

  constructor(
    private readonly alertas: Alertas,
    private readonly relogio: () => number = Date.now,
    /** Nome do número, quando há mais de um. */
    private readonly nome: string | null = null
  ) {}

  private assunto(a: string): string {
    return this.nome ? `${a} (${this.nome})` : a
  }

  verificar(e: { status: string; desde: number; motivo: string | null }): void {
    if (e.status === 'conectado') {
      if (this.avisado) {
        this.avisado = false
        void this.alertas.enviar(this.assunto('Conexão restabelecida'), 'O bot voltou a se conectar ao WhatsApp.')
      }
      return
    }
    if (this.avisado) return
    if (e.status === 'desconectado' && e.motivo) {
      this.avisado = true
      void this.alertas.enviar(
        this.assunto('Sessão do WhatsApp encerrada'),
        `O bot parou: ${e.motivo}.\nAbra a página Números do painel e leia o QR de novo com o celular deste número.`
      )
      return
    }
    if (this.relogio() - e.desde > LIMITE_QUEDA_MS) {
      this.avisado = true
      const situacao = e.status === 'aguardando_qr' ? 'aguardando leitura do QR' : 'sem conexão'
      void this.alertas.enviar(this.assunto('Bot fora do ar há mais de 10 minutos'), `Situação: ${situacao}. Confira a página /saude do painel.`)
    }
  }
}
