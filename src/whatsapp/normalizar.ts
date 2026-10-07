import { createHash } from 'node:crypto'
import {
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  isLidUser,
  isPnUser,
  jidDecode,
  jidNormalizedUser,
  normalizeMessageContent,
  type GroupMetadata,
  type WAMessage
} from '@whiskeysockets/baileys'
import type { InfoGrupo, MembroGrupo, Pessoa } from '../grupos/tipos.js'
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

/** Bot de grupos: aceita grupos e conversas privadas; nunca status, listas de transmissão ou canais. */
export function jidIgnoradoGrupos(jid: string | null | undefined): boolean {
  return !jid || !!isJidBroadcast(jid) || !!isJidStatusBroadcast(jid) || !!isJidNewsletter(jid)
}

/** Só o texto digitado (comandos não vêm em legenda de foto). */
export function textoDaMensagem(msg: WAMessage): string | null {
  const c = normalizeMessageContent(msg.message)
  return c?.conversation || c?.extendedTextMessage?.text || null
}

function lidDe(...jids: (string | null | undefined)[]): string | null {
  for (const j of jids) if (j && isLidUser(j)) return jidNormalizedUser(j)
  return null
}

/** Onde responder e quem mandou. No grupo, o remetente é o participante (LID ou telefone). */
export function origemComando(msg: WAMessage): { chat: string; ehGrupo: boolean; remetente: Pessoa } | null {
  const chat = msg.key.remoteJid
  if (!chat || jidIgnoradoGrupos(chat)) return null
  if (!isJidGroup(chat)) {
    const quem = identidade(msg)
    return quem ? { chat, ehGrupo: false, remetente: quem } : null
  }
  const autor = msg.key.participant ? jidNormalizedUser(msg.key.participant) : null
  if (!autor) return null
  const alt = msg.key.participantAlt ? jidNormalizedUser(msg.key.participantAlt) : null
  return { chat, ehGrupo: true, remetente: { jid: autor, telefone: telefoneDoJid(autor) ?? telefoneDoJid(alt), lid: lidDe(autor, alt) } }
}

export function mencoesDaMensagem(msg: WAMessage): { mencionados: string[]; citada: string | null } {
  const info = normalizeMessageContent(msg.message)?.extendedTextMessage?.contextInfo
  const mencionados = (info?.mentionedJid ?? []).filter((j): j is string => !!j).map((j) => jidNormalizedUser(j))
  const citada = info?.quotedMessage && info.participant ? jidNormalizedUser(info.participant) : null
  return { mencionados, citada }
}

type Participante = string | { id: string; lid?: string | undefined; phoneNumber?: string | undefined }

/** O bot aparece no grupo pelo telefone ou pelo LID, conforme o modo do grupo. */
export function souEu(eu: string[], p: Participante): boolean {
  const ids = typeof p === 'string' ? [p] : [p.id, p.lid, p.phoneNumber]
  return ids.filter((j): j is string => !!j).some((j) => eu.includes(jidNormalizedUser(j)))
}

export function infoDoGrupo(g: GroupMetadata, eu: string[]): InfoGrupo {
  return { jid: g.id, nome: g.subject || 'Grupo sem nome', botAdmin: (g.participants ?? []).some((p) => souEu(eu, p) && !!p.admin) }
}

/** Participantes sem o próprio bot. */
export function membrosDoGrupo(g: GroupMetadata, eu: string[]): MembroGrupo[] {
  return (g.participants ?? [])
    .filter((p) => !souEu(eu, p))
    .map((p) => {
      const id = jidNormalizedUser(p.id)
      const pn = p.phoneNumber ? jidNormalizedUser(p.phoneNumber) : null
      return { jid: id, telefone: telefoneDoJid(id) ?? telefoneDoJid(pn), lid: lidDe(p.id, p.lid), admin: !!p.admin }
    })
}
