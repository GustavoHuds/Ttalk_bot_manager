import { beforeEach, describe, expect, it } from 'vitest'
import { abrirBanco } from '../src/db/banco.js'
import { RepoGrupos, type DadosFuncionario } from '../src/db/grupos.js'
import { RepoNumeros } from '../src/db/numeros.js'
import { Repositorio } from '../src/db/repositorio.js'
import { AGORA } from './ajuda.js'

const ANA: DadosFuncionario = {
  nome: 'Ana Souza',
  telefone: '5583999990001',
  lid: null,
  setor: 'Vendas',
  loja: 'Centro',
  cargo: 'Gerente',
  nascimento: null,
  ativo: true
}

describe('repositório do bot de grupos', () => {
  let repo: Repositorio
  let g: RepoGrupos
  const N = 2

  beforeEach(() => {
    repo = new Repositorio(abrirBanco(':memory:'))
    new RepoNumeros(repo.db).criar('Avisos', 'grupos', AGORA)
    new RepoNumeros(repo.db).criar('Outro', 'grupos', AGORA)
    g = new RepoGrupos(repo.db)
  })

  it('grupo relido mantém as etiquetas; o que sumiu da lista fica inativo', () => {
    g.salvarGrupo(N, 'a@g.us', 'Loja Centro', false, AGORA)
    g.salvarGrupo(N, 'b@g.us', 'Loja Sul', true, AGORA)
    expect(g.etiquetarGrupo(N, 'a@g.us', 'Vendas', 'Centro', AGORA)).toBe(true)
    g.salvarGrupo(N, 'a@g.us', 'Loja Centro (novo)', true, AGORA + 1)
    expect(g.grupo(N, 'a@g.us')).toMatchObject({ nome: 'Loja Centro (novo)', botAdmin: true, setor: 'Vendas', loja: 'Centro', ativo: true })
    expect(g.desativarAusentes(N, ['a@g.us'], AGORA + 2)).toBe(1)
    expect(g.grupos(N).map((x) => x.jid)).toEqual(['a@g.us'])
    expect(g.grupo(N, 'b@g.us')).toMatchObject({ ativo: false, botAdmin: false })
    expect(g.todosGrupos()).toHaveLength(2)
  })

  it('funcionário: telefone é único, LID só é gravado uma vez, gestor sai junto com o cadastro', () => {
    const id = g.salvarFuncionario(null, ANA, AGORA)
    expect(g.porTelefone('5583999990001')!.id).toBe(id)
    expect(() => g.salvarFuncionario(null, { ...ANA, nome: 'Outra' }, AGORA)).toThrow()
    g.vincularLid(id, '111@lid', AGORA)
    g.vincularLid(id, '222@lid', AGORA)
    expect(g.funcionario(id)!.lid).toBe('111@lid')
    g.salvarFuncionario(id, { ...ANA, cargo: null, ativo: false, lid: '111@lid' }, AGORA)
    expect(g.funcionario(id)).toMatchObject({ cargo: null, ativo: false })
    g.adicionarGestor(id, 'painel:rh', AGORA)
    g.adicionarGestor(id, 'painel:rh', AGORA)
    expect(g.gestores()).toEqual([id])
    expect(g.excluirFuncionario(id)).toBe(true)
    expect(g.gestores()).toEqual([])
  })

  it('comando: a mesma mensagem só é registrada uma vez por número', () => {
    expect(g.comandoVisto(N, 'X')).toBe(false)
    expect(g.registrarComando(N, 'X', 'a@g.us', AGORA)).toBe(true)
    expect(g.registrarComando(N, 'X', 'a@g.us', AGORA)).toBe(false)
    expect(g.comandoVisto(N, 'X')).toBe(true)
    expect(g.registrarComando(3, 'X', 'a@g.us', AGORA)).toBe(true)
    expect(repo.filas().entrada).toBe(0)
  })

  it('caixa de saída dos grupos sai em ordem, por número, e conta na fila geral', () => {
    g.enfileirarSaida(N, 'a@g.us', '{"n":1}', AGORA)
    g.enfileirarSaida(N, 'a@g.us', '{"n":2}', AGORA)
    g.enfileirarSaida(3, 'c@g.us', '{"n":3}', AGORA)
    expect(g.jidsComSaida(N, AGORA)).toEqual(['a@g.us'])
    const primeiro = g.proximaSaida(N, 'a@g.us')!
    expect(primeiro.conteudo).toBe('{"n":1}')
    g.adiarSaida(primeiro.id, AGORA + 5000)
    expect(g.jidsComSaida(N, AGORA)).toEqual([])
    expect(g.proximaSaida(N, 'a@g.us')).toMatchObject({ tentativas: 1, proximaEm: AGORA + 5000 })
    g.removerSaida(primeiro.id)
    expect(g.proximaSaida(N, 'a@g.us')!.conteudo).toBe('{"n":2}')
    expect(repo.filas().saida).toBe(2)

    // duas filas no mesmo número: uma com a cabeça adiada, outra pronta — só a pronta volta.
    g.enfileirarSaida(N, 'd@g.us', '{"n":4}', AGORA)
    const segundo = g.proximaSaida(N, 'a@g.us')!
    g.adiarSaida(segundo.id, AGORA + 9000)
    expect(g.jidsComSaida(N, AGORA)).toEqual(['d@g.us'])
    // passado o horário do reenvio, a fila adiada volta a aparecer.
    expect(g.jidsComSaida(N, AGORA + 9000)).toEqual(['a@g.us', 'd@g.us'])
  })

  it('salvarFuncionario com id inexistente lança erro', () => {
    expect(() => g.salvarFuncionario(999, ANA, AGORA)).toThrow('funcionário não encontrado')
  })

  it('enfileirarSaida com número inexistente lança erro (FK)', () => {
    expect(() => g.enfileirarSaida(99, 'x@g.us', '{}', AGORA)).toThrow()
  })
})
