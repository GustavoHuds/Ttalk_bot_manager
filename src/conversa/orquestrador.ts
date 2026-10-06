import type { Logger } from 'pino'
import { ArmazemArquivos, ErroAssinatura } from '../arquivos.js'
import type { ConfigCarregada } from '../config/tipos.js'
import type { NovoArquivo, Repositorio } from '../db/repositorio.js'
import { processar } from './motor.js'
import { renderizar } from './textos.js'
import type { Acao, Contexto, Entrada } from './tipos.js'

/** Mensagem recebida como o adaptador entrega ao orquestrador. */
export interface MensagemRecebida {
  id: string
  /** Chat para onde a resposta vai (pode ser @lid). */
  jid: string
  /** 55 + DDD + número, quando a conexão souber. */
  telefone: string | null
  lid: string | null
  recebidaEm: number
  entrada: Entrada
  /** Mensagem original serializada, só para baixar mídia. */
  bruto?: string
}

/** Conteúdo de um item da caixa de saída. */
export type Envio = { tipo: 'texto'; texto: string } | { tipo: 'enquete'; chave: string; pergunta: string; opcoes: string[] }

export interface DependenciasOrquestrador {
  repo: Repositorio
  config: () => ConfigCarregada
  baixarMidia: (bruto: string) => Promise<Buffer>
  armazem: ArmazemArquivos
  log: Logger
  relogio?: () => number
  aleatorio?: () => number
  /** Avisado quando há algo novo na caixa de saída. */
  aoEnfileirar?: () => void
}

const MAX_TENTATIVAS = 3

/**
 * Liga a caixa de entrada ao motor. Cada contato tem sua própria fila, então
 * mensagens da mesma pessoa são tratadas em ordem e pessoas diferentes não esperam umas pelas outras.
 */
export class Orquestrador {
  private filas = new Map<string, Promise<void>>()
  private readonly relogio: () => number
  private readonly aleatorio: () => number

  constructor(private readonly d: DependenciasOrquestrador) {
    this.relogio = d.relogio ?? Date.now
    this.aleatorio = d.aleatorio ?? Math.random
  }

  /** Grava e enfileira. Devolve false se a mensagem já tinha sido recebida. */
  receber(m: MensagemRecebida): boolean {
    if (!this.d.repo.registrarRecebida(m.id, m.jid, m.recebidaEm, JSON.stringify(m))) return false
    if (m.telefone || m.lid) this.d.repo.completarIdentidade(m.jid, m.telefone, m.lid)
    this.agendar(m.jid, () => this.processarMensagem(m.id))
    return true
  }

  /** Reprocessa o que ficou pendente (queda do processo, erro temporário). */
  retomarPendentes(): void {
    for (const p of this.d.repo.pendentes()) this.agendar(p.jid, () => this.processarMensagem(p.id))
  }

  /** Fecha os lotes de arquivos cujo prazo de 60 s acabou. */
  verificarFinalizacoes(): void {
    for (const c of this.d.repo.paraFinalizar(this.relogio())) {
      this.agendar(c.jid, () => this.finalizarArquivos(c.id))
    }
  }

  /** Espera todas as filas esvaziarem (usado em testes e no desligamento). */
  async ocioso(): Promise<void> {
    while (this.filas.size > 0) await Promise.all([...this.filas.values()])
  }

  private agendar(jid: string, tarefa: () => Promise<void>): void {
    const anterior = this.filas.get(jid) ?? Promise.resolve()
    const proxima = anterior
      .then(tarefa)
      .catch((err) => this.d.log.error({ err }, 'falha inesperada na fila do contato'))
      .finally(() => {
        if (this.filas.get(jid) === proxima) this.filas.delete(jid)
      })
    this.filas.set(jid, proxima)
  }

  private async processarMensagem(id: string): Promise<void> {
    const pendente = this.d.repo.lerPendente(id)
    if (!pendente) return
    const m = JSON.parse(pendente.payload) as MensagemRecebida
    try {
      await this.executar(m.jid, m.entrada, m)
    } catch (err) {
      const desistir = pendente.tentativas + 1 >= MAX_TENTATIVAS
      this.d.log.error({ err, mensagem: id, desistir }, 'erro ao processar mensagem')
      this.d.repo.registrarFalha(id, desistir)
    }
  }

  private async finalizarArquivos(candidaturaId: number): Promise<void> {
    const ainda = this.d.repo.paraFinalizar(this.relogio()).find((c) => c.id === candidaturaId)
    if (!ainda) return
    try {
      await this.executar(ainda.jid, { tipo: 'finalizar_arquivos' })
    } catch (err) {
      this.d.log.error({ err, candidatura: candidaturaId }, 'erro ao finalizar arquivos')
    }
  }

  private contexto(jid: string, telefone: string | null): Contexto {
    const config = this.d.config()
    const conversa = this.d.repo.conversa(jid)
    const candidaturas = this.d.repo.candidaturasDoContato(jid)
    return {
      agora: this.relogio(),
      processos: config.processos,
      padrao: config.padrao,
      empresa: config.empresa,
      estado: conversa?.estado ?? null,
      ativaId: conversa?.candidaturaId ?? null,
      candidaturas,
      telefone: telefone ?? candidaturas.find((c) => c.telefone)?.telefone ?? null,
      aleatorio: this.aleatorio
    }
  }

