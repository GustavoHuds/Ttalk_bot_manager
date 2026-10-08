import type { DadosFuncionario, Funcionario } from '../db/grupos.js'
import type { ComandosDoBot } from './catalogo.js'

/** Alguém no WhatsApp: o JID visto, o telefone (quando se sabe) e o LID (quando existe). */
export interface Pessoa {
  jid: string
  /** Chave do telefone: brasileiro canônico (55+DDD+número com o 9) ou dígitos com DDI para outros países. */
  telefone: string | null
  /** JID @lid sem dispositivo. */
  lid: string | null
}

export interface MembroGrupo extends Pessoa {
  admin: boolean
}

/** Comando como o adaptador entrega. Conversa comum nunca chega aqui. */
export interface MensagemGrupo {
  numeroId: number
  id: string
  /** Onde responder: o grupo (@g.us) ou a conversa privada. */
  chat: string
  ehGrupo: boolean
  remetente: Pessoa
  texto: string
  /** JIDs mencionados na mensagem. */
  mencionados: string[]
  /** Autor da mensagem respondida (citada), se houver. */
  citada: string | null
  /** messageTimestamp em ms. */
  recebidaEm: number
}

export interface InfoGrupo {
  jid: string
  nome: string
  botAdmin: boolean
}

export interface MetadadosGrupo extends InfoGrupo {
  /** Participantes, sem o próprio bot. */
  membros: MembroGrupo[]
}

/** Mudanças nos grupos, já traduzidas pelo adaptador. */
export type EventoGrupos =
  /** Lista completa (ao conectar): o que não vier é grupo de onde o bot saiu. */
  | { tipo: 'lista'; grupos: InfoGrupo[] }
  | { tipo: 'entrou'; grupos: InfoGrupo[] }
  | { tipo: 'renomeado'; jid: string; nome: string }
  | { tipo: 'admin'; jid: string; admin: boolean }
  | { tipo: 'saiu'; jid: string }
  /** Alguém (não o bot) entrou, saiu, virou ou deixou de ser admin. Só importa em grupo ativo. */
  | { tipo: 'participantes'; jid: string; acao: 'add' | 'remove' | 'promote' | 'demote'; membros: MembroGrupo[] }

/** O que o bot de grupos precisa de uma conexão de WhatsApp. */
export interface ConexaoGrupos {
  pronta(): boolean
  digitando(jid: string): Promise<void>
  enviarTexto(jid: string, texto: string, mencoes?: string[]): Promise<void>
  listarGrupos(): Promise<InfoGrupo[]>
  metadados(jid: string): Promise<MetadadosGrupo>
  /** Telefone por trás de um LID, se o WhatsApp já informou. Só dígitos, já com DDI. */
  telefoneDoLid(lid: string): Promise<string | null>
}

/** Conteúdo de um item de saida_grupos. */
export type EnvioGrupo = { tipo: 'texto'; texto: string; mencoes?: string[] }

export interface LinhaAuditoria {
  em: number
  usuario: string
  acao: string
  detalhe: string | null
}

/** Grupo ativo de um bot, como o motor enxerga. */
export interface GrupoDoBot {
  jid: string
  nome: string
  botAdmin: boolean
  loja: string | null
  setor: string | null
}

/** Gestor indicado que ainda não confirmou (sem poder nenhum). */
export interface GestorPendente {
  funcionarioId: number
  codigo: string | null
  expiraEm: number | null
}

/** Retrato do momento entregue ao motor. */
export interface ContextoGrupos {
  agora: number
  bot: { id: number; nome: string }
  /** Como este bot configurou os comandos (desligados, textos, personalizados). */
  comandos: ComandosDoBot
  chat: string
  ehGrupo: boolean
  remetente: Pessoa
  /** Mencionados, na ordem, já com telefone quando foi possível descobrir. */
  mencionados: Pessoa[]
  citada: Pessoa | null
  funcionarios: Funcionario[]
  /** IDs de funcionário que são gestores confirmados deste bot. */
  gestores: Set<number>
  pendentes: GestorPendente[]
  /** Grupo da mensagem (sempre um grupo ativo do bot); null no privado. */
  grupo: GrupoDoBot | null
  /** Grupos ativos deste bot. */
  grupos: GrupoDoBot[]
  /** Participantes do grupo, só quando o comando precisa (senão null). */
  membros: MembroGrupo[] | null
  /** Auditoria mais recente primeiro (até 30). */
  auditoria: LinhaAuditoria[]
  /** Desde quando o número do bot está conectado. */
  conectadoDesde: number | null
}

export type AcaoGrupo =
  | { tipo: 'responder'; texto: string; mencoes?: string[] }
  /** id null cria; senão substitui os campos. */
  | { tipo: 'salvar_funcionario'; id: number | null; dados: DadosFuncionario }
  /** Indica (pendente). O orquestrador gera o código e manda no privado de quem pediu (`avisar`). */
  | { tipo: 'indicar_gestor'; funcionarioId: number; avisar: Pessoa }
  | { tipo: 'remover_gestor'; funcionarioId: number }
  /** Código certo vindo do WhatsApp do cadastro. */
  | { tipo: 'confirmar_gestor'; funcionarioId: number; pessoa: Pessoa }
  /** Código certo vindo de outro WhatsApp: fica para conferir no painel. */
  | { tipo: 'divergencia'; funcionarioId: number; pessoa: Pessoa }
  /** Código errado ou vencido (conta para o limite de tentativas). */
  | { tipo: 'codigo_errado' }
  | { tipo: 'auditar'; acao: string; detalhe: string; funcionarioId?: number }
