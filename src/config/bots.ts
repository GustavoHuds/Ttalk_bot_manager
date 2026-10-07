import type { Repositorio } from '../db/repositorio.js'
import { semAcento } from '../conversa/textos.js'
import { ErroConfig, montarConfig, validarProcesso } from './carregar.js'
import type { ConfigCarregada, FormatoArquivo, Mensagens, Processo, StatusProcesso } from './tipos.js'

/** Pergunta como fica guardada no banco e como o editor do painel a manipula. */
export interface PerguntaBot {
  chave?: string
  tipo: 'texto' | 'enquete' | 'arquivo'
  texto: string
  validacao?: 'nome_completo' | 'telefone'
  opcoes?: string[]
  formatos?: FormatoArquivo[]
  tamanho_max_mb?: number
}

/** Um bot (uma vaga). Mesmo formato do antigo YAML, guardado como JSON. */
export interface DadosBot {
  codigo: string
  vaga: string
  status: StatusProcesso
  abre_em: string | null
  encerra_em: string
  retencao_meses: number
  /** Número de recrutamento que atende o bot. A coluna processos.numero_id é quem vale; aqui vai junto para o editor. */
  numero_id: number
  perguntas: PerguntaBot[]
  /** Só os textos que diferem do padrão. */
  mensagens: Record<string, string | string[]>
}

/** Textos de cada bot que o painel deixa editar (os gerais ficam em mensagens-padrao.yaml). */
export const TEXTOS_EDITAVEIS: { chave: string; rotulo: string; lista?: true }[] = [
  { chave: 'boas_vindas', rotulo: 'Boas-vindas (uma versão por linha; o bot sorteia)', lista: true },
  { chave: 'aviso_dados', rotulo: 'Aviso de dados (LGPD)' },
  { chave: 'confirmacao', rotulo: 'Confirmação final' },
  { chave: 'arquivo_recebido', rotulo: 'Ao receber o currículo' },
  { chave: 'arquivo_antecipado', rotulo: 'Currículo recebido antes das perguntas' },
  { chave: 'pede_telefone', rotulo: 'Pedido de telefone (quando o WhatsApp não informa)' },
  { chave: 'ja_concluiu', rotulo: 'Quem já se candidatou escreve de novo' },
  { chave: 'curriculo_substituido', rotulo: 'Currículo trocado' },
  { chave: 'processo_encerrado', rotulo: 'Inscrições encerradas' },
  { chave: 'retomada', rotulo: 'Candidato volta depois de 24 h' },
  { chave: 'nome_invalido', rotulo: 'Nome incompleto' },
  { chave: 'telefone_invalido', rotulo: 'Telefone não reconhecido' },
  { chave: 'texto_invalido', rotulo: 'Resposta vazia ou longa demais' },
  { chave: 'opcao_invalida', rotulo: 'Opção da enquete não reconhecida ({opcoes} = lista)' },
  { chave: 'espera_texto', rotulo: 'Mandou arquivo quando era para responder' },
  { chave: 'espera_arquivo', rotulo: 'Escreveu quando era para mandar o currículo' },
  { chave: 'formato_nao_aceito', rotulo: 'Formato de arquivo não aceito' },
  { chave: 'arquivo_grande', rotulo: 'Arquivo grande demais' },
  { chave: 'erro_download', rotulo: 'Falha ao baixar o arquivo' },
  { chave: 'midia_nao_suportada', rotulo: 'Áudio, figurinha, vídeo, localização' }
]

const RESERVADAS = new Set(['telefone', 'fim', 'substituindo'])

/** Chave interna estável da pergunta, gerada do texto só quando a pergunta é criada. */
export function gerarChave(texto: string, usadas: Set<string>): string {
  let base = semAcento(texto)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .split('_')
    .filter((p) => p.length > 2 && !['qual', 'voce', 'sua', 'seu', 'com', 'para', 'que', 'tem'].includes(p))
    .slice(0, 3)
    .join('_')
  if (!base) base = 'pergunta'
  else if (!/^[a-z]/.test(base)) base = `p_${base}`
  base = base.slice(0, 30)
  let chave = base
  for (let i = 2; usadas.has(chave) || RESERVADAS.has(chave); i++) chave = `${base}_${i}`
  usadas.add(chave)
  return chave
}

