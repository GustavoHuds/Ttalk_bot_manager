import { describe, expect, it } from 'vitest'
import type { GroupMetadata, WAMessage } from '@whiskeysockets/baileys'
import { entradaDaMensagem, hashOpcao, identidade, opcoesVotadas } from '../src/whatsapp/normalizar.js'
import {
  comandoDaMensagem,
  infoDoGrupo,
  jidIgnoradoGrupos,
  membrosDoGrupo,
  mencoesDaMensagem,
  origemComando,
  souEu,
  textoDaMensagem
} from '../src/whatsapp/normalizar.js'

const base = (message: object, key: object = {}) =>
  ({ key: { remoteJid: '5583999990000@s.whatsapp.net', id: 'X', fromMe: false, ...key }, message }) as never

describe('normalização das mensagens do Baileys', () => {
  it('texto simples e texto estendido', () => {
    expect(entradaDaMensagem(base({ conversation: 'oi' }))).toEqual({ tipo: 'texto', texto: 'oi' })
    expect(entradaDaMensagem(base({ extendedTextMessage: { text: 'olá' } }))).toEqual({ tipo: 'texto', texto: 'olá' })
  })

  it('documento com legenda e foto viram arquivo', () => {
    const doc = base({
      documentWithCaptionMessage: { message: { documentMessage: { mimetype: 'application/pdf', fileName: 'cv.pdf', fileLength: 2048 } } }
    })
    expect(entradaDaMensagem(doc)).toEqual({ tipo: 'arquivo', mimetype: 'application/pdf', nomeArquivo: 'cv.pdf', tamanho: 2048 })
    expect(entradaDaMensagem(base({ imageMessage: { mimetype: 'image/jpeg', fileLength: { toNumber: () => 9 } } }))).toEqual({
      tipo: 'arquivo',
      mimetype: 'image/jpeg',
      nomeArquivo: null,
      tamanho: 9
    })
  })

  it('áudio e figurinha são não suportados; reação é ignorada', () => {
    expect(entradaDaMensagem(base({ audioMessage: {} }))).toEqual({ tipo: 'nao_suportado' })
    expect(entradaDaMensagem(base({ stickerMessage: {} }))).toEqual({ tipo: 'nao_suportado' })
    expect(entradaDaMensagem(base({ reactionMessage: { text: 'ok' } }))).toBeNull()
  })

  it('identidade: telefone do JID, do campo alternativo (LID) ou nenhum', () => {
    expect(identidade(base({}))).toEqual({ jid: '5583999990000@s.whatsapp.net', telefone: '5583999990000', lid: null })
    expect(identidade(base({}, { remoteJid: '987@lid', remoteJidAlt: '5583911112222@s.whatsapp.net' }))).toEqual({
      jid: '987@lid',
      telefone: '5583911112222',
      lid: '987@lid'
    })
    expect(identidade(base({}, { remoteJid: '987@lid' }))).toEqual({ jid: '987@lid', telefone: null, lid: '987@lid' })
    expect(identidade(base({}, { remoteJid: '1203630@g.us' }))).toBeNull()
    expect(identidade(base({}, { remoteJid: 'status@broadcast' }))).toBeNull()
  })

  it('voto chega como hash da opção e volta ao texto', () => {
    expect(opcoesVotadas([Buffer.from(hashOpcao('Tarde'), 'hex')], ['Manhã', 'Tarde'])).toEqual(['Tarde'])
  })
})

const msgGrupo = (extra: Record<string, unknown> = {}) =>
  ({
    key: { remoteJid: '120363-1@g.us', participant: '111@lid', participantAlt: '5583999990001@s.whatsapp.net', id: 'X', fromMe: false },
    message: { extendedTextMessage: { text: '/quem @222', contextInfo: { mentionedJid: ['222@lid'] } } },
    ...extra
  }) as unknown as WAMessage

