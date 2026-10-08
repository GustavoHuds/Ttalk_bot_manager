import { describe, expect, it } from 'vitest'
import type { Funcionario } from '../src/db/grupos.js'
import { DURACAO_SESSAO_MS, INTERVALO_MENCAO_EM_MASSA_MS, dentroDoSilencio, horarios, palavraProibida, processar } from '../src/grupos/motor.js'
import type { AcaoGrupo, ContextoGrupos, GrupoDoBot, MembroGrupo, Pessoa } from '../src/grupos/tipos.js'
import { AGORA } from './ajuda.js'

const LOJA: GrupoDoBot = { jid: 'loja@g.us', nome: 'Loja Centro', botAdmin: true }
const GERENTES: GrupoDoBot = { jid: 'ger@g.us', nome: 'Gerentes', botAdmin: false }
const ANA: Funcionario = { id: 1, nome: 'Ana', telefone: '5583999990001', lid: null, ativo: true, confirmadoEm: AGORA }
const BIA: Funcionario = { id: 2, nome: 'Bia', telefone: '5583999990002', lid: null, ativo: true, confirmadoEm: null }
const anaPessoa: Pessoa = { jid: '5583999990001@s.whatsapp.net', telefone: '5583999990001', lid: null }
const membros: MembroGrupo[] = [
  { jid: '111@lid', telefone: '5583999990009', lid: '111@lid', admin: false },
  { jid: '5583999990008@s.whatsapp.net', telefone: '5583999990008', lid: null, admin: false },
  { jid: '333@lid', telefone: null, lid: '333@lid', admin: true }
]

function ctx(extra: Partial<ContextoGrupos> = {}): ContextoGrupos {
  return {
    agora: AGORA,
    bot: { id: 1, nome: 'Avisos' },
    desligados: new Set(),
    chat: LOJA.jid,
    ehGrupo: true,
    mensagem: { chat: LOJA.jid, id: 'M1', participante: anaPessoa.jid },
    remetente: anaPessoa,
    mencionados: [],
    citada: null,
    midia: null,
    pessoas: [ANA, BIA],
    gestores: new Set([1]),
    pendentes: [{ funcionarioId: 2, codigo: '123456', expiraEm: AGORA + 1000 }],
    grupos: [GERENTES, LOJA],
    sessao: null,
    alvo: LOJA,
    membros,
    palavras: [],
    ultimaMencaoEmMassa: null,
    ...extra
  }
}

const cmd = (texto: string) => ({ tipo: 'comando' as const, texto })
const respostas = (acoes: AcaoGrupo[]) => acoes.flatMap((a) => (a.tipo === 'responder' ? [a.texto] : []))
const envios = (acoes: AcaoGrupo[]) => acoes.flatMap((a) => (a.tipo === 'enviar' ? [a] : []))
const privado = (extra: Partial<ContextoGrupos> = {}) =>
  ctx({ ehGrupo: false, chat: anaPessoa.jid, mensagem: { chat: anaPessoa.jid, id: 'M1', participante: null }, alvo: null, ...extra })