/** Modelo para "Novo bot": as perguntas do planejamento, prontas para ajustar. */
export function botModelo(hoje: string, numeroId = 1): DadosBot {
  return {
    codigo: '',
    vaga: '',
    status: 'rascunho',
    abre_em: hoje,
    encerra_em: hoje,
    retencao_meses: 12,
    numero_id: numeroId,
    perguntas: [
      { chave: 'nome', tipo: 'texto', texto: 'Para começar, qual é o seu nome completo?', validacao: 'nome_completo' },
      { chave: 'cidade', tipo: 'texto', texto: 'Em qual cidade e bairro você mora?' },
      { chave: 'disponibilidade', tipo: 'enquete', texto: 'Qual horário você tem disponível?', opcoes: ['Manhã', 'Tarde', 'Integral'] },
      { chave: 'pretensao', tipo: 'texto', texto: 'Qual é a sua pretensão salarial? Pode responder "a combinar".' },
      { chave: 'curriculo', tipo: 'arquivo', texto: 'Agora envie seu currículo em PDF, Word ou foto.', formatos: ['pdf', 'docx', 'jpg', 'png'], tamanho_max_mb: 10 }
    ],
    mensagens: {}
  }
}

function dataTexto(v: unknown): string | null {
  if (v == null || v === '') return null
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v).trim()
}

/** Converte o que está guardado (ou um YAML antigo) para o formato do editor, com todos os textos preenchidos. */
export function paraEditor(bruto: unknown, padrao: Mensagens): DadosBot {
  const d = (bruto ?? {}) as Record<string, unknown>
  const mensagens = { ...((d.mensagens as Record<string, string | string[]>) ?? {}) }
  const todas = { ...padrao, ...mensagens }
  const perguntas = ((d.perguntas as Record<string, unknown>[]) ?? []).map((p) => {
    const chave = String(p.chave ?? '')
    const pede = todas[`pede_${chave}`]
    const texto = typeof p.texto === 'string' ? p.texto : Array.isArray(pede) ? (pede[0] ?? '') : (pede ?? '')
    return { ...p, chave, texto } as PerguntaBot
  })
  return {
    codigo: String(d.codigo ?? ''),
    vaga: String(d.vaga ?? ''),
    status: (d.status as StatusProcesso) ?? 'rascunho',
    abre_em: dataTexto(d.abre_em),
    encerra_em: dataTexto(d.encerra_em) ?? '',
    retencao_meses: Number(d.retencao_meses ?? 12),
    numero_id: Number(d.numero_id ?? 1),
    perguntas,
    mensagens
  }
}

/**
 * Normaliza o que veio do formulário e valida com as mesmas regras do motor.
 * Regras do painel: o currículo é sempre a última pergunta, e só existe um.
 */
