import { situacao } from '../config/carregar.js'
import type { FormatoArquivo, Pergunta, Processo } from '../config/tipos.js'
import { casarOpcao, listaNumerada, primeiroNome, renderizar, semAcento } from './textos.js'
import {
  CHAVE_VAGA,
  PASSO_FIM,
  PASSO_SUBSTITUINDO,
  PASSO_TELEFONE,
  type Acao,
  type CandidaturaVista,
  type Contexto,
  type Entrada
} from './tipos.js'

export const ESPERA_ARQUIVOS_MS = 60_000
export const PAUSA_RETOMADA_MS = 24 * 60 * 60 * 1000
const MAX_TEXTO = 500

const REGEX_CODIGO = /\[\s*([A-Za-z0-9][A-Za-z0-9-]{1,30})\s*\]/
const REGEX_EXCLUSAO = /\b(excluir|apagar|deletar|remover)\s+(os\s+)?meus\s+dados\b/

export function extrairCodigo(texto: string): string | null {
  return REGEX_CODIGO.exec(texto)?.[1]?.toUpperCase() ?? null
}

export function pedeExclusao(texto: string): boolean {
  return REGEX_EXCLUSAO.test(semAcento(texto))
}

export function nomeCompletoValido(texto: string): boolean {
  const partes = texto.trim().split(/\s+/).filter((p) => /\p{L}{2,}/u.test(p))
  return partes.length >= 2 && texto.length <= 120 && !/\d/.test(texto)
}

/** Devolve só os dígitos, com DDD e sem o 55, ou null se não parecer telefone brasileiro. */
export function normalizarTelefone(texto: string): string | null {
  let d = texto.replace(/\D/g, '')
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2)
  if (d.length === 10 || d.length === 11) return `55${d}`
  return null
}

export function formatoDoArquivo(mimetype: string, nome: string | null): FormatoArquivo | null {
  const porTipo: Record<string, FormatoArquivo> = {
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/msword': 'doc',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png'
  }
  const tipo = porTipo[mimetype.split(';')[0]!.trim().toLowerCase()]
  if (tipo) return tipo
  const ext = /\.([a-z0-9]+)$/i.exec(nome ?? '')?.[1]?.toLowerCase()
  const porExt: Record<string, FormatoArquivo> = { pdf: 'pdf', docx: 'docx', doc: 'doc', jpg: 'jpg', jpeg: 'jpg', png: 'png' }
  return ext ? (porExt[ext] ?? null) : null
}

/**
 * Decide o que fazer com uma mensagem. Não faz nada sozinho: devolve as ações
 * para o orquestrador gravar e enviar. Assim a regra inteira fica testável sem WhatsApp.
 */
export function processar(ctx: Contexto, entrada: Entrada): Acao[] {
  return new Motor(ctx).processar(entrada)
}

class Motor {
  private acoes: Acao[] = []

  constructor(private readonly ctx: Contexto) {}

  processar(e: Entrada): Acao[] {
    const texto = e.tipo === 'texto' ? e.texto : null

    if (this.ctx.estado?.tipo === 'confirmar_exclusao' && e.tipo !== 'finalizar_arquivos') {
      this.acoes.push({ tipo: 'estado', estado: null })
      if (texto !== null && /^sim\b/.test(semAcento(texto))) {
        this.acoes.push({ tipo: 'excluir_dados' })
        this.enviarPadrao('dados_excluidos')
        return this.acoes
      }
      this.enviarPadrao('exclusao_cancelada')
      const ativa = this.ativa()
      const p = ativa && this.processo(ativa.processo)
      if (ativa && p && ativa.status === 'em_andamento') this.perguntar(p, ativa, ativa.passo)
      return this.acoes
    }

    if (texto !== null && pedeExclusao(texto)) {
      if (this.ctx.candidaturas.length === 0) {
        this.enviarPadrao('sem_dados')
      } else {
        this.acoes.push({ tipo: 'estado', estado: { tipo: 'confirmar_exclusao' } })
        this.enviarPadrao('confirmar_exclusao')
      }
      return this.acoes
    }

    const codigo = texto !== null ? extrairCodigo(texto) : null
    if (codigo) {
      const p = this.ctx.processos.find((x) => x.codigo === codigo && x.status !== 'rascunho')
      if (p) return this.entrarNoProcesso(p)
    }

    if (this.ctx.estado?.tipo === 'escolher_vaga') return this.escolherVaga(e)

    const ativa = this.ativa()
    const p = ativa && this.processo(ativa.processo)
    if (ativa && p) {
      if (ativa.status === 'concluida') return this.concluida(p, ativa, e)
      if (e.tipo === 'finalizar_arquivos') return this.emAndamento(p, ativa, e)
      if (situacao(p, this.ctx.agora) !== 'aberto') {
        this.enviar(p, ativa, 'processo_encerrado')
        return this.acoes
      }
      return this.emAndamento(p, ativa, e)
    }

    // Sem candidatura em foco: só uma mensagem real inicia algo.
    if (e.tipo === 'finalizar_arquivos' || e.tipo === 'voto') return this.acoes
    const abertos = this.ctx.processos.filter((x) => situacao(x, this.ctx.agora) === 'aberto')
    if (abertos.length === 0) this.enviarPadrao('sem_processos')
    else if (abertos.length === 1) return this.entrarNoProcesso(abertos[0]!, e)
    else this.oferecerVagas(abertos)
    return this.acoes
  }

