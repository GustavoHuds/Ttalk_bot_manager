import type { Midia } from '../db/bots-grupos.js'
import type { Funcionario } from '../db/grupos.js'
import type { NomeComando } from './comandos.js'

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

/** Mensagem citada (respondida): quem escreveu, o texto e, se tiver mídia, o necessário para baixá-la. */
export interface Citacao {
  autor: string | null
  texto: string | null
  /** Mensagem serializada (BufferJSON) para baixar a mídia; null = só texto. */
  midia: string | null
}

/**
 * Mensagem de texto (ou legenda) como o adaptador entrega. Só chega aqui de grupos e conversas
 * privadas; o orquestrador descarta na hora o que não for de um grupo ativo, nem comando, nem resposta esperada.
 */
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
  citada: Citacao | null
  /** A própria mensagem tem mídia (foto com legenda etc.): serializada para baixar. */
  midia: string | null
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

/** Chave de uma mensagem no WhatsApp, para apagar ou marcar como lida. */
export interface ChaveMensagem {
  chat: string
  id: string
  /** Autor, em grupo. */
  participante: string | null
}

/** O que o bot de grupos precisa de uma conexão de WhatsApp. */
export interface ConexaoGrupos {
  pronta(): boolean
  /** "Digitando..." (ou "gravando áudio") e depois "parou". */
  presenca(jid: string, estado: 'composing' | 'recording' | 'paused'): Promise<void>
  enviarTexto(jid: string, texto: string, mencoes?: string[]): Promise<void>
  enviarMidia(jid: string, midia: Midia, dados: Buffer, legenda: string | null, mencoes?: string[]): Promise<void>
  removerParticipantes(jid: string, participantes: string[]): Promise<void>
  /** true = só admins mandam mensagem. */
  fecharGrupo(jid: string, fechado: boolean): Promise<void>
  apagar(chave: ChaveMensagem): Promise<void>
  marcarLida(chave: ChaveMensagem): Promise<void>
  listarGrupos(): Promise<InfoGrupo[]>
  metadados(jid: string): Promise<MetadadosGrupo>
  /** Telefone por trás de um LID, se o WhatsApp já informou. Só dígitos, já com DDI. */
  telefoneDoLid(lid: string): Promise<string | null>
  /** Baixa a mídia de uma mensagem serializada (a própria ou a citada). */
  baixarMidiaGrupo(bruto: string): Promise<{ dados: Buffer; midia: Omit<Midia, 'caminho'>; ext: string }>
}

/** Item da caixa de saída de um número de grupos (saida_grupos.conteudo). */
export type EnvioGrupo =
  | { tipo: 'texto'; texto: string; mencoes?: string[] }
  /** `temporaria`: o arquivo é apagado depois de enviado (mídia mandada pelo privado). */
  | { tipo: 'midia'; midia: Midia; legenda: string | null; mencoes?: string[]; temporaria?: boolean }
  | { tipo: 'remover'; participantes: string[] }
  | { tipo: 'fechar'; fechado: boolean }
  | { tipo: 'apagar'; chave: ChaveMensagem }

/** Grupo ativo de um bot, como o motor enxerga. */
export interface GrupoDoBot {
  jid: string
  nome: string
  botAdmin: boolean
}

/** Gestor indicado que ainda não confirmou (sem poder nenhum). */
export interface GestorPendente {
  funcionarioId: number
  codigo: string | null
  expiraEm: number | null
}

/**
 * Conversa em andamento com um gestor, por (chat, gestor). No privado guarda o grupo escolhido; nos dois
 * lugares guarda o que o bot perguntou e está esperando (número do grupo, ou a mensagem do /repeat).
 */
export interface Sessao {
  /** Grupo escolhido no privado. */
  grupo: string | null
  aguardando: 'grupo' | 'repeat' | null
  /** Comando que ficou esperando a escolha do grupo, para rodar logo depois dela. */
  pendente: string | null
  /** Até quando vale (depois, esquecida). */
  ate: number
}

/** Retrato do momento entregue ao motor. */
export interface ContextoGrupos {
  agora: number
  bot: { id: number; nome: string }
  desligados: Set<NomeComando>
  chat: string
  ehGrupo: boolean
  /** A mensagem recebida (para apagar o comando do grupo). */
  mensagem: ChaveMensagem
  remetente: Pessoa
  /** Mencionados, na ordem, já com telefone quando foi possível descobrir. */
  mencionados: Pessoa[]
  citada: { autor: Pessoa | null; texto: string | null; midia: Midia | null } | null
  /** Mídia da própria mensagem, já baixada (só quando o comando a usa). */
  midia: Midia | null
  /** Gestores do bot (confirmados ou pendentes) e o cadastro deles. */
  pessoas: Funcionario[]
  gestores: Set<number>
  pendentes: GestorPendente[]
  /** Grupos ativos deste bot. */
  grupos: GrupoDoBot[]
  sessao: Sessao | null
  /** Onde o comando age: o próprio grupo, ou o escolhido no privado. null = ainda não escolhido. */
  alvo: GrupoDoBot | null
  /** Participantes do alvo, só quando o comando precisa (senão null). */
  membros: MembroGrupo[] | null
  /** Palavras proibidas do alvo. */
  palavras: string[]
  /** Última menção a todos no alvo (freio contra excesso). */
  ultimaMencaoEmMassa: number | null
}

/** Entrada do motor: um comando, ou uma resposta solta a algo que o bot perguntou. */
export type Entrada = { tipo: 'comando'; texto: string } | { tipo: 'resposta'; texto: string }

export type AcaoGrupo =
  | { tipo: 'responder'; texto: string; mencoes?: string[] }
  /** Para o grupo alvo (ou o próprio). */
  | { tipo: 'enviar'; jid: string; envio: EnvioGrupo }
  | { tipo: 'sessao'; sessao: Sessao | null }
  /** Roda este comando de novo, depois de aplicar a sessão (o grupo acabou de ser escolhido). */
  | { tipo: 'executar'; texto: string }
  | { tipo: 'mencao_em_massa'; jid: string }
  | { tipo: 'palavras'; jid: string; adicionar: string[] }
  | { tipo: 'palavras_remover'; jid: string; palavras: string[] | null }
  | { tipo: 'silencio'; jid: string; inicio: string | null; fim: string | null }
  | { tipo: 'silencio_remover'; jid: string }
  | { tipo: 'repetir'; jid: string; horarios: string[]; texto: string | null; midia: Midia | null }
  | { tipo: 'repetir_parar'; jid: string }
  /** Código certo vindo do WhatsApp do cadastro. */
  | { tipo: 'confirmar_gestor'; funcionarioId: number; pessoa: Pessoa }
  /** Código certo vindo de outro WhatsApp: fica para conferir no painel. */
  | { tipo: 'divergencia'; funcionarioId: number; pessoa: Pessoa }
  /** Código errado ou vencido (conta para o limite de tentativas). */
  | { tipo: 'codigo_errado' }
  | { tipo: 'auditar'; acao: string; detalhe: string; funcionarioId?: number }
