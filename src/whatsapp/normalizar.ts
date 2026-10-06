import { createHash } from 'node:crypto'
import {
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  isLidUser,
  isPnUser,
  jidDecode,
  normalizeMessageContent,
  type WAMessage
} from '@whiskeysockets/baileys'
import type { Entrada } from '../conversa/tipos.js'

/** Números do Baileys podem chegar como Long. */
export function paraNumero(v: unknown): number | null {
  if (v == null) return null
  if (typeof v === 'number') return v
  if (typeof v === 'object' && v !== null && 'toNumber' in v && typeof v.toNumber === 'function') return v.toNumber() as number
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export function jidIgnorado(jid: string | null | undefined): boolean {
  return !jid || !!isJidGroup(jid) || !!isJidBroadcast(jid) || !!isJidStatusBroadcast(jid) || !!isJidNewsletter(jid)
}

export function telefoneDoJid(jid: string | null | undefined): string | null {
  if (!jid || !isPnUser(jid)) return null
  const user = jidDecode(jid)?.user
  return user && /^\d{8,15}$/.test(user) ? user : null
}

export interface Identidade {
  jid: string
  telefone: string | null
  lid: string | null
}

/** Quem mandou: o chat para responder, o telefone (se a conexão souber) e o LID. */
export function identidade(msg: WAMessage): Identidade | null {
  const jid = msg.key.remoteJid
  if (jidIgnorado(jid)) return null
  const alt = msg.key.remoteJidAlt ?? null
  const telefone = telefoneDoJid(jid) ?? telefoneDoJid(alt)
  const lid = isLidUser(jid!) ? jid! : alt && isLidUser(alt) ? alt : null
  return { jid: jid!, telefone, lid }
}

/**
 * Traduz o conteúdo para o motor. Devolve null para o que deve ser ignorado
 * em silêncio (reações, edições, votos — que são tratados à parte).
 */
export function entradaDaMensagem(msg: WAMessage): Entrada | null {
  const c = normalizeMessageContent(msg.message)
  if (!c) return null
  if (c.conversation) return { tipo: 'texto', texto: c.conversation }
  if (c.extendedTextMessage?.text) return { tipo: 'texto', texto: c.extendedTextMessage.text }
  if (c.documentMessage) {
    return {
      tipo: 'arquivo',
      mimetype: c.documentMessage.mimetype ?? 'application/octet-stream',
      nomeArquivo: c.documentMessage.fileName ?? null,
      tamanho: paraNumero(c.documentMessage.fileLength)
    }
  }
  if (c.imageMessage) {
    return {
      tipo: 'arquivo',
      mimetype: c.imageMessage.mimetype ?? 'image/jpeg',
      nomeArquivo: null,
      tamanho: paraNumero(c.imageMessage.fileLength)
    }
  }
  if (
    c.audioMessage ||
    c.videoMessage ||
    c.stickerMessage ||
    c.locationMessage ||
    c.liveLocationMessage ||
    c.contactMessage ||
    c.contactsArrayMessage ||
    c.ptvMessage
  ) {
    return { tipo: 'nao_suportado' }
  }
  return null
}

/** As opções de enquete chegam no voto como SHA-256 do texto. */
export function hashOpcao(opcao: string): string {
  return createHash('sha256').update(Buffer.from(opcao)).digest('hex')
}

export function opcoesVotadas(hashes: Uint8Array[], opcoes: string[]): string[] {
  const porHash = new Map(opcoes.map((o) => [hashOpcao(o), o]))
  return hashes.map((h) => porHash.get(Buffer.from(h).toString('hex'))).filter((o): o is string => !!o)
}