  // --- entrada num processo ---------------------------------------------------

  private entrarNoProcesso(p: Processo, e?: Entrada): Acao[] {
    if (this.ctx.estado) this.acoes.push({ tipo: 'estado', estado: null })
    const existente = this.ctx.candidaturas.find((c) => c.processo === p.codigo)

    if (existente) {
      this.acoes.push({ tipo: 'focar', candidaturaId: existente.id })
      if (existente.status === 'concluida') {
        this.enviar(p, existente, 'ja_concluiu')
      } else if (situacao(p, this.ctx.agora) !== 'aberto') {
        this.enviar(p, existente, 'processo_encerrado')
      } else {
        this.acoes.push({ tipo: 'interacao' })
        this.enviar(p, existente, 'retomada')
        this.perguntar(p, existente, existente.passo)
      }
      return this.acoes
    }

    if (situacao(p, this.ctx.agora) !== 'aberto') {
      this.enviar(p, null, 'processo_encerrado')
      return this.acoes
    }

    const primeira = p.perguntas[0]!
    this.acoes.push({ tipo: 'criar_candidatura', processo: p.codigo })
    this.acoes.push({ tipo: 'passo', passo: primeira.chave })
    this.enviar(p, null, 'boas_vindas')
    this.enviar(p, null, 'aviso_dados')
    // Contato direto que já chega mandando o currículo: guarda e segue com as perguntas.
    if (e?.tipo === 'arquivo') this.arquivoAntecipado(p, null, e)
    this.perguntar(p, null, primeira.chave)
    return this.acoes
  }

  private oferecerVagas(abertos: Processo[]): void {
    const rotulos = rotulosDeVaga(abertos)
    this.acoes.push({ tipo: 'estado', estado: { tipo: 'escolher_vaga', codigos: abertos.map((p) => p.codigo) } })
    this.acoes.push({ tipo: 'enquete', chave: CHAVE_VAGA, pergunta: this.textoPadrao('escolher_vaga'), opcoes: rotulos })
  }

  private escolherVaga(e: Entrada): Acao[] {
    if (this.ctx.estado?.tipo !== 'escolher_vaga') return this.acoes
    const candidatos = this.ctx.estado.codigos
      .map((c) => this.ctx.processos.find((p) => p.codigo === c))
      .filter((p): p is Processo => !!p)
    const rotulos = rotulosDeVaga(candidatos)

    let escolhido: string | null = null
    if (e.tipo === 'voto' && e.chave === CHAVE_VAGA) escolhido = e.opcoes[0] ?? null
    else if (e.tipo === 'texto') escolhido = casarOpcao(e.texto, rotulos)
    else if (e.tipo === 'finalizar_arquivos' || e.tipo === 'voto') return this.acoes

    const indice = escolhido ? rotulos.indexOf(escolhido) : -1
    if (indice < 0) {
      if (candidatos.length === 0) {
        this.acoes.push({ tipo: 'estado', estado: null })
        this.enviarPadrao('sem_processos')
      } else {
        this.acoes.push({
          tipo: 'enviar',
          texto: renderizar(this.ctx.padrao, 'opcao_invalida', { opcoes: listaNumerada(rotulos), empresa: this.ctx.empresa }, this.ctx.aleatorio)
        })
      }
      return this.acoes
    }
    return this.entrarNoProcesso(candidatos[indice]!)
  }

  // --- candidatura em andamento ----------------------------------------------

