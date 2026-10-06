export type StatusProcesso = 'rascunho' | 'aberto' | 'encerrado'

export type FormatoArquivo = 'pdf' | 'docx' | 'doc' | 'jpg' | 'png'

export type Pergunta =
  | { chave: string; tipo: 'texto'; texto?: string; validacao?: 'nome_completo' | 'telefone' }
  | { chave: string; tipo: 'enquete'; texto?: string; opcoes: string[] }
  | { chave: string; tipo: 'arquivo'; texto?: string; formatos: FormatoArquivo[]; tamanho_max_mb: number }

/** Textos já mesclados (padrão + processo). Uma lista indica versões sorteadas. */
export type Mensagens = Record<string, string | string[]>

export interface Processo {
  codigo: string
  vaga: string
  status: StatusProcesso
  /** Início do dia de abertura (ms, horário de Brasília). */
  abreEm: number | null
  /** Fim do dia de encerramento (ms, horário de Brasília). */
  encerraEm: number
  retencaoMeses: number
  perguntas: Pergunta[]
  mensagens: Mensagens
  arquivoOrigem: string
}

export interface ConfigCarregada {
  processos: Processo[]
  padrao: Mensagens
  /** Nome da empresa, usado como {empresa} nos textos. */
  empresa: string
  /** Erros de leitura dos YAML; processos com erro ficam de fora. */
  erros: string[]
  carregadaEm: number
}