export function prepararBot(
  entrada: unknown,
  padrao: Mensagens,
  status: StatusProcesso,
  numerosRecrutamento: number[]
): { dados: DadosBot; processo: Processo } {
  if (!entrada || typeof entrada !== 'object') throw new ErroConfig('formulário vazio')
  const e = entrada as Record<string, unknown>
  const numeroId = Number(e.numero_id)
  if (!numerosRecrutamento.includes(numeroId)) throw new ErroConfig('escolha um número de recrutamento para o bot')
  const brutas = Array.isArray(e.perguntas) ? (e.perguntas as Record<string, unknown>[]) : []
  const usadas = new Set(brutas.map((p) => String(p.chave ?? '')).filter(Boolean))

  const perguntas: PerguntaBot[] = brutas.map((p, i) => {
    const tipo = p.tipo as PerguntaBot['tipo']
    const texto = String(p.texto ?? '').trim()
    if (!texto) throw new ErroConfig(`pergunta ${i + 1}: escreva o texto da pergunta`)
    const chave = String(p.chave ?? '') || gerarChave(texto, usadas)
    if (tipo === 'enquete') {
      const opcoes = (Array.isArray(p.opcoes) ? p.opcoes : String(p.opcoes ?? '').split('\n')).map((o) => String(o).trim()).filter(Boolean)
      return { chave, tipo, texto, opcoes }
    }
    if (tipo === 'arquivo') {
      return {
        chave,
        tipo,
        texto,
        formatos: (Array.isArray(p.formatos) ? p.formatos : []) as FormatoArquivo[],
        tamanho_max_mb: Number(p.tamanho_max_mb ?? 10)
      }
    }
    const validacao = p.validacao === 'nome_completo' || p.validacao === 'telefone' ? p.validacao : undefined
    return { chave, tipo: 'texto', texto, ...(validacao ? { validacao } : {}) }
  })

  const arquivos = perguntas.filter((p) => p.tipo === 'arquivo')
  if (arquivos.length !== 1 || perguntas.at(-1)?.tipo !== 'arquivo') {
    throw new ErroConfig('o bot precisa terminar pedindo o currículo (uma única pergunta de arquivo, no fim)')
  }
  if (perguntas.length < 2) throw new ErroConfig('adicione pelo menos uma pergunta antes do currículo')

  const mensagens: Record<string, string | string[]> = {}
  const brutasMsg = (e.mensagens ?? {}) as Record<string, unknown>
  for (const { chave, lista } of TEXTOS_EDITAVEIS) {
    const v = brutasMsg[chave]
    const textos = (Array.isArray(v) ? v : String(v ?? '').split(lista ? '\n' : '\u0000')).map((t) => String(t).trim()).filter(Boolean)
    if (textos.length === 0) continue
    const valor = lista ? textos : textos[0]!
    // Igual ao padrão não precisa ser guardado: se o padrão mudar, o bot acompanha.
    if (JSON.stringify(valor) !== JSON.stringify(padrao[chave])) mensagens[chave] = valor
  }

  const dados: DadosBot = {
    codigo: String(e.codigo ?? '').trim().toUpperCase(),
    vaga: String(e.vaga ?? '').trim(),
    status,
    abre_em: dataTexto(e.abre_em),
    encerra_em: dataTexto(e.encerra_em) ?? '',
    retencao_meses: Number(e.retencao_meses),
    numero_id: numeroId,
    perguntas,
    mensagens
  }
  return { dados, processo: validarProcesso(dados, padrao, `painel:${dados.codigo}`) }
}

/** Bots lidos do banco, validados e guardados em memória até a próxima edição. */
export class FonteBots {
  private cache: ConfigCarregada | null = null

  constructor(
    private readonly repo: Repositorio,
    readonly padrao: Mensagens,
    readonly empresa = 'nossa empresa'
  ) {}

  get(): ConfigCarregada {
    this.cache ??= montarConfig(
      this.padrao,
      this.repo.listarBots().map((b) => ({ origem: `bot ${b.codigo}`, dados: { ...(JSON.parse(b.dados) as object), numero_id: b.numeroId } })),
      Date.now(),
      this.empresa
    )
    return this.cache
  }

  invalidar(): void {
    this.cache = null
  }

  /** Na primeira subida, traz os YAML antigos para o banco. Depois disso, tudo é pelo painel. */
  importarYaml(itens: { arquivo: string; dados: unknown }[], agora: number): { importados: string[]; erros: string[] } {
    const r = { importados: [] as string[], erros: [] as string[] }
    if (this.repo.listarBots().length > 0) return r
    for (const { arquivo, dados } of itens) {
      try {
        const p = validarProcesso(dados, this.padrao, arquivo)
        const ed = paraEditor(dados, this.padrao)
        this.repo.salvarBot(p.codigo, JSON.stringify({ ...ed, codigo: p.codigo, numero_id: 1 }), 1, 'importacao', agora)
        r.importados.push(p.codigo)
      } catch (e) {
        r.erros.push(`${arquivo}: ${(e as Error).message}`)
      }
    }
    this.invalidar()
    return r
  }
}