  private emAndamento(p: Processo, c: CandidaturaVista, e: Entrada): Acao[] {
    if (e.tipo === 'finalizar_arquivos') {
      const pergunta = p.perguntas.find((q) => q.chave === c.passo)
      if (pergunta?.tipo === 'arquivo' && c.arquivosNoLote > 0) this.avancar(p, c, c.passo, {})
      return this.acoes
    }

    if (e.tipo === 'texto' && this.ctx.agora - c.ultimaInteracao > PAUSA_RETOMADA_MS) {
      this.acoes.push({ tipo: 'interacao' })
      this.enviar(p, c, 'retomada')
      this.perguntar(p, c, c.passo)
      return this.acoes
    }

    if (e.tipo !== 'voto') this.acoes.push({ tipo: 'interacao' })

    if (e.tipo === 'nao_suportado') {
      this.enviar(p, c, 'midia_nao_suportada')
      return this.acoes
    }

    if (c.passo === PASSO_TELEFONE) {
      if (e.tipo === 'voto') return this.acoes
      if (e.tipo !== 'texto') {
        this.enviar(p, c, 'telefone_invalido')
        return this.acoes
      }
      const tel = normalizarTelefone(e.texto)
      if (!tel) this.enviar(p, c, 'telefone_invalido')
      else {
        this.acoes.push({ tipo: 'telefone', telefone: tel })
        this.concluir(p, c, {})
      }
      return this.acoes
    }

    const pergunta = p.perguntas.find((q) => q.chave === c.passo)
    if (!pergunta) {
      // O passo sumiu do YAML (pergunta removida): segue para a próxima ainda não respondida.
      const proxima = p.perguntas.find((q) => !this.respondida(q, c))
      if (proxima) {
        this.acoes.push({ tipo: 'passo', passo: proxima.chave })
        this.perguntar(p, c, proxima.chave)
      } else this.fecharCadastro(p, c, {})
      return this.acoes
    }

    if (e.tipo === 'arquivo' && pergunta.tipo !== 'arquivo') {
      this.arquivoAntecipado(p, c, e)
      this.perguntar(p, c, pergunta.chave)
      return this.acoes
    }

    switch (pergunta.tipo) {
      case 'texto':
        return this.respostaTexto(p, c, pergunta, e)
      case 'enquete':
        return this.respostaEnquete(p, c, pergunta, e)
      case 'arquivo':
        return this.respostaArquivo(p, c, pergunta, e, false)
    }
  }

  private respostaTexto(p: Processo, c: CandidaturaVista, pergunta: Extract<Pergunta, { tipo: 'texto' }>, e: Entrada): Acao[] {
    if (e.tipo === 'voto') return this.acoes
    if (e.tipo !== 'texto') {
      this.enviar(p, c, 'espera_texto')
      this.perguntar(p, c, pergunta.chave)
      return this.acoes
    }
    const valor = e.texto.trim().replace(/\s+/g, ' ')
    let valido = valor.length > 0 && valor.length <= MAX_TEXTO
    let erro = 'texto_invalido'
    let final = valor
    if (pergunta.validacao === 'nome_completo') {
      valido = nomeCompletoValido(valor)
      erro = 'nome_invalido'
    } else if (pergunta.validacao === 'telefone') {
      const tel = normalizarTelefone(valor)
      valido = tel !== null
      erro = 'telefone_invalido'
      final = tel ?? valor
    }
    if (!valido) {
      this.enviar(p, c, erro)
      return this.acoes
    }
    this.acoes.push({ tipo: 'resposta', chave: pergunta.chave, valor: final })
    this.avancar(p, c, pergunta.chave, { [pergunta.chave]: final })
    return this.acoes
  }

  private respostaEnquete(p: Processo, c: CandidaturaVista, pergunta: Extract<Pergunta, { tipo: 'enquete' }>, e: Entrada): Acao[] {
    let escolhido: string | null = null
    if (e.tipo === 'voto') {
      // Voto de outra enquete (antiga) ou voto retirado: ignora.
      if (e.chave !== pergunta.chave || e.opcoes.length === 0) return this.acoes
      escolhido = pergunta.opcoes.find((o) => o === e.opcoes[0]) ?? null
    } else if (e.tipo === 'texto') {
      escolhido = casarOpcao(e.texto, pergunta.opcoes)
    }
    if (!escolhido) {
      this.enviar(p, c, 'opcao_invalida', { opcoes: listaNumerada(pergunta.opcoes) })
      return this.acoes
    }
    this.acoes.push({ tipo: 'resposta', chave: pergunta.chave, valor: escolhido })
    this.avancar(p, c, pergunta.chave, { [pergunta.chave]: escolhido })
    return this.acoes
  }

