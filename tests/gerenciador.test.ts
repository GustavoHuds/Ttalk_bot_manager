import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Numero } from '../src/db/numeros.js'
import type { EstadoConexao } from '../src/whatsapp/baileys.js'
import { GerenciadorConexoes, moverSessaoAntiga, pastaSessaoNumero, type ConexaoGerida } from '../src/whatsapp/gerenciador.js'
import { AGORA, log, pastaTemp } from './ajuda.js'

const numero = (id: number, ativo = true): Numero => ({ id, nome: `N${id}`, papel: 'recrutamento', ativo, criadoEm: AGORA })

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
})