  private async executar(jid: string, entrada: Entrada, m?: MensagemRecebida): Promise<void> {
    const ctx = this.contexto(jid, m?.telefone ?? null)
    const acoes = processar(ctx, entrada)
    const agora = ctx.agora

    // O download acontece antes de qualquer gravação: se falhar, nada muda e o candidato reenvia.
    let baixado: NovoArquivo | null = null
    const guardar = acoes.find((a): a is Extract<Acao, { tipo: 'guardar_arquivo' }> => a.tipo === 'guardar_arquivo')
    if (guardar && entrada.tipo === 'arquivo') {
      // A candidatura pode estar sendo criada agora (currículo como primeira mensagem).
      const criada = acoes.find((a): a is Extract<Acao, { tipo: 'criar_candidatura' }> => a.tipo === 'criar_candidatura')
      const focada = acoes.find((a): a is Extract<Acao, { tipo: 'focar' }> => a.tipo === 'focar')
      const processo =
        criada?.processo ?? ctx.candidaturas.find((c) => c.id === (focada?.candidaturaId ?? ctx.ativaId))?.processo
      try {
        if (!m?.bruto || !processo) throw new Error('mensagem sem mídia')
        const dados = await this.d.baixarMidia(m.bruto)
        baixado = await this.d.armazem.salvar(processo, guardar.ext, entrada.mimetype, dados, agora)
      } catch (err) {
        const chave = err instanceof ErroAssinatura ? 'formato_nao_aceito' : 'erro_download'
        this.d.log.warn({ err: err instanceof ErroAssinatura ? err.message : err, mensagem: m?.id }, 'arquivo não recebido')
        this.d.repo.transacao(() => {
          this.enfileirar(jid, { tipo: 'texto', texto: this.texto(ctx, chave) }, agora)
          if (m) this.d.repo.marcarProcessada(m.id)
        })
        this.d.aoEnfileirar?.()
        return
      }
    }

    const apagar: string[] = []
    try {
      this.d.repo.transacao(() => {
        let foco = ctx.ativaId
        const r = this.d.repo
        for (const a of acoes) {
          switch (a.tipo) {
            case 'enviar':
              this.enfileirar(jid, { tipo: 'texto', texto: a.texto }, agora)
              break
            case 'enquete':
              this.enfileirar(jid, { tipo: 'enquete', chave: a.chave, pergunta: a.pergunta, opcoes: a.opcoes }, agora)
              break
            case 'estado':
              r.definirEstado(jid, a.estado)
              break
            case 'criar_candidatura':
              foco = r.criarCandidatura(a.processo, jid, m?.telefone ?? null, m?.lid ?? null, agora)
              r.focar(jid, foco)
              break
            case 'focar':
              foco = a.candidaturaId
              r.focar(jid, foco)
              break
            case 'excluir_dados':
              apagar.push(...r.excluirDadosDoContato(jid, ctx.telefone))
              r.auditar('candidato', 'exclusao_a_pedido', null, agora)
              foco = null
              break
            default:
              if (foco === null) throw new Error(`ação ${a.tipo} sem candidatura em foco`)
              this.aplicarNaCandidatura(foco, a, agora, baixado, apagar)
          }
        }
        if (m) r.marcarProcessada(m.id)
      })
    } catch (err) {
      if (baixado) await this.d.armazem.apagar(baixado.caminho)
      throw err
    }

    for (const caminho of apagar) {
      await this.d.armazem.apagar(caminho).catch((err) => this.d.log.error({ err }, 'falha ao apagar arquivo'))
    }
    this.d.aoEnfileirar?.()
  }

  private aplicarNaCandidatura(id: number, a: Acao, agora: number, baixado: NovoArquivo | null, apagar: string[]): void {
    const r = this.d.repo
    switch (a.tipo) {
      case 'passo':
        return r.definirPasso(id, a.passo, agora)
      case 'resposta':
        return r.salvarResposta(id, a.chave, a.valor, agora)
      case 'guardar_arquivo':
        if (!baixado) throw new Error('arquivo não baixado')
        return r.registrarArquivo(id, baixado, agora)
      case 'agendar_finalizacao':
        return r.agendarFinalizacao(id, a.em)
      case 'cancelar_finalizacao':
        return r.agendarFinalizacao(id, null)
      case 'telefone':
        return r.definirTelefone(id, a.telefone)
      case 'concluir':
        return r.concluir(id, agora)
      case 'novo_lote':
        return r.novoLote(id)
      case 'descartar_lotes_antigos':
        apagar.push(...r.descartarLotesAntigos(id))
        return
      case 'interacao':
        return r.registrarInteracao(id, agora)
      default:
        throw new Error(`ação inesperada: ${a.tipo}`)
    }
  }

  private enfileirar(jid: string, envio: Envio, agora: number): void {
    this.d.repo.enfileirarSaida(jid, JSON.stringify(envio), agora)
  }

  /** Texto de erro fora do motor, com as mensagens do processo em foco. */
  private texto(ctx: Contexto, chave: string): string {
    const ativa = ctx.candidaturas.find((c) => c.id === ctx.ativaId)
    const p = ativa && ctx.processos.find((x) => x.codigo === ativa.processo)
    return renderizar(p ? p.mensagens : ctx.padrao, chave, { vaga: p?.vaga, empresa: ctx.empresa }, this.aleatorio)
  }
}
