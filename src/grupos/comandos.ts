import { semAcento } from '../conversa/textos.js'

export type NomeComando =
  | 'menu'
  | 'gestores'
  | 'quem'
  | 'cadastrar'
  | 'setores'
  | 'desconhecidos'
  | 'grupos'
  | 'gestor'
  | 'status'
  | 'log'
  | 'confirmar'

export interface DefComando {
  nome: NomeComando
  /** Só gestores podem usar (os outros são ignorados em silêncio). */
  gestor: boolean
  onde: 'grupo' | 'privado' | 'ambos'
  uso: string
  descricao: string
  /** Exemplo pronto para o painel. */
  exemplo: string
  /** Não pode ser desligado no painel. */
  fixo?: true
  /** Fora do /menu (não é comando do dia a dia). */
  oculto?: true
  /** Precisa da lista de participantes do grupo. */
  precisaMembros?: true
  /** Precisa que o bot seja admin do grupo (nenhum nesta entrega; usado a partir dos avisos). */
  precisaAdmin?: true
}

/** Tabela única: permissões, onde vale, texto do /menu. O motor, o orquestrador e o painel leem daqui. */
export const COMANDOS: DefComando[] = [
  { nome: 'menu', gestor: false, onde: 'ambos', uso: '/menu', descricao: 'mostra os comandos', exemplo: '/menu', fixo: true },
  {
    nome: 'gestores',
    gestor: false,
    onde: 'grupo',
    uso: '/gestores',
    descricao: 'chama os gestores deste grupo',
    exemplo: '/gestores',
    precisaMembros: true
  },
  { nome: 'quem', gestor: false, onde: 'grupo', uso: '/quem @pessoa', descricao: 'nome, setor e loja de alguém', exemplo: '/quem @Ana' },
  {
    nome: 'cadastrar',
    gestor: true,
    onde: 'ambos',
    uso: '/cadastrar @pessoa Nome | Setor | Loja | Cargo',
    descricao: 'cadastra ou atualiza alguém (cargo é opcional; no privado use o telefone no lugar do @)',
    exemplo: '/cadastrar @Ana Ana Souza | Vendas | Centro | Gerente'
  },
  { nome: 'setores', gestor: true, onde: 'ambos', uso: '/setores', descricao: 'setores e lojas com o número de pessoas', exemplo: '/setores' },
  {
    nome: 'desconhecidos',
    gestor: true,
    onde: 'grupo',
    uso: '/desconhecidos',
    descricao: 'quem está no grupo sem cadastro',
    exemplo: '/desconhecidos',
    precisaMembros: true
  },
  { nome: 'grupos', gestor: true, onde: 'privado', uso: '/grupos', descricao: 'grupos ativos deste bot', exemplo: '/grupos' },
  {
    nome: 'gestor',
    gestor: true,
    onde: 'ambos',
    uso: '/gestor add @pessoa  ·  /gestor remover @pessoa',
    descricao: 'indica ou tira um gestor (quem é indicado confirma com um código)',
    exemplo: '/gestor add @Ana'
  },
  { nome: 'status', gestor: true, onde: 'ambos', uso: '/status', descricao: 'situação do bot', exemplo: '/status' },
  { nome: 'log', gestor: true, onde: 'privado', uso: '/log 10', descricao: 'últimas ações registradas (até 30)', exemplo: '/log 10' },
  {
    nome: 'confirmar',
    gestor: false,
    onde: 'privado',
    uso: '/confirmar 123456',
    descricao: 'confirma você como gestor(a) com o código recebido',
    exemplo: '/confirmar 482193',
    fixo: true,
    oculto: true
  }
]

export const APELIDOS: Record<string, NomeComando> = { ajuda: 'menu', help: 'menu', comandos: 'menu' }

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

/**
 * Permite marcas invisíveis antes da barra (LRM/RLM/zero-width/BOM — o WhatsApp às vezes as manda),
 * aceita letra com marca de acento solta (texto não normalizado) e exige que o nome termine numa
 * borda de palavra, senão "/menu/x" ou "/home/x" seriam lidos como comando "menu"/"home".
 */
const PREFIXO = /^[\s​-‏﻿]*\/(\p{L}[\p{L}\p{M}\d_-]*)(?=$|[\s|@.,!?])/u
/** Comando é coisa curta; texto enorme não é interpretado. */
const TAMANHO_MAXIMO = 2000

export function ehComando(texto: string | null | undefined): boolean {
  if (!texto || texto.length > TAMANHO_MAXIMO) return false
  return PREFIXO.test(texto.normalize('NFC'))
}

export function interpretar(texto: string, mencionados: string[] = [], citada: string | null = null): Comando | null {
  if (texto.length > TAMANHO_MAXIMO) return null
  const t = texto.normalize('NFC')
  const m = PREFIXO.exec(t)
  if (!m) return null
  const args = t
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
  const alvo = Object.hasOwn(APELIDOS, nome) ? APELIDOS[nome]! : nome
  return COMANDOS.find((c) => c.nome === alvo) ?? null
}
