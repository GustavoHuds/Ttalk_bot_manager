import { describe, expect, it } from 'vitest'
import { abrirBanco } from '../src/db/banco.js'
import { RepoGrupos } from '../src/db/grupos.js'
import { RepoNumeros } from '../src/db/numeros.js'
import { ExpedidorGrupos, VALIDADE_SAIDA_GRUPO_MS, duracaoDigitandoGrupo } from '../src/grupos/expedidor.js'
import type { ConexaoGrupos } from '../src/grupos/tipos.js'
import { AGORA, log } from './ajuda.js'

function montar(o: { falhar?: boolean; pronta?: boolean } = {}) {
  let t = AGORA
  const db = abrirBanco(':memory:')
  const numeros = new RepoNumeros(db)
  numeros.criar('Avisos', 'grupos', AGORA)
  numeros.criar('Outro', 'grupos', AGORA)
  const grupos = new RepoGrupos(db)
  const eventos: { em: number; tipo: string; jid: string; texto?: string; mencoes?: string[] }[] = []
  const conexao: ConexaoGrupos = {
    pronta: () => o.pronta ?? true,
    digitando: async (jid) => void eventos.push({ em: t, tipo: 'digitando', jid }),
    enviarTexto: async (jid, texto, mencoes) => {
      if (o.falhar) throw new Error('caiu')
      eventos.push({ em: t, tipo: 'texto', jid, texto, ...(mencoes ? { mencoes } : {}) })
    },
    listarGrupos: async () => [],
    metadados: async () => {
      throw new Error('não usado')
    },
    telefoneDoLid: async () => null
  }
  const exp = new ExpedidorGrupos({ numeroId: 2, grupos, conexao, log, relogio: () => t, esperar: async (ms) => void (t += ms) })
  const fila = (jid: string, texto: string, numeroId = 2, mencoes?: string[]) =>
    grupos.enfileirarSaida(numeroId, jid, JSON.stringify({ tipo: 'texto', texto, ...(mencoes ? { mencoes } : {}) }), t)
  return { exp, grupos, eventos, fila, tempo: () => t }
}