describe('bot de grupos: leitura das mensagens', () => {
  it('no grupo, o remetente é o participante, com telefone e LID', () => {
    expect(origemComando(msgGrupo())).toEqual({
      chat: '120363-1@g.us',
      ehGrupo: true,
      remetente: { jid: '111@lid', telefone: '5583999990001', lid: '111@lid' }
    })
  })

  it('no privado, o remetente é o próprio chat; status e canais são ignorados', () => {
    const privado = { key: { remoteJid: '5583999990001@s.whatsapp.net', id: 'Y' }, message: { conversation: '/menu' } } as unknown as WAMessage
    expect(origemComando(privado)).toEqual({
      chat: '5583999990001@s.whatsapp.net',
      ehGrupo: false,
      remetente: { jid: '5583999990001@s.whatsapp.net', telefone: '5583999990001', lid: null }
    })
    expect(origemComando({ key: { remoteJid: 'status@broadcast', id: 'Z' } } as unknown as WAMessage)).toBeNull()
    expect(jidIgnoradoGrupos('120363-1@g.us')).toBe(false)
    expect(jidIgnoradoGrupos('123@newsletter')).toBe(true)
  })

  it('texto, menções e mensagem citada', () => {
    expect(textoDaMensagem(msgGrupo())).toBe('/quem @222')
    expect(mencoesDaMensagem(msgGrupo())).toEqual({ mencionados: ['222@lid'], citada: null })
    const resposta = msgGrupo({
      message: { extendedTextMessage: { text: '/quem', contextInfo: { participant: '333@lid', quotedMessage: { conversation: 'oi' } } } }
    })
    expect(mencoesDaMensagem(resposta)).toEqual({ mencionados: [], citada: '333@lid' })
  })

  it('dados do grupo: o bot é reconhecido por qualquer um dos seus JIDs e sai da lista de membros', () => {
    const eu = ['5583900000000@s.whatsapp.net', '888@lid']
    const g = {
      id: '120363-1@g.us',
      subject: 'Loja Centro',
      participants: [
        { id: '888@lid', admin: 'admin' },
        { id: '111@lid', phoneNumber: '5583999990001@s.whatsapp.net', admin: null },
        { id: '5583999990002@s.whatsapp.net', admin: 'superadmin' }
      ]
    } as unknown as GroupMetadata
    expect(infoDoGrupo(g, eu)).toEqual({ jid: '120363-1@g.us', nome: 'Loja Centro', botAdmin: true })
    expect(membrosDoGrupo(g, eu)).toEqual([
      { jid: '111@lid', telefone: '5583999990001', lid: '111@lid', admin: false },
      { jid: '5583999990002@s.whatsapp.net', telefone: '5583999990002', lid: null, admin: true }
    ])
    expect(souEu(eu, '5583900000000:7@s.whatsapp.net')).toBe(true)
  })

  it('grupo com endereçamento por telefone: o participant já é o telefone, o alt é o LID', () => {
    const msg = msgGrupo({
      key: { remoteJid: '120363-1@g.us', participant: '5583999990001@s.whatsapp.net', participantAlt: '111@lid', id: 'X', fromMe: false }
    })
    expect(origemComando(msg)).toEqual({
      chat: '120363-1@g.us',
      ehGrupo: true,
      remetente: { jid: '5583999990001@s.whatsapp.net', telefone: '5583999990001', lid: '111@lid' }
    })
  })

  it('souEu também reconhece o participante pelo campo lid do objeto (não só id/phoneNumber)', () => {
    const eu = ['5583900000000@s.whatsapp.net', '888@lid']
    expect(souEu(eu, { id: '999@s.whatsapp.net', lid: '888@lid' })).toBe(true)
    expect(souEu(eu, { id: '999@s.whatsapp.net', lid: '777@lid' })).toBe(false)
  })

  it('textoDaMensagem ignora legenda de foto: comando não vem em legenda', () => {
    const comLegenda = msgGrupo({ message: { imageMessage: { caption: '/quem @222' } } })
    expect(textoDaMensagem(comLegenda)).toBeNull()
  })
})

describe('bot de grupos: o que vira comando', () => {
  it('texto comum (sem barra) nunca vira comando: a conversa do grupo não é revelada', () => {
    const comum = msgGrupo({ message: { extendedTextMessage: { text: 'bom dia a todos' } } })
    expect(comandoDaMensagem(comum, 7)).toBeNull()
  })

  it('mensagem do próprio bot, sem id ou sem conteúdo nunca é comando', () => {
    const comFromMe = msgGrupo({
      key: { remoteJid: '120363-1@g.us', participant: '111@lid', participantAlt: '5583999990001@s.whatsapp.net', id: 'X', fromMe: true }
    })
    expect(comandoDaMensagem(comFromMe, 7)).toBeNull()
    expect(comandoDaMensagem({ key: { remoteJid: '120363-1@g.us', participant: '111@lid' }, message: null } as unknown as WAMessage, 7)).toBeNull()
  })

  it('comando reconhecido chega pronto para o motor, com o numeroId da conexão', () => {
    expect(comandoDaMensagem(msgGrupo(), 7)).toEqual({
      numeroId: 7,
      id: 'X',
      chat: '120363-1@g.us',
      ehGrupo: true,
      remetente: { jid: '111@lid', telefone: '5583999990001', lid: '111@lid' },
      texto: '/quem @222',
      mencionados: ['222@lid'],
      citada: null,
      recebidaEm: expect.any(Number)
    })
  })
})
