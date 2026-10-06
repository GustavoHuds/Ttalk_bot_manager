import { describe, expect, it } from 'vitest'
import { abrirBanco } from '../src/db/banco.js'
import { Repositorio } from '../src/db/repositorio.js'
import { Expedidor, duracaoDigitando, type ConexaoEnvio } from '../src/whatsapp/expedidor.js'
import { AGORA, log } from './ajuda.js'

function montar(opcoes: { falhar?: boolean; limitePorMinuto?: number } = {}) {
  let t = AGORA
  const repo = new Repositorio(abrirBanco(':memory:'))
  const eventos: { em: number; tipo: string; jid: string; texto?: string }[] = []
  const conexao: ConexaoEnvio = {
    pronta: () => true,
    digitando: async (jid) => void eventos.push({ em: t, tipo: 'digitando', jid }),
    enviarTexto: async (jid, texto) => {
      if (opcoes.falhar) throw new Error('caiu')
      eventos.push({ em: t, tipo: 'texto', jid, texto })
    },
    enviarEnquete: async (jid, _c, pergunta) => void eventos.push({ em: t, tipo: 'enquete', jid, texto: pergunta })
  }
  const exp = new Expedidor({
    repo,
    conexao,
    log,
    janelaMs: 24 * 3600_000,
    relogio: () => t,
    esperar: async (ms) => void (t += ms),
    ...(opcoes.limitePorMinuto ? { limitePorMinuto: opcoes.limitePorMinuto } : {})
  })
  const receber = (jid: string, em = t) => repo.registrarRecebida(`in-${jid}-${em}`, jid, em, '{}')
  const fila = (jid: string, texto: string) => repo.enfileirarSaida(jid, JSON.stringify({ tipo: 'texto', texto }), t)
  return { repo, exp, eventos, receber, fila, tempo: () => t, avancar: (ms: number) => void (t += ms) }
}

describe('expedidor', () => {
  it('digita antes de cada envio, em ordem, com 1,5 s ou mais entre mensagens da conversa', async () => {
    const { exp, eventos, receber, fila } = montar()
    receber('a@s.whatsapp.net')
    fila('a@s.whatsapp.net', 'um')
    fila('a@s.whatsapp.net', 'dois')
    await exp.acordar()
    expect(eventos.map((e) => e.tipo)).toEqual(['digitando', 'texto', 'digitando', 'texto'])
    const [, um, , dois] = eventos
    expect(um!.texto).toBe('um')
    expect(dois!.em - um!.em).toBeGreaterThanOrEqual(1500)
  })

  it('"digitando" dura entre 1 e 4 s conforme o texto', () => {
    expect(duracaoDigitando('oi')).toBe(1000)
    expect(duracaoDigitando('x'.repeat(1000))).toBe(4000)
  })

  it('nunca inicia conversa: descarta resposta para quem não escreveu dentro da janela', async () => {
    const { exp, eventos, receber, fila, repo, avancar } = montar()
    receber('a@s.whatsapp.net')
    avancar(25 * 3600_000)
    fila('a@s.whatsapp.net', 'tarde demais')
    fila('b@s.whatsapp.net', 'nunca falou')
    await exp.acordar()
    expect(eventos).toEqual([])
    expect(repo.filas().saida).toBe(0)
  })

  it('respeita o limite global por minuto', async () => {
    const { exp, eventos, receber, fila, tempo } = montar({ limitePorMinuto: 3 })
    const inicio = tempo()
    for (let i = 0; i < 4; i++) {
      receber(`${i}@s.whatsapp.net`)
      fila(`${i}@s.whatsapp.net`, 'oi')
    }
    await exp.acordar()
    const envios = eventos.filter((e) => e.tipo === 'texto')
    expect(envios).toHaveLength(4)
    expect(envios[3]!.em - inicio).toBeGreaterThanOrEqual(60_000)
  })

  it('falha de envio mantém a mensagem na fila para nova tentativa', async () => {
    const { exp, receber, fila, repo } = montar({ falhar: true })
    receber('a@s.whatsapp.net')
    fila('a@s.whatsapp.net', 'oi')
    await exp.acordar()
    expect(repo.proximaSaida('a@s.whatsapp.net')?.tentativas).toBe(1)
  })
})
