import { beforeEach, describe, expect, it } from 'vitest'
import { ArmazemArquivos } from '../src/arquivos.js'
import { abrirBanco } from '../src/db/banco.js'
import { RepoBotsGrupos } from '../src/db/bots-grupos.js'
import { RepoGrupos } from '../src/db/grupos.js'
import { RepoNumeros } from '../src/db/numeros.js'
import { Repositorio } from '../src/db/repositorio.js'
import { ERROS_CODIGO_POR_PESSOA, JANELA_COMANDO_MS, OrquestradorGrupos } from '../src/grupos/orquestrador.js'
import type { ConexaoGrupos, EnvioGrupo, MensagemGrupo, MetadadosGrupo } from '../src/grupos/tipos.js'
import { AGORA, log, pastaTemp } from './ajuda.js'

const GRUPO = '120363-1@g.us'
const OUTRO = '120363-2@g.us'
const INATIVO = '120363-9@g.us'
const ANA_PV = '5583999990001@s.whatsapp.net'

function conexaoFalsa() {
  const lids = new Map<string, string>([['111@lid', '5583999990001']])
  const lidas: string[] = []
  const md = (jid: string, nome: string): MetadadosGrupo => ({
    jid,
    nome,
    botAdmin: true,
    membros: [
      { jid: '111@lid', telefone: null, lid: '111@lid', admin: true },
      { jid: '222@lid', telefone: null, lid: '222@lid', admin: false }
    ]
  })
  const conexao: ConexaoGrupos = {
    pronta: () => true,
    presenca: async () => {},
    enviarTexto: async () => {},
    enviarMidia: async () => {},
    removerParticipantes: async () => {},
    fecharGrupo: async () => {},
    apagar: async () => {},
    marcarLida: async (c) => void lidas.push(c.id),
    listarGrupos: async () => [],
    metadados: async (jid) => md(jid, jid === GRUPO ? 'Loja Centro' : 'Gerentes'),
    telefoneDoLid: async (lid) => lids.get(lid) ?? null,
    baixarMidiaGrupo: async () => ({ dados: Buffer.from('img'), midia: { tipo: 'imagem', mimetype: 'image/jpeg', nome: null }, ext: 'jpg' })
  }
  return { conexao, lidas }
}

