import type { FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'
import { ArmazemArquivos } from '../src/arquivos.js'
import { FonteBots, botModelo } from '../src/config/bots.js'
import { abrirBanco } from '../src/db/banco.js'
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
    ativar: async (n: Numero) => void estados.set(n.id, { status: 'aguardando_qr', qr: 'QR-TESTE', desde: AGORA, numero: null, motivo: null }),
    desativar: async (id) => void estados.delete(id),
    ...conexoesExtra
  }
  const app = await criarPainel({
    repo,
    numeros: new RepoNumeros(repo.db),
    grupos: new RepoGrupos(repo.db),
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

  beforeEach(async () => {
    repo = new Repositorio(abrirBanco(':memory:'))
    ;({ app } = await painelComBot(repo, new ArmazemArquivos(pastaTemp())))
    cookie = await login(app)
  })

  it('adicionar número mostra o QR e é auditado; /healthz só fica ok com todos os ativos conectados', async () => {
    expect((await app.inject('/healthz')).statusCode).toBe(200)
    const r = await app.inject({ method: 'POST', url: '/numeros', headers: { ...form, cookie }, payload: 'nome=Avisos&papel=grupos' })
    expect(r.statusCode).toBe(303)
    expect(r.headers.location).toBe('/numeros/2')
    expect((await app.inject({ url: '/numeros/2', headers: { cookie } })).body).toContain('data:image/png;base64')
    expect(repo.auditoriaRecente(1)[0]).toMatchObject({ usuario: 'rh', acao: 'criar_numero' })
    const h = await app.inject('/healthz')
    expect(h.statusCode).toBe(503)
    expect(h.json()).toEqual({ ok: false })
    expect((await app.inject({ method: 'POST', url: '/numeros/2/desativar', headers: { cookie } })).statusCode).toBe(303)
    expect(new RepoNumeros(repo.db).numero(2)!.ativo).toBe(false)
    expect((await app.inject('/healthz')).statusCode).toBe(200)
    expect(repo.auditoriaRecente(1)[0]).toMatchObject({ acao: 'desativar_numero' })
  })

  it('nome vazio ou uso desconhecido é recusado', async () => {
    const r = await app.inject({ method: 'POST', url: '/numeros', headers: { ...form, cookie }, payload: 'nome=&papel=grupos' })
    expect(r.statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/numeros', headers: { ...form, cookie }, payload: 'nome=X&papel=vendas' })).statusCode).toBe(400)
    expect(new RepoNumeros(repo.db).listar()).toHaveLength(1)
  })

  it('/conexao leva para /numeros; /numeros e /saude mostram cada número', async () => {
    new RepoNumeros(repo.db).criar('Avisos', 'grupos', AGORA)
    expect((await app.inject({ url: '/conexao', headers: { cookie } })).headers.location).toBe('/numeros')
    const lista = await app.inject({ url: '/numeros', headers: { cookie } })
    expect(lista.body).toContain('Principal')
    expect(lista.body).toContain('Avisos')
    const saude = await app.inject({ url: '/saude', headers: { cookie } })
    expect(saude.body).toContain('Principal')
    expect(saude.body).toContain('Avisos')
  })

  it('/numeros sem cookie redireciona para /login', async () => {
    expect((await app.inject('/numeros')).headers.location).toBe('/login')
  })

  it('bot com número desativado mostra aviso em vez do link; número ativo some do aviso de "qual"', async () => {
    new RepoNumeros(repo.db).definirAtivo(1, false)
    const r = await app.inject({ url: '/', headers: { cookie } })
    expect(r.body).toContain('número «Principal» desativado')
    expect(r.body).not.toContain('wa.me')
  })

  it('ativar é no-op (sem auditoria) se já ativo; desativar é no-op se já desativado', async () => {
    const antes = repo.auditoriaRecente(10).length
    expect((await app.inject({ method: 'POST', url: '/numeros/1/ativar', headers: { cookie } })).statusCode).toBe(303)
    expect(repo.auditoriaRecente(10)).toHaveLength(antes)

    await app.inject({ method: 'POST', url: '/numeros/1/desativar', headers: { cookie } })
    const depois = repo.auditoriaRecente(10).length
    expect((await app.inject({ method: 'POST', url: '/numeros/1/desativar', headers: { cookie } })).statusCode).toBe(303)
    expect(repo.auditoriaRecente(10)).toHaveLength(depois)
  })

  it('ativar liga a conexão e audita quando o número estava desativado', async () => {
    await app.inject({ method: 'POST', url: '/numeros/1/desativar', headers: { cookie } })
    const r = await app.inject({ method: 'POST', url: '/numeros/1/ativar', headers: { cookie } })
    expect(r.statusCode).toBe(303)
    expect(new RepoNumeros(repo.db).numero(1)!.ativo).toBe(true)
    expect(repo.auditoriaRecente(1)[0]).toMatchObject({ acao: 'ativar_numero' })
  })

  it('nova sessão recusa número desativado com 409', async () => {
    await app.inject({ method: 'POST', url: '/numeros/1/desativar', headers: { cookie } })
    const r = await app.inject({ method: 'POST', url: '/numeros/1/nova-sessao', headers: { cookie } })
    expect(r.statusCode).toBe(409)
  })

  it('id inválido em /numeros/:id dá 404', async () => {
    expect((await app.inject({ url: '/numeros/abc', headers: { cookie } })).statusCode).toBe(404)
    expect((await app.inject({ url: '/numeros/1e3', headers: { cookie } })).statusCode).toBe(404)
  })

  it('nome com HTML é escapado em /numeros e /saude', async () => {
    new RepoNumeros(repo.db).criar('<script>x</script>', 'grupos', AGORA)
    const lista = await app.inject({ url: '/numeros', headers: { cookie } })
    expect(lista.body).not.toContain('<script>x</script>')
    expect(lista.body).toContain('&lt;script&gt;')
    const saude = await app.inject({ url: '/saude', headers: { cookie } })
    expect(saude.body).not.toContain('<script>x</script>')
    expect(saude.body).toContain('&lt;script&gt;')
  })

  it('/saude mostra o uso (papel) de cada número pelo rótulo', async () => {
    new RepoNumeros(repo.db).criar('Avisos', 'grupos', AGORA)
    const saude = await app.inject({ url: '/saude', headers: { cookie } })
    expect(saude.body).toContain('Recrutamento')
    expect(saude.body).toContain('Grupos')
    expect(saude.body).not.toContain('(grupos)')
  })

  it('nome maior que 40 caracteres é recusado', async () => {
    const r = await app.inject({ method: 'POST', url: '/numeros', headers: { ...form, cookie }, payload: `nome=${'A'.repeat(41)}&papel=grupos` })
    expect(r.statusCode).toBe(400)
  })
})

describe('números — falhas do gerenciador', () => {
  let app: FastifyInstance
  let repo: Repositorio
  let cookie: string

  it('falha ao ativar número novo redireciona com ?erro=1, audita a criação e não desfaz o banco', async () => {
    repo = new Repositorio(abrirBanco(':memory:'))
    ;({ app } = await painelComBot(repo, new ArmazemArquivos(pastaTemp()), {
      ativar: async () => {
        throw new Error('boom')
      }
    }))
    cookie = await login(app)
    const r = await app.inject({ method: 'POST', url: '/numeros', headers: { ...form, cookie }, payload: 'nome=Avisos&papel=grupos' })
    expect(r.statusCode).toBe(303)
    expect(r.headers.location).toBe('/numeros/2?erro=1')
    expect(new RepoNumeros(repo.db).numero(2)).toMatchObject({ nome: 'Avisos', ativo: true })
    expect(repo.auditoriaRecente(1)[0]).toMatchObject({ acao: 'criar_numero' })
    const pagina = await app.inject({ url: '/numeros/2?erro=1', headers: { cookie } })
    expect(pagina.body).toContain('Não foi possível')
  })

  it('falha ao ativar número existente não desfaz o banco', async () => {
    repo = new Repositorio(abrirBanco(':memory:'))
    ;({ app } = await painelComBot(repo, new ArmazemArquivos(pastaTemp()), {
      ativar: async () => {
        throw new Error('boom')
      }
    }))
    cookie = await login(app)
    await app.inject({ method: 'POST', url: '/numeros/1/desativar', headers: { cookie } })
    const r = await app.inject({ method: 'POST', url: '/numeros/1/ativar', headers: { cookie } })
    expect(r.statusCode).toBe(303)
    expect(r.headers.location).toBe('/numeros/1?erro=1')
    expect(new RepoNumeros(repo.db).numero(1)!.ativo).toBe(true)
  })

  it('falha ao desativar não desfaz o banco', async () => {
    repo = new Repositorio(abrirBanco(':memory:'))
    ;({ app } = await painelComBot(repo, new ArmazemArquivos(pastaTemp()), {
      desativar: async () => {
        throw new Error('boom')
      }
    }))
    cookie = await login(app)
    const r = await app.inject({ method: 'POST', url: '/numeros/1/desativar', headers: { cookie } })
    expect(r.statusCode).toBe(303)
    expect(r.headers.location).toBe('/numeros/1?erro=1')
    expect(new RepoNumeros(repo.db).numero(1)!.ativo).toBe(false)
  })

  it('falha ao gerar nova sessão audita "nova_sessao_falhou" em vez de "nova_sessao"', async () => {
    repo = new Repositorio(abrirBanco(':memory:'))
    ;({ app } = await painelComBot(repo, new ArmazemArquivos(pastaTemp()), {
      novaSessao: async () => {
        throw new Error('boom')
      }
    }))
    cookie = await login(app)
    const r = await app.inject({ method: 'POST', url: '/numeros/1/nova-sessao', headers: { cookie } })
    expect(r.statusCode).toBe(303)
    expect(r.headers.location).toBe('/numeros/1?erro=1')
    expect(repo.auditoriaRecente(1)[0]).toMatchObject({ acao: 'nova_sessao_falhou' })
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

describe('grupos e equipe', () => {
  let app: FastifyInstance
  let repo: Repositorio
  let grupos: RepoGrupos
  let cookie: string
  const post = (url: string, payload: Record<string, string>) =>
    app.inject({ method: 'POST', url, headers: { ...form, cookie }, payload: new URLSearchParams(payload).toString() })

  beforeEach(async () => {
    repo = new Repositorio(abrirBanco(':memory:'))
    ;({ app } = await painelComBot(repo, new ArmazemArquivos(pastaTemp())))
    new RepoNumeros(repo.db).criar('Avisos', 'grupos', AGORA)
    grupos = new RepoGrupos(repo.db)
    grupos.salvarGrupo(2, '120363-1@g.us', 'Loja Centro', false, AGORA)
    cookie = await login(app)
  })

  it('/grupos lista por número e grava setor e loja com auditoria', async () => {
    expect((await app.inject({ url: '/grupos', headers: { cookie } })).body).toContain('Loja Centro')
    const r = await post('/grupos/etiquetar', { numero_id: '2', jid: '120363-1@g.us', setor: 'Vendas', loja: 'Centro' })
    expect(r.statusCode).toBe(303)
    expect(grupos.grupo(2, '120363-1@g.us')).toMatchObject({ setor: 'Vendas', loja: 'Centro' })
    expect(repo.auditoriaRecente(1)[0]).toMatchObject({ usuario: 'rh', acao: 'etiquetar_grupo' })
    expect((await post('/grupos/etiquetar', { numero_id: '2', jid: 'nao@g.us', setor: '', loja: '' })).statusCode).toBe(404)
  })

  it('cadastro pelo painel: telefone normalizado, repetido recusado, gestor e exclusão auditados', async () => {
    expect((await post('/equipe/salvar', { nome: 'Ana Souza', telefone: '(83) 99999-0001', setor: 'Vendas', loja: 'Centro', ativo: '1' })).statusCode).toBe(303)
    const ana = grupos.porTelefone('5583999990001')!
    expect(ana).toMatchObject({ nome: 'Ana Souza', ativo: true })
    const repetido = await post('/equipe/salvar', { nome: 'Outra Pessoa', telefone: '83999990001', ativo: '1' })
    expect(repetido.statusCode).toBe(400)
    expect(repetido.body).toContain('já é de Ana Souza')
    expect((await post(`/equipe/${ana.id}/gestor`, { ativo: '1' })).statusCode).toBe(303)
    expect(grupos.gestores()).toEqual([ana.id])
    expect((await app.inject({ url: '/equipe?q=souza', headers: { cookie } })).body).toContain('👔 gestor')
    expect((await post(`/equipe/${ana.id}/excluir`, {})).statusCode).toBe(303)
    expect(grupos.funcionarios()).toEqual([])
    expect(repo.auditoriaRecente(4).map((l) => l.acao)).toEqual(['excluir_funcionario', 'gestor_adicionado', 'criar_funcionario', 'login'])
  })

  it('importação CSV: prévia com erro por linha, confirma só as válidas e atualiza quem já existe', async () => {
    const id = grupos.salvarFuncionario(
      null,
      { nome: 'Ana', telefone: '5583999990001', lid: '111@lid', setor: null, loja: null, cargo: null, nascimento: null, ativo: true },
      AGORA
    )
    const csv = 'Ana Souza;83999990001;Vendas;Centro;;\nBeto Lima;83999990002;Caixa;Sul;;\nX;1;;;;'
    const previa = await post('/equipe/importar', { csv })
    expect(previa.statusCode).toBe(200)
    expect(previa.body).toContain('atualiza')
    expect(previa.body).toContain('novo')
    expect(previa.body).toContain('nome é obrigatório')
    expect(grupos.funcionarios()).toHaveLength(1)
    const r = await post('/equipe/importar', { csv, confirmar: '1' })
    expect(r.headers.location).toBe('/equipe?importados=2')
    expect(grupos.funcionario(id)).toMatchObject({ nome: 'Ana Souza', setor: 'Vendas', lid: '111@lid' })
    expect(grupos.porTelefone('5583999990002')).toMatchObject({ nome: 'Beto Lima' })
    expect(repo.auditoriaRecente(1)[0]).toMatchObject({ acao: 'importar_equipe', detalhe: '2 pessoas (1 linhas com erro)' })
  })

  it('exportação da equipe vem com BOM e neutraliza fórmulas', async () => {
    grupos.salvarFuncionario(
      null,
      { nome: '=HYPERLINK("x")', telefone: '5583999990001', lid: null, setor: null, loja: null, cargo: null, nascimento: null, ativo: true },
      AGORA
    )
    const r = await app.inject({ url: '/equipe/exportar', headers: { cookie } })
    expect(r.headers['content-type']).toContain('text/csv')
    expect(r.body.startsWith('﻿"nome";"telefone"')).toBe(true)
    expect(r.body).toContain(`"'=HYPERLINK(""x"")"`)
    expect(repo.auditoriaRecente(1)[0]).toMatchObject({ acao: 'exportar_equipe' })
  })
})
