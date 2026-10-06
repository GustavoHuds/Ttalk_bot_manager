import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { botModelo, prepararBot } from '../src/config/bots.js'
import { paginaEditorBot } from '../src/painel/editor.js'
import { padrao } from './ajuda.js'

/** Roda o script real da página num DOM simulado e devolve o JSON que seria enviado. */
function abrir(html: string) {
  const dom = new JSDOM(html, { runScripts: 'dangerously' })
  dom.window.confirm = () => true
  const doc = dom.window.document
  const enviar = () => {
    doc.getElementById('f')!.dispatchEvent(new dom.window.Event('submit', { cancelable: true }))
    return JSON.parse((doc.getElementById('dados') as HTMLInputElement).value) as Record<string, unknown>
  }
  return { doc, enviar }
}

describe('editor de bots no navegador', () => {
  const html = paginaEditorBot({
    dados: { ...botModelo('2026-10-06'), codigo: 'VEND-OUT26', vaga: 'Vendedor', encerra_em: '2026-10-31' },
    padrao,
    original: 'VEND-OUT26',
    candidaturas: 0,
    erro: null,
    usuario: 'rh'
  })

  it('mostra as perguntas do bot e envia exatamente o que está na tela', () => {
    const { doc, enviar } = abrir(html)
    expect(doc.querySelectorAll('#perguntas > li')).toHaveLength(4)
    const dados = enviar()
    const perguntas = dados.perguntas as { chave: string; tipo: string }[]
    expect(perguntas.map((p) => p.chave)).toEqual(['nome', 'cidade', 'disponibilidade', 'pretensao', 'curriculo'])
    expect(() => prepararBot(dados, padrao, 'aberto')).not.toThrow()
  })

  it('campos escondidos ficam realmente escondidos (o CSS de label não anula o hidden)', () => {
    // O jsdom não resolve a cascata como o navegador; a regra precisa existir na página.
    expect(html).toContain('[hidden]{display:none!important}')
    const { doc } = abrir(html)
    expect((doc.querySelector('#perguntas > li .q_ops') as HTMLElement).hidden).toBe(true)
  })

  it('adicionar, reordenar, trocar tipo e remover perguntas', () => {
    const { doc, enviar } = abrir(html)
    const lista = doc.getElementById('perguntas')!
    ;(doc.getElementById('adicionar') as HTMLButtonElement).click()
    const nova = lista.lastElementChild!
    ;(nova.querySelector('.q_texto') as HTMLInputElement).value = 'Você tem CNH?'
    const tipo = nova.querySelector('.q_tipo') as HTMLSelectElement
    tipo.value = 'enquete'
    tipo.dispatchEvent(new doc.defaultView!.Event('change'))
    expect((nova.querySelector('.q_ops') as HTMLElement).hidden).toBe(false)
    ;(nova.querySelector('.q_opcoes') as HTMLTextAreaElement).value = 'Sim\nNão'
    ;(nova.querySelector('.q_cima') as HTMLButtonElement).click()
    ;(lista.children[0]!.querySelector('.q_remover') as HTMLButtonElement).click()
    ;(doc.querySelector('.cv_formato[value="png"]') as HTMLInputElement).checked = false
    const mensagem = doc.querySelector('[data-msg="confirmacao"]') as HTMLTextAreaElement
    mensagem.value = 'Valeu, {primeiro_nome}!'

    const dados = enviar()
    const perguntas = dados.perguntas as { chave: string; texto: string; tipo: string; opcoes?: string[]; formatos?: string[] }[]
    expect(perguntas.map((p) => p.texto)).toEqual([
      'Em qual cidade e bairro você mora?',
      'Qual horário você tem disponível?',
      'Você tem CNH?',
      'Qual é a sua pretensão salarial? Pode responder "a combinar".',
      'Agora envie seu currículo em PDF, Word ou foto.'
    ])
    expect(perguntas[2]).toMatchObject({ chave: '', tipo: 'enquete', opcoes: ['Sim', 'Não'] })
    expect(perguntas[4]!.formatos).toEqual(['pdf', 'docx', 'jpg'])
    expect(dados.mensagens).toEqual({ confirmacao: 'Valeu, {primeiro_nome}!' })

    const { processo } = prepararBot(dados, padrao, 'aberto')
    expect(processo.perguntas[2]!.chave).toBe('cnh')
    expect(processo.mensagens.confirmacao).toBe('Valeu, {primeiro_nome}!')
  })

  it('texto com aspas e < não quebra a página', () => {
    const perigoso = paginaEditorBot({
      dados: {
        ...botModelo('2026-10-06'),
        codigo: 'X-1',
        vaga: '<b>"Vaga"</b>',
        encerra_em: '2026-10-31',
        perguntas: [
          { chave: 'a', tipo: 'texto', texto: '</script><script>window.invadido=1</script>' },
          { chave: 'curriculo', tipo: 'arquivo', texto: 'CV', formatos: ['pdf'], tamanho_max_mb: 10 }
        ]
      },
      padrao,
      original: null,
      candidaturas: 0,
      erro: null,
      usuario: 'rh'
    })
    const { doc, enviar } = abrir(perigoso)
    expect((doc.defaultView as unknown as { invadido?: number }).invadido).toBeUndefined()
    expect((doc.querySelector('.q_texto') as HTMLInputElement).value).toBe('</script><script>window.invadido=1</script>')
    expect(enviar().vaga).toBe('<b>"Vaga"</b>')
  })
})
