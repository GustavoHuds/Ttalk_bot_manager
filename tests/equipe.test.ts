import type { FastifyInstance } from 'fastify'
import { describe, expect, it } from 'vitest'
import { ArmazemArquivos } from '../src/arquivos.js'
import { FonteBots } from '../src/config/bots.js'
import { abrirBanco } from '../src/db/banco.js'
import type { Funcionario } from '../src/db/grupos.js'
import { RepoGrupos } from '../src/db/grupos.js'
import { RepoNumeros } from '../src/db/numeros.js'
import { Repositorio } from '../src/db/repositorio.js'
import { ErroEquipe, MAX_LINHAS_CSV, dividirLinhaCsv, lerCsvEquipe, validarFuncionario } from '../src/grupos/equipe.js'
import { hashSenha } from '../src/painel/auth.js'
import { gerarCsvEquipe } from '../src/painel/exportar.js'
import { criarPainel } from '../src/painel/servidor.js'
import { AGORA, log, padrao, pastaTemp } from './ajuda.js'

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

  it('apóstrofo de neutralização de fórmula (CSV reimportado) é ignorado no telefone', () => {
    expect(validarFuncionario({ nome: 'Ana Souza', telefone: "'+4512345678" }, { telefoneObrigatorio: false, lid: null })).toMatchObject({
      telefone: '4512345678'
    })
  })

  it('detecta separador por vírgula quando o arquivo usa vírgula em vez de ponto e vírgula', () => {
    const csv = 'nome,telefone,setor,loja,cargo,nascimento\nAna Souza,83999990001,Vendas,Centro,,'
    const r = lerCsvEquipe(csv)
    expect(r).toHaveLength(1)
    expect(r[0]!.dados).toMatchObject({ nome: 'Ana Souza', telefone: '5583999990001', setor: 'Vendas', loja: 'Centro' })
  })

  it('cabeçalho é reconhecido mesmo com uma linha vazia antes dele', () => {
    const csv = '\nnome;telefone\nAna Souza;83999990001'
    const r = lerCsvEquipe(csv)
    expect(r).toHaveLength(1)
    expect(r[0]!.dados).toMatchObject({ nome: 'Ana Souza', telefone: '5583999990001' })
  })

  it('arquivo com codificação errada (caracteres ilegíveis) é recusado com mensagem clara', () => {
    const csv = 'nome;telefone\nJo�o Silva;83999990001'
    expect(() => lerCsvEquipe(csv)).toThrow(ErroEquipe)
    expect(() => lerCsvEquipe(csv)).toThrow(/UTF-8/)
  })

  it('exportação e reimportação fazem o caminho de volta: telefone brasileiro e estrangeiro batem', () => {
    const funcionarios: Funcionario[] = [
      { id: 1, nome: 'Ana Souza', telefone: '5583999990001', lid: null, setor: 'Vendas', loja: 'Centro', cargo: null, nascimento: null, ativo: true },
      { id: 2, nome: 'John Smith', telefone: '12025550123', lid: null, setor: 'TI', loja: 'Remoto', cargo: null, nascimento: null, ativo: true }
    ]
    const csv = gerarCsvEquipe(funcionarios, new Set())
    const linhas = lerCsvEquipe(csv)
    expect(linhas.map((l) => l.dados?.telefone)).toEqual(['5583999990001', '12025550123'])
  })
})