describe('orquestrador do bot de grupos', () => {
  let t: number
  let seq: number
  let repo: Repositorio
  let grupos: RepoGrupos
  let bots: RepoBotsGrupos
  let numeros: RepoNumeros
  let bot: number
  let falsa: ReturnType<typeof conexaoFalsa>
  let orq: OrquestradorGrupos
  let ana: number
  let silencios: number
  const N = 2

  beforeEach(() => {
    t = AGORA
    seq = 0
    silencios = 0
    repo = new Repositorio(abrirBanco(':memory:'))
    numeros = new RepoNumeros(repo.db)
    numeros.criar('Avisos', 'grupos', AGORA)
    grupos = new RepoGrupos(repo.db)
    grupos.salvarGrupo(N, GRUPO, 'Loja Centro', true, AGORA)
    grupos.salvarGrupo(N, OUTRO, 'Gerentes', true, AGORA)
    ana = grupos.salvarFuncionario(null, { nome: 'Ana Souza', telefone: '5583999990001', lid: null, ativo: true }, AGORA)
    bots = new RepoBotsGrupos(repo.db)
    bot = bots.criarBot('Avisos', N, AGORA)
    bots.ativarGrupo(bot, GRUPO, 'rh', AGORA)
    bots.ativarGrupo(bot, OUTRO, 'rh', AGORA)
    bots.indicarGestor(bot, ana, 'painel:rh', AGORA)
    bots.confirmarGestor(bot, ana, '111@lid', AGORA)
    falsa = conexaoFalsa()
    orq = new OrquestradorGrupos({
      repo,
      grupos,
      bots,
      armazem: new ArmazemArquivos(pastaTemp()),
      conexao: () => falsa.conexao,
      pausado: (n) => numeros.numero(n)?.pausado ?? false,
      log,
      relogio: () => t,
      aoMudarSilencio: () => void silencios++
    })
  })

  function msg(texto: string, extra: Partial<MensagemGrupo> = {}): MensagemGrupo {
    seq++
    return {
      numeroId: N,
      id: `C${seq}`,
      chat: GRUPO,
      ehGrupo: true,
      remetente: { jid: '111@lid', telefone: null, lid: '111@lid' },
      texto,
      mencionados: [],
      citada: null,
      midia: null,
      recebidaEm: t,
      ...extra
    }
  }

  const pv = (texto: string, extra: Partial<MensagemGrupo> = {}) =>
    msg(texto, { chat: ANA_PV, ehGrupo: false, remetente: { jid: ANA_PV, telefone: '5583999990001', lid: null }, ...extra })

  async function enviar(m: MensagemGrupo) {
    orq.receber(m)
    await orq.ocioso()
  }

  function saida(chat = GRUPO): EnvioGrupo[] {
    const r: EnvioGrupo[] = []
    for (;;) {
      const item = grupos.proximaSaida(N, chat)
      if (!item) return r
      r.push(JSON.parse(item.conteudo) as EnvioGrupo)
      grupos.removerSaida(item.id)
    }
  }

  const textos = (chat?: string) => saida(chat).flatMap((e) => (e.tipo === 'texto' ? [e.texto] : []))
  const dedupe = () => (repo.db.prepare(`SELECT COUNT(*) AS n FROM mensagens_processadas`).get() as { n: number }).n

  it('/all no grupo: reconhece a gestora pelo LID, apaga o comando e menciona todos', async () => {
    await enviar(msg('/all Reunião'))
    expect(saida()).toEqual([
      { tipo: 'apagar', chave: { chat: GRUPO, id: 'C1', participante: '111@lid' } },
      { tipo: 'texto', texto: 'Reunião', mencoes: ['111@lid', '222@lid'] }
    ])
    expect(grupos.funcionario(ana)!.lid).toBe('111@lid')
    expect(falsa.lidas).toEqual(['C1'])
  })

  it('grupo inativo, número pausado e conversa comum: nada, nem dedupe', async () => {
    await enviar(msg('/all oi', { chat: INATIVO }))
    await enviar(msg('bom dia a todos'))
    numeros.definirPausado(N, true)
    await enviar(msg('/all oi'))
    expect(dedupe()).toBe(0)
    expect(saida()).toEqual([])
  })

  it('privado: pergunta o grupo, a resposta numerada roda o comando e o grupo fica escolhido', async () => {
    await enviar(pv('/all Oi pessoal'))
    expect(textos(ANA_PV)).toEqual(['Em qual grupo? Responda com o número:\n1. Gerentes\n2. Loja Centro'])
    await enviar(pv('2'))
    expect(saida()).toEqual([{ tipo: 'texto', texto: 'Oi pessoal', mencoes: ['111@lid', '222@lid'] }])
    expect(textos(ANA_PV)).toEqual(['✅ Enviado em *Loja Centro*, com 2 pessoa(s) mencionada(s).'])
    t += 2 * 60_000
    await enviar(pv('/todos Segunda chamada'))
    expect(saida()[0]).toMatchObject({ tipo: 'texto', texto: 'Segunda chamada\n\n@111 @222' })
  })

  it('número solto no privado sem pergunta pendente é ignorado', async () => {
    await enviar(pv('2'))
    expect(dedupe()).toBe(0)
  })

  it('a mesma mensagem entregue duas vezes gera uma resposta só', async () => {
    const m = msg('/banword golpe')
    orq.receber(m)
    orq.receber(m)
    await orq.ocioso()
    expect(textos()).toHaveLength(1)
    expect(bots.palavras(bot, GRUPO)).toEqual(['golpe'])
  })

  it('palavra proibida: apaga a mensagem de quem não é gestor nem admin', async () => {
    bots.adicionarPalavras(bot, GRUPO, ['golpe'])
    await enviar(msg('isso é golpe', { remetente: { jid: '222@lid', telefone: null, lid: '222@lid' } }))
    expect(saida()).toEqual([{ tipo: 'apagar', chave: { chat: GRUPO, id: 'C1', participante: '222@lid' } }])
    await enviar(msg('golpe de novo')) // a gestora (admin) pode
    expect(saida()).toEqual([])
  })

  it('/mutegroup grava o silêncio e avisa o agendador; /unmute abre o grupo', async () => {
    await enviar(msg('/mutegroup'))
    expect(bots.silencio(bot, GRUPO)).toMatchObject({ inicio: null, fim: null })
    expect(silencios).toBe(1)
    textos()
    await enviar(msg('/unmute'))
    expect(bots.silencio(bot, GRUPO)).toBeNull()
    expect(saida()[0]).toEqual({ tipo: 'fechar', fechado: false })
  })

  it('/repeat em duas etapas: pergunta, e a resposta citando a mensagem cria a repetição', async () => {
    await enviar(msg('/repeat'))
    expect(textos()[0]).toMatch(/citando/)
    await enviar(msg('08:00 18:30', { citada: { autor: '222@lid', texto: 'Fechamos às 18h', midia: null } }))
    const [p] = bots.programadas(bot)
    expect(p).toMatchObject({ origem: 'repeat', jid: GRUPO, horarios: ['08:00', '18:30'], variacoes: [{ texto: 'Fechamos às 18h', midia: null }] })
    await enviar(msg('/repeat stop'))
    expect(bots.programadas(bot)).toEqual([])
  })

  it('/repeat citando uma foto baixa e guarda a mídia', async () => {
    await enviar(msg('/repeat 9h', { citada: { autor: '222@lid', texto: null, midia: '{"x":1}' } }))
    const [p] = bots.programadas(bot)
    expect(p!.variacoes[0]!.midia).toMatchObject({ tipo: 'imagem', mimetype: 'image/jpeg' })
  })

  it('comando antigo (fila ao reconectar) não é executado', async () => {
    const m = msg('/all oi')
    t += JANELA_COMANDO_MS + 1
    await enviar(m)
    expect(saida()).toEqual([])
  })

  describe('/confirmar', () => {
    let bia: number
    let codigo: string
    const BIA_PV = '5583999990002@s.whatsapp.net'
    const confirmar = (texto: string, de = BIA_PV, tel: string | null = '5583999990002') =>
      msg(texto, { chat: de, ehGrupo: false, remetente: { jid: de, telefone: tel, lid: null } })

    beforeEach(() => {
      bia = grupos.salvarFuncionario(null, { nome: 'Bia', telefone: '5583999990002', lid: null, ativo: true }, AGORA)
      codigo = bots.indicarGestor(bot, bia, 'painel:rh', AGORA)
    })

    it('do WhatsApp do cadastro: vira gestora e pode usar comandos', async () => {
      await enviar(confirmar(`/confirmar ${codigo}`))
      expect(bots.gestor(bot, bia)!.confirmadoEm).toBe(AGORA)
      expect(textos(BIA_PV)[0]).toMatch(/Pronto, Bia/)
      await enviar(confirmar('/menu'))
      expect(textos(BIA_PV)[0]).toMatch(/Comandos/)
    })

    it('de outro WhatsApp: divergência sem poder', async () => {
      await enviar(confirmar(`/confirmar ${codigo}`, '5583977770000@s.whatsapp.net', '5583977770000'))
      expect(bots.gestor(bot, bia)).toMatchObject({ confirmadoEm: null, divergenteTelefone: '5583977770000' })
    })

    it(`depois de ${ERROS_CODIGO_POR_PESSOA} códigos errados em uma hora, fica sem resposta`, async () => {
      for (let i = 0; i < ERROS_CODIGO_POR_PESSOA; i++) await enviar(confirmar('/confirmar 000000'))
      textos(BIA_PV)
      await enviar(confirmar(`/confirmar ${codigo}`))
      expect(textos(BIA_PV)).toEqual([])
      expect(bots.gestor(bot, bia)!.confirmadoEm).toBeNull()
    })
  })
})
