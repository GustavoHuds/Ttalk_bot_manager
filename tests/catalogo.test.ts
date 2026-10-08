import { describe, expect, it } from 'vitest'
import type { ComandoSalvo } from '../src/db/bots-grupos.js'
import {
  COMANDOS_PADRAO,
  TEXTOS,
  comandosDoBot,
  preencher,
  texto,
  validarPersonalizado,
  validarTexto
} from '../src/grupos/catalogo.js'
import { COMANDOS, acharComando } from '../src/grupos/comandos.js'

const salvo = (extra: Partial<ComandoSalvo> & { nome: string }): ComandoSalvo => ({
  ligado: true, personalizado: false, quem: null, onde: null, descricao: null, resposta: null, textos: {}, ...extra
})

describe('catálogo de comandos', () => {
  it('todo comando pronto tem exemplo; /confirmar existe, é fixo e vale só no privado', () => {
    for (const c of COMANDOS) expect(c.exemplo, c.nome).toMatch(/^\//)
    expect(acharComando('confirmar')).toMatchObject({ onde: 'privado', gestor: false, fixo: true })
    expect(acharComando('menu')!.fixo).toBe(true)
    expect(acharComando('quem')!.fixo).toBeUndefined()
  })

  it('preencher troca só os campos conhecidos', () => {
    expect(preencher('Oi {nome}, {total} itens {xyz}', { nome: 'Ana', total: 3 })).toBe('Oi Ana, 3 itens {xyz}')
  })

  it('validarTexto: só os campos do texto, nada vazio, até 1000 caracteres', () => {
    expect(validarTexto('status', 'resumo', 'Ok: {grupos} grupos e {pessoas} pessoas')).toBeNull()
    expect(validarTexto('status', 'resumo', 'Ok {xyz}')).toBe('Campo desconhecido: {xyz}. Use: {conexao}, {grupos}, {pessoas}, {gestores}.')
    expect(validarTexto('status', 'resumo', 'x'.repeat(1001))).toBe('Texto longo demais (máximo 1000 caracteres).')
    expect(validarTexto('status', 'nao_existe', 'x')).toBe('Texto desconhecido.')
    expect(validarTexto('menu', 'titulo', 'Sem campos')).toBeNull()
  })

  it('validarPersonalizado normaliza o nome e recusa o que já existe', () => {
    expect(validarPersonalizado({ nome: '/Horário', descricao: ' horário das lojas ', quem: 'todos', onde: 'ambos', resposta: ' Seg a sáb ' })).toEqual({
      ok: { nome: 'horario', descricao: 'horário das lojas', quem: 'todos', onde: 'ambos', resposta: 'Seg a sáb' }
    })
    expect(validarPersonalizado({ nome: 'quem', descricao: 'x', quem: 'todos', onde: 'ambos', resposta: 'x' })).toEqual({
      erro: 'O comando /quem já existe. Escolha outro nome.'
    })
    expect(validarPersonalizado({ nome: 'ajuda', descricao: 'x', quem: 'todos', onde: 'ambos', resposta: 'x' })).toEqual({
      erro: 'O comando /ajuda já existe. Escolha outro nome.'
    })
    expect(validarPersonalizado({ nome: 'a', descricao: 'x', quem: 'todos', onde: 'ambos', resposta: 'x' })).toEqual({
      erro: 'Nome: de 2 a 20 letras, números ou _, sem espaços.'
    })
    expect(validarPersonalizado({ nome: 'pix', descricao: 'x', quem: 'todos', onde: 'ambos', resposta: '  ' })).toEqual({
      erro: 'Escreva a resposta (até 1000 caracteres).'
    })
    expect(validarPersonalizado({ nome: 'pix', descricao: '', quem: 'todos', onde: 'ambos', resposta: 'x' })).toEqual({
      erro: 'Escreva uma descrição curta (até 80 caracteres) para o /menu.'
    })
    expect(validarPersonalizado({ nome: 'pix', descricao: 'x', quem: 'outro' as never, onde: 'ambos', resposta: 'x' })).toEqual({
      erro: 'Escolha quem pode usar e onde vale.'
    })
  })

  it('comandosDoBot: menu e confirmar nunca desligam; textos e personalizados vêm do banco', () => {
    const c = comandosDoBot(
      new Map([
        ['quem', salvo({ nome: 'quem', ligado: false })],
        ['menu', salvo({ nome: 'menu', ligado: false })],
        ['confirmar', salvo({ nome: 'confirmar', ligado: false })],
        ['status', salvo({ nome: 'status', textos: { resumo: 'Tudo certo: {grupos}' } })],
        ['pix', salvo({ nome: 'pix', personalizado: true, quem: 'todos', onde: 'grupo', descricao: 'chave pix', resposta: 'CNPJ 123' })]
      ])
    )
    expect([...c.desligados]).toEqual(['quem'])
    expect(c.personalizados).toEqual([{ nome: 'pix', descricao: 'chave pix', quem: 'todos', onde: 'grupo', resposta: 'CNPJ 123' }])
    expect(texto(c, 'status', 'resumo', { grupos: 4 })).toBe('Tudo certo: 4')
    expect(texto(c, 'log', 'titulo')).toBe('📜 Últimas ações')
    expect(texto(COMANDOS_PADRAO, 'gestores', 'lista', { lista: '@1 @2' })).toBe('👔 Gestores deste grupo: @1 @2')
  })

  it('cada texto padrão só usa os próprios campos', () => {
    for (const [cmd, lista] of Object.entries(TEXTOS)) {
      for (const t of lista) expect(validarTexto(cmd as never, t.chave, t.padrao), `${cmd}.${t.chave}`).toBeNull()
    }
  })
})