describe('painel: equipe (telefone, CSV e auditoria)', () => {
  const form = { 'content-type': 'application/x-www-form-urlencoded' }

  async function painelDeEquipe() {
    const repo = new Repositorio(abrirBanco(':memory:'))
    const numeros = new RepoNumeros(repo.db)
    const grupos = new RepoGrupos(repo.db)
    const app = await criarPainel({
      repo,
      numeros,
      grupos,
      bots: new FonteBots(repo, padrao),
      relogio: () => AGORA,
      armazem: new ArmazemArquivos(pastaTemp()),
      log,
      conexoes: {
        estado: () => null,
        novaSessao: async () => {},
        ativar: async () => {},
        desativar: async () => {}
      },
      usuarios: new Map([['rh', hashSenha('senha-bem-longa')]]),
      segredo: 'x'.repeat(40),
      cookieSeguro: false,
      backupAtivo: false,
      alertaAtivo: false
    })
    const r = await app.inject({ method: 'POST', url: '/login', payload: 'usuario=rh&senha=senha-bem-longa', headers: form })
    const cookie = `sessao=${r.cookies.find((x) => x.name === 'sessao')!.value}`
    return { app, repo, grupos, cookie }
  }

  const post = (app: FastifyInstance, cookie: string, url: string, payload: Record<string, string>) =>
    app.inject({ method: 'POST', url, headers: { ...form, cookie }, payload: new URLSearchParams(payload).toString() })

  it('auditoria de gestor leva o id e o nome; exclusão só leva o id (sem prender o nome na auditoria)', async () => {
    const { app, repo, grupos, cookie } = await painelDeEquipe()
    const ana = grupos.salvarFuncionario(
      null,
      { nome: 'Ana Souza', telefone: '5583999990001', lid: null, setor: null, loja: null, cargo: null, nascimento: null, ativo: true },
      AGORA
    )
    await post(app, cookie, `/equipe/${ana}/gestor`, { ativo: '1' })
    expect(repo.auditoriaRecente(1)[0]).toMatchObject({ acao: 'gestor_adicionado', detalhe: `#${ana} Ana Souza` })
    await post(app, cookie, `/equipe/${ana}/excluir`, {})
    expect(repo.auditoriaRecente(1)[0]).toMatchObject({ acao: 'excluir_funcionario', detalhe: `#${ana}` })
  })

  it('importação com célula vazia mantém o valor atual (setor, loja, cargo, nascimento); prévia ainda diz "atualiza"', async () => {
    const { app, grupos, cookie } = await painelDeEquipe()
    const id = grupos.salvarFuncionario(
      null,
      { nome: 'Ana', telefone: '5583999990001', lid: null, setor: 'Vendas', loja: 'Centro', cargo: 'Gerente', nascimento: '1990-05-10', ativo: true },
      AGORA
    )
    const csv = 'Ana Souza;83999990001;;;;'
    const previa = await post(app, cookie, '/equipe/importar', { csv })
    expect(previa.statusCode).toBe(200)
    expect(previa.body).toContain('atualiza')
    const r = await post(app, cookie, '/equipe/importar', { csv, confirmar: '1' })
    expect(r.statusCode).toBe(303)
    expect(grupos.funcionario(id)).toMatchObject({
      nome: 'Ana Souza',
      setor: 'Vendas',
      loja: 'Centro',
      cargo: 'Gerente',
      nascimento: '1990-05-10'
    })
  })

  it('gestor que ficou inativo aparece como "gestor (inativo)" na lista da equipe', async () => {
    const { app, grupos, cookie } = await painelDeEquipe()
    const id = grupos.salvarFuncionario(
      null,
      { nome: 'Ana Souza', telefone: '5583999990001', lid: null, setor: null, loja: null, cargo: null, nascimento: null, ativo: true },
      AGORA
    )
    grupos.adicionarGestor(id, 'painel:rh', AGORA)
    // sem o campo "ativo" no corpo: validarFuncionario entende como desmarcado e desativa o cadastro.
    await post(app, cookie, '/equipe/salvar', { id: String(id), nome: 'Ana Souza', telefone: '83999990001' })
    const pagina = await app.inject({ url: '/equipe', headers: { cookie } })
    expect(pagina.body).toContain('👔 gestor (inativo)')
  })

  it('nome com tentativa de XSS fica escapado na prévia e no textarea escondido do CSV', async () => {
    const { app, cookie } = await painelDeEquipe()
    const csv = '</textarea><script>x</script>;83999990001;;;;'
    const r = await post(app, cookie, '/equipe/importar', { csv })
    expect(r.statusCode).toBe(200)
    expect(r.body).not.toContain('<script>x</script>')
    expect(r.body).toContain('&lt;script&gt;')
  })

  it('editar e salvar sem mexer mantém a chave do telefone, brasileiro ou estrangeiro', async () => {
    const { app, grupos, cookie } = await painelDeEquipe()
    for (const telefone of ['4512345678', '14155550123', '5583999990001']) {
      const id = grupos.salvarFuncionario(
        null,
        { nome: 'Ana Souza', telefone, lid: null, setor: null, loja: null, cargo: null, nascimento: null, ativo: true },
        AGORA
      )
      const pagina = await app.inject({ url: `/equipe/${id}`, headers: { cookie } })
      const preenchido = /<input name="telefone" value="([^"]*)"/.exec(pagina.body)![1]!
      const r = await post(app, cookie, '/equipe/salvar', { id: String(id), nome: 'Ana Souza', telefone: preenchido, ativo: '1' })
      expect(r.statusCode).toBe(303)
      expect(grupos.funcionario(id)!.telefone).toBe(telefone)
      grupos.excluirFuncionario(id)
    }
  })

  it('excluir um gestor remove também o vínculo de gestor (cascata)', async () => {
    const { app, grupos, cookie } = await painelDeEquipe()
    const id = grupos.salvarFuncionario(
      null,
      { nome: 'Ana Souza', telefone: '5583999990001', lid: null, setor: null, loja: null, cargo: null, nascimento: null, ativo: true },
      AGORA
    )
    grupos.adicionarGestor(id, 'painel:rh', AGORA)
    expect(grupos.gestores()).toEqual([id])
    await post(app, cookie, `/equipe/${id}/excluir`, {})
    expect(grupos.gestores()).toEqual([])
  })
})
