import type { DadosFuncionario, Funcionario, Grupo } from '../db/grupos.js'

/** Alguém no WhatsApp: o JID visto, o telefone (quando se sabe) e o LID (quando existe). */
export interface Pessoa {
  jid: string
  /** 55 + DDD + número, canônico. */
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

/** O que o bot de grupos precisa de uma conexão de WhatsApp. */
export interface ConexaoGrupos {
  pronta(): boolean
  digitando(jid: string): Promise<void>
  enviarTexto(jid: string, texto: string, mencoes?: string[]): Promise<void>
  listarGrupos(): Promise<InfoGrupo[]>
  metadados(jid: string): Promise<MetadadosGrupo>
  /** Telefone por trás de um LID, se o WhatsApp já informou. */
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

/** Retrato do momento entregue ao motor. */
export interface ContextoGrupos {
  agora: number
  chat: string
  ehGrupo: boolean
  remetente: Pessoa
  /** Mencionados, na ordem, já com telefone quando foi possível descobrir. */
  mencionados: Pessoa[]
  citada: Pessoa | null
  funcionarios: Funcionario[]
  /** IDs de funcionário que são gestores. */
  gestores: Set<number>
  /** Grupo da mensagem; null no privado. */
  grupo: Grupo | null
  /** Grupos ativos deste número. */
  grupos: Grupo[]
  /** Participantes do grupo, só quando o comando precisa (senão null). */
  membros: MembroGrupo[] | null
  /** Auditoria mais recente primeiro (até 30). */
  auditoria: LinhaAuditoria[]
  /** Desde quando este número está conectado. */
  conectadoDesde: number | null
}

export type AcaoGrupo =
  | { tipo: 'responder'; texto: string; mencoes?: string[] }
  /** id null cria; senão substitui os campos. */
  | { tipo: 'salvar_funcionario'; id: number | null; dados: DadosFuncionario }
  | { tipo: 'gestor'; funcionarioId: number; ativo: boolean }
  | { tipo: 'auditar'; acao: string; detalhe: string }
