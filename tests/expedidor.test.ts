import { describe, expect, it } from 'vitest'
import { abrirBanco } from '../src/db/banco.js'
import { Repositorio } from '../src/db/repositorio.js'
import { Expedidor, type ConexaoEnvio } from '../src/whatsapp/expedidor.js'
import { AGORA, log } from './ajuda.js'

const JANELA = 24 * 3600_000

function montar(opcoes: { falhar?: boolean; limitePorMinuto?: number } = {}) {
  let t = AGORA
  const repo = new Repositorio(abrirBanco(':memory:'))
  const eventos: { em: number; tipo: string; jid: string; texto?: string }[] = []
  const conexao: ConexaoEnvio = {
    pronta: () => true,
    presenca: async (jid, estado) => {
      if (estado === 'composing') eventos.push({ em: t, tipo: 'digitando', jid })
    },
    enviarTexto: async (jid, texto) => {
      if (opcoes.falhar) throw new Error('caiu')
      eventos.push({ em: t, tipo: 'texto', jid, texto })
    },
    enviarEnquete: async (jid, _c, pergunta) => void eventos.push({ em: t, tipo: 'enquete', jid, texto: pergunta })
  }
  const exp = new Expedidor({
    numeroId: 1,
    repo,
    conexao,
    log,
    janelaMs: 24 * 3600_000,
    relogio: () => t,
    aleatorio: () => 0,
    esperar: async (ms) => void (t += ms),
    ...(opcoes.limitePorMinuto ? { limitePorMinuto: opcoes.limitePorMinuto } : {})
  })
  const receber = (jid: string, em = t) => repo.registrarRecebida(1, `in-${jid}-${em}`, jid, em, '{}')
  const fila = (jid: string, texto: string) => repo.enfileirarSaida(1, jid, JSON.stringify({ tipo: 'texto', texto }), t)
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
    expect(repo.proximaSaida(1, 'a@s.whatsapp.net')?.tentativas).toBe(1)
  })

  it('cada número drena só a própria fila', async () => {
    const { exp, eventos, repo, tempo } = montar()
    repo.registrarRecebida(2, 'in-b', 'b@s.whatsapp.net', tempo(), '{}')
    repo.enfileirarSaida(2, 'b@s.whatsapp.net', JSON.stringify({ tipo: 'texto', texto: 'oi' }), tempo())
    await exp.acordar()
    expect(eventos).toEqual([])
    expect(repo.proximaSaida(2, 'b@s.whatsapp.net')).not.toBeNull()
  })

  it('depois da primeira falha, a próxima tentativa é agendada para t + 5000', async () => {
    const { exp, repo, receber, fila, tempo } = montar({ falhar: true })
    receber('a@s.whatsapp.net')
    fila('a@s.whatsapp.net', 'oi')
    await exp.acordar()
    const t = tempo()
    expect(repo.proximaSaida(1, 'a@s.whatsapp.net')).toMatchObject({ tentativas: 1, proximaEm: t + 5000 })
  })

  it('cabeça atrasada da fila trava os itens seguintes da mesma conversa', async () => {
    const { exp, repo, receber, fila, eventos, tempo } = montar()
    receber('a@s.whatsapp.net')
    fila('a@s.whatsapp.net', 'um')
    const item = repo.proximaSaida(1, 'a@s.whatsapp.net')!
    repo.adiarSaida(item.id, tempo() + 10_000)
    fila('a@s.whatsapp.net', 'dois')
    await exp.acordar()
    expect(eventos.filter((e) => e.tipo === 'texto')).toHaveLength(0)
  })

  it('duas chamadas de acordar() sobrepostas não enviam duas vezes', async () => {
    const { exp, eventos, receber, fila } = montar()
    receber('a@s.whatsapp.net')
    fila('a@s.whatsapp.net', 'oi')
    await Promise.all([exp.acordar(), exp.acordar()])
    expect(eventos.filter((e) => e.tipo === 'texto')).toHaveLength(1)
  })

  it('linha com conteúdo inválido não trava o processo; some depois de 5 tentativas', async () => {
    const { exp, repo, receber, tempo } = montar()
    receber('a@s.whatsapp.net')
    repo.enfileirarSaida(1, 'a@s.whatsapp.net', 'não-json', tempo())
    await expect(exp.acordar()).resolves.toBeUndefined()
    const item = repo.proximaSaida(1, 'a@s.whatsapp.net')
    expect(item).toMatchObject({ tentativas: 1 })
    for (let i = 0; i < 3; i++) repo.adiarSaida(item!.id, 0)
    await exp.acordar()
    expect(repo.proximaSaida(1, 'a@s.whatsapp.net')).toBeNull()
  })

  it('se a conexão cai durante o envio, a tentativa não é contada', async () => {
    const repo = new Repositorio(abrirBanco(':memory:'))
    let t = AGORA
    let prontaFlag = true
    const conexao: ConexaoEnvio = {
      pronta: () => prontaFlag,
      presenca: async () => {},
      enviarTexto: async () => {
        prontaFlag = false
        throw new Error('caiu')
      },
      enviarEnquete: async () => {}
    }
    const exp = new Expedidor({
      numeroId: 1,
      repo,
      conexao,
      log,
      janelaMs: JANELA,
      relogio: () => t,
      esperar: async (ms) => void (t += ms)
    })
    repo.registrarRecebida(1, 'in-a', 'a@s.whatsapp.net', t, '{}')
    repo.enfileirarSaida(1, 'a@s.whatsapp.net', JSON.stringify({ tipo: 'texto', texto: 'oi' }), t)
    await exp.acordar()
    expect(repo.proximaSaida(1, 'a@s.whatsapp.net')).toMatchObject({ tentativas: 0 })
  })

  it('se a conexão cai enquanto espera a vaga do limite, não envia nem gasta tentativa', async () => {
    const repo = new Repositorio(abrirBanco(':memory:'))
    let t = AGORA
    let prontaFlag = true
    let primeiraEspera = true
    const eventos: string[] = []
    const conexao: ConexaoEnvio = {
      pronta: () => prontaFlag,
      presenca: async () => void eventos.push('digitando'),
      enviarTexto: async (jid, texto) => void eventos.push(`texto:${jid}:${texto}`),
      enviarEnquete: async () => {}
    }
    const exp = new Expedidor({
      numeroId: 1,
      repo,
      conexao,
      log,
      janelaMs: JANELA,
      limitePorMinuto: 1,
      relogio: () => t,
      esperar: async (ms) => {
        t += ms
        if (!primeiraEspera) prontaFlag = false
        primeiraEspera = false
      }
    })
    repo.registrarRecebida(1, 'in-a', 'a@s.whatsapp.net', t, '{}')
    repo.enfileirarSaida(1, 'a@s.whatsapp.net', JSON.stringify({ tipo: 'texto', texto: 'um' }), t)
    await exp.acordar()
    expect(eventos).toContain('texto:a@s.whatsapp.net:um')

    repo.registrarRecebida(1, 'in-b', 'b@s.whatsapp.net', t, '{}')
    repo.enfileirarSaida(1, 'b@s.whatsapp.net', JSON.stringify({ tipo: 'texto', texto: 'dois' }), t)
    await exp.acordar()
    expect(eventos.filter((e) => e.startsWith('texto'))).toHaveLength(1)
    expect(repo.proximaSaida(1, 'b@s.whatsapp.net')).toMatchObject({ tentativas: 0 })
  })
})
