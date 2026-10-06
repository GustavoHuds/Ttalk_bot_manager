import { describe, expect, it } from 'vitest'
import { entradaDaMensagem, hashOpcao, identidade, opcoesVotadas } from '../src/whatsapp/normalizar.js'

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
