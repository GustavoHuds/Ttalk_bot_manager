import { existsSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { ArmazemArquivos } from '../src/arquivos.js'
import type { Processo } from '../src/config/tipos.js'
import { ESPERA_ARQUIVOS_MS } from '../src/conversa/motor.js'
import { Orquestrador, type MensagemRecebida } from '../src/conversa/orquestrador.js'
import type { Entrada } from '../src/conversa/tipos.js'
import { abrirBanco } from '../src/db/banco.js'
import { Repositorio } from '../src/db/repositorio.js'
import { AGORA, JPG, PDF, config, log, pastaTemp, processo } from './ajuda.js'

const JID = '5583999990000@s.whatsapp.net'

describe('fluxo completo com banco', () => {
  let t: number
  let repo: Repositorio
  let armazem: ArmazemArquivos
  let orq: Orquestrador
  let midias: Map<string, Buffer | Error>
  let seq = 0
  let processos: Processo[]

  beforeEach(() => {
    t = AGORA
    seq = 0
    processos = [processo()]
    repo = new Repositorio(abrirBanco(':memory:'))
    armazem = new ArmazemArquivos(pastaTemp())
    midias = new Map()
    orq = new Orquestrador({
      repo,
      config: () => config(processos),
      baixarMidia: async (_numeroId, bruto) => {
        const m = midias.get(bruto)
        if (!m || m instanceof Error) throw m ?? new Error('sem mídia')
        return m
      },
      armazem,
      log,
      relogio: () => t,
      aleatorio: () => 0
    })
  })

  function msg(entrada: Entrada, extra: Partial<MensagemRecebida> = {}): MensagemRecebida {
    seq++
    return { numeroId: 1, id: `M${seq}`, jid: JID, telefone: '5583999990000', lid: null, recebidaEm: t, entrada, ...extra }
  }

  async function enviar(entrada: Entrada, extra: Partial<MensagemRecebida> = {}) {
    t += 5000
    const m = msg(entrada, extra)
    orq.receber(m)
    await orq.ocioso()
    return m
  }

  async function arquivo(dados: Buffer | Error, mimetype = 'application/pdf', extra: Partial<MensagemRecebida> = {}) {
    const bruto = `bruto-${seq + 1}`
    midias.set(bruto, dados)
    return enviar({ tipo: 'arquivo', mimetype, nomeArquivo: null, tamanho: 100 }, { bruto, ...extra })
  }

  /** Drena a caixa de saída como o expedidor faria e devolve os textos. */
  function saida(numeroId = 1): string[] {
    const textos: string[] = []
    for (;;) {
      const item = repo.proximaSaida(numeroId, JID)
      if (!item) return textos
      const e = JSON.parse(item.conteudo) as { tipo: string; texto?: string; pergunta?: string }
      textos.push(e.texto ?? `[enquete] ${e.pergunta}`)
      repo.removerSaida(item.id)
    }
  }

  async function fecharLote() {
    t += ESPERA_ARQUIVOS_MS + 1
    orq.verificarFinalizacoes()
    await orq.ocioso()
  }

  it('do link ao currículo, com fotos de várias páginas agrupadas', async () => {
    await enviar({ tipo: 'texto', texto: 'Quero me candidatar [VEND-OUT26]' })
    expect(saida()).toHaveLength(3)
    await enviar({ tipo: 'texto', texto: 'Maria da Silva' })
    await enviar({ tipo: 'texto', texto: 'João Pessoa, Mangabeira' })
    expect(saida()).toEqual(['Em qual cidade e bairro você mora?', '[enquete] Qual horário você tem disponível?'])
    await enviar({ tipo: 'voto', chave: 'disponibilidade', opcoes: ['Tarde'] })
    await enviar({ tipo: 'texto', texto: 'a combinar' })
    saida()

    await arquivo(JPG, 'image/jpeg')
    await arquivo(JPG, 'image/jpeg')
    expect(saida()).toEqual(['Recebido! Se o currículo tiver mais páginas, pode enviar em seguida.'])
    await fecharLote()
    expect(saida()[0]).toContain('Obrigado, Maria! Recebemos seu currículo (protocolo VEND-OUT26-0001)')

    const [c] = repo.candidatosDoProcesso('VEND-OUT26')
    expect(c!.status).toBe('concluida')
    expect(c!.respostas).toEqual({ nome: 'Maria da Silva', cidade: 'João Pessoa, Mangabeira', disponibilidade: 'Tarde', pretensao: 'a combinar' })
    expect(c!.arquivos).toHaveLength(2)
    expect(c!.arquivos[0]!.caminho).toMatch(/^curriculos\/VEND-OUT26\/2026-10\/[0-9a-f]{32}\.jpg$/)
    expect(existsSync(armazem.absoluto(c!.arquivos[0]!.caminho))).toBe(true)
    expect(repo.filas().entrada).toBe(0)
  })

  it('contato direto mandando o currículo como primeira mensagem: nada se perde', async () => {
    await arquivo(PDF)
    const primeiras = saida()
    expect(primeiras[2]).toContain('Recebi seu currículo')
    for (const r of ['Maria Silva', 'Recife', '2', 'a combinar']) await enviar({ tipo: 'texto', texto: r })
    expect(saida().at(-1)).toContain('Obrigado, Maria!')
    const [c] = repo.candidatosDoProcesso('VEND-OUT26')
    expect(c!.status).toBe('concluida')
    expect(c!.arquivos).toHaveLength(1)
    expect(c!.arquivos[0]!.caminho).toMatch(/^curriculos\/VEND-OUT26\//)
  })

  it('a mesma mensagem entregue duas vezes é processada uma vez só', async () => {
    const m = msg({ tipo: 'texto', texto: '[VEND-OUT26]' })
    expect(orq.receber(m)).toBe(true)
    expect(orq.receber(m)).toBe(false)
    await orq.ocioso()
    expect(saida()).toHaveLength(3)
  })

  it('mensagem pendente (queda no meio) é reprocessada ao retomar', async () => {
    const m = msg({ tipo: 'texto', texto: '[VEND-OUT26]' })
    repo.registrarRecebida(1, m.id, m.jid, m.recebidaEm, JSON.stringify(m))
    expect(repo.filas().entrada).toBe(1)
    orq.retomarPendentes()
    await orq.ocioso()
    expect(repo.filas().entrada).toBe(0)
    expect(saida()).toHaveLength(3)
  })

  it('falha no download não muda o estado e pede reenvio', async () => {
    await enviar({ tipo: 'texto', texto: '[VEND-OUT26]' })
    for (const r of ['Maria Silva', 'Recife', '1', 'a combinar']) await enviar({ tipo: 'texto', texto: r })
    saida()
    await arquivo(new Error('link expirado'))
    expect(saida()).toEqual(['Não consegui receber seu arquivo. Pode enviar de novo, por favor?'])
    expect(repo.candidatosDoProcesso('VEND-OUT26')[0]!.arquivos).toHaveLength(0)
    expect(repo.paraFinalizar(t + ESPERA_ARQUIVOS_MS * 2)).toHaveLength(0)
  })

  it('arquivo que diz ser PDF mas não é é recusado', async () => {
    await enviar({ tipo: 'texto', texto: '[VEND-OUT26]' })
    for (const r of ['Maria Silva', 'Recife', '1', 'a combinar']) await enviar({ tipo: 'texto', texto: r })
    saida()
    await arquivo(Buffer.from('MZ executável'))
    expect(saida()[0]).toContain('Não consigo abrir esse formato')
  })

  it('só com LID pergunta o telefone e guarda o informado', async () => {
    const lid = { telefone: null, lid: '123456789@lid', jid: JID }
    await enviar({ tipo: 'texto', texto: '[VEND-OUT26]' }, lid)
    for (const r of ['Maria Silva', 'Recife', '1', 'a combinar']) await enviar({ tipo: 'texto', texto: r }, lid)
    await arquivo(PDF, 'application/pdf', lid)
    await fecharLote()
    expect(saida().at(-1)).toBe('Para finalizar, qual é o seu telefone com DDD para contato?')
    await enviar({ tipo: 'texto', texto: '(83) 98888-7777' }, lid)
    expect(saida()[0]).toContain('Obrigado, Maria!')
    expect(repo.candidatosDoProcesso('VEND-OUT26')[0]!.telefone).toBe('5583988887777')
  })

  it('troca de currículo apaga o arquivo antigo do disco', async () => {
    await enviar({ tipo: 'texto', texto: '[VEND-OUT26]' })
    for (const r of ['Maria Silva', 'Recife', '1', 'a combinar']) await enviar({ tipo: 'texto', texto: r })
    await arquivo(PDF)
    await fecharLote()
    const antigo = repo.candidatosDoProcesso('VEND-OUT26')[0]!.arquivos[0]!.caminho
    saida()

    await enviar({ tipo: 'texto', texto: 'oi' })
    expect(saida()[0]).toContain('trocar o currículo')
    await arquivo(PDF)
    await fecharLote()
    expect(saida().at(-1)).toBe('Pronto, Maria! Seu currículo foi atualizado.')
    const arquivos = repo.candidatosDoProcesso('VEND-OUT26')[0]!.arquivos
    expect(arquivos).toHaveLength(1)
    expect(arquivos[0]!.caminho).not.toBe(antigo)
    expect(existsSync(armazem.absoluto(antigo))).toBe(false)
  })

  it('"excluir meus dados" + SIM apaga candidatura e arquivos, registrando só a data', async () => {
    await enviar({ tipo: 'texto', texto: '[VEND-OUT26]' })
    for (const r of ['Maria Silva', 'Recife', '1', 'a combinar']) await enviar({ tipo: 'texto', texto: r })
    await arquivo(PDF)
    await fecharLote()
    const caminho = repo.candidatosDoProcesso('VEND-OUT26')[0]!.arquivos[0]!.caminho
    saida()

    await enviar({ tipo: 'texto', texto: 'quero excluir meus dados' })
    await enviar({ tipo: 'texto', texto: 'SIM' })
    expect(saida().at(-1)).toBe('Pronto. Seus dados foram excluídos.')
    expect(repo.candidatosDoProcesso('VEND-OUT26')).toHaveLength(0)
    expect(existsSync(armazem.absoluto(caminho))).toBe(false)
    expect(repo.auditoriaRecente(1)[0]).toMatchObject({ usuario: 'candidato', acao: 'exclusao_a_pedido', detalhe: null })

    // Depois de excluir, pode se candidatar de novo do zero.
    await enviar({ tipo: 'texto', texto: 'oi' })
    expect(saida()[2]).toBe('Para começar, qual é o seu nome completo?')
  })

  it('dois números de recrutamento não dividem a conversa', async () => {
    processos = [processo(), processo({ codigo: 'CAIXA-NOV26', vaga: 'Operador(a) de caixa', numero_id: 2 })]
    await enviar({ tipo: 'texto', texto: 'oi' })
    await enviar({ tipo: 'texto', texto: 'oi' }, { numeroId: 2 })
    expect(repo.candidaturasDoContato(1, JID).map((c) => c.processo)).toEqual(['VEND-OUT26'])
    expect(repo.candidaturasDoContato(2, JID).map((c) => c.processo)).toEqual(['CAIXA-NOV26'])
    expect(repo.conversa(1, JID)!.candidaturaId).not.toBe(repo.conversa(2, JID)!.candidaturaId)
    expect(saida(2).join('\n')).toContain('Operador(a) de caixa')
    expect(saida(1).join('\n')).toContain('Vendedor(a) de loja')
  })
})
