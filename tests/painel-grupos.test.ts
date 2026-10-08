import type { FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'
import { ArmazemArquivos } from '../src/arquivos.js'
import { FonteBots } from '../src/config/bots.js'
import { abrirBanco } from '../src/db/banco.js'
import { RepoBotsGrupos } from '../src/db/bots-grupos.js'
import { RepoGrupos } from '../src/db/grupos.js'
import { RepoNumeros } from '../src/db/numeros.js'
import { Repositorio } from '../src/db/repositorio.js'
import { hashSenha } from '../src/painel/auth.js'
import { criarPainel } from '../src/painel/servidor.js'
import type { EstadoConexao } from '../src/whatsapp/baileys.js'
import { AGORA, log, padrao, pastaTemp } from './ajuda.js'

const form = { 'content-type': 'application/x-www-form-urlencoded' }
const G1 = '120363-1@g.us'
const G2 = '120363-2@g.us'

describe('painel: bots de grupos', () => {
  let app: FastifyInstance
  let repo: Repositorio
  let grupos: RepoGrupos
  let bots: RepoBotsGrupos
  let armazem: ArmazemArquivos
  let bot: number
  let cookie: string
  const estados = new Map<number, EstadoConexao>()

  const get = (url: string) => app.inject({ url, headers: { cookie } })
  const post = (url: string, payload: Record<string, string>) =>
    app.inject({ method: 'POST', url, headers: { ...form, cookie }, payload: new URLSearchParams(payload).toString() })

  beforeEach(async () => {
    repo = new Repositorio(abrirBanco(':memory:'))
    const numeros = new RepoNumeros(repo.db)
    numeros.criar('Avisos', 'grupos', AGORA) // 2
    numeros.criar('Reserva', 'grupos', AGORA) // 3
    grupos = new RepoGrupos(repo.db)
    bots = new RepoBotsGrupos(repo.db)
    armazem = new ArmazemArquivos(pastaTemp())
    bot = bots.criarBot('Avisos da Loja', 2, AGORA)
    grupos.salvarGrupo(2, G1, 'Vendas Centro', true, AGORA)
    grupos.salvarGrupo(2, G2, 'Gerentes', false, AGORA)
    estados.clear()
    estados.set(2, { status: 'conectado', qr: null, desde: AGORA, numero: '5583900002222', motivo: null })
    app = await criarPainel({
      repo,
      numeros,
      grupos,
      botsGrupos: bots,
      bots: new FonteBots(repo, padrao),
      relogio: () => AGORA,
      armazem,
      log,
      conexoes: { estado: (id) => estados.get(id) ?? null, novaSessao: async () => {}, revogar: async () => {}, ativar: async () => {}, desativar: async () => {} },
      usuarios: new Map([['rh', hashSenha('senha-bem-longa')]]),
      segredo: 'x'.repeat(40),
      cookieSeguro: false,
      backupAtivo: false,
      alertaAtivo: false
    })
    const r = await app.inject({ method: 'POST', url: '/login', payload: 'usuario=rh&senha=senha-bem-longa', headers: form })
    cookie = `sessao=${r.cookies.find((x) => x.name === 'sessao')!.value}`
  })

  it('todas as abas do bot ficam dentro da página dele, com a mesma navegação', async () => {
    for (const aba of ['', '/grupos', '/gestores', '/comandos', '/programadas']) {
      const r = await get(`/grupos-bot/${bot}${aba}`)
      expect(r.statusCode).toBe(200)
      for (const outra of ['/grupos', '/gestores', '/comandos', '/programadas']) expect(r.body).toContain(`href="/grupos-bot/${bot}${outra}"`)
    }
  })

  it('endereços antigos (/grupos, /equipe) levam para os bots', async () => {
    for (const url of ['/grupos', '/equipe', '/equipe/3']) expect((await get(url)).headers.location).toBe('/')
  })

  it('criar bot de grupos: número já usado é recusado', async () => {
    expect((await post('/grupos-bot', { nome: 'Outro', numero_id: '2' })).statusCode).toBe(400)
    const r = await post('/grupos-bot', { nome: 'Outro', numero_id: '3' })
    expect(r.headers.location).toMatch(/^\/grupos-bot\/\d+\?ok=criado$/)
  })

  it('ativar e desativar grupo pela aba Grupos', async () => {
    expect((await post(`/grupos-bot/${bot}/grupos/ativar`, { jid: G1 })).headers.location).toBe(`/grupos-bot/${bot}/grupos?ok=ativado`)
    expect(bots.grupoAtivo(bot, G1)).not.toBeNull()
    const pagina = (await get(`/grupos-bot/${bot}/grupos`)).body
    expect(pagina).toContain('Vendas Centro')
    expect(pagina).toContain('Gerentes')
    expect((await post(`/grupos-bot/${bot}/grupos/ativar`, { jid: 'nao@g.us' })).statusCode).toBe(404)
    await post(`/grupos-bot/${bot}/grupos/desativar`, { jid: G1 })
    expect(bots.grupoAtivo(bot, G1)).toBeNull()
  })

  it('gestor novo: nome e WhatsApp criam a pessoa pendente com código; remover tira do cadastro', async () => {
    expect((await post(`/grupos-bot/${bot}/gestores`, { nome: 'Ana', telefone: '123' })).statusCode).toBe(400)
    const r = await post(`/grupos-bot/${bot}/gestores`, { nome: 'Ana Souza', telefone: '(83) 99999-0001' })
    expect(r.headers.location).toBe(`/grupos-bot/${bot}/gestores?ok=indicado`)
    const f = grupos.porTelefone('5583999990001')!
    const g = bots.gestor(bot, f.id)!
    expect(g.codigo).toMatch(/^\d{6}$/)
    const pagina = (await get(`/grupos-bot/${bot}/gestores`)).body
    expect(pagina).toContain(g.codigo!)
    expect(pagina).toContain(`https://wa.me/5583900002222?text=%2Fconfirmar%20${g.codigo}`)
    await post(`/grupos-bot/${bot}/gestores/${f.id}/remover`, {})
    expect(grupos.funcionario(f.id)).toBeNull()
  })

  it('comandos: liga e desliga; fixo não desliga', async () => {
    await post(`/grupos-bot/${bot}/comandos/remove`, { ligado: '0' })
    expect(bots.desligados(bot)).toEqual(new Set(['remove']))
    expect((await post(`/grupos-bot/${bot}/comandos/menu`, { ligado: '0' })).statusCode).toBe(409)
    expect((await post(`/grupos-bot/${bot}/comandos/xyz`, { ligado: '0' })).statusCode).toBe(404)
  })

  describe('programadas', () => {
    beforeEach(() => bots.ativarGrupo(bot, G1, 'rh', AGORA))

    const base = { jid: G1, tipo: 'semanal', dia1: '1', dia3: '1', horario0: '08:00', horario1: '18:30', texto0: 'Bom dia!' }

    it('cria com mídia em base64, edita sem perder a mídia e exclui apagando o arquivo', async () => {
      const r = await post(`/grupos-bot/${bot}/programadas`, {
        ...base,
        variar: '1',
        texto1: 'Olá!',
        arquivo0: Buffer.from('foto').toString('base64'),
        arquivo_nome0: 'promo.jpg',
        arquivo_tipo0: 'image/jpeg'
      })
      expect(r.headers.location).toBe(`/grupos-bot/${bot}/programadas?ok=programada`)
      const [p] = bots.programadas(bot)
      expect(p).toMatchObject({ horarios: ['08:00', '18:30'], dias: [1, 3], data: null, variar: true })
      expect(p!.variacoes[0]!.midia).toMatchObject({ tipo: 'imagem', mimetype: 'image/jpeg', nome: 'promo.jpg' })
      const caminho = p!.variacoes[0]!.midia!.caminho
      expect((await armazem.ler(caminho)).toString()).toBe('foto')

      await post(`/grupos-bot/${bot}/programadas`, { ...base, id: String(p!.id), texto0: 'Bom dia, editado' })
      expect(bots.programada(p!.id)!.variacoes[0]).toMatchObject({ texto: 'Bom dia, editado', midia: { caminho } })

      await post(`/grupos-bot/${bot}/programadas/${p!.id}/excluir`, {})
      expect(bots.programadas(bot)).toEqual([])
      await expect(armazem.ler(caminho)).rejects.toThrow()
    })

    it('valida grupo, horário, dias, data e mensagem', async () => {
      const casos: [Record<string, string>, string][] = [
        [{ ...base, jid: G2 }, 'Escolha um grupo ativo.'],
        [{ ...base, horario0: '', horario1: '' }, 'Informe ao menos um horário.'],
        [{ jid: G1, tipo: 'semanal', horario0: '08:00', texto0: 'x' }, 'Escolha ao menos um dia.'],
        [{ ...base, tipo: 'unica', data: '2020-01-01' }, 'Escolha uma data de hoje em diante.'],
        [{ ...base, texto0: '' }, 'Escreva a mensagem 1 (ou anexe uma mídia).']
      ]
      for (const [corpo, erro] of casos) {
        const r = await post(`/grupos-bot/${bot}/programadas`, corpo)
        expect(r.statusCode).toBe(400)
        expect(r.body).toContain(erro)
      }
      expect(bots.programadas(bot)).toEqual([])
    })

    it('pausar e ativar', async () => {
      await post(`/grupos-bot/${bot}/programadas`, base)
      const [p] = bots.programadas(bot)
      await post(`/grupos-bot/${bot}/programadas/${p!.id}/pausar`, {})
      expect(bots.programada(p!.id)!.ativa).toBe(false)
      await post(`/grupos-bot/${bot}/programadas/${p!.id}/ativar`, {})
      expect(bots.programada(p!.id)!.ativa).toBe(true)
    })
  })

  it('a lista de bots mostra o bot de grupos com número, grupos, gestores e programadas', async () => {
    const r = await get('/')
    expect(r.body).toContain('Avisos da Loja')
    expect(r.body).toContain(`/grupos-bot/${bot}/programadas`)
  })
})
