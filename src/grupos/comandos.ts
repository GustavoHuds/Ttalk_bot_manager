import { semAcento } from '../conversa/textos.js'

export type NomeComando = 'menu' | 'gestores' | 'quem' | 'cadastrar' | 'setores' | 'desconhecidos' | 'grupos' | 'gestor' | 'status' | 'log'

export interface DefComando {
  nome: NomeComando
  /** Só gestores podem usar (os outros são ignorados em silêncio). */
  gestor: boolean
  onde: 'grupo' | 'privado' | 'ambos'
  uso: string
  descricao: string
  /** Precisa da lista de participantes do grupo. */
  precisaMembros?: true
  /** Precisa que o bot seja admin do grupo (nenhum nesta entrega; usado a partir dos avisos). */
  precisaAdmin?: true
}

/** Tabela única: permissões, onde vale, texto do /menu. O motor e o orquestrador leem daqui. */
export const COMANDOS: DefComando[] = [
  { nome: 'menu', gestor: false, onde: 'ambos', uso: '/menu', descricao: 'mostra os comandos' },
  { nome: 'gestores', gestor: false, onde: 'grupo', uso: '/gestores', descricao: 'chama os gestores deste grupo', precisaMembros: true },
  { nome: 'quem', gestor: false, onde: 'grupo', uso: '/quem @pessoa', descricao: 'nome, setor e loja de alguém' },
  {
    nome: 'cadastrar',
    gestor: true,
    onde: 'ambos',
    uso: '/cadastrar @pessoa Nome | Setor | Loja | Cargo',
    descricao: 'cadastra ou atualiza alguém (cargo é opcional; no privado use o telefone no lugar do @)'
  },
  { nome: 'setores', gestor: true, onde: 'ambos', uso: '/setores', descricao: 'setores e lojas com o número de pessoas' },
  { nome: 'desconhecidos', gestor: true, onde: 'grupo', uso: '/desconhecidos', descricao: 'quem está no grupo sem cadastro', precisaMembros: true },
  { nome: 'grupos', gestor: true, onde: 'privado', uso: '/grupos', descricao: 'grupos deste número' },
  { nome: 'gestor', gestor: true, onde: 'ambos', uso: '/gestor add @pessoa  ·  /gestor remover @pessoa', descricao: 'dá ou tira o poder de gestor' },
  { nome: 'status', gestor: true, onde: 'ambos', uso: '/status', descricao: 'situação do bot' },
  { nome: 'log', gestor: true, onde: 'privado', uso: '/log 10', descricao: 'últimas ações registradas (até 30)' }
]

const APELIDOS: Record<string, NomeComando> = { ajuda: 'menu', help: 'menu', comandos: 'menu' }

export interface Comando {
  /** Nome sem a barra, minúsculo e sem acento ("cadastrar"). */
  nome: string
  /** O resto do texto, sem as menções "@123..." e com espaços simples. */
  args: string
  /** args separado por "|", cada parte aparada. Vazio quando não há args. */
  campos: string[]
  /** JIDs mencionados, na ordem. */
  mencionados: string[]
  /** Autor da mensagem citada. */
  citada: string | null
}

const PREFIXO = /^\s*\/(\p{L}[\p{L}\d_-]*)/u
/** Comando é coisa curta; texto enorme não é interpretado. */
const TAMANHO_MAXIMO = 2000

export function ehComando(texto: string | null | undefined): boolean {
  return !!texto && PREFIXO.test(texto)
}

export function interpretar(texto: string, mencionados: string[] = [], citada: string | null = null): Comando | null {
  if (texto.length > TAMANHO_MAXIMO) return null
  const m = PREFIXO.exec(texto)
  if (!m) return null
  const args = texto
    .slice(m[0].length)
    .replace(/@\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return {
    nome: semAcento(m[1]!),
    args,
    campos: args ? args.split('|').map((c) => c.trim()) : [],
    mencionados,
    citada
  }
}

export function acharComando(nome: string): DefComando | null {
  const alvo = APELIDOS[nome] ?? nome
  return COMANDOS.find((c) => c.nome === alvo) ?? null
}
