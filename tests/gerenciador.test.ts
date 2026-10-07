import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { cp, mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Numero } from '../src/db/numeros.js'
import type { EstadoConexao } from '../src/whatsapp/baileys.js'
import { GerenciadorConexoes, moverSessaoAntiga, pastaSessaoNumero, type ConexaoGerida } from '../src/whatsapp/gerenciador.js'
import { AGORA, log, pastaTemp } from './ajuda.js'

const numero = (id: number, ativo = true): Numero => ({ id, nome: `N${id}`, papel: 'recrutamento', ativo, criadoEm: AGORA })

/** Promessa controlável de fora, para montar cenários de corrida nos testes. */
function deferido<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => (resolve = res))
  return { promise, resolve }
}

function fabrica() {
  const eventos: string[] = []
  const criar = (n: Numero) => {
    let estado: EstadoConexao = { status: 'iniciando', qr: null, desde: AGORA, numero: null, motivo: null }
    const conexao: ConexaoGerida = {
      get estadoAtual() {
        return estado
      },
      iniciar: async () => {
        eventos.push(`iniciar ${n.id}`)
        estado = { ...estado, status: 'conectado' }
      },
      parar: async () => void eventos.push(`parar ${n.id}`),
      novaSessao: async () => void eventos.push(`nova ${n.id}`)
    }
    const expedidor = {
      iniciar: () => void eventos.push(`exp ${n.id}`),
      parar: () => void eventos.push(`exp-parar ${n.id}`),
      acordar: async () => void eventos.push(`acordar ${n.id}`)
    }
    return { conexao, expedidor }
  }
  return { eventos, g: new GerenciadorConexoes(criar, log) }
}

describe('gerenciador de conexões', () => {
  it('inicia só os ativos, uma vez cada; para e esquece', async () => {
    const { eventos, g } = fabrica()
    await g.iniciarTodos([numero(1), numero(2, false), numero(3)])
    await g.adicionar(numero(1))
    expect(eventos).toEqual(['iniciar 1', 'exp 1', 'iniciar 3', 'exp 3'])
    expect([...g.estados().keys()]).toEqual([1, 3])
    expect(g.estado(1)!.status).toBe('conectado')
    g.acordar(3)
    await g.parar(3)
    expect(eventos.slice(-3)).toEqual(['acordar 3', 'exp-parar 3', 'parar 3'])
    expect(g.estado(3)).toBeNull()
    expect(g.conexao(3)).toBeNull()
  })

  it('nova sessão só para número ativo', async () => {
    const { eventos, g } = fabrica()
    await g.iniciarTodos([numero(1)])
    await g.novaSessao(1)
    expect(eventos).toContain('nova 1')
    await expect(g.novaSessao(2)).rejects.toThrow('desativado')
  })

  it('pararTodos fecha tudo', async () => {
    const { eventos, g } = fabrica()
    await g.iniciarTodos([numero(1), numero(2)])
    await g.pararTodos()
    expect(eventos.filter((e) => e.startsWith('parar'))).toEqual(['parar 1', 'parar 2'])
    expect(g.estados().size).toBe(0)
  })

  it('parar durante um iniciar pendente: o expedidor não chega a iniciar; conexao.parar só depois do iniciar terminar', async () => {
    const eventos: string[] = []
    const comecouIniciar = deferido<void>()
    const liberaIniciar = deferido<void>()
    const criar = (n: Numero) => {
      let estado: EstadoConexao = { status: 'iniciando', qr: null, desde: AGORA, numero: null, motivo: null }
      const conexao: ConexaoGerida = {
        get estadoAtual() {
          return estado
        },
        iniciar: async () => {
          eventos.push('iniciar-inicio')
          comecouIniciar.resolve()
          await liberaIniciar.promise
          eventos.push('iniciar-fim')
          estado = { ...estado, status: 'conectado' }
        },
        parar: async () => void eventos.push('parar'),
        novaSessao: async () => {}
      }
      const expedidor = {
        iniciar: () => void eventos.push('exp-iniciar'),
        parar: () => void eventos.push('exp-parar'),
        acordar: async () => {}
      }
      return { conexao, expedidor }
    }
    const g = new GerenciadorConexoes(criar, log)

    const pAdicionar = g.adicionar(numero(1))
    await comecouIniciar.promise // garante que iniciar() já começou e a linha já está registrada
    const pParar = g.parar(1)
    liberaIniciar.resolve()
    await pAdicionar
    await pParar

    // o expedidor nunca chegou a iniciar: adicionar() viu que a linha já tinha sido removida
    expect(eventos).toEqual(['iniciar-inicio', 'iniciar-fim', 'exp-parar', 'parar'])
    expect(g.estado(1)).toBeNull()
    expect(g.conexao(1)).toBeNull()
  })

  it('duas trocas de sessão do mesmo número rodam em sequência, nunca ao mesmo tempo', async () => {
    const eventos: string[] = []
    const liberaPrimeira = deferido<void>()
    const liberaSegunda = deferido<void>()
    let chamadas = 0
    const criar = () => {
      const conexao: ConexaoGerida = {
        estadoAtual: { status: 'conectado', qr: null, desde: AGORA, numero: null, motivo: null },
        iniciar: async () => {},
        parar: async () => {},
        novaSessao: async () => {
          chamadas++
          const minha = chamadas
          eventos.push(`nova-inicio-${minha}`)
          await (minha === 1 ? liberaPrimeira.promise : liberaSegunda.promise)
          eventos.push(`nova-fim-${minha}`)
        }
      }
      return { conexao, expedidor: { iniciar: () => {}, parar: () => {}, acordar: async () => {} } }
    }
    const g = new GerenciadorConexoes(criar, log)
    await g.adicionar(numero(1))

    const p1 = g.novaSessao(1)
    const p2 = g.novaSessao(1)
    liberaPrimeira.resolve()
    await p1
    liberaSegunda.resolve()
    await p2

    expect(eventos).toEqual(['nova-inicio-1', 'nova-fim-1', 'nova-inicio-2', 'nova-fim-2'])
  })

  it('adicionar duas vezes ao mesmo tempo para o mesmo número só chama criar uma vez', async () => {
    let criarChamadas = 0
    const criar = () => {
      criarChamadas++
      const conexao: ConexaoGerida = {
        estadoAtual: { status: 'iniciando', qr: null, desde: AGORA, numero: null, motivo: null },
        iniciar: async () => {},
        parar: async () => {},
        novaSessao: async () => {}
      }
      return { conexao, expedidor: { iniciar: () => {}, parar: () => {}, acordar: async () => {} } }
    }
    const g = new GerenciadorConexoes(criar, log)
    await Promise.all([g.adicionar(numero(1)), g.adicionar(numero(1))])
    expect(criarChamadas).toBe(1)
  })
})

