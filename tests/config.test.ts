import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ErroConfig, lerConfig, situacao, validarProcesso } from '../src/config/carregar.js'
import { AGORA, padrao, pastaTemp, processo } from './ajuda.js'

const CONFIG = join(import.meta.dirname, '..', 'config')

describe('configuração', () => {
  it('lê os arquivos reais do projeto sem erros', () => {
    const c = lerConfig(CONFIG)
    expect(c.erros).toEqual([])
    expect(c.processos.map((p) => p.codigo)).toEqual(['VEND-OUT26'])
    expect(c.processos[0]!.mensagens.pede_nome).toBe('Para começar, qual é o seu nome completo?')
  })

  it('mensagens do processo sobrescrevem o padrão', () => {
    const p = processo({ mensagens: { pede_nome: 'Seu nome?' } })
    expect(p.mensagens.pede_nome).toBe('Seu nome?')
    expect(p.mensagens.pede_cidade).toBe(padrao.pede_cidade)
  })

  it('datas valem o dia inteiro no horário de Brasília', () => {
    const p = processo()
    expect(situacao(p, Date.UTC(2026, 9, 6, 3))).toBe('aberto') // 06/10 00:00
    expect(situacao(p, Date.UTC(2026, 9, 6, 2, 59))).toBe('fechado')
    expect(situacao(p, Date.UTC(2026, 10, 1, 2, 59))).toBe('aberto') // 31/10 23:59
    expect(situacao(p, Date.UTC(2026, 10, 1, 3))).toBe('fechado')
  })

  it.each([
    [{ status: 'ativo' }, /status/],
    [{ retencao_meses: 0 }, /retencao_meses/],
    [{ encerra_em: '31/10/2026' }, /AAAA-MM-DD/],
    [{ perguntas: [{ chave: 'telefone', tipo: 'texto', texto: 'x' }] }, /reservada/],
    [{ perguntas: [{ chave: 'escolaridade', tipo: 'texto' }] }, /pede_escolaridade/],
    [{ perguntas: [{ chave: 'turno', tipo: 'enquete', texto: 'Turno?', opcoes: ['A'] }] }, /2 a 12/],
    [{ perguntas: [{ chave: 'cv', tipo: 'arquivo', texto: 'CV', formatos: ['exe'] }] }, /formatos/]
  ])('recusa configuração inválida %#', (extra, erro) => {
    expect(() => processo(extra)).toThrow(erro)
  })

  it('um YAML com erro fica de fora sem derrubar os outros', () => {
    const dir = pastaTemp()
    mkdirSync(join(dir, 'processos'))
    copyFileSync(join(CONFIG, 'mensagens-padrao.yaml'), join(dir, 'mensagens-padrao.yaml'))
    copyFileSync(join(CONFIG, 'processos', 'VEND-OUT26.yaml'), join(dir, 'processos', 'a.yaml'))
    writeFileSync(join(dir, 'processos', 'b.yaml'), 'codigo: X1\nvaga: Y\nstatus: aberto\n')
    writeFileSync(
      join(dir, 'processos', 'c.yaml'),
      'codigo: VEND-OUT26\nvaga: Dup\nstatus: aberto\nencerra_em: 2026-12-01\nretencao_meses: 1\nperguntas:\n  - {chave: nome, tipo: texto}\n'
    )
    const c = lerConfig(dir, AGORA)
    expect(c.processos).toHaveLength(1)
    expect(c.erros).toHaveLength(2)
    expect(c.erros[1]).toMatch(/já usado/)
  })

  it('arquivo vazio gera ErroConfig', () => {
    expect(() => validarProcesso(null, padrao, 'x')).toThrow(ErroConfig)
  })
})
