import { describe, expect, it } from 'vitest'
import type { Funcionario } from '../src/db/grupos.js'
import { COMANDOS, acharComando, ehComando, interpretar } from '../src/grupos/comandos.js'
import { acharFuncionario, formatarTelefone, pessoaDoJid, telefoneCanonico, usuarioDoJid, vinculosDeLid } from '../src/grupos/pessoas.js'

const f = (id: number, telefone: string | null, lid: string | null): Funcionario => ({
  id,
  nome: `F${id}`,
  telefone,
  lid,
  setor: null,
  loja: null,
  cargo: null,
  nascimento: null,
  ativo: true
})

describe('parser de comandos', () => {
  it('reconhece só texto que começa com /palavra', () => {
    expect(ehComando('/menu')).toBe(true)
    expect(ehComando('  /Cadastrar x')).toBe(true)
    expect(ehComando('bom dia /menu')).toBe(false)
    expect(ehComando('/ 1')).toBe(false)
    expect(ehComando('/')).toBe(false)
    expect(ehComando(null)).toBe(false)
  })

  it('nome sem acento e minúsculo; menções saem dos argumentos; | separa campos', () => {
    const c = interpretar('/CADASTRAR @5583999990001 Ana  Souza | Vendas |Centro', ['5583999990001@s.whatsapp.net'], null)!
    expect(c).toEqual({
      nome: 'cadastrar',
      args: 'Ana Souza | Vendas |Centro',
      campos: ['Ana Souza', 'Vendas', 'Centro'],
      mencionados: ['5583999990001@s.whatsapp.net'],
      citada: null
    })
    expect(interpretar('/Gestóres')!.nome).toBe('gestores')
    expect(interpretar('/quem', [], '111@lid')!.citada).toBe('111@lid')
    expect(interpretar('/menu')!.campos).toEqual([])
    expect(interpretar('oi')).toBeNull()
    expect(interpretar(`/menu ${'x'.repeat(3000)}`)).toBeNull()
  })

  it('apelidos levam ao comando certo; desconhecido devolve null', () => {
    expect(acharComando('ajuda')!.nome).toBe('menu')
    expect(acharComando('help')!.nome).toBe('menu')
    expect(acharComando('cadastrar')!.gestor).toBe(true)
    expect(acharComando('xyz')).toBeNull()
    expect(new Set(COMANDOS.map((c) => c.nome)).size).toBe(COMANDOS.length)
  })
})

describe('pessoas', () => {
  it('telefone canônico: 55 + DDD + número, com o 9 dos celulares', () => {
    expect(telefoneCanonico('(83) 99999-0001')).toBe('5583999990001')
    expect(telefoneCanonico('+55 83 99999-0001')).toBe('5583999990001')
    expect(telefoneCanonico('558399990001')).toBe('5583999990001')
    expect(telefoneCanonico('558332220000')).toBe('558332220000')
    expect(telefoneCanonico('123')).toBeNull()
    expect(telefoneCanonico(null)).toBeNull()
    expect(formatarTelefone('5583999990001')).toBe('+55 83 99999-0001')
  })

  it('JID solto vira pessoa; dispositivo é ignorado', () => {
    expect(usuarioDoJid('5583999990001:12@s.whatsapp.net')).toBe('5583999990001')
    expect(pessoaDoJid('558399990001@s.whatsapp.net')).toEqual({
      jid: '558399990001@s.whatsapp.net',
      telefone: '5583999990001',
      lid: null
    })
    expect(pessoaDoJid('111:3@lid')).toEqual({ jid: '111:3@lid', telefone: null, lid: '111@lid' })
  })

  it('acha no cadastro pelo telefone, senão pelo LID', () => {
    const lista = [f(1, '5583999990001', null), f(2, null, '222@lid')]
    expect(acharFuncionario(lista, { jid: 'x', telefone: '558399990001', lid: null })!.id).toBe(1)
    expect(acharFuncionario(lista, { jid: 'x', telefone: null, lid: '222@lid' })!.id).toBe(2)
    expect(acharFuncionario(lista, { jid: 'x', telefone: null, lid: '333@lid' })).toBeNull()
  })

  it('LID novo só é ligado a quem tem o telefone e ainda não tem LID', () => {
    const lista = [f(1, '5583999990001', null), f(2, '5583999990002', '222@lid'), f(3, '5583999990003', null)]
    const pessoas = [
      { jid: 'a', telefone: '5583999990001', lid: '111@lid' },
      { jid: 'b', telefone: '5583999990001', lid: '111@lid' },
      { jid: 'c', telefone: '5583999990002', lid: '999@lid' },
      { jid: 'd', telefone: '5583999990003', lid: '222@lid' },
      { jid: 'e', telefone: null, lid: '444@lid' }
    ]
    expect(vinculosDeLid(lista, pessoas)).toEqual([{ id: 1, lid: '111@lid' }])
  })
})