  /** Recebe um arquivo e espera 60 s por outras páginas antes de seguir. */
  private respostaArquivo(
    p: Processo,
    c: CandidaturaVista,
    pergunta: Extract<Pergunta, { tipo: 'arquivo' }>,
    e: Entrada,
    substituindo: boolean
  ): Acao[] {
    if (e.tipo === 'voto') return this.acoes
    if (e.tipo !== 'arquivo') {
      // Texto depois de já ter mandado arquivo ("pronto", "segue"): o agendador fecha o lote.
      if (c.arquivosNoLote === 0) this.enviar(p, c, 'espera_arquivo')
      return this.acoes
    }
    const formato = formatoDoArquivo(e.mimetype, e.nomeArquivo)
    if (!formato || !pergunta.formatos.includes(formato)) {
      this.enviar(p, c, 'formato_nao_aceito')
      return this.acoes
    }
    if (e.tamanho !== null && e.tamanho > pergunta.tamanho_max_mb * 1024 * 1024) {
      this.enviar(p, c, 'arquivo_grande')
      return this.acoes
    }
    if (substituindo && c.passo !== PASSO_SUBSTITUINDO) {
      this.acoes.push({ tipo: 'novo_lote' }, { tipo: 'passo', passo: PASSO_SUBSTITUINDO })
    }
    this.acoes.push({ tipo: 'guardar_arquivo', ext: formato === 'jpg' ? 'jpg' : formato })
    this.acoes.push({ tipo: 'agendar_finalizacao', em: this.ctx.agora + ESPERA_ARQUIVOS_MS })
    const primeiroDoLote = substituindo ? c.passo !== PASSO_SUBSTITUINDO || c.arquivosNoLote === 0 : c.arquivosNoLote === 0
    if (primeiroDoLote) this.enviar(p, c, 'arquivo_recebido')
    return this.acoes
  }

  /** Pergunta de arquivo conta como respondida quando o currículo já chegou antes da hora. */
  private respondida(q: Pergunta, c: CandidaturaVista): boolean {
    return q.tipo === 'arquivo' ? c.arquivosNoLote > 0 : q.chave in c.respostas
  }

  /**
   * Currículo enviado antes do pedido: guarda sem abrir o prazo de 60 s, porque
   * ainda faltam perguntas. Mais páginas enviadas depois entram no mesmo lote.
   */
  private arquivoAntecipado(p: Processo, c: CandidaturaVista | null, e: Extract<Entrada, { tipo: 'arquivo' }>): void {
    const pergunta = p.perguntas.find((q): q is Extract<Pergunta, { tipo: 'arquivo' }> => q.tipo === 'arquivo')
    if (!pergunta) {
      this.enviar(p, c, 'espera_texto')
      return
    }
    const formato = formatoDoArquivo(e.mimetype, e.nomeArquivo)
    if (!formato || !pergunta.formatos.includes(formato)) return this.enviar(p, c, 'formato_nao_aceito')
    if (e.tamanho !== null && e.tamanho > pergunta.tamanho_max_mb * 1024 * 1024) return this.enviar(p, c, 'arquivo_grande')
    this.acoes.push({ tipo: 'guardar_arquivo', ext: formato })
    if (!c || c.arquivosNoLote === 0) this.enviar(p, c, 'arquivo_antecipado')
  }

  private avancar(p: Processo, c: CandidaturaVista, chaveAtual: string, novas: Record<string, string>): void {
    this.acoes.push({ tipo: 'cancelar_finalizacao' })
    const i = p.perguntas.findIndex((q) => q.chave === chaveAtual)
    const proxima = p.perguntas.slice(i + 1).find((q) => !this.respondida(q, c))
    if (proxima) {
      this.acoes.push({ tipo: 'passo', passo: proxima.chave })
      this.perguntar(p, { ...c, respostas: { ...c.respostas, ...novas } }, proxima.chave)
      return
    }
    this.fecharCadastro(p, c, novas)
  }

  private fecharCadastro(p: Processo, c: CandidaturaVista, novas: Record<string, string>): void {
    const tel = c.telefone ?? this.ctx.telefone
    if (!tel) {
      this.acoes.push({ tipo: 'passo', passo: PASSO_TELEFONE })
      this.enviar(p, { ...c, respostas: { ...c.respostas, ...novas } }, 'pede_telefone')
      return
    }
    if (!c.telefone) this.acoes.push({ tipo: 'telefone', telefone: tel })
    this.concluir(p, c, novas)
  }

  private concluir(p: Processo, c: CandidaturaVista, novas: Record<string, string>): void {
    this.acoes.push({ tipo: 'cancelar_finalizacao' }, { tipo: 'passo', passo: PASSO_FIM }, { tipo: 'concluir' })
    this.enviar(p, { ...c, respostas: { ...c.respostas, ...novas } }, 'confirmacao')
  }

