import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FonteBots, gerarChave } from '../src/config/bots.js'
import { lerPadrao, lerYamlProcessos } from '../src/config/carregar.js'
import { abrirBanco } from '../src/db/banco.js'
import { Repositorio } from '../src/db/repositorio.js'
import { AGORA } from './ajuda.js'

const CONFIG = join(import.meta.dirname, '..', 'config')

describe('bots no banco', () => {
  it('importa os YAML antigos uma vez só, com o texto de cada pergunta preenchido', () => {
    const repo = new Repositorio(abrirBanco(':memory:'))
    const fonte = new FonteBots(repo, lerPadrao(CONFIG))
    expect(fonte.importarYaml(lerYamlProcessos(CONFIG), AGORA).importados).toEqual(['VEND-OUT26'])
    const p = fonte.get().processos[0]!
    expect(p.perguntas[0]).toMatchObject({ chave: 'nome', texto: 'Para começar, qual é o seu nome completo?' })
    expect(fonte.importarYaml(lerYamlProcessos(CONFIG), AGORA).importados).toEqual([])
  })

  it('bot com dado inválido fica de fora e aparece como erro', () => {
    const repo = new Repositorio(abrirBanco(':memory:'))
    repo.salvarBot('X-1', JSON.stringify({ codigo: 'X-1', vaga: 'X' }), 1, 'teste', AGORA)
    const c = new FonteBots(repo, lerPadrao(CONFIG)).get()
    expect(c.processos).toEqual([])
    expect(c.erros[0]).toMatch(/^bot X-1:/)
  })

  it('gera chaves legíveis, únicas e fora das reservadas', () => {
    const usadas = new Set<string>(['cidade'])
    expect(gerarChave('Qual é a sua cidade?', usadas)).toBe('cidade_2')
    expect(gerarChave('Telefone?', usadas)).toBe('telefone_2')
    expect(gerarChave('Você tem CNH?', usadas)).toBe('cnh')
    expect(gerarChave('???', usadas)).toBe('pergunta')
  })

  it('o número do bot vem da coluna, não do JSON', () => {
    const repo = new Repositorio(abrirBanco(':memory:'))
    const fonte = new FonteBots(repo, lerPadrao(CONFIG))
    fonte.importarYaml(lerYamlProcessos(CONFIG), AGORA)
    const bruto = JSON.parse(repo.bot('VEND-OUT26')!)
    repo.salvarBot('VEND-OUT26', JSON.stringify({ ...bruto, numero_id: 9 }), 2, 'teste', AGORA)
    fonte.invalidar()
    expect(fonte.get().processos[0]!.numeroId).toBe(2)
  })
})
