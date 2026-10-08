import type { FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it } from 'vitest'
import { ArmazemArquivos } from '../src/arquivos.js'
import { FonteBots } from '../src/config/bots.js'
import { abrirBanco } from '../src/db/banco.js'
import { RepoBotsGrupos } from '../src/db/bots-grupos.js'
import { RepoGrupos } from '../src/db/grupos.js'
import { RepoNumeros } from '../src/db/numeros.js'
import { Repositorio } from '../src/db/repositorio.js'
import { comandosDoBot } from '../src/grupos/catalogo.js'
import { hashSenha } from '../src/painel/auth.js'
import { criarPainel } from '../src/painel/servidor.js'
import type { EstadoConexao } from '../src/whatsapp/baileys.js'
import { AGORA, log, padrao, pastaTemp } from './ajuda.js'

const form = { 'content-type': 'application/x-www-form-urlencoded' }
const G1 = '120363-1@g.us'
const G2 = '120363-2@g.us'

describe('painel: bots de grupos, grupos e equipe', () => {
  let app: FastifyInstance
  let repo: Repositorio
  let grupos: RepoGrupos
  let bots: RepoBotsGrupos
  let numeros: RepoNumeros
  let bot: number
  let cookie: string
  let sincronizados: [number, string][]
  const estados = new Map<number, EstadoConexao>()

  const get = (url: string) => app.inject({ url, headers: { cookie } })
  const post = (url: string, payload: Record<string, string>) =>
    app.inject({ method: 'POST', url, headers: { ...form, cookie }, payload: new URLSearchParams(payload).toString() })
  const pessoa = (nome: string, telefone: string, extra: Partial<{ lid: string; loja: string; ativo: boolean }> = {}) =>
    grupos.salvarFuncionario(
      null,
      { nome, telefone, lid: extra.lid ?? null, setor: 'Vendas', loja: extra.loja ?? 'Centro', cargo: null, nascimento: null, ativo: extra.ativo ?? true },
      AGORA
    )

  beforeEach(async () => {
    repo = new Repositorio(abrirBanco(':memory:'))
    numeros = new RepoNumeros(repo.db)
    numeros.criar('Avisos', 'grupos', AGORA) // 2
    numeros.criar('Reserva', 'grupos', AGORA) // 3
    grupos = new RepoGrupos(repo.db)
    bots = new RepoBotsGrupos(repo.db)
    bot = bots.criarBot('Avisos Belmont', 2, AGORA)
    grupos.salvarGrupo(2, G1, 'Vendas Centro', true, AGORA)
    grupos.salvarGrupo(2, G2, 'TCC da faculdade', false, AGORA)
    estados.clear()
    estados.set(2, { status: 'conectado', qr: null, desde: AGORA, numero: '5583900002222', motivo: null })
    sincronizados = []
    app = await criarPainel({
      repo,
      numeros,
      grupos,
      botsGrupos: bots,
      sincronizarGrupo: async (b, jid) => {
        sincronizados.push([b, jid])
        return true
      },
      bots: new FonteBots(repo, padrao),
      relogio: () => AGORA,
      armazem: new ArmazemArquivos(pastaTemp()),
      log,
      conexoes: { estado: (id) => estados.get(id) ?? null, novaSessao: async () => {}, ativar: async () => {}, desativar: async () => {} },
      usuarios: new Map([['rh', hashSenha('senha-bem-longa')]]),
      segredo: 'x'.repeat(40),
      cookieSeguro: false,
      backupAtivo: false,
      alertaAtivo: false
    })
    const r = await app.inject({ method: 'POST', url: '/login', payload: 'usuario=rh&senha=senha-bem-longa', headers: form })
    cookie = `sessao=${r.cookies.find((x) => x.name === 'sessao')!.value}`
  })

  describe('Bots', () => {
    it('lista os bots de grupos com número, grupos, gestores e comandos', async () => {
      bots.ativarGrupo(bot, G1, null, null, 'rh', AGORA)
      const ana = pessoa('Ana Souza', '5583999990001')
      bots.indicarGestor(bot, ana, 'rh', AGORA)
      const body = (await get('/')).body
      expect(body).toContain('Bots de recrutamento')
      expect(body).toContain('Bots de grupos')
      expect(body).toContain('Avisos Belmont')
      expect(body).toContain('1 ativo(s)')
      expect(body).toContain('0 ✅ · 1 ⏳')
      expect(body).toContain('10 ligados')
      expect(body).toContain('+5583900002222')
    })

    it('cria bot de grupos; o número de outro bot não pode ser escolhido', async () => {
      const novo = await get('/grupos-bot/novo')
      expect(novo.body).toMatch(/<option value="2" disabled>Avisos — usado por Avisos Belmont<\/option>/)
      expect((await post('/grupos-bot', { nome: 'Outro', numero_id: '2' })).statusCode).toBe(400)
      const r = await post('/grupos-bot', { nome: 'Reserva <b>', numero_id: '3' })
      expect(r.statusCode).toBe(303)
      const criado = bots.botDoNumero(3)!
      expect(r.headers.location).toBe(`/grupos-bot/${criado.id}?ok=criado`)
      expect((await get(`/grupos-bot/${criado.id}`)).body).toContain('Reserva &lt;b&gt;')
      expect(repo.auditoriaRecente(1)[0]).toMatchObject({ acao: 'criar_bot_grupos' })
    })

    it('Geral: troca de número mantém tudo; desativar; excluir só sem grupos ativos', async () => {
      const loja = bots.criarLoja(bot, 'Centro')
      bots.ativarGrupo(bot, G1, loja, null, 'rh', AGORA)
      expect((await post(`/grupos-bot/${bot}`, { nome: 'Avisos', numero_id: '3', ativo: '1' })).statusCode).toBe(303)
      expect(bots.bot(bot)).toMatchObject({ nome: 'Avisos', numeroId: 3, ativo: true })
      expect(bots.grupoAtivo(bot, G1)).toMatchObject({ loja: 'Centro' })
      expect((await get(`/grupos-bot/${bot}`)).body).toContain('1 grupo(s) ativo(s) sem o número atual dentro')
      expect((await post(`/grupos-bot/${bot}/excluir`, {})).statusCode).toBe(409)
      bots.desativarGrupo(bot, G1)
      expect((await post(`/grupos-bot/${bot}/excluir`, {})).statusCode).toBe(303)
      expect(bots.bot(bot)).toBeNull()
    })
  })

  describe('Lojas', () => {
    it('adiciona, recusa repetida, renomeia levando a equipe junto e exclui', async () => {
      const ana = pessoa('Ana Souza', '5583999990001', { loja: 'centro' })
      expect((await post(`/grupos-bot/${bot}/lojas`, { nome: 'Centro' })).statusCode).toBe(303)
      const repetida = await post(`/grupos-bot/${bot}/lojas`, { nome: 'CENTRO' })
      expect(repetida.statusCode).toBe(400)
      expect(repetida.body).toContain('já existe')
      const loja = bots.lojas(bot)[0]!
      expect((await post(`/grupos-bot/${bot}/lojas/${loja.id}/renomear`, { nome: 'Loja Centro' })).statusCode).toBe(303)
      expect(grupos.funcionario(ana)!.loja).toBe('Loja Centro')
      expect((await post(`/grupos-bot/${bot}/lojas/${loja.id}/excluir`, {})).statusCode).toBe(303)
      expect(bots.lojas(bot)).toEqual([])
      expect(repo.auditoriaRecente(3).map((l) => l.acao)).toEqual(['excluir_loja', 'renomear_loja', 'criar_loja'])
    })
  })

  describe('Gestores', () => {
    it('busca na equipe, indica, mostra o código e o link wa.me; novo código troca o anterior', async () => {
      const ana = pessoa('Ana Souza', '5583999990001')
      const busca = await get(`/grupos-bot/${bot}/gestores?q=ana`)
      expect(busca.body).toContain('Indicar como gestor')
      expect((await post(`/grupos-bot/${bot}/gestores`, { funcionario_id: String(ana) })).headers.location).toBe(
        `/grupos-bot/${bot}/gestores?ok=indicado`
      )
      const codigo = bots.gestor(bot, ana)!.codigo!
      const pagina = (await get(`/grupos-bot/${bot}/gestores`)).body
      expect(pagina).toContain(codigo)
      expect(pagina).toContain(`https://wa.me/5583900002222?text=%2Fconfirmar%20${codigo}`)
      expect(pagina).toContain('aguardando confirmação')
      await post(`/grupos-bot/${bot}/gestores/${ana}/codigo`, {})
      expect(bots.gestor(bot, ana)!.codigo).not.toBe(codigo)
      // já indicada: some da busca
      expect((await get(`/grupos-bot/${bot}/gestores?q=ana`)).body).toContain('Ninguém encontrado')
    })

    it('aceitar divergência corrige o telefone do cadastro e confirma', async () => {
      const ana = pessoa('Ana Souza', '5583999990001')
      bots.indicarGestor(bot, ana, 'rh', AGORA)
      bots.registrarDivergencia(bot, ana, '5583988887777@s.whatsapp.net', '5583988887777', AGORA)
      expect((await get(`/grupos-bot/${bot}/gestores`)).body).toContain('+55 83 98888-7777')
      const r = await post(`/grupos-bot/${bot}/gestores/${ana}/aceitar-divergencia`, {})
      expect(r.headers.location).toBe(`/grupos-bot/${bot}/gestores?ok=confirmado`)
      expect(grupos.funcionario(ana)).toMatchObject({ telefone: '5583988887777', confirmadoEm: AGORA })
      expect(bots.gestoresConfirmados(bot)).toEqual([ana])
    })

    it('aceitar divergência recusa telefone que já é de outra pessoa', async () => {
      const ana = pessoa('Ana Souza', '5583999990001')
      pessoa('Beto Lima', '5583988887777')
      bots.indicarGestor(bot, ana, 'rh', AGORA)
      bots.registrarDivergencia(bot, ana, '5583988887777@s.whatsapp.net', '5583988887777', AGORA)
      const r = await post(`/grupos-bot/${bot}/gestores/${ana}/aceitar-divergencia`, {})
      expect(decodeURIComponent(r.headers.location as string)).toContain('já está no cadastro de Beto Lima')
      expect(bots.gestoresConfirmados(bot)).toEqual([])
    })

    it('ações a partir da página da pessoa voltam para ela; destino de fora do painel é ignorado', async () => {
      const ana = pessoa('Ana Souza', '5583999990001')
      const r = await post(`/grupos-bot/${bot}/gestores`, { funcionario_id: String(ana), voltar: `/equipe/${ana}` })
      expect(r.headers.location).toBe(`/equipe/${ana}?ok=indicado`)
      const fora = await post(`/grupos-bot/${bot}/gestores/${ana}/remover`, { voltar: 'https://exemplo.com/' })
      expect(fora.headers.location).toBe(`/grupos-bot/${bot}/gestores?ok=removido`)
    })
  })

  describe('Comandos', () => {
    it('desliga e liga com auditoria; /menu e /confirmar não desligam', async () => {
      expect((await post(`/grupos-bot/${bot}/comandos/quem/ligar`, { ligado: '0' })).statusCode).toBe(303)
      expect([...comandosDoBot(bots.comandos(bot)).desligados]).toEqual(['quem'])
      expect(repo.auditoriaRecente(1)[0]).toMatchObject({ acao: 'desligar_comando', detalhe: 'Avisos Belmont: /quem' })
      expect((await get(`/grupos-bot/${bot}/comandos`)).body).toContain('○ Desligado')
      expect((await post(`/grupos-bot/${bot}/comandos/menu/ligar`, { ligado: '0' })).statusCode).toBe(409)
      expect((await post(`/grupos-bot/${bot}/comandos/confirmar/ligar`, { ligado: '0' })).statusCode).toBe(409)
      expect((await post(`/grupos-bot/${bot}/comandos/xyz/ligar`, { ligado: '0' })).statusCode).toBe(404)
    })

    it('textos: salva o editado, ignora o igual ao original, recusa campo desconhecido e volta ao original', async () => {
      const r = await post(`/grupos-bot/${bot}/comandos/status/textos`, { t_resumo: 'Tudo ok: {grupos} grupos' })
      expect(r.statusCode).toBe(303)
      expect(bots.comandos(bot).get('status')!.textos).toEqual({ resumo: 'Tudo ok: {grupos} grupos' })
      const ruim = await post(`/grupos-bot/${bot}/comandos/status/textos`, { t_resumo: 'Oi {nome}' })
      expect(ruim.statusCode).toBe(400)
      expect(ruim.body).toContain('Campo desconhecido: {nome}')
      expect(ruim.body).toContain('Oi {nome}')
      await post(`/grupos-bot/${bot}/comandos/status/textos`, { original: '1' })
      expect(bots.comandos(bot).get('status')!.textos).toEqual({})
    })

    it('personalizado: cria, recusa nome de comando pronto, edita e exclui', async () => {
      const novo = { nome: '/Horário', descricao: 'horário das lojas', quem: 'todos', onde: 'grupo', resposta: 'Seg a sáb, 8h às 18h' }
      expect((await post(`/grupos-bot/${bot}/comandos/personalizado`, novo)).statusCode).toBe(303)
      expect(bots.comandos(bot).get('horario')).toMatchObject({ personalizado: true, resposta: 'Seg a sáb, 8h às 18h' })
      const repetido = await post(`/grupos-bot/${bot}/comandos/personalizado`, novo)
      expect(repetido.statusCode).toBe(400)
      expect(repetido.body).toContain('já existe neste bot')
      expect((await post(`/grupos-bot/${bot}/comandos/personalizado`, { ...novo, nome: 'quem' })).body).toContain('/quem já existe')
      expect((await get(`/grupos-bot/${bot}/comandos/personalizado/horario`)).body).toContain('Seg a sáb, 8h às 18h')
      await post(`/grupos-bot/${bot}/comandos/personalizado`, { ...novo, original: 'horario', resposta: 'Seg a sex' })
      expect(bots.comandos(bot).get('horario')!.resposta).toBe('Seg a sex')
      expect((await post(`/grupos-bot/${bot}/comandos/personalizado/horario/excluir`, {})).statusCode).toBe(303)
      expect(bots.comandos(bot).has('horario')).toBe(false)
    })
  })

  describe('Grupos', () => {
    it('lista geral com todos os grupos; ativar move para a lista de ativos com a loja e lê os participantes', async () => {
      const antes = (await get('/grupos')).body
      expect(antes).toContain('Vendas Centro')
      expect(antes).toContain('TCC da faculdade')
      expect(antes).toContain('Nenhum grupo ativo')
      const formulario = await get(`/grupos/ativar?bot=${bot}&jid=${encodeURIComponent(G1)}`)
      expect(formulario.body).toContain('Ativar: Vendas Centro')
      const r = await post('/grupos/ativar', { bot: String(bot), jid: G1, loja_id: '', loja_nova: 'Loja Centro', setor: 'Vendas' })
      expect(r.headers.location).toBe(`/grupos?bot=${bot}&ok=ativado`)
      expect(bots.grupoAtivo(bot, G1)).toMatchObject({ loja: 'Loja Centro', setor: 'Vendas', ativadoPor: 'rh' })
      expect(sincronizados).toEqual([[bot, G1]])
      const depois = (await get(`/grupos?bot=${bot}`)).body
      const ativos = depois.slice(depois.indexOf('Grupos ativos'), depois.indexOf('Todos os grupos'))
      expect(ativos).toContain('Vendas Centro')
      expect(ativos).toContain('Loja Centro')
      expect(depois.slice(depois.indexOf('Todos os grupos'))).not.toContain('Vendas Centro')
      expect(repo.auditoriaRecente(1)[0]).toMatchObject({ acao: 'ativar_grupo', detalhe: 'Avisos Belmont: Vendas Centro (Loja Centro · Vendas)' })
    })

    it('editar troca a loja; desativar apaga participantes; grupo de outro número não ativa', async () => {
      const loja = bots.criarLoja(bot, 'Sul')
      bots.ativarGrupo(bot, G1, null, null, 'rh', AGORA)
      bots.substituirParticipantes(bot, G1, [{ jid: '1@lid', telefone: null, lid: '1@lid', admin: false }])
      expect((await post('/grupos/editar', { bot: String(bot), jid: G1, loja_id: String(loja), setor: '' })).statusCode).toBe(303)
      expect(bots.grupoAtivo(bot, G1)).toMatchObject({ loja: 'Sul' })
      expect((await get(`/grupos?bot=${bot}`)).body).toContain('1 · <span class="alerta">1 sem cadastro</span>')
      expect((await post('/grupos/desativar', { bot: String(bot), jid: G1 })).statusCode).toBe(303)
      expect(bots.participantes(bot, G1)).toEqual([])
      grupos.salvarGrupo(3, 'x@g.us', 'De outro número', false, AGORA)
      expect((await post('/grupos/ativar', { bot: String(bot), jid: 'x@g.us' })).statusCode).toBe(404)
    })

    it('número desconectado: ativa e avisa que os participantes ficam para depois', async () => {
      app = await criarPainelSemConexao()
      const r = await post('/grupos/ativar', { bot: String(bot), jid: G1, loja_id: '' })
      expect(r.headers.location).toBe(`/grupos?bot=${bot}&ok=ativado_depois`)
    })

    it('avisa quando o número atual não está num grupo ativo', async () => {
      bots.ativarGrupo(bot, G1, null, null, 'rh', AGORA)
      grupos.desativarGrupo(2, G1, AGORA)
      expect((await get(`/grupos?bot=${bot}`)).body).toContain('Avisos não está neste grupo')
    })

    it('nome de grupo com aspas e HTML não quebra a página nem o confirm', async () => {
      grupos.salvarGrupo(2, G1, `O'Neil <script>x</script>`, false, AGORA)
      bots.ativarGrupo(bot, G1, null, null, 'rh', AGORA)
      const body = (await get(`/grupos?bot=${bot}`)).body
      expect(body).not.toContain('<script>x</script>')
      expect(body).toContain('data-confirma="Desativar O&#39;Neil &lt;script&gt;')
      expect(body).not.toContain("confirm('Desativar")
    })

    it('sem bot de grupos, explica como criar', async () => {
      bots.excluirBot(bot)
      expect((await get('/grupos')).body).toContain('Ainda não há nenhum bot de grupos')
    })
  })

  describe('Equipe', () => {
    it('filtros por situação e loja, com contadores', async () => {
      const ana = pessoa('Ana Souza', '5583999990001', { loja: 'Centro' })
      const beto = pessoa('Beto Lima', '5583999990002', { loja: 'Sul', lid: '2@lid' })
      pessoa('Caio Reis', '5583999990003', { loja: 'Sul' })
      grupos.confirmarFuncionario(ana, AGORA)
      bots.indicarGestor(bot, ana, 'rh', AGORA)
      bots.confirmarGestor(bot, ana, '5583999990001@s.whatsapp.net', AGORA)
      bots.indicarGestor(bot, beto, 'rh', AGORA)
      const nomes = async (q: string) => {
        const body = (await get(`/equipe${q}`)).body
        return ['Ana Souza', 'Beto Lima', 'Caio Reis'].filter((n) => body.includes(n))
      }
      expect(await nomes('')).toEqual(['Ana Souza', 'Beto Lima', 'Caio Reis'])
      expect(await nomes('?situacao=confirmados')).toEqual(['Ana Souza'])
      expect(await nomes('?situacao=nunca_vistos')).toEqual(['Caio Reis'])
      expect(await nomes('?situacao=gestores')).toEqual(['Ana Souza'])
      expect(await nomes('?situacao=pendentes')).toEqual(['Beto Lima'])
      expect(await nomes('?loja=sul')).toEqual(['Beto Lima', 'Caio Reis'])
      const body = (await get('/equipe')).body
      expect(body).toContain('👔 Avisos Belmont ✅')
      expect(body).toContain('👔 Avisos Belmont ⏳')
      expect(body).toContain('👁 visto nos grupos')
    })

    it('página da pessoa: grupos onde aparece, gestor por bot com código e histórico', async () => {
      const ana = pessoa('Ana Souza', '5583999990001')
      const loja = bots.criarLoja(bot, 'Centro')
      bots.ativarGrupo(bot, G1, loja, null, 'rh', AGORA)
      bots.substituirParticipantes(bot, G1, [{ jid: '1@lid', telefone: '5583999990001', lid: '1@lid', admin: false }])
      await post(`/grupos-bot/${bot}/gestores`, { funcionario_id: String(ana), voltar: `/equipe/${ana}` })
      const codigo = bots.gestor(bot, ana)!.codigo!
      const body = (await get(`/equipe/${ana}?ok=indicado`)).body
      expect(body).toContain('Pessoa indicada')
      expect(body).toContain('Vendas Centro')
      expect(body).toContain('👁 visto nos grupos')
      expect(body).toContain(codigo)
      expect(body).toContain('gestor_indicado')
      expect(body).toContain('<datalist id="lojas"><option value="Centro">')
    })

    it('mudar o telefone de quem confirmou tira a marca de confirmado', async () => {
      const ana = pessoa('Ana Souza', '5583999990001')
      grupos.confirmarFuncionario(ana, AGORA)
      await post('/equipe/salvar', { id: String(ana), nome: 'Ana Souza', telefone: '+55 83 99999-0001', ativo: '1' })
      expect(grupos.funcionario(ana)!.confirmadoEm).toBe(AGORA)
      await post('/equipe/salvar', { id: String(ana), nome: 'Ana Souza', telefone: '83977776666', ativo: '1' })
      expect(grupos.funcionario(ana)!.confirmadoEm).toBeNull()
    })

    it('exportação marca como gestor quem está confirmado em algum bot', async () => {
      const ana = pessoa('Ana Souza', '5583999990001')
      pessoa('Beto Lima', '5583999990002')
      bots.indicarGestor(bot, ana, 'rh', AGORA)
      bots.confirmarGestor(bot, ana, 'x', AGORA)
      const csv = (await get('/equipe/exportar')).body
      expect(csv).toMatch(/"Ana Souza";.*"sim";"sim"/)
      expect(csv).toMatch(/"Beto Lima";.*"não";"sim"/)
    })
  })

  async function criarPainelSemConexao() {
    const outro = await criarPainel({
      repo,
      numeros,
      grupos,
      botsGrupos: bots,
      sincronizarGrupo: async () => false,
      bots: new FonteBots(repo, padrao),
      relogio: () => AGORA,
      armazem: new ArmazemArquivos(pastaTemp()),
      log,
      conexoes: { estado: () => null, novaSessao: async () => {}, ativar: async () => {}, desativar: async () => {} },
      usuarios: new Map([['rh', hashSenha('senha-bem-longa')]]),
      segredo: 'x'.repeat(40),
      cookieSeguro: false,
      backupAtivo: false,
      alertaAtivo: false
    })
    return outro
  }
})