describe('expedidor dos grupos', () => {
  it('digita, envia com menções e espera 3 s ou mais entre mensagens do mesmo grupo', async () => {
    const { exp, eventos, fila } = montar()
    fila('a@g.us', 'um', 2, ['111@lid'])
    fila('a@g.us', 'dois')
    await exp.acordar()
    expect(eventos.map((e) => e.tipo)).toEqual(['digitando', 'texto', 'digitando', 'texto'])
    expect(eventos[1]).toMatchObject({ texto: 'um', mencoes: ['111@lid'] })
    expect(eventos[3]!.em - eventos[1]!.em).toBeGreaterThanOrEqual(3000)
  })

  it('não precisa de janela de resposta: envia em grupo que nunca falou com o bot', async () => {
    const { exp, eventos, fila } = montar()
    fila('novo@g.us', 'oi')
    await exp.acordar()
    expect(eventos.filter((e) => e.tipo === 'texto')).toHaveLength(1)
  })

  it('no máximo 10 envios por minuto por número', async () => {
    const { exp, eventos, fila, tempo } = montar()
    const inicio = tempo()
    for (let i = 0; i < 11; i++) fila(`${i}@g.us`, 'oi')
    await exp.acordar()
    const envios = eventos.filter((e) => e.tipo === 'texto')
    expect(envios).toHaveLength(11)
    expect(envios[10]!.em - inicio).toBeGreaterThanOrEqual(60_000)
  })

  it('só drena a fila do próprio número e nada sai desconectado', async () => {
    const { exp, eventos, fila, grupos } = montar()
    fila('a@g.us', 'de outro número', 3)
    await exp.acordar()
    expect(eventos).toEqual([])
    expect(grupos.proximaSaida(3, 'a@g.us')).not.toBeNull()
    const off = montar({ pronta: false })
    off.fila('a@g.us', 'oi')
    await off.exp.acordar()
    expect(off.eventos).toEqual([])
  })

  it('falha agenda nova tentativa; na quinta falha desiste', async () => {
    const { exp, grupos, fila } = montar({ falhar: true })
    fila('a@g.us', 'oi')
    await exp.acordar()
    expect(grupos.proximaSaida(2, 'a@g.us')).toMatchObject({ tentativas: 1 })
    const item = grupos.proximaSaida(2, 'a@g.us')!
    for (let i = 0; i < 3; i++) grupos.adiarSaida(item.id, 0)
    await exp.acordar()
    expect(grupos.proximaSaida(2, 'a@g.us')).toBeNull()
  })

  it('mensagem parada na fila há mais de 30 minutos é descartada sem enviar; a seguinte sai', async () => {
    const { exp, grupos, eventos, fila, tempo } = montar()
    expect(VALIDADE_SAIDA_GRUPO_MS).toBe(30 * 60_000)
    grupos.enfileirarSaida(2, 'a@g.us', JSON.stringify({ tipo: 'texto', texto: 'velha' }), tempo() - VALIDADE_SAIDA_GRUPO_MS - 1)
    grupos.enfileirarSaida(2, 'a@g.us', JSON.stringify({ tipo: 'texto', texto: 'no limite' }), tempo() - VALIDADE_SAIDA_GRUPO_MS + 60_000)
    fila('a@g.us', 'nova')
    await exp.acordar()
    expect(eventos.filter((e) => e.tipo === 'texto').map((e) => e.texto)).toEqual(['no limite', 'nova'])
    expect(grupos.proximaSaida(2, 'a@g.us')).toBeNull()
  })

  it('"digitando" dura entre 1 e 2 s', () => {
    expect(duracaoDigitandoGrupo('oi')).toBe(1000)
    expect(duracaoDigitandoGrupo('x'.repeat(500))).toBe(2000)
  })

  it('depois da primeira falha, a próxima tentativa é agendada para t + 5000', async () => {
    const { exp, grupos, fila, tempo } = montar({ falhar: true })
    fila('a@g.us', 'oi')
    await exp.acordar()
    const t = tempo()
    expect(grupos.proximaSaida(2, 'a@g.us')).toMatchObject({ tentativas: 1, proximaEm: t + 5000 })
  })

  it('cabeça atrasada da fila trava os itens seguintes do mesmo jid', async () => {
    const { exp, grupos, fila, eventos, tempo } = montar()
    fila('a@g.us', 'um')
    const item = grupos.proximaSaida(2, 'a@g.us')!
    grupos.adiarSaida(item.id, tempo() + 10_000)
    fila('a@g.us', 'dois')
    await exp.acordar()
    expect(eventos.filter((e) => e.tipo === 'texto')).toHaveLength(0)
  })

  it('duas chamadas de acordar() sobrepostas não enviam duas vezes', async () => {
    const { exp, eventos, fila } = montar()
    fila('a@g.us', 'oi')
    await Promise.all([exp.acordar(), exp.acordar()])
    expect(eventos.filter((e) => e.tipo === 'texto')).toHaveLength(1)
  })

  it('linha com conteúdo inválido não trava o processo; some depois de 5 tentativas', async () => {
    const { exp, grupos, tempo } = montar()
    grupos.enfileirarSaida(2, 'a@g.us', 'não-json', tempo())
    await expect(exp.acordar()).resolves.toBeUndefined()
    const item = grupos.proximaSaida(2, 'a@g.us')
    expect(item).toMatchObject({ tentativas: 1 })
    for (let i = 0; i < 3; i++) grupos.adiarSaida(item!.id, 0)
    await exp.acordar()
    expect(grupos.proximaSaida(2, 'a@g.us')).toBeNull()
  })

  it('se a conexão cai durante o envio, a tentativa não é contada', async () => {
    const db = abrirBanco(':memory:')
    const numeros = new RepoNumeros(db)
    numeros.criar('Avisos', 'grupos', AGORA)
    const grupos = new RepoGrupos(db)
    let t = AGORA
    let prontaFlag = true
    const conexao: ConexaoGrupos = {
      pronta: () => prontaFlag,
      digitando: async () => {},
      enviarTexto: async () => {
        prontaFlag = false
        throw new Error('caiu')
      },
      listarGrupos: async () => [],
      metadados: async () => {
        throw new Error('não usado')
      },
      telefoneDoLid: async () => null
    }
    const exp = new ExpedidorGrupos({ numeroId: 1, grupos, conexao, log, relogio: () => t, esperar: async (ms) => void (t += ms) })
    grupos.enfileirarSaida(1, 'a@g.us', JSON.stringify({ tipo: 'texto', texto: 'oi' }), t)
    await exp.acordar()
    expect(grupos.proximaSaida(1, 'a@g.us')).toMatchObject({ tentativas: 0 })
  })

  it('se a conexão cai enquanto espera a vaga do limite, não envia nem gasta tentativa', async () => {
    const db = abrirBanco(':memory:')
    const numeros = new RepoNumeros(db)
    numeros.criar('Avisos', 'grupos', AGORA)
    const grupos = new RepoGrupos(db)
    let t = AGORA
    let prontaFlag = true
    let primeiraEspera = true
    const eventos: string[] = []
    const conexao: ConexaoGrupos = {
      pronta: () => prontaFlag,
      digitando: async () => void eventos.push('digitando'),
      enviarTexto: async (jid, texto) => void eventos.push(`texto:${jid}:${texto}`),
      listarGrupos: async () => [],
      metadados: async () => {
        throw new Error('não usado')
      },
      telefoneDoLid: async () => null
    }
    const exp = new ExpedidorGrupos({
      numeroId: 1,
      grupos,
      conexao,
      log,
      limitePorMinuto: 1,
      relogio: () => t,
      esperar: async (ms) => {
        t += ms
        if (!primeiraEspera) prontaFlag = false
        primeiraEspera = false
      }
    })
    grupos.enfileirarSaida(1, 'a@g.us', JSON.stringify({ tipo: 'texto', texto: 'um' }), t)
    await exp.acordar()
    expect(eventos).toContain('texto:a@g.us:um')

    grupos.enfileirarSaida(1, 'b@g.us', JSON.stringify({ tipo: 'texto', texto: 'dois' }), t)
    await exp.acordar()
    expect(eventos.filter((e) => e.startsWith('texto'))).toHaveLength(1)
    expect(grupos.proximaSaida(1, 'b@g.us')).toMatchObject({ tentativas: 0 })
  })
})
