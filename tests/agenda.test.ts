import { beforeEach, describe, expect, it } from 'vitest'
import { abrirBanco } from '../src/db/banco.js'
import { RepoBotsGrupos, type DadosProgramada } from '../src/db/bots-grupos.js'
import { RepoGrupos } from '../src/db/grupos.js'
import { RepoNumeros } from '../src/db/numeros.js'
import { Repositorio } from '../src/db/repositorio.js'
import { AgendaGrupos, ESPALHAR_MS, TOLERANCIA_ATRASO_MS, diaBR, instanteBR } from '../src/grupos/agenda.js'
import type { ConexaoGrupos, EnvioGrupo } from '../src/grupos/tipos.js'
import { AGORA, log } from './ajuda.js'

const G = 'loja@g.us'
const HOJE = diaBR(AGORA).data // 10/10/2026, sábado; AGORA = 12:00 em Brasília

describe('agenda dos grupos', () => {
  let t: number
  let repo: Repositorio
  let grupos: RepoGrupos
  let bots: RepoBotsGrupos
  let numeros: RepoNumeros
  let bot: number
  let agenda: AgendaGrupos
  let pronta: boolean
  const N = 2

  beforeEach(() => {
    t = AGORA
    pronta = true
    repo = new Repositorio(abrirBanco(':memory:'))
    numeros = new RepoNumeros(repo.db)
    numeros.criar('Avisos', 'grupos', AGORA)
    grupos = new RepoGrupos(repo.db)
    grupos.salvarGrupo(N, G, 'Loja', true, AGORA)
    bots = new RepoBotsGrupos(repo.db)
    bot = bots.criarBot('Avisos', N, AGORA)
    bots.ativarGrupo(bot, G, 'rh', AGORA)
    const conexao = {
      pronta: () => pronta,
      metadados: async () => ({ jid: G, nome: 'Loja', botAdmin: true, membros: [{ jid: '1@lid', telefone: null, lid: '1@lid', admin: false }] })
    } as unknown as ConexaoGrupos
    agenda = new AgendaGrupos({
      repo,
      grupos,
      bots,
      conexao: () => conexao,
      pausado: (n) => numeros.numero(n)!.pausado,
      log,
      relogio: () => t,
      aleatorio: () => 0.5
    })
  })

  const programar = (d: Partial<DadosProgramada>, criadaEm = AGORA - 3_600_000) =>
    bots.salvarProgramada(
      null,
      bot,
      { jid: G, origem: 'painel', horarios: ['12:00'], dias: [0, 1, 2, 3, 4, 5, 6], data: null, variar: false, mencionar: false, variacoes: [{ texto: 'Oi', midia: null }], ...d },
      'rh',
      criadaEm
    )

  function saida(): { envio: EnvioGrupo; proximaEm: number }[] {
    return (repo.db.prepare(`SELECT conteudo, proxima_em FROM saida_grupos ORDER BY id`).all() as { conteudo: string; proxima_em: number }[]).map((r) => ({
      envio: JSON.parse(r.conteudo) as EnvioGrupo,
      proximaEm: r.proxima_em
    }))
  }

  it('manda no horário, uma vez só, num momento espalhado depois dele', async () => {
    programar({})
    await agenda.rodar()
    await agenda.rodar()
    expect(saida()).toEqual([{ envio: { tipo: 'texto', texto: 'Oi' }, proximaEm: AGORA + ESPALHAR_MS / 2 }])
  })

  it('dia da semana fora da lista, número pausado ou desconectado: não manda', async () => {
    programar({ dias: [1] })
    await agenda.rodar()
    expect(saida()).toEqual([])
    programar({})
    numeros.definirPausado(N, true)
    await agenda.rodar()
    numeros.definirPausado(N, false)
    pronta = false
    await agenda.rodar()
    expect(saida()).toEqual([])
  })

  it('horário que passou com o número parado há mais de 10 min é pulado', async () => {
    programar({})
    t = AGORA + TOLERANCIA_ATRASO_MS + 1
    await agenda.rodar()
    expect(saida()).toEqual([])
  })

  it('criada agora com horário que acabou de passar não sai na hora', async () => {
    programar({}, AGORA + 1)
    t = AGORA + 60_000
    await agenda.rodar()
    expect(saida()).toEqual([])
  })

  it('uma vez só: encerra depois do último horário do dia', async () => {
    const id = programar({ data: HOJE, horarios: ['11:58', '12:00'] })
    await agenda.rodar()
    expect(bots.programada(id)!.ativa).toBe(false)
    expect(saida()).toHaveLength(1)
  })

  it('variando, não repete a última variação; mencionar leva os participantes', async () => {
    const id = programar({
      variar: true,
      mencionar: true,
      variacoes: [
        { texto: 'A', midia: null },
        { texto: 'B', midia: null },
        { texto: 'C', midia: null }
      ]
    })
    repo.db.prepare(`UPDATE programadas SET ultima_variacao = 1 WHERE id = ?`).run(id)
    await agenda.rodar()
    expect(saida()[0]!.envio).toEqual({ tipo: 'texto', texto: 'C', mencoes: ['1@lid'] })
  })

  it('silêncio: fecha dentro da janela, abre fora dela, sem repetir o que já aplicou', async () => {
    bots.definirSilencio(bot, G, '11:00', '13:00', 'rh', AGORA)
    await agenda.rodar()
    await agenda.rodar()
    expect(saida().map((x) => x.envio)).toEqual([{ tipo: 'fechar', fechado: true }])
    t = instanteBR(HOJE, '13:05')
    await agenda.rodar()
    expect(saida().map((x) => x.envio)).toEqual([
      { tipo: 'fechar', fechado: true },
      { tipo: 'fechar', fechado: false }
    ])
  })
})
