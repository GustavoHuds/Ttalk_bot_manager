import { describe, expect, it } from 'vitest'
import { ArmazemArquivos } from '../src/arquivos.js'
import { abrirBanco } from '../src/db/banco.js'
import { RepoGrupos } from '../src/db/grupos.js'
import { RepoNumeros } from '../src/db/numeros.js'
import { ExpedidorGrupos, VALIDADE_SAIDA_GRUPO_MS } from '../src/grupos/expedidor.js'
import type { ConexaoGrupos, EnvioGrupo } from '../src/grupos/tipos.js'
import { duracaoDigitando } from '../src/whatsapp/limite.js'
import { AGORA, log, pastaTemp } from './ajuda.js'

function montar(o: { falhar?: boolean; pausado?: boolean; aleatorio?: number } = {}) {
  let t = AGORA
  const db = abrirBanco(':memory:')
  new RepoNumeros(db).criar('Avisos', 'grupos', AGORA)
  const grupos = new RepoGrupos(db)
  const armazem = new ArmazemArquivos(pastaTemp())
  const eventos: { em: number; tipo: string; jid: string; extra?: unknown }[] = []
  const ev = (tipo: string, jid: string, extra?: unknown) => void eventos.push({ em: t, tipo, jid, ...(extra === undefined ? {} : { extra }) })
  const conexao: ConexaoGrupos = {
    pronta: () => true,
    presenca: async (jid, estado) => ev(estado, jid),
    enviarTexto: async (jid, texto, mencoes) => {
      if (o.falhar) throw new Error('caiu')
      ev('texto', jid, { texto, mencoes })
    },
    enviarMidia: async (jid, midia, dados, legenda) => ev('midia', jid, { tipo: midia.tipo, bytes: dados.length, legenda }),
    removerParticipantes: async (jid, ps) => ev('remover', jid, ps),
    fecharGrupo: async (jid, f) => ev('fechar', jid, f),
    apagar: async (c) => ev('apagar', c.chat, c.id),
    marcarLida: async () => {},
    listarGrupos: async () => [],
    metadados: async () => {
      throw new Error('não usado')
    },
    telefoneDoLid: async () => null,
    baixarMidiaGrupo: async () => {
      throw new Error('não usado')
    }
  }
  const exp = new ExpedidorGrupos({
    numeroId: 2,
    grupos,
    armazem,
    conexao,
    log,
    pausado: () => !!o.pausado,
    relogio: () => t,
    esperar: async (ms) => void (t += ms),
    aleatorio: () => o.aleatorio ?? 0.5
  })
  const fila = (jid: string, envio: EnvioGrupo) => grupos.enfileirarSaida(2, jid, JSON.stringify(envio), t)
  return { exp, grupos, armazem, eventos, fila, tempo: () => t, avancar: (ms: number) => void (t += ms) }
}

describe('expedidor dos grupos', () => {
  it('"digitando" pelo tempo do texto, "parou", envia; entre mensagens do mesmo grupo espera 3 s ou mais', async () => {
    const { exp, eventos, fila } = montar()
    fila('a@g.us', { tipo: 'texto', texto: 'um', mencoes: ['111@lid'] })
    fila('a@g.us', { tipo: 'texto', texto: 'dois' })
    await exp.acordar()
    expect(eventos.map((e) => e.tipo)).toEqual(['composing', 'paused', 'texto', 'composing', 'paused', 'texto'])
    expect(eventos[2]!.extra).toEqual({ texto: 'um', mencoes: ['111@lid'] })
    expect(eventos[1]!.em - eventos[0]!.em).toBe(duracaoDigitando('um', () => 0.5))
    expect(eventos[3]!.em - eventos[2]!.em).toBeGreaterThanOrEqual(3000)
  })

  it('"digitando" acompanha o tamanho do texto e muda a cada vez (sorteado), entre 1,2 e 9 s', () => {
    expect(duracaoDigitando('oi', () => 0)).toBe(1200)
    expect(duracaoDigitando('x'.repeat(100), () => 0)).toBe(3400)
    expect(duracaoDigitando('x'.repeat(100), () => 1)).toBe(7200)
    expect(duracaoDigitando('x'.repeat(5000), () => 0.5)).toBe(9000)
  })

  it('mídia sai do disco, com legenda; a temporária é apagada depois', async () => {
    const { exp, eventos, fila, armazem } = montar()
    const caminho = await armazem.salvarMidia('jpg', Buffer.from('imagem'))
    fila('a@g.us', { tipo: 'midia', midia: { caminho, tipo: 'imagem', mimetype: 'image/jpeg', nome: null }, legenda: 'Promo', temporaria: true })
    await exp.acordar()
    expect(eventos.find((e) => e.tipo === 'midia')!.extra).toEqual({ tipo: 'imagem', bytes: 6, legenda: 'Promo' })
    await expect(armazem.ler(caminho)).rejects.toThrow()
  })

  it('remover, fechar e apagar vão direto, sem "digitando"', async () => {
    const { exp, eventos, fila } = montar()
    fila('a@g.us', { tipo: 'remover', participantes: ['1@lid'] })
    fila('a@g.us', { tipo: 'fechar', fechado: true })
    fila('a@g.us', { tipo: 'apagar', chave: { chat: 'a@g.us', id: 'X', participante: '1@lid' } })
    await exp.acordar()
    expect(eventos.map((e) => e.tipo)).toEqual(['remover', 'fechar', 'apagar'])
  })

  it('pausado não envia nada', async () => {
    const { exp, eventos, fila } = montar({ pausado: true })
    fila('a@g.us', { tipo: 'texto', texto: 'oi' })
    await exp.acordar()
    expect(eventos).toEqual([])
  })

  it('no máximo 12 envios por minuto por número', async () => {
    const { exp, eventos, fila, tempo } = montar()
    const inicio = tempo()
    for (let i = 0; i < 13; i++) fila(`${i}@g.us`, { tipo: 'texto', texto: 'oi' })
    await exp.acordar()
    const envios = eventos.filter((e) => e.tipo === 'texto')
    expect(envios).toHaveLength(13)
    expect(envios[12]!.em - inicio).toBeGreaterThanOrEqual(60_000)
  })

  it('item parado na fila há mais de 30 minutos é descartado; o seguinte sai', async () => {
    const { exp, eventos, fila, avancar } = montar()
    fila('a@g.us', { tipo: 'texto', texto: 'velha' })
    avancar(VALIDADE_SAIDA_GRUPO_MS + 1)
    fila('a@g.us', { tipo: 'texto', texto: 'nova' })
    await exp.acordar()
    expect(eventos.filter((e) => e.tipo === 'texto').map((e) => (e.extra as { texto: string }).texto)).toEqual(['nova'])
  })

  it('falha no envio reagenda com espera crescente e desiste depois de 5 tentativas', async () => {
    const { exp, grupos, fila, avancar } = montar({ falhar: true })
    fila('a@g.us', { tipo: 'texto', texto: 'oi' })
    for (let i = 0; i < 5; i++) {
      await exp.acordar()
      avancar(5000 * 2 ** i + 1)
    }
    expect(grupos.proximaSaida(2, 'a@g.us')).toBeNull()
  })
})