describe('pastas de sessão', () => {
  it('a sessão de antes vira a do número 1, sem precisar ler o QR de novo; só uma vez', async () => {
    const dados = pastaTemp()
    mkdirSync(join(dados, 'sessao'))
    writeFileSync(join(dados, 'sessao', 'creds.json'), '{}')
    expect(await moverSessaoAntiga(dados)).toBe(true)
    expect(existsSync(join(pastaSessaoNumero(dados, 1), 'creds.json'))).toBe(true)
    expect(existsSync(join(dados, 'sessao'))).toBe(false)
    expect(await moverSessaoAntiga(dados)).toBe(false)
  })

  it('não mexe se o número 1 já tem sessão', async () => {
    const dados = pastaTemp()
    mkdirSync(join(dados, 'sessao'))
    mkdirSync(pastaSessaoNumero(dados, 1), { recursive: true })
    expect(await moverSessaoAntiga(dados)).toBe(false)
    expect(existsSync(join(dados, 'sessao'))).toBe(true)
  })

  it('tenta de novo em EPERM antes de desistir do rename', async () => {
    const dados = pastaTemp()
    const antiga = join(dados, 'sessao')
    mkdirSync(antiga)
    writeFileSync(join(antiga, 'creds.json'), '{}')
    let tentativas = 0
    const fs = {
      rename: async (de: string, para: string) => {
        if (de === antiga && tentativas++ < 1) {
          const erro = new Error('em uso') as NodeJS.ErrnoException
          erro.code = 'EPERM'
          throw erro
        }
        return rename(de, para)
      },
      cp,
      rm,
      mkdir
    }
    expect(await moverSessaoAntiga(dados, fs)).toBe(true)
    expect(tentativas).toBe(2) // falhou na 1ª tentativa, teve sucesso na 2ª
    expect(existsSync(join(pastaSessaoNumero(dados, 1), 'creds.json'))).toBe(true)
  })

  it('cai para cópia quando mover entre dispositivos falha (EXDEV) e limpa uma pasta .parcial de antes', async () => {
    const dados = pastaTemp()
    const antiga = join(dados, 'sessao')
    mkdirSync(antiga)
    writeFileSync(join(antiga, 'creds.json'), '{}')
    const parcial = `${pastaSessaoNumero(dados, 1)}.parcial`
    mkdirSync(parcial, { recursive: true })
    writeFileSync(join(parcial, 'lixo-de-uma-tentativa-anterior.json'), '{}')

    const fs = {
      rename: async (de: string, para: string) => {
        if (de === antiga) {
          const erro = new Error('cruza dispositivos') as NodeJS.ErrnoException
          erro.code = 'EXDEV'
          throw erro
        }
        return rename(de, para)
      },
      cp,
      rm,
      mkdir
    }
    expect(await moverSessaoAntiga(dados, fs)).toBe(true)
    expect(existsSync(join(pastaSessaoNumero(dados, 1), 'creds.json'))).toBe(true)
    expect(existsSync(join(pastaSessaoNumero(dados, 1), 'lixo-de-uma-tentativa-anterior.json'))).toBe(false)
    expect(existsSync(antiga)).toBe(false)
    expect(existsSync(parcial)).toBe(false)
  })

  it('erro ao copiar remove a pasta .parcial e propaga o erro', async () => {
    const dados = pastaTemp()
    const antiga = join(dados, 'sessao')
    mkdirSync(antiga)
    writeFileSync(join(antiga, 'creds.json'), '{}')
    const fs = {
      rename: async (de: string, para: string) => {
        if (de === antiga) {
          const erro = new Error('cruza dispositivos') as NodeJS.ErrnoException
          erro.code = 'EXDEV'
          throw erro
        }
        return rename(de, para)
      },
      cp: async () => {
        throw new Error('disco cheio')
      },
      rm,
      mkdir
    }
    await expect(moverSessaoAntiga(dados, fs)).rejects.toThrow('disco cheio')
    expect(existsSync(`${pastaSessaoNumero(dados, 1)}.parcial`)).toBe(false)
  })
})
