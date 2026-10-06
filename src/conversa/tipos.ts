import type { Processo } from '../config/tipos.js'

/** Mensagem recebida já traduzida para o que o motor entende, sem nada do Baileys. */
export type Entrada =
  | { tipo: 'texto'; texto: string }
  /** Voto numa enquete enviada pelo bot. `chave` é a pergunta (ou VAGA para a escolha de vaga). */
  | { tipo: 'voto'; chave: string; opcoes: string[] }
  | { tipo: 'arquivo'; mimetype: string; nomeArquivo: string | null; tamanho: number | null }
  | { tipo: 'nao_suportado' }
  /** Disparada pelo agendador 60 s depois do último arquivo. */
  | { tipo: 'finalizar_arquivos' }

export const CHAVE_VAGA = '_vaga'

export type StatusCandidatura = 'em_andamento' | 'concluida'

/** Passos além das chaves de pergunta. */
export const PASSO_TELEFONE = 'telefone'
export const PASSO_FIM = 'fim'
export const PASSO_SUBSTITUINDO = 'substituindo'

export interface CandidaturaVista {
  id: number
  processo: string
  protocolo: string
  passo: string
  status: StatusCandidatura
  telefone: string | null
  respostas: Record<string, string>
  /** Arquivos válidos no lote atual (o lote muda quando o candidato troca o currículo). */
  arquivosNoLote: number
  ultimaInteracao: number
}

export interface Contexto {
  agora: number
  processos: Processo[]
  padrao: Record<string, string | string[]>
  /** Estado pendente da conversa (escolha de vaga ou confirmação de exclusão). */
  estado: EstadoConversa | null
  /** Candidatura em foco nesta conversa, se houver. */
  ativaId: number | null
  /** Todas as candidaturas deste contato. */
  candidaturas: CandidaturaVista[]
  /** Telefone identificado pela conexão (null quando só veio o LID). */
  telefone: string | null
  aleatorio: () => number
  /** Nome da empresa para {empresa}. */
  empresa: string
}

export type EstadoConversa =
  | { tipo: 'escolher_vaga'; codigos: string[] }
  | { tipo: 'confirmar_exclusao' }

export type Acao =
  | { tipo: 'enviar'; texto: string }
  | { tipo: 'enquete'; chave: string; pergunta: string; opcoes: string[] }
  | { tipo: 'estado'; estado: EstadoConversa | null }
  | { tipo: 'criar_candidatura'; processo: string }
  | { tipo: 'focar'; candidaturaId: number }
  | { tipo: 'passo'; passo: string }
  | { tipo: 'resposta'; chave: string; valor: string }
  /** Baixar o arquivo da mensagem atual e ligá-lo à candidatura em foco. */
  | { tipo: 'guardar_arquivo'; ext: string }
  | { tipo: 'agendar_finalizacao'; em: number }
  | { tipo: 'cancelar_finalizacao' }
  | { tipo: 'telefone'; telefone: string }
  | { tipo: 'concluir' }
  | { tipo: 'novo_lote' }
  | { tipo: 'descartar_lotes_antigos' }
  | { tipo: 'excluir_dados' }
  /** Registra que o contato interagiu (para a regra de retomada após 24 h). */
  | { tipo: 'interacao' }
