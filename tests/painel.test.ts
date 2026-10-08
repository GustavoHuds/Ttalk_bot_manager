import type { FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'
import { ArmazemArquivos } from '../src/arquivos.js'
import { FonteBots, botModelo } from '../src/config/bots.js'
import { abrirBanco } from '../src/db/banco.js'
import { RepoBotsGrupos } from '../src/db/bots-grupos.js'
import { RepoGrupos } from '../src/db/grupos.js'
import type { Numero } from '../src/db/numeros.js'
import { RepoNumeros } from '../src/db/numeros.js'
import { Repositorio } from '../src/db/repositorio.js'
import { hashSenha } from '../src/painel/auth.js'
import { celula, gerarCsv } from '../src/painel/exportar.js'
import { linkWaMe } from '../src/painel/paginas.js'
import { criarPainel } from '../src/painel/servidor.js'
import type { EstadoConexao } from '../src/whatsapp/baileys.js'
import { AGORA, PDF, log, padrao, pastaTemp, processo } from './ajuda.js'

const form = { 'content-type': 'application/x-www-form-urlencoded' }

interface ConexoesFake {
  estado: (id: number) => EstadoConexao | null
  novaSessao: (id: number) => Promise<void>
  revogar: (id: number) => Promise<void>
  ativar: (n: Numero) => Promise<void>
  desativar: (id: number) => Promise<void>
}

// `conexoesExtra` permite a um teste substituir ativar/desativar/novaSessao por uma função que falha (rejeita),
// para exercitar o tratamento de erro do gerenciador sem derrubar o resto da configuração.
async function painelComBot(repo: Repositorio, armazem: ArmazemArquivos, conexoesExtra: Partial<ConexoesFake> = {}) {
  const modelo = botModelo('2026-10-06')
  repo.salvarBot(
    'VEND-OUT26',
    JSON.stringify({ ...modelo, codigo: 'VEND-OUT26', vaga: 'Vendedor(a) de loja', status: 'aberto', encerra_em: '2026-10-31' }),
    1,
    'teste',
    AGORA
  )
  const bots = new FonteBots(repo, padrao)
  const estados = new Map<number, EstadoConexao>([[1, { status: 'conectado', qr: null, desde: AGORA, numero: '5583900001111', motivo: null }]])
  const conexoes: ConexoesFake = {
    estado: (id) => estados.get(id) ?? null,
    novaSessao: async () => {},
    revogar: async () => {},
    ativar: async (n: Numero) => void estados.set(n.id, { status: 'aguardando_qr', qr: 'QR-TESTE', desde: AGORA, numero: null, motivo: null }),
    desativar: async (id) => void estados.delete(id),
    ...conexoesExtra
  }
  const app = await criarPainel({
    repo,
    numeros: new RepoNumeros(repo.db),
    grupos: new RepoGrupos(repo.db),
    botsGrupos: new RepoBotsGrupos(repo.db),
    bots,
    relogio: () => AGORA,
    armazem,
    log,
    conexoes,
    usuarios: new Map([['rh', hashSenha('senha-bem-longa')]]),
    segredo: 'x'.repeat(40),
    cookieSeguro: false,
    backupAtivo: false,
    alertaAtivo: false
  })
  return { app, bots, estados }
}

async function login(app: FastifyInstance): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/login', payload: 'usuario=rh&senha=senha-bem-longa', headers: form })
  return `sessao=${r.cookies.find((x) => x.name === 'sessao')!.value}`
}