describe('motor do bot de grupos', () => {
  it('quem não é gestor confirmado não recebe nada (nem a pendente)', () => {
    const bia: Pessoa = { jid: '5583999990002@s.whatsapp.net', telefone: '5583999990002', lid: null }
    expect(processar(ctx({ remetente: bia }), cmd('/all oi'))).toEqual([])
    expect(processar(ctx({ remetente: bia }), cmd('/menu'))).toEqual([])
  })

  it('/all no grupo: apaga o comando, manda o texto mencionando todos em segredo', () => {
    const a = processar(ctx(), cmd('/all Reunião às 15h'))
    const [apagar, msg] = envios(a)
    expect(apagar!.envio).toEqual({ tipo: 'apagar', chave: { chat: LOJA.jid, id: 'M1', participante: anaPessoa.jid } })
    expect(msg!.envio).toEqual({ tipo: 'texto', texto: 'Reunião às 15h', mencoes: membros.map((m) => m.jid) })
    expect(respostas(a)).toEqual([])
    expect(a).toContainEqual({ tipo: 'mencao_em_massa', jid: LOJA.jid })
  })

  it('/all sem texto no grupo usa o aviso padrão; sem admin não apaga o comando', () => {
    const a = processar(ctx({ alvo: { ...LOJA, botAdmin: false } }), cmd('/all'))
    expect(envios(a)).toHaveLength(1)
    expect(envios(a)[0]!.envio).toMatchObject({ tipo: 'texto', texto: '📢 Todos do grupo mencionados!' })
  })

  it('/todos mostra as menções no texto', () => {
    const a = processar(ctx(), cmd('/todos Bom dia'))
    expect(envios(a)[1]!.envio).toMatchObject({ texto: 'Bom dia\n\n@111 @5583999990008 @333' })
  })

  it('freio: segunda menção a todos no mesmo grupo em menos de 1 minuto é recusada', () => {
    const a = processar(ctx({ ultimaMencaoEmMassa: AGORA - INTERVALO_MENCAO_EM_MASSA_MS + 10_000 }), cmd('/all oi'))
    expect(envios(a)).toEqual([])
    expect(respostas(a)[0]).toMatch(/Espere 10s/)
  })

  it('no privado sem grupo escolhido: pergunta numerado e guarda o comando', () => {
    const a = processar(privado(), cmd('/all Oi pessoal'))
    expect(respostas(a)[0]).toBe('Em qual grupo? Responda com o número:\n1. Gerentes\n2. Loja Centro')
    expect(a).toContainEqual({ tipo: 'sessao', sessao: { grupo: null, aguardando: 'grupo', pendente: '/all Oi pessoal', ate: AGORA + DURACAO_SESSAO_MS } })
  })

  it('a resposta com o número escolhe o grupo e manda rodar o comando guardado', () => {
    const sessao = { grupo: null, aguardando: 'grupo' as const, pendente: '/all Oi', ate: AGORA + 1000 }
    const a = processar(privado({ sessao }), { tipo: 'resposta', texto: '2' })
    expect(a).toEqual([
      { tipo: 'sessao', sessao: { grupo: LOJA.jid, aguardando: null, pendente: null, ate: AGORA + DURACAO_SESSAO_MS } },
      { tipo: 'executar', texto: '/all Oi' }
    ])
    expect(respostas(processar(privado({ sessao }), { tipo: 'resposta', texto: '9' }))[0]).toMatch(/de 1 a 2/)
  })

  it('/all no privado com o grupo escolhido: envia lá, confirma aqui e não apaga nada', () => {
    const a = processar(privado({ alvo: LOJA }), cmd('/all Oi pessoal'))
    expect(envios(a)).toEqual([{ tipo: 'enviar', jid: LOJA.jid, envio: { tipo: 'texto', texto: 'Oi pessoal', mencoes: membros.map((m) => m.jid) } }])
    expect(respostas(a)).toEqual(['✅ Enviado em *Loja Centro*, com 3 pessoa(s) mencionada(s).'])
  })

  it('/all no privado com foto leva a mídia para o grupo (a legenda é o texto)', () => {
    const midia = { caminho: 'midias/a.jpg', tipo: 'imagem' as const, mimetype: 'image/jpeg', nome: null }
    const a = processar(privado({ alvo: LOJA, midia }), cmd('/all Promoção'))
    expect(envios(a)[0]!.envio).toEqual({ tipo: 'midia', midia, legenda: 'Promoção', mencoes: membros.map((m) => m.jid), temporaria: true })
  })

  it('/mencionar: no grupo pela menção; no privado pelo telefone; texto sem o telefone', () => {
    const noGrupo = processar(ctx({ mencionados: [{ jid: '111@lid', telefone: null, lid: '111@lid' }] }), cmd('/mencionar Passa no caixa'))
    expect(envios(noGrupo)[1]!.envio).toEqual({ tipo: 'texto', texto: 'Passa no caixa', mencoes: ['111@lid'] })
    const noPrivado = processar(privado({ alvo: LOJA }), cmd('/mencionar Passa no caixa 83 99999-0008'))
    expect(envios(noPrivado)[0]!.envio).toEqual({ tipo: 'texto', texto: 'Passa no caixa', mencoes: ['5583999990008@s.whatsapp.net'] })
    expect(respostas(processar(privado({ alvo: LOJA }), cmd('/mencionar oi 83 98888-7777')))[0]).toMatch(/Não achei/)
  })

  it('/remove tira quem foi mencionado, mas nunca um admin', () => {
    const a = processar(
      ctx({ mencionados: [{ jid: '111@lid', telefone: null, lid: '111@lid' }, { jid: '333@lid', telefone: null, lid: '333@lid' }] }),
      cmd('/remove')
    )
    expect(envios(a)).toEqual([{ tipo: 'enviar', jid: LOJA.jid, envio: { tipo: 'remover', participantes: ['111@lid'] } }])
    expect(respostas(a)[0]).toBe('✅ 1 pessoa(s) removida(s) de *Loja Centro*. 1 é admin do grupo e ficou.')
    expect(respostas(processar(ctx({ alvo: GERENTES }), cmd('/remove')))[0]).toMatch(/Preciso ser admin/)
  })

  it('/banword adiciona, lista, remove e limpa', () => {
    expect(processar(ctx(), cmd('/banword Golpe, PIX grátis'))).toContainEqual({ tipo: 'palavras', jid: LOJA.jid, adicionar: ['golpe', 'pix gratis'] })
    expect(respostas(processar(ctx({ palavras: ['golpe'] }), cmd('/banword')))[0]).toBe('🚫 Palavras proibidas em *Loja Centro*: golpe')
    expect(processar(ctx({ palavras: ['golpe'] }), cmd('/banword remover golpe'))).toContainEqual({ tipo: 'palavras_remover', jid: LOJA.jid, palavras: ['golpe'] })
    expect(processar(ctx(), cmd('/banword limpar'))).toContainEqual({ tipo: 'palavras_remover', jid: LOJA.jid, palavras: null })
  })

  it('/mutegroup sem horário fecha até o /unmute; com horário vira janela diária', () => {
    expect(processar(ctx(), cmd('/mutegroup'))).toContainEqual({ tipo: 'silencio', jid: LOJA.jid, inicio: null, fim: null })
    expect(processar(ctx(), cmd('/mutegroup 22h/6h'))).toContainEqual({ tipo: 'silencio', jid: LOJA.jid, inicio: '22:00', fim: '06:00' })
    expect(respostas(processar(ctx(), cmd('/mutegroup 22:00/22:00')))[0]).toMatch(/^Uso/)
    const abrir = processar(ctx(), cmd('/unmute'))
    expect(abrir).toContainEqual({ tipo: 'silencio_remover', jid: LOJA.jid })
    expect(envios(abrir)[0]!.envio).toEqual({ tipo: 'fechar', fechado: false })
  })

  it('/repeat citando a mensagem com horários; sem citação pergunta e espera; stop para', () => {
    const citada = { autor: null, texto: 'Fechamos às 18h', midia: null }
    expect(processar(ctx({ citada }), cmd('/repeat 08:00 18h'))).toContainEqual({
      tipo: 'repetir',
      jid: LOJA.jid,
      horarios: ['08:00', '18:00'],
      texto: 'Fechamos às 18h',
      midia: null
    })
    const pergunta = processar(ctx(), cmd('/repeat'))
    expect(pergunta[0]).toEqual({ tipo: 'sessao', sessao: { grupo: null, aguardando: 'repeat', pendente: null, ate: AGORA + DURACAO_SESSAO_MS } })
    const sessao = { grupo: null, aguardando: 'repeat' as const, pendente: null, ate: AGORA + 1000 }
    expect(respostas(processar(ctx({ sessao }), { tipo: 'resposta', texto: '08:00' }))[0]).toMatch(/citando/)
    expect(processar(ctx({ sessao, citada }), { tipo: 'resposta', texto: '08:00 e 12:30' })).toContainEqual(expect.objectContaining({ tipo: 'repetir', horarios: ['08:00', '12:30'] }))
    expect(processar(ctx(), cmd('/repeat stop'))).toContainEqual({ tipo: 'repetir_parar', jid: LOJA.jid })
  })

  it('comando desligado avisa o gestor; /menu lista só os ligados e mostra o grupo no privado', () => {
    const c = ctx({ desligados: new Set(['remove']) })
    expect(respostas(processar(c, cmd('/remove')))[0]).toBe('O /remove está desligado neste bot.')
    const menu = respostas(processar(c, cmd('/menu')))[0]!
    expect(menu).not.toContain('/remove')
    expect(menu).not.toContain('/grupo')
    expect(respostas(processar(privado({ alvo: LOJA, sessao: { grupo: LOJA.jid, aguardando: null, pendente: null, ate: AGORA + 1 } }), cmd('/menu')))[0]).toContain(
      '📍 Grupo: *Loja Centro*'
    )
  })

  it('/confirmar: código certo do mesmo WhatsApp confirma; de outro vira divergência; errado conta', () => {
    const bia: Pessoa = { jid: '5583999990002@s.whatsapp.net', telefone: '5583999990002', lid: null }
    expect(processar(privado({ remetente: bia }), cmd('/confirmar 123456'))[0]).toEqual({ tipo: 'confirmar_gestor', funcionarioId: 2, pessoa: bia })
    const outro: Pessoa = { jid: '5583977770000@s.whatsapp.net', telefone: '5583977770000', lid: null }
    expect(processar(privado({ remetente: outro }), cmd('/confirmar 123456'))[0]).toMatchObject({ tipo: 'divergencia', funcionarioId: 2 })
    expect(processar(privado({ remetente: outro }), cmd('/confirmar 000000'))[0]).toEqual({ tipo: 'codigo_errado' })
  })

  it('ajudantes: horários, janela de silêncio e palavra inteira', () => {
    expect(horarios('8h, 18:30 e 7')).toEqual(['07:00', '08:00', '18:30'])
    expect(horarios('25:00')).toBeNull()
    // AGORA = 12:00 em Brasília
    expect(dentroDoSilencio('22:00', '06:00', AGORA)).toBe(false)
    expect(dentroDoSilencio('11:00', '13:00', AGORA)).toBe(true)
    expect(dentroDoSilencio(null, null, AGORA)).toBe(true)
    expect(palavraProibida('Isso é GOLPE!', ['golpe'])).toBe('golpe')
    expect(palavraProibida('golpeado', ['golpe'])).toBeNull()
    expect(palavraProibida('ganhe pix grátis', ['pix gratis'])).toBe('pix gratis')
  })
})
