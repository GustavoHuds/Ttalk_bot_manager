import { describe, expect, it } from 'vitest'
import { ErroEquipe, MAX_LINHAS_CSV, dividirLinhaCsv, lerCsvEquipe, validarFuncionario } from '../src/grupos/equipe.js'

describe('cadastro da equipe', () => {
  it('lê CSV com BOM, cabeçalho e aspas, com um erro por linha', () => {
    const csv = [
      '﻿nome;telefone;setor;loja;cargo;nascimento',
      'Ana Souza;(83) 99999-0001;Vendas;Centro;Gerente;10/05/1990',
      '"Souza; Beto";83999990002;Caixa;Sul;;',
      'X;123;;;;',
      'Caio Lima;83999990001;;;;',
      'Dani Reis;83999990004;;;;31/02/1990',
      ''
    ].join('\r\n')
    const r = lerCsvEquipe(csv)
    expect(r.map((l) => [l.linha, l.erro])).toEqual([
      [2, null],
      [3, null],
      [4, 'nome é obrigatório (até 80 caracteres)'],
      [5, 'telefone repetido (já está na linha 2)'],
      [6, 'nascimento não é uma data válida']
    ])
    expect(r[0]!.dados).toEqual({
      nome: 'Ana Souza', telefone: '5583999990001', lid: null, setor: 'Vendas', loja: 'Centro',
      cargo: 'Gerente', nascimento: '1990-05-10', ativo: true
    })
    expect(r[1]!.dados).toMatchObject({ nome: 'Souza; Beto', cargo: null, nascimento: null })
  })

  it('aspas duplas dentro de campo', () => {
    expect(dividirLinhaCsv('"a ""b""";c')).toEqual(['a "b"', 'c'])
  })

  it('telefone só é obrigatório quando pedido; telefone inválido sempre é erro', () => {
    expect(validarFuncionario({ nome: 'Ana Souza' }, { telefoneObrigatorio: false, lid: '1@lid' })).toMatchObject({ telefone: null, lid: '1@lid' })
    expect(() => validarFuncionario({ nome: 'Ana Souza' }, { telefoneObrigatorio: true, lid: null })).toThrow('telefone é obrigatório')
    expect(() => validarFuncionario({ nome: 'Ana Souza', telefone: '99' }, { telefoneObrigatorio: false, lid: null })).toThrow(ErroEquipe)
  })

  it('telefone internacional digitado com "+" (fora do Brasil) mantém os dígitos; sem "+" assume o Brasil', () => {
    expect(validarFuncionario({ nome: 'Ana Souza', telefone: '+1 202-555-0123' }, { telefoneObrigatorio: false, lid: null })).toMatchObject({
      telefone: '12025550123'
    })
    expect(validarFuncionario({ nome: 'Ana Souza', telefone: '+55 83 99999-0001' }, { telefoneObrigatorio: false, lid: null })).toMatchObject({
      telefone: '5583999990001'
    })
    expect(() => validarFuncionario({ nome: 'Ana Souza', telefone: '+123' }, { telefoneObrigatorio: false, lid: null })).toThrow(ErroEquipe)
  })

  it('arquivo grande demais é recusado inteiro', () => {
    const csv = Array.from({ length: MAX_LINHAS_CSV + 1 }, (_, i) => `P${i} Silva;8399999${String(i).padStart(4, '0')}`).join('\n')
    expect(() => lerCsvEquipe(csv)).toThrow(ErroEquipe)
  })
})
