import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ArmazemArquivos } from '../src/arquivos.js'
import { abrirBanco } from '../src/db/banco.js'
import { Repositorio } from '../src/db/repositorio.js'
import { VigiaConexao, type Alertas } from '../src/rotinas/alerta.js'
import { fazerBackup, restaurarBackup } from '../src/rotinas/backup.js'
import { aplicarRetencao } from '../src/rotinas/retencao.js'
import { AGORA, PDF, config, log, pastaTemp, processo } from './ajuda.js'

describe('retenção', () => {
  it('apaga dados e arquivos só depois de retencao_meses do encerramento', async () => {
    const repo = new Repositorio(abrirBanco(':memory:'))
    const armazem = new ArmazemArquivos(pastaTemp())
    const id = repo.criarCandidatura(1, 'VEND-OUT26', 'x@s.whatsapp.net', null, null, AGORA)
    const arq = await armazem.salvar('VEND-OUT26', 'pdf', 'application/pdf', PDF, AGORA)
    repo.registrarArquivo(id, arq, AGORA)
    const cfg = config([processo({ retencao_meses: 12 })])

    const antes = await aplicarRetencao({ repo, config: cfg, armazem, log, agora: Date.UTC(2027, 9, 30) })
    expect(antes.apagados).toEqual([])
    const depois = await aplicarRetencao({ repo, config: cfg, armazem, log, agora: Date.UTC(2027, 10, 2) })
    expect(depois.apagados).toEqual([{ processo: 'VEND-OUT26', candidaturas: 1 }])
    expect(existsSync(armazem.absoluto(arq.caminho))).toBe(false)
    expect(repo.auditoriaRecente(1)[0]).toMatchObject({ usuario: 'sistema', acao: 'retencao' })
  })

  it('não toca dados de processo sem YAML', async () => {
    const repo = new Repositorio(abrirBanco(':memory:'))
    repo.criarCandidatura(1, 'ANTIGO', 'x@s.whatsapp.net', null, null, AGORA)
    const r = await aplicarRetencao({ repo, config: config([]), armazem: new ArmazemArquivos(pastaTemp()), log, agora: Date.UTC(2030, 0, 1) })
    expect(r.semConfig).toEqual(['ANTIGO'])
    expect(repo.processosComDados()).toEqual(['ANTIGO'])
  })
})

describe('backup', () => {
  it('gera arquivo cifrado que só abre com a senha certa', async () => {
    const dados = pastaTemp()
    const db = abrirBanco(join(dados, 'banco.sqlite'))
    new Repositorio(db).criarCandidatura(1, 'VEND-OUT26', 'x@s.whatsapp.net', null, null, AGORA)
    mkdirSync(join(dados, 'curriculos', 'VEND-OUT26'), { recursive: true })
    writeFileSync(join(dados, 'curriculos', 'VEND-OUT26', 'a.pdf'), PDF)

    const arquivo = await fazerBackup({ db, dados, senha: 'segredo-do-backup', agora: AGORA })
    expect(readFileSync(arquivo).includes(PDF)).toBe(false)

    await expect(restaurarBackup(arquivo, 'senha-errada', join(pastaTemp(), 'x'))).rejects.toThrow()

    const destino = pastaTemp()
    await restaurarBackup(arquivo, 'segredo-do-backup', destino)
    expect(readFileSync(join(destino, 'curriculos', 'VEND-OUT26', 'a.pdf'))).toEqual(PDF)
    const banco = join(destino, 'backups', `.tmp-${AGORA}`, 'banco.sqlite')
    const restaurado = new Database(banco, { readonly: true })
    expect(restaurado.prepare('SELECT protocolo FROM candidaturas').get()).toEqual({ protocolo: 'VEND-OUT26-0001' })
    restaurado.close()
    db.close()
  })
})

describe('vigia da conexão', () => {
  it('avisa uma vez após 10 min fora, avisa logout na hora e avisa a volta', () => {
    const enviados: string[] = []
    const alertas = { enviar: async (assunto: string) => void enviados.push(assunto) } as unknown as Alertas
    let t = AGORA
    const vigia = new VigiaConexao(alertas, () => t)
    const fora = { status: 'reconectando', desde: AGORA, motivo: null }
    vigia.verificar(fora)
    t += 9 * 60_000
    vigia.verificar(fora)
    expect(enviados).toEqual([])
    t += 2 * 60_000
    vigia.verificar(fora)
    vigia.verificar(fora)
    expect(enviados).toEqual(['Bot fora do ar há mais de 10 minutos'])
    vigia.verificar({ status: 'conectado', desde: t, motivo: null })
    vigia.verificar({ status: 'desconectado', desde: t, motivo: 'sessão encerrada' })
    expect(enviados).toEqual(['Bot fora do ar há mais de 10 minutos', 'Conexão restabelecida', 'Sessão do WhatsApp encerrada'])
  })

  it('com vários números, o alerta diz qual caiu', () => {
    const enviados: { assunto: string; texto: string }[] = []
    const alertas = { enviar: async (assunto: string, texto: string) => void enviados.push({ assunto, texto }) } as unknown as Alertas
    const vigia = new VigiaConexao(alertas, () => AGORA, 'Avisos')
    vigia.verificar({ status: 'desconectado', desde: AGORA, motivo: 'sessão encerrada' })
    expect(enviados[0]!.assunto).toBe('Sessão do WhatsApp encerrada (Avisos)')
    expect(enviados[0]!.texto).toContain('Números')
  })
})