describe('painel', () => {
  let app: FastifyInstance
  let repo: Repositorio
  let armazem: ArmazemArquivos
  let idArquivo: number

  beforeEach(async () => {
    repo = new Repositorio(abrirBanco(':memory:'))
    armazem = new ArmazemArquivos(pastaTemp())
    const id = repo.criarCandidatura(1, 'VEND-OUT26', 'x@s.whatsapp.net', '5583999990000', null, AGORA)
    repo.salvarResposta(id, 'nome', '=HYPERLINK("http://mal")', AGORA)
    repo.registrarArquivo(id, await armazem.salvar('VEND-OUT26', 'pdf', 'application/pdf', PDF, AGORA), AGORA)
    repo.concluir(id, AGORA)
    idArquivo = repo.candidatosDoProcesso('VEND-OUT26')[0]!.arquivos[0]!.id
    app = (await painelComBot(repo, armazem)).app
  })

  async function entrar(): Promise<string> {
    const r = await app.inject({ method: 'POST', url: '/login', payload: 'usuario=rh&senha=senha-bem-longa', headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    expect(r.statusCode).toBe(303)
    const c = r.cookies.find((x) => x.name === 'sessao')!
    return `sessao=${c.value}`
  }

  it('sem login redireciona; /healthz é público e não expõe dados', async () => {
    expect((await app.inject('/')).headers.location).toBe('/login')
    expect((await app.inject(`/arquivos/${idArquivo}`)).statusCode).toBe(303)
    const h = await app.inject('/healthz')
    expect(h.json()).toEqual({ ok: true })
  })

  it('senha errada é recusada e auditada; 5 erros bloqueiam o IP', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({ method: 'POST', url: '/login', payload: 'usuario=rh&senha=errada', headers: { 'content-type': 'application/x-www-form-urlencoded' } })
      expect(r.statusCode).toBe(401)
    }
    const bloqueado = await app.inject({ method: 'POST', url: '/login', payload: 'usuario=rh&senha=senha-bem-longa', headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    expect(bloqueado.statusCode).toBe(429)
    expect(repo.auditoriaRecente(10).filter((a) => a.acao === 'login_falhou')).toHaveLength(5)
  })

  it('lista processos com o link wa.me e candidatos com HTML escapado', async () => {
    const cookie = await entrar()
    const inicio = await app.inject({ url: '/', headers: { cookie } })
    expect(inicio.body).toContain('https://wa.me/5583900001111?text=Quero%20me%20candidatar%20%5BVEND-OUT26%5D')
    const lista = await app.inject({ url: '/processos/vend-out26', headers: { cookie } })
    expect(lista.statusCode).toBe(200)
    expect(lista.body).toContain('VEND-OUT26-0001')
    expect(lista.body).toContain('=HYPERLINK(&quot;http://mal&quot;)')
  })

  it('download registra quem baixou o quê', async () => {
    const cookie = await entrar()
    const r = await app.inject({ url: `/arquivos/${idArquivo}`, headers: { cookie } })
    expect(r.statusCode).toBe(200)
    expect(r.rawPayload.subarray(0, 4).toString()).toBe('%PDF')
    expect(r.headers['content-disposition']).toContain('VEND-OUT26-0001')
    expect(repo.auditoriaRecente(1)[0]).toMatchObject({ usuario: 'rh', acao: 'download' })
  })

  it('exporta ZIP com CSV e currículos', async () => {
    const cookie = await entrar()
    const r = await app.inject({ url: '/processos/VEND-OUT26/exportar', headers: { cookie } })
    expect(r.statusCode).toBe(200)
    expect(r.headers['content-type']).toBe('application/zip')
    expect(r.rawPayload.subarray(0, 2).toString()).toBe('PK')
    expect(r.rawPayload.includes(Buffer.from('candidatos.csv'))).toBe(true)
    expect(r.rawPayload.includes(Buffer.from('curriculos/VEND-OUT26-0001.pdf'))).toBe(true)
  })

  it('exclusão pelo painel apaga candidatura e arquivo', async () => {
    const cookie = await entrar()
    const caminho = repo.arquivo(idArquivo)!.caminho
    const r = await app.inject({ method: 'POST', url: `/candidaturas/1/excluir`, headers: { cookie } })
    expect(r.statusCode).toBe(303)
    expect(repo.candidatosDoProcesso('VEND-OUT26')).toHaveLength(0)
    const { existsSync } = await import('node:fs')
    expect(existsSync(armazem.absoluto(caminho))).toBe(false)
  })
})

describe('editor de bots', () => {
  let app: FastifyInstance
  let repo: Repositorio
  let bots: FonteBots
  let cookie: string

  beforeEach(async () => {
    repo = new Repositorio(abrirBanco(':memory:'))
    ;({ app, bots } = await painelComBot(repo, new ArmazemArquivos(pastaTemp())))
    repo.excluirBot('VEND-OUT26')
    bots.invalidar()
    const r = await app.inject({ method: 'POST', url: '/login', payload: 'usuario=rh&senha=senha-bem-longa', headers: form })
    cookie = `sessao=${r.cookies.find((x) => x.name === 'sessao')!.value}`
  })

  const salvar = (dados: unknown, acao: string, original = '') =>
    app.inject({
      method: 'POST',
      url: '/bots/salvar',
      headers: { ...form, cookie },
      payload: new URLSearchParams({ dados: JSON.stringify(dados), acao, original }).toString()
    })

  const novo = (extra: Record<string, unknown> = {}) => ({
    ...botModelo('2026-10-06'),
    codigo: 'caixa-nov26',
    vaga: 'Operador(a) de caixa',
    encerra_em: '2026-11-30',
    perguntas: [
      { tipo: 'texto', texto: 'Qual é o seu nome completo?', validacao: 'nome_completo' },
      { tipo: 'enquete', texto: 'Você tem experiência com caixa?', opcoes: ['Sim', 'Não', ''] },
      { tipo: 'arquivo', texto: 'Envie seu currículo.', formatos: ['pdf', 'jpg'], tamanho_max_mb: 5 }
    ],
    mensagens: { boas_vindas: 'Oi! Vaga de {vaga}.\nOlá! Vaga de {vaga}.', confirmacao: padrao.confirmacao },
    ...extra
  })

  it('formulário de novo bot vem com as perguntas do modelo', async () => {
    const r = await app.inject({ url: '/bots/novo', headers: { cookie } })
    expect(r.statusCode).toBe(200)
    expect(r.body).toContain('Para começar, qual é o seu nome completo?')
    expect(r.body).toContain('Abrir inscrições')
  })

  it('cria e abre um bot pelo painel; o motor passa a enxergá-lo na hora', async () => {
    const r = await salvar(novo(), 'aberto')
    expect(r.statusCode).toBe(303)
    const p = bots.get().processos.find((x) => x.codigo === 'CAIXA-NOV26')!
    expect(p.status).toBe('aberto')
    expect(p.perguntas.map((q) => q.chave)).toEqual(['nome_completo', 'experiencia_caixa', 'envie_curriculo'])
    expect(p.perguntas[1]).toMatchObject({ tipo: 'enquete', opcoes: ['Sim', 'Não'] })
    expect(p.mensagens.boas_vindas).toEqual(['Oi! Vaga de {vaga}.', 'Olá! Vaga de {vaga}.'])
    // texto igual ao padrão não é guardado como personalização
    expect(JSON.parse(repo.bot('CAIXA-NOV26')!).mensagens.confirmacao).toBeUndefined()
    expect(repo.auditoriaRecente(1)[0]).toMatchObject({ usuario: 'rh', acao: 'criar_bot' })
    const inicio = await app.inject({ url: '/', headers: { cookie } })
    expect(inicio.body).toContain('Operador(a) de caixa')
    expect(inicio.body).toContain('%5BCAIXA-NOV26%5D')
  })

  it('editar mantém as chaves das perguntas existentes', async () => {
    await salvar(novo(), 'aberto')
    const salvo = JSON.parse(repo.bot('CAIXA-NOV26')!)
    salvo.perguntas[0].texto = 'Nome e sobrenome, por favor'
    salvo.perguntas.splice(1, 0, { tipo: 'texto', texto: 'Em qual bairro você mora?' })
    expect((await salvar(salvo, 'aberto', 'CAIXA-NOV26')).statusCode).toBe(303)
    const p = bots.get().processos[0]!
    expect(p.perguntas[0]).toMatchObject({ chave: 'nome_completo', texto: 'Nome e sobrenome, por favor' })
    expect(p.perguntas[1]!.chave).toBe('bairro_mora')
  })

  it('erro de validação volta ao formulário com a mensagem e sem salvar', async () => {
    const r = await salvar(
      novo({ perguntas: [{ tipo: 'enquete', texto: 'Turno?', opcoes: ['Só uma'] }, { tipo: 'arquivo', texto: 'CV', formatos: ['pdf'] }] }),
      'aberto'
    )
    expect(r.statusCode).toBe(400)
    expect(r.body).toContain('2 a 12 opções')
    expect(repo.bot('CAIXA-NOV26')).toBeNull()
    expect((await salvar(novo({ perguntas: [{ tipo: 'texto', texto: 'Nome?' }] }), 'aberto')).body).toContain('terminar pedindo o currículo')
  })

  it('código repetido é recusado e código de bot existente não muda', async () => {
    await salvar(novo(), 'rascunho')
    expect((await salvar(novo(), 'rascunho')).body).toContain('já foi usado')
    expect((await salvar(novo({ codigo: 'OUTRO-1' }), 'rascunho', 'CAIXA-NOV26')).body).toContain('não pode mudar')
  })

  it('copiar abre um bot novo com as mesmas perguntas e código em branco', async () => {
    await salvar(novo(), 'aberto')
    const r = await app.inject({ url: '/bots/novo?de=CAIXA-NOV26', headers: { cookie } })
    expect(r.body).toContain('Você tem experiência com caixa?')
    expect(r.body).toContain('id="codigo" value=""')
  })

  it('só exclui bot sem candidaturas', async () => {
    await salvar(novo(), 'aberto')
    repo.criarCandidatura(1, 'CAIXA-NOV26', 'x@s.whatsapp.net', null, null, AGORA)
    expect((await app.inject({ method: 'POST', url: '/bots/CAIXA-NOV26/excluir', headers: { cookie } })).statusCode).toBe(409)
    repo.excluirProcesso('CAIXA-NOV26')
    expect((await app.inject({ method: 'POST', url: '/bots/CAIXA-NOV26/excluir', headers: { cookie } })).statusCode).toBe(303)
    expect(bots.get().processos).toEqual([])
  })

  it('bot fica no número escolhido; número de grupos não aparece e é recusado', async () => {
    const numeros = new RepoNumeros(repo.db)
    const sul = numeros.criar('Loja Sul', 'recrutamento', AGORA)
    const avisos = numeros.criar('Avisos', 'grupos', AGORA)
    expect((await salvar(novo({ numero_id: avisos.id }), 'aberto')).body).toContain('número de recrutamento')
    expect((await salvar(novo({ numero_id: sul.id }), 'aberto')).statusCode).toBe(303)
    expect(bots.get().processos[0]!.numeroId).toBe(sul.id)
    const form = await app.inject({ url: '/bots/CAIXA-NOV26', headers: { cookie } })
    expect(form.body).toContain(`<option value="${sul.id}" selected>Loja Sul</option>`)
    expect(form.body).not.toContain('Avisos')
  })

  it('número de bot com candidaturas não muda', async () => {
    await salvar(novo(), 'aberto')
    repo.criarCandidatura(1, 'CAIXA-NOV26', 'x@s.whatsapp.net', null, null, AGORA)
    const sul = new RepoNumeros(repo.db).criar('Loja Sul', 'recrutamento', AGORA)
    const salvo = JSON.parse(repo.bot('CAIXA-NOV26')!)
    const r = await salvar({ ...salvo, numero_id: sul.id }, 'aberto', 'CAIXA-NOV26')
    expect(r.statusCode).toBe(400)
    expect(r.body).toContain('número de um bot com candidaturas não pode mudar')
    expect(bots.get().processos[0]!.numeroId).toBe(1)
  })

  it('editor só oferece números ativos, mas aceita o número atual do bot mesmo desativado', async () => {
    await salvar(novo(), 'aberto')
    new RepoNumeros(repo.db).definirAtivo(1, false)
    const paraNovo = await app.inject({ url: '/bots/novo', headers: { cookie } })
    expect(paraNovo.body).not.toContain('Principal')
    const form = await app.inject({ url: '/bots/CAIXA-NOV26', headers: { cookie } })
    expect(form.body).toContain('<option value="1" selected>Principal</option>')
    const salvo = JSON.parse(repo.bot('CAIXA-NOV26')!)
    expect((await salvar(salvo, 'aberto', 'CAIXA-NOV26')).statusCode).toBe(303)
  })
})

describe('números', () => {
  let app: FastifyInstance
  let repo: Repositorio
  let cookie: string
  let estados: Map<number, EstadoConexao>
  let revogados: number[]

  beforeEach(async () => {
    repo = new Repositorio(abrirBanco(':memory:'))
    revogados = []
    ;({ app, estados } = await painelComBot(repo, new ArmazemArquivos(pastaTemp()), {
      revogar: async (id) => {
        revogados.push(id)
        estados.set(id, { status: 'aguardando_qr', qr: 'QR-NOVO', desde: AGORA, numero: null, motivo: null })
      }
    }))
    cookie = await login(app)
  })

  const numeros = () => new RepoNumeros(repo.db)

  it('número novo só conecta quando a tela dele consulta o estado; aí o QR aparece', async () => {
    const r = await app.inject({ method: 'POST', url: '/numeros', headers: { ...form, cookie }, payload: 'nome=Avisos&papel=grupos' })
    expect(r.headers.location).toBe('/numeros/2')
    expect(numeros().numero(2)!.ativo).toBe(false)
    expect(repo.auditoriaRecente(1)[0]).toMatchObject({ usuario: 'rh', acao: 'criar_numero' })
    const e = await app.inject({ url: '/numeros/2/estado', headers: { cookie } })
    expect(e.json()).toMatchObject({ status: 'aguardando_qr', situacao: 'Aguardando leitura do QR' })
    expect(e.json().qr).toMatch(/^data:image\/png;base64/)
    expect(numeros().numero(2)!.ativo).toBe(true)
    expect((await app.inject('/healthz')).statusCode).toBe(503)
  })

  it('pausar mantém conectado e audita; retomar volta', async () => {
    expect((await app.inject({ method: 'POST', url: '/numeros/1/pausar', headers: { cookie } })).headers.location).toBe('/numeros/1?ok=pausado')
    expect(numeros().numero(1)).toMatchObject({ ativo: true, pausado: true })
    expect((await app.inject({ url: '/numeros', headers: { cookie } })).body).toContain('pausado')
    await app.inject({ method: 'POST', url: '/numeros/1/retomar', headers: { cookie } })
    expect(numeros().numero(1)!.pausado).toBe(false)
    expect(repo.auditoriaRecente(2).map((x) => x.acao)).toEqual(['retomar_numero', 'pausar_numero'])
  })

  it('revogar desconecta o WhatsApp atual e começa um QR novo', async () => {
    await app.inject({ method: 'POST', url: '/numeros/1/pausar', headers: { cookie } })
    const r = await app.inject({ method: 'POST', url: '/numeros/1/revogar', headers: { cookie } })
    expect(r.headers.location).toBe('/numeros/1?ok=revogado')
    expect(revogados).toEqual([1])
    expect(numeros().numero(1)!.pausado).toBe(false)
    expect((await app.inject({ url: '/numeros/1/estado', headers: { cookie } })).json()).toMatchObject({ status: 'aguardando_qr' })
  })

  it('a tela do número conectado mostra telefone, situação, os bots dele e os botões', async () => {
    const r = await app.inject({ url: '/numeros/1', headers: { cookie } })
    expect(r.body).toContain('+55 83 90000-1111')
    expect(r.body).toContain('Vendedor(a) de loja')
    expect(r.body).toContain('/numeros/1/revogar')
    expect(r.body).toContain('/numeros/1/pausar')
  })

  it('nome vazio, longo ou uso desconhecido é recusado', async () => {
    for (const payload of ['nome=&papel=grupos', 'nome=X&papel=vendas', `nome=${'A'.repeat(41)}&papel=grupos`]) {
      expect((await app.inject({ method: 'POST', url: '/numeros', headers: { ...form, cookie }, payload })).statusCode).toBe(400)
    }
    expect(numeros().listar()).toHaveLength(1)
  })

  it('/conexao leva para /numeros; sem cookie vai para /login; id inválido dá 404', async () => {
    expect((await app.inject({ url: '/conexao', headers: { cookie } })).headers.location).toBe('/numeros')
    expect((await app.inject('/numeros')).headers.location).toBe('/login')
    expect((await app.inject({ url: '/numeros/abc', headers: { cookie } })).statusCode).toBe(404)
  })

  it('número sem conexão aparece no lugar do link do bot', async () => {
    numeros().definirAtivo(1, false)
    const r = await app.inject({ url: '/', headers: { cookie } })
    expect(r.body).toContain('Principal sem conexão')
    expect(r.body).not.toContain('wa.me')
  })

  it('nome com HTML é escapado em /numeros e /saude', async () => {
    numeros().criar('<script>x</script>', 'grupos', AGORA)
    for (const url of ['/numeros', '/saude']) {
      const body = (await app.inject({ url, headers: { cookie } })).body
      expect(body).not.toContain('<script>x</script>')
      expect(body).toContain('&lt;script&gt;')
    }
  })

  it('falha do WhatsApp ao revogar volta com aviso, sem derrubar o painel', async () => {
    const outro = new Repositorio(abrirBanco(':memory:'))
    const { app: app2 } = await painelComBot(outro, new ArmazemArquivos(pastaTemp()), {
      revogar: async () => {
        throw new Error('boom')
      }
    })
    const c = await login(app2)
    expect((await app2.inject({ method: 'POST', url: '/numeros/1/revogar', headers: { cookie: c } })).headers.location).toBe('/numeros/1?erro=1')
    expect((await app2.inject({ url: '/numeros/1?erro=1', headers: { cookie: c } })).body).toContain('Não foi possível')
  })
})

describe('exportação', () => {
  it('neutraliza fórmulas no CSV', () => {
    expect(celula('=1+1')).toBe(`"'=1+1"`)
    expect(celula('a "b"')).toBe('"a ""b"""')
  })

  it('CSV tem BOM, ; e colunas na ordem das perguntas', () => {
    const csv = gerarCsv(processo(), [])
    expect(csv.startsWith('﻿"protocolo";"status";"nome";"cidade";"disponibilidade";"pretensao";"telefone"')).toBe(true)
  })

  it('link de divulgação leva o código no texto', () => {
    expect(linkWaMe('5583900001111', 'X-1')).toBe('https://wa.me/5583900001111?text=Quero%20me%20candidatar%20%5BX-1%5D')
  })
})
