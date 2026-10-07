import { describe, expect, it } from 'vitest'
import { abrirBanco } from '../src/db/banco.js'
import { RepoGrupos } from '../src/db/grupos.js'
import { RepoNumeros } from '../src/db/numeros.js'
import { ExpedidorGrupos, duracaoDigitandoGrupo } from '../src/grupos/expedidor.js'
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

  it('"digitando" dura entre 1 e 2 s', () => {
    expect(duracaoDigitandoGrupo('oi')).toBe(1000)
    expect(duracaoDigitandoGrupo('x'.repeat(500))).toBe(2000)
  })
})
