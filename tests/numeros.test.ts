import { describe, expect, it } from 'vitest'
import { abrirBanco } from '../src/db/banco.js'
import { RepoNumeros } from '../src/db/numeros.js'
import { AGORA } from './ajuda.js'

describe('números', () => {
  it('começa com o Principal; cria, lista e desativa sem apagar', () => {
    const numeros = new RepoNumeros(abrirBanco(':memory:'))
    expect(numeros.listar().map((n) => [n.id, n.nome, n.papel, n.ativo])).toEqual([[1, 'Principal', 'recrutamento', true]])
    const g = numeros.criar('Avisos', 'grupos', AGORA)
    expect(g).toEqual({ id: 2, nome: 'Avisos', papel: 'grupos', ativo: true, pausado: false, criadoEm: AGORA })
    numeros.definirPausado(2, true)
    expect(numeros.numero(2)!.pausado).toBe(true)
    numeros.definirAtivo(2, false)
    expect(numeros.numero(2)!.ativo).toBe(false)
    expect(numeros.numero(99)).toBeNull()
  })
})
