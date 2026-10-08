import { semAcento } from '../conversa/textos.js'

export type NomeComando = 'menu' | 'grupo' | 'all' | 'todos' | 'mencionar' | 'remove' | 'banword' | 'mutegroup' | 'unmute' | 'repeat' | 'confirmar'

export interface DefComando {
  nome: NomeComando
  uso: string
  descricao: string
  /** Não pode ser desligado no painel. */
  fixo?: true
  /** Fora do /menu e da lista do painel. */
  oculto?: true
  /** Só no privado com o bot. */
  soPrivado?: true
  /** Age num grupo: no grupo, nele mesmo; no privado, no grupo escolhido. */
  precisaGrupo?: true
  /** Precisa da lista de participantes do grupo. */
  precisaMembros?: true
  /** Precisa que o número do bot seja admin do grupo. */
  precisaAdmin?: true
}

/**
 * Tabela única dos comandos. Todos são de gestores (quem não é gestor confirmado não recebe resposta),
 * menos o /confirmar, que é como alguém indicado vira gestor. Todos valem no grupo e no privado: no
 * privado, o bot pergunta em qual grupo agir (numerado) e lembra a escolha por um tempo.
 */
export const COMANDOS: DefComando[] = [
  { nome: 'menu', uso: '/menu', descricao: 'lista os comandos', fixo: true },
  { nome: 'grupo', uso: '/grupo', descricao: 'escolhe em qual grupo agir', fixo: true, soPrivado: true },
  { nome: 'all', uso: '/all mensagem', descricao: 'manda a mensagem mencionando todos, sem mostrar as menções', precisaGrupo: true, precisaMembros: true },
  { nome: 'todos', uso: '/todos mensagem', descricao: 'manda a mensagem com todos mencionados no texto', precisaGrupo: true, precisaMembros: true },
  { nome: 'mencionar', uso: '/mencionar mensagem @pessoa', descricao: 'manda a mensagem mencionando a pessoa em segredo', precisaGrupo: true, precisaMembros: true },
  { nome: 'remove', uso: '/remove @pessoa @pessoa', descricao: 'remove participantes do grupo', precisaGrupo: true, precisaMembros: true, precisaAdmin: true },
  { nome: 'banword', uso: '/banword palavra,outra', descricao: 'apaga mensagens com essas palavras', precisaGrupo: true, precisaAdmin: true },
  { nome: 'mutegroup', uso: '/mutegroup 22:00/06:00', descricao: 'fecha o grupo (sem horário: até o /unmute)', precisaGrupo: true, precisaAdmin: true },
  { nome: 'unmute', uso: '/unmute', descricao: 'abre o grupo', precisaGrupo: true, precisaAdmin: true },
  { nome: 'repeat', uso: '/repeat 08:00 18:00', descricao: 'repete a mensagem citada nos horários (/repeat stop para parar)', precisaGrupo: true },
  { nome: 'confirmar', uso: '/confirmar 123456', descricao: 'confirma você como gestor(a)', fixo: true, oculto: true, soPrivado: true }
]

export const APELIDOS: Record<string, NomeComando> = {
  ajuda: 'menu',
  help: 'menu',
  comandos: 'menu',
  grupos: 'grupo',
  remover: 'remove',
  mutar: 'mutegroup',
  mute: 'mutegroup',
  desmutar: 'unmute',
  repetir: 'repeat'
}

export interface Comando {
  /** Nome sem a barra, minúsculo e sem acento ("all"). */
  nome: string
  /** O resto do texto, sem as menções "@123..." e com espaços simples. */
  args: string
  /** O resto do texto como veio (quebras de linha mantidas), só sem as menções. */
  bruto: string
}

/**
 * Permite marcas invisíveis antes da barra (LRM/RLM/zero-width/BOM — o WhatsApp às vezes as manda),
 * aceita letra com marca de acento solta (texto não normalizado) e exige que o nome termine numa
 * borda de palavra, senão "/menu/x" ou "/home/x" seriam lidos como comando "menu"/"home".
 */
const PREFIXO = /^[\s​-‏﻿]*\/(\p{L}[\p{L}\p{M}\d_-]*)(?=$|[\s|@.,!?])/u
/** Comando é coisa curta; texto enorme não é interpretado. */
const TAMANHO_MAXIMO = 4000

export function ehComando(texto: string | null | undefined): boolean {
  if (!texto || texto.length > TAMANHO_MAXIMO) return false
  return PREFIXO.test(texto.normalize('NFC'))
}

export function interpretar(texto: string): Comando | null {
  if (texto.length > TAMANHO_MAXIMO) return null
  const t = texto.normalize('NFC')
  const m = PREFIXO.exec(t)
  if (!m) return null
  const resto = t.slice(m[0].length).replace(/@\d+/g, ' ')
  return {
    nome: semAcento(m[1]!),
    args: resto.replace(/\s+/g, ' ').trim(),
    bruto: resto.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim()
  }
}

export function acharComando(nome: string): DefComando | null {
  const alvo = Object.hasOwn(APELIDOS, nome) ? APELIDOS[nome]! : nome
  return COMANDOS.find((c) => c.nome === alvo) ?? null
}