  // --- candidatura concluída ---------------------------------------------------

  private concluida(p: Processo, c: CandidaturaVista, e: Entrada): Acao[] {
    if (e.tipo === 'finalizar_arquivos') {
      if (c.passo === PASSO_SUBSTITUINDO) {
        this.acoes.push({ tipo: 'cancelar_finalizacao' }, { tipo: 'passo', passo: PASSO_FIM })
        if (c.arquivosNoLote > 0) {
          this.acoes.push({ tipo: 'descartar_lotes_antigos' })
          this.enviar(p, c, 'curriculo_substituido')
        }
      }
      return this.acoes
    }
    if (e.tipo === 'voto') return this.acoes
    this.acoes.push({ tipo: 'interacao' })

    const perguntaArquivo = p.perguntas.find((q): q is Extract<Pergunta, { tipo: 'arquivo' }> => q.tipo === 'arquivo')
    if (e.tipo === 'arquivo' && perguntaArquivo && situacao(p, this.ctx.agora) === 'aberto') {
      return this.respostaArquivo(p, c, perguntaArquivo, e, true)
    }
    if (c.passo === PASSO_SUBSTITUINDO && c.arquivosNoLote > 0) return this.acoes
    if (c.passo === PASSO_SUBSTITUINDO) this.acoes.push({ tipo: 'passo', passo: PASSO_FIM })
    if (e.tipo === 'nao_suportado') this.enviar(p, c, 'midia_nao_suportada')
    else if (situacao(p, this.ctx.agora) === 'aberto' && perguntaArquivo) this.enviar(p, c, 'ja_concluiu')
    else this.enviar(p, c, 'confirmacao')
    return this.acoes
  }

  // --- utilitários ---------------------------------------------------------------

  private ativa(): CandidaturaVista | null {
    return this.ctx.candidaturas.find((c) => c.id === this.ctx.ativaId) ?? null
  }

  private processo(codigo: string): Processo | null {
    return this.ctx.processos.find((p) => p.codigo === codigo) ?? null
  }

  private perguntar(p: Processo, c: CandidaturaVista | null, passo: string): void {
    if (passo === PASSO_TELEFONE) {
      this.enviar(p, c, 'pede_telefone')
      return
    }
    const pergunta = p.perguntas.find((q) => q.chave === passo)
    if (!pergunta) return
    const texto = pergunta.texto ?? renderizar(p.mensagens, `pede_${pergunta.chave}`, this.variaveis(p, c), this.ctx.aleatorio)
    if (pergunta.tipo === 'enquete') {
      this.acoes.push({ tipo: 'enquete', chave: pergunta.chave, pergunta: texto, opcoes: pergunta.opcoes })
    } else {
      this.acoes.push({ tipo: 'enviar', texto })
    }
  }

  private variaveis(p: Processo, c: CandidaturaVista | null) {
    return {
      vaga: p.vaga,
      codigo: p.codigo,
      retencao_meses: p.retencaoMeses,
      empresa: this.ctx.empresa,
      primeiro_nome: primeiroNome(c?.respostas.nome),
      protocolo: c?.protocolo ?? ''
    }
  }

  private enviar(p: Processo, c: CandidaturaVista | null, chave: string, extra: Record<string, string> = {}): void {
    this.acoes.push({
      tipo: 'enviar',
      texto: renderizar(p.mensagens, chave, { ...this.variaveis(p, c), ...extra }, this.ctx.aleatorio)
    })
  }

  private textoPadrao(chave: string): string {
    return renderizar(this.ctx.padrao, chave, { empresa: this.ctx.empresa }, this.ctx.aleatorio)
  }

  private enviarPadrao(chave: string): void {
    const ativa = this.ativa()
    const p = ativa && this.processo(ativa.processo)
    // Dentro de um processo, usa os textos dele (que podem ter sido personalizados).
    if (p) this.enviar(p, ativa, chave)
    else this.acoes.push({ tipo: 'enviar', texto: this.textoPadrao(chave) })
  }
}

/** Nome da vaga como opção de enquete; desempata com o código se dois processos tiverem o mesmo nome. */
export function rotulosDeVaga(processos: Processo[]): string[] {
  return processos.map((p) =>
    processos.filter((x) => x.vaga.toLowerCase() === p.vaga.toLowerCase()).length > 1 ? `${p.vaga} (${p.codigo})` : p.vaga
  )
}
