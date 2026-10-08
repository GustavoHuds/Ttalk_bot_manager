import { beforeEach, describe, expect, it } from 'vitest'
import { abrirBanco } from '../src/db/banco.js'
import { RepoBotsGrupos, VALIDADE_CODIGO_MS, type DadosProgramada } from '../src/db/bots-grupos.js'
import { RepoGrupos } from '../src/db/grupos.js'
import { RepoNumeros } from '../src/db/numeros.js'
import { Repositorio } from '../src/db/repositorio.js'
import { AGORA } from './ajuda.js'

const G = 'loja@g.us'

describe('repositório dos bots de grupos', () => {
  let repo: Repositorio
  let b: RepoBotsGrupos
  let g: RepoGrupos
  let bot: number
  let ana: number

  beforeEach(() => {
    repo = new Repositorio(abrirBanco(':memory:'))
    new RepoNumeros(repo.db).criar('Avisos', 'grupos', AGORA)
    b = new RepoBotsGrupos(repo.db)
    g = new RepoGrupos(repo.db)
    bot = b.criarBot('Avisos', 2, AGORA)
    ana = g.salvarFuncionario(null, { nome: 'Ana', telefone: '5583999990001', lid: null, ativo: true }, AGORA)
  })

  const programada = (d: Partial<DadosProgramada> = {}): DadosProgramada => ({
    jid: G,
    origem: 'painel',
    horarios: ['08:00'],
    dias: [1, 2, 3],
    data: null,
    variar: false,
    mencionar: false,
    variacoes: [{ texto: 'Oi', midia: null }],
    ...d
  })

  it('um número atende um bot só; bot desativado não atende', () => {
    expect(() => b.criarBot('Outro', 2, AGORA)).toThrow()
    expect(b.botDoNumero(2)!.id).toBe(bot)
    b.editarBot(bot, { nome: 'Avisos', numeroId: 2, ativo: false })
    expect(b.botDoNumero(2)).toBeNull()
  })

  it('gestor: código de 6 dígitos, vence em 48 h, confirmar apaga o código', () => {
    const codigo = b.indicarGestor(bot, ana, 'rh', AGORA)
    expect(codigo).toMatch(/^\d{6}$/)
    expect(b.gestor(bot, ana)).toMatchObject({ codigo, codigoExpiraEm: AGORA + VALIDADE_CODIGO_MS, confirmadoEm: null })
    expect(b.novoCodigo(bot, ana, AGORA)).not.toBeUndefined()
    b.confirmarGestor(bot, ana, '111@lid', AGORA)
    expect(b.gestor(bot, ana)).toMatchObject({ codigo: null, confirmadoEm: AGORA, confirmadoJid: '111@lid' })
    expect(b.botsDaPessoa(ana)).toBe(1)
  })

  it('comandos: só os desligados ficam gravados, por bot', () => {
    b.ligarComando(bot, 'remove', false)
    expect(b.desligados(bot)).toEqual(new Set(['remove']))
    b.ligarComando(bot, 'remove', true)
    expect(b.desligados(bot)).toEqual(new Set())
  })

  it('palavras proibidas por grupo: adicionar sem repetir, remover algumas ou todas', () => {
    b.ativarGrupo(bot, G, 'rh', AGORA)
    b.adicionarPalavras(bot, G, ['golpe', 'golpe', 'pix'])
    expect(b.palavras(bot, G)).toEqual(['golpe', 'pix'])
    expect(b.removerPalavras(bot, G, ['pix'])).toBe(1)
    expect(b.palavrasDoBot(bot)).toEqual(new Map([[G, ['golpe']]]))
    b.removerPalavras(bot, G, null)
    expect(b.palavras(bot, G)).toEqual([])
  })

  it('silêncio: grava o horário, lembra o que foi aplicado e some com o grupo', () => {
    b.ativarGrupo(bot, G, 'rh', AGORA)
    b.definirSilencio(bot, G, '22:00', '06:00', 'rh', AGORA)
    b.marcarSilencioAplicado(bot, G, true)
    expect(b.silencio(bot, G)).toEqual({ botId: bot, jid: G, inicio: '22:00', fim: '06:00', fechado: true })
    b.desativarGrupo(bot, G)
    expect(b.silencios(bot)).toEqual([])
  })

  it('programadas: variações vazias não entram; editar troca tudo; /repeat stop só apaga repetições', () => {
    b.ativarGrupo(bot, G, 'rh', AGORA)
    const midia = { caminho: 'midias/x.jpg', tipo: 'imagem' as const, mimetype: 'image/jpeg', nome: 'x.jpg' }
    const id = b.salvarProgramada(null, bot, programada({ variacoes: [{ texto: 'A', midia }, { texto: null, midia: null }, { texto: 'C', midia: null }] }), 'rh', AGORA)
    expect(b.programada(id)!.variacoes).toEqual([{ texto: 'A', midia }, { texto: 'C', midia: null }])
    expect(b.midiasEmUso()).toEqual(new Set(['midias/x.jpg']))
    b.salvarProgramada(id, bot, programada({ horarios: ['09:00', '18:00'] }), 'rh', AGORA)
    expect(b.programada(id)).toMatchObject({ horarios: ['09:00', '18:00'], variacoes: [{ texto: 'Oi', midia: null }], ativa: true })
    b.salvarProgramada(null, bot, programada({ origem: 'repeat' }), 'wa', AGORA)
    expect(b.excluirRepeticoes(bot, G).total).toBe(1)
    expect(b.programadas(bot).map((p) => p.origem)).toEqual(['painel'])
    b.marcarEnvio(id, AGORA, 0, true)
    expect(b.programada(id)).toMatchObject({ ativa: false, ultimoEnvio: AGORA, ultimaVariacao: 0 })
  })

  it('excluir o bot apaga grupos ativos, gestores, comandos e programadas dele', () => {
    b.ativarGrupo(bot, G, 'rh', AGORA)
    b.indicarGestor(bot, ana, 'rh', AGORA)
    b.ligarComando(bot, 'all', false)
    b.salvarProgramada(null, bot, programada(), 'rh', AGORA)
    b.excluirBot(bot)
    for (const t of ['grupos_ativos', 'gestores_bot', 'comandos_bot', 'programadas', 'programadas_msgs']) {
      expect((repo.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n).toBe(0)
    }
  })
})
