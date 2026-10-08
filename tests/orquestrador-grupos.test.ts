import { beforeEach, describe, expect, it, vi } from 'vitest'
import { abrirBanco } from '../src/db/banco.js'
import { RepoBotsGrupos } from '../src/db/bots-grupos.js'
import { RepoGrupos } from '../src/db/grupos.js'
import { RepoNumeros } from '../src/db/numeros.js'
import { Repositorio } from '../src/db/repositorio.js'
import { ERROS_CODIGO_POR_PESSOA, JANELA_COMANDO_MS, OrquestradorGrupos } from '../src/grupos/orquestrador.js'
import type { ConexaoGrupos, MensagemGrupo, MetadadosGrupo } from '../src/grupos/tipos.js'
import { AGORA, log } from './ajuda.js'

const GRUPO = '120363-1@g.us'

function conexaoFalsa() {
  const lids = new Map<string, string>()
  const chamadas = { metadados: 0 }
  const metadados: MetadadosGrupo = {
    jid: GRUPO,
    nome: 'Loja Centro',
    botAdmin: true,
    membros: [{ jid: '111@lid', telefone: null, lid: '111@lid', admin: true }]
  }
  const conexao: ConexaoGrupos = {
    pronta: () => true,
    digitando: async () => {},
    enviarTexto: async () => {},
    listarGrupos: async () => [],
    metadados: async () => {
      chamadas.metadados++
      return metadados
    },
    telefoneDoLid: async (lid) => lids.get(lid) ?? null
  }
  return { conexao, lids, chamadas }
}

describe('orquestrador do bot de grupos', () => {
  let t: number
  let seq: number
  let repo: Repositorio
  let grupos: RepoGrupos
  let bots: RepoBotsGrupos
  let bot: number
  let falsa: ReturnType<typeof conexaoFalsa>
  let orq: OrquestradorGrupos
  let ana: number
  let acordados: number[]
  const N = 2

  beforeEach(() => {
    t = AGORA
    seq = 0
    acordados = []
    repo = new Repositorio(abrirBanco(':memory:'))
    new RepoNumeros(repo.db).criar('Avisos', 'grupos', AGORA)
    grupos = new RepoGrupos(repo.db)
    ana = grupos.salvarFuncionario(
      null,
      { nome: 'Ana Souza', telefone: '5583999990001', lid: null, setor: 'Vendas', loja: 'Centro', cargo: null, nascimento: null, ativo: true },
      AGORA
    )
    bots = new RepoBotsGrupos(repo.db)
    bot = bots.criarBot('Avisos', N, AGORA)
    bots.ativarGrupo(bot, GRUPO, null, null, 'rh', AGORA)
    bots.indicarGestor(bot, ana, 'painel:rh', AGORA)
    bots.confirmarGestor(bot, ana, '111@lid', AGORA)
    falsa = conexaoFalsa()
    falsa.lids.set('111@lid', '5583999990001')
    orq = new OrquestradorGrupos({
      repo,
      grupos,
      bots,
      conexao: () => falsa.conexao,
      log,
      relogio: () => t,
      conectadoDesde: () => AGORA,
      telefoneDoNumero: () => '5583900002222',
      aoEnfileirar: (n) => void acordados.push(n)
    })
  })

  function msg(texto: string, extra: Partial<MensagemGrupo> = {}): MensagemGrupo {
    seq++
    return {
      numeroId: N, id: `C${seq}`, chat: GRUPO, ehGrupo: true,
      remetente: { jid: '111@lid', telefone: null, lid: '111@lid' },
      texto, mencionados: [], citada: null, recebidaEm: t, ...extra
    }
  }

  async function enviar(m: MensagemGrupo) {
    orq.receber(m)
    await orq.ocioso()
  }

  function saida(chat = GRUPO): { texto: string; mencoes?: string[] }[] {
    const r: { texto: string; mencoes?: string[] }[] = []
    for (;;) {
      const item = grupos.proximaSaida(N, chat)
      if (!item) return r
      r.push(JSON.parse(item.conteudo) as { texto: string; mencoes?: string[] })
      grupos.removerSaida(item.id)
    }
  }

  const dedupe = () => (repo.db.prepare(`SELECT COUNT(*) AS n FROM mensagens_processadas`).get() as { n: number }).n

  it('descobre o telefone do LID, reconhece o gestor e grava o LID no cadastro', async () => {
    await enviar(msg('/status'))
    expect(saida()).toHaveLength(1)
    expect(grupos.funcionario(ana)!.lid).toBe('111@lid')
    expect(acordados).toEqual([N])
  })

  it('a mesma mensagem entregue duas vezes gera uma resposta só', async () => {
    const m = msg('/status')
    orq.receber(m)
    orq.receber(m)
    await orq.ocioso()
    expect(saida()).toHaveLength(1)
  })

  it('comando de gestor vindo de outra pessoa: só a linha de dedupe, nenhum dado', async () => {
    await enviar(msg('/cadastrar @999 Carla Dias | Estoque | Norte', { remetente: { jid: '999@lid', telefone: null, lid: '999@lid' }, mencionados: ['999@lid'] }))
    expect(saida()).toEqual([])
    expect(grupos.funcionarios()).toHaveLength(1)
    expect(dedupe()).toBe(1)
    expect(repo.auditoriaRecente(5)).toEqual([])
  })

  it('/cadastrar grava funcionário (com telefone do LID) e auditoria na mesma transação', async () => {
    falsa.lids.set('777@lid', '5583988887777')
    await enviar(msg('/cadastrar @777 Carla Dias | Estoque | Norte', { mencionados: ['777@lid'] }))
    const carla = grupos.porTelefone('5583988887777')!
    expect(carla).toMatchObject({ nome: 'Carla Dias', lid: '777@lid', setor: 'Estoque', loja: 'Norte' })
    expect(repo.auditoriaRecente(1)[0]).toMatchObject({ usuario: 'wa:5583999990001', acao: 'cadastrar_funcionario' })
    expect(saida()[0]!.texto).toContain('Carla Dias cadastrado(a)')
  })

  it('telefone estrangeiro do mencionado (via LID) é guardado como veio, sem virar brasileiro', async () => {
    falsa.lids.set('777@lid', '14155550123')
    await enviar(msg('/cadastrar @777 Carla Dias | Estoque | Norte', { mencionados: ['777@lid'] }))
    const carla = grupos.porTelefone('14155550123')
    expect(carla).toMatchObject({ nome: 'Carla Dias', telefone: '14155550123', lid: '777@lid' })
  })

  it('telefone estrangeiro de 10 dígitos (mesmo tamanho de um DDD+8 brasileiro) via LID não ganha o 55 inventado', async () => {
    // Dinamarca +45 12345678: 10 dígitos com o código do país, do mesmo tamanho de um DDD+8 digitado
    // localmente no Brasil. O bug antigo decidia pelo tamanho (chaveTelefone) e virava "554512345678".
    falsa.lids.set('777@lid', '4512345678')
    await enviar(msg('/cadastrar @777 Dana Nielsen | Estoque | Norte', { mencionados: ['777@lid'] }))
    const dana = grupos.porTelefone('4512345678')
    expect(dana).toMatchObject({ nome: 'Dana Nielsen', telefone: '4512345678', lid: '777@lid' })
    expect(grupos.porTelefone('554512345678')).toBeNull()
  })

  it('falha ao gravar desfaz tudo e avisa que não conseguiu', async () => {
    vi.spyOn(grupos, 'salvarFuncionario').mockImplementation(() => {
      throw new Error('disco cheio')
    })
    await enviar(msg('/cadastrar @777 Carla Dias | Estoque | Norte', { mencionados: ['777@lid'] }))
    expect(saida().map((s) => s.texto)).toEqual(['Não consegui concluir esse comando agora. Tente de novo em instantes.'])
    expect(repo.auditoriaRecente(5)).toEqual([])
    expect(dedupe()).toBe(1)
    expect(grupos.funcionarios()).toHaveLength(1)
  })

  it('grupo desconhecido é lido uma vez e gravado; membros só quando o comando pede', async () => {
    expect(grupos.grupo(N, GRUPO)).toBeNull()
    await enviar(msg('/status'))
    expect(grupos.grupo(N, GRUPO)).toMatchObject({ nome: 'Loja Centro', botAdmin: true, ativo: true })
    expect(falsa.chamadas.metadados).toBe(1)
    await enviar(msg('/status'))
    expect(falsa.chamadas.metadados).toBe(1)
    await enviar(msg('/gestores'))
    expect(falsa.chamadas.metadados).toBe(2)
    expect(saida().at(-1)).toEqual({ tipo: 'texto', texto: '👔 Gestores deste grupo: @111', mencoes: ['111@lid'] })
  })

  it('comando velho (fila ao reconectar) é ignorado sem deixar rastro', async () => {
    await enviar(msg('/status', { recebidaEm: t - JANELA_COMANDO_MS - 1 }))
    expect(saida()).toEqual([])
    expect(dedupe()).toBe(0)
  })

  it('privado de estranho: nada é respondido', async () => {
    await enviar(msg('/menu', { chat: '999@lid', ehGrupo: false, remetente: { jid: '999@lid', telefone: null, lid: '999@lid' } }))
    expect(saida('999@lid')).toEqual([])
    expect(repo.auditoriaRecente(5)).toEqual([])
    expect(dedupe()).toBe(1)
  })

  it('texto comum (sem barra) não gera dedupe nem fila', async () => {
    await enviar(msg('bom dia, time!'))
    expect(saida()).toEqual([])
    expect(dedupe()).toBe(0)
  })

  it('erro ao buscar metadados do grupo responde com aviso e não trava os próximos comandos', async () => {
    let falhar = true
    const original = falsa.conexao.metadados
    falsa.conexao.metadados = async (jid: string) => {
      if (falhar) {
        falhar = false
        throw new Error('timeout')
      }
      return original(jid)
    }
    await enviar(msg('/gestores'))
    expect(saida()).toEqual([{ tipo: 'texto', texto: 'Não consegui ler os participantes agora. Tente de novo em instantes.' }])
    t += 61_000 // além do freio anti-spam, para isolar o teste do próximo comando de fato ser atendido
    await enviar(msg('/gestores'))
    expect(saida()).toEqual([{ tipo: 'texto', texto: '👔 Gestores deste grupo: @111', mencoes: ['111@lid'] }])
  })

  it('telefone do remetente vem do cadastro quando o WhatsApp não informa o LID desta vez', async () => {
    grupos.vincularLid(ana, '111@lid', AGORA)
    falsa.lids.delete('111@lid')
    falsa.lids.set('777@lid', '5583988887777')
    await enviar(msg('/cadastrar @777 Carla Dias | Estoque | Norte', { mencionados: ['777@lid'] }))
    expect(repo.auditoriaRecente(1)[0]).toMatchObject({ usuario: 'wa:5583999990001', acao: 'cadastrar_funcionario' })
  })

  it('comando de gestor ignorado (vindo de quem não é gestor) não liga o LID de quem enviou', async () => {
    const bruno = grupos.salvarFuncionario(
      null,
      { nome: 'Bruno', telefone: '5583999990002', lid: null, setor: 'Vendas', loja: 'Centro', cargo: null, nascimento: null, ativo: true },
      AGORA
    )
    falsa.lids.set('222@lid', '5583999990002')
    await enviar(msg('/status', { remetente: { jid: '222@lid', telefone: null, lid: '222@lid' } }))
    expect(saida()).toEqual([])
    expect(grupos.funcionario(bruno)!.lid).toBeNull()
    expect(dedupe()).toBe(1)
  })

  it('freio anti-spam: a mesma pessoa repetindo um comando comum em menos de 1 minuto recebe só a primeira resposta', async () => {
    await enviar(msg('/menu'))
    t += 10_000
    await enviar(msg('/menu'))
    expect(saida()).toHaveLength(1)
    expect(dedupe()).toBe(1)
  })

  it('freio anti-spam: pessoas diferentes com folga de tempo recebem resposta cada uma', async () => {
    await enviar(msg('/menu'))
    t += 20_000
    await enviar(msg('/menu', { remetente: { jid: '222@lid', telefone: null, lid: '222@lid' } }))
    expect(saida()).toHaveLength(2)
  })

  it('freio anti-spam: o mesmo comando comum por pessoas diferentes em menos de 15s segura a segunda', async () => {
    await enviar(msg('/menu'))
    t += 5_000
    await enviar(msg('/menu', { remetente: { jid: '222@lid', telefone: null, lid: '222@lid' } }))
    expect(saida()).toHaveLength(1)
  })

  it('freio anti-spam: comando de gestor nunca é seguro mesmo repetido rápido', async () => {
    await enviar(msg('/status'))
    t += 1_000
    await enviar(msg('/status'))
    expect(saida()).toHaveLength(2)
  })

  it('eventos: lista completa desativa ausentes; bot vira admin; bot sai; renomeado', async () => {
    orq.eventoGrupos(N, { tipo: 'lista', grupos: [{ jid: 'a@g.us', nome: 'A', botAdmin: false }, { jid: 'b@g.us', nome: 'B', botAdmin: false }] })
    orq.eventoGrupos(N, { tipo: 'lista', grupos: [{ jid: 'a@g.us', nome: 'A', botAdmin: false }] })
    expect(grupos.grupos(N).map((g) => g.jid)).toEqual(['a@g.us'])
    orq.eventoGrupos(N, { tipo: 'admin', jid: 'a@g.us', admin: true })
    orq.eventoGrupos(N, { tipo: 'renomeado', jid: 'a@g.us', nome: 'A2' })
    expect(grupos.grupo(N, 'a@g.us')).toMatchObject({ botAdmin: true, nome: 'A2' })
    orq.eventoGrupos(N, { tipo: 'saiu', jid: 'a@g.us' })
    expect(grupos.grupos(N)).toEqual([])
    orq.eventoGrupos(N, { tipo: 'entrou', grupos: [{ jid: 'b@g.us', nome: 'B', botAdmin: true }] })
    expect(grupos.grupo(N, 'b@g.us')).toMatchObject({ ativo: true, botAdmin: true })
    await orq.ocioso()
  })

  it('grupo que não está ativo no bot: silêncio total, sem nem a linha de dedupe', async () => {
    await enviar(msg('/menu', { chat: 'outro@g.us' }))
    await enviar(msg('/status', { chat: 'outro@g.us' }))
    expect(saida('outro@g.us')).toEqual([])
    expect(dedupe()).toBe(0)
    expect(falsa.chamadas.metadados).toBe(0)
  })

  it('número sem bot (ou com o bot desativado) não atende nada', async () => {
    bots.editarBot(bot, { nome: 'Avisos', numeroId: N, ativo: false })
    await enviar(msg('/status'))
    expect(saida()).toEqual([])
    expect(dedupe()).toBe(0)
  })

  it('gestor de outro bot não manda neste', async () => {
    bots.removerGestor(bot, ana)
    const outro = bots.criarBot('Outro', null, AGORA)
    bots.indicarGestor(outro, ana, 'rh', AGORA)
    bots.confirmarGestor(outro, ana, '111@lid', AGORA)
    await enviar(msg('/status'))
    expect(saida()).toEqual([])
  })

  describe('confirmação por código', () => {
    let beto: number
    let codigo: string
    const BETO = { jid: '5583999990002@s.whatsapp.net', telefone: '5583999990002', lid: null }
    const privado = (texto: string, remetente = BETO) => msg(texto, { chat: remetente.jid, ehGrupo: false, remetente })

    beforeEach(() => {
      beto = grupos.salvarFuncionario(
        null,
        { nome: 'Beto Lima', telefone: '5583999990002', lid: null, setor: 'Caixa', loja: 'Sul', cargo: null, nascimento: null, ativo: true },
        AGORA
      )
      codigo = bots.indicarGestor(bot, beto, 'painel:rh', AGORA)
    })

    it('a pessoa do cadastro manda o código no privado: vira gestora, confirmada, e recebe a resposta', async () => {
      await enviar(privado(`/confirmar ${codigo}`))
      expect(bots.gestoresConfirmados(bot)).toEqual([ana, beto])
      expect(bots.gestor(bot, beto)).toMatchObject({ confirmadoJid: BETO.jid, codigo: null })
      expect(grupos.funcionario(beto)!.confirmadoEm).toBe(t)
      expect(saida(BETO.jid).map((x) => x.texto)).toEqual(['✅ Pronto, Beto Lima! Você agora é gestor(a) do Avisos.'])
      expect(repo.auditoriaDaPessoa(beto, 5)[0]).toMatchObject({ acao: 'gestor_confirmado', usuario: 'wa:5583999990002' })
    })

    it('a confirmação grava o LID que faltava no cadastro', async () => {
      const pelaLid = { jid: '222@lid', telefone: null, lid: '222@lid' }
      falsa.lids.set('222@lid', '5583999990002')
      await enviar(privado(`/confirmar ${codigo}`, pelaLid))
      expect(grupos.funcionario(beto)).toMatchObject({ lid: '222@lid', confirmadoEm: t })
    })

    it('código certo de outro WhatsApp: fica como divergência, sem poder', async () => {
      const outro = { jid: '5583977776666@s.whatsapp.net', telefone: '5583977776666', lid: null }
      await enviar(privado(`/confirmar ${codigo}`, outro))
      expect(bots.gestoresConfirmados(bot)).toEqual([ana])
      expect(bots.gestor(bot, beto)).toMatchObject({ divergenteJid: outro.jid, divergenteTelefone: '5583977776666', divergenteEm: t })
      expect(saida(outro.jid)[0]!.texto).toContain('diferente do cadastro de Beto Lima')
    })

    it(`depois de ${ERROS_CODIGO_POR_PESSOA} códigos errados em uma hora, a pessoa fica sem resposta`, async () => {
      for (let i = 0; i < ERROS_CODIGO_POR_PESSOA; i++) await enviar(privado('/confirmar 000000'))
      expect(saida(BETO.jid)).toHaveLength(ERROS_CODIGO_POR_PESSOA)
      await enviar(privado(`/confirmar ${codigo}`))
      expect(saida(BETO.jid)).toEqual([])
      expect(bots.gestoresConfirmados(bot)).toEqual([ana])
      t += 60 * 60 * 1000
      await enviar(privado(`/confirmar ${codigo}`))
      expect(bots.gestoresConfirmados(bot)).toEqual([ana, beto])
    })

    it('/gestor add no grupo: resposta no grupo e o código só no privado de quem pediu', async () => {
      bots.removerGestor(bot, beto)
      falsa.lids.set('333@lid', '5583999990002')
      await enviar(msg('/gestor add @333', { mencionados: ['333@lid'] }))
      expect(saida()[0]!.texto).toContain('Beto Lima foi indicado(a) como gestor(a)')
      const novo = bots.gestor(bot, beto)!.codigo!
      const privadoAna = saida('111@lid')
      expect(privadoAna).toHaveLength(1)
      expect(privadoAna[0]!.texto).toContain(`/confirmar ${novo}`)
      expect(privadoAna[0]!.texto).toContain(`https://wa.me/5583900002222?text=%2Fconfirmar%20${novo}`)
      expect(JSON.stringify(saida())).not.toContain(novo)
    })
  })

  it('participantes: eventos só mexem em grupo ativo; /gestores lê o que está guardado', async () => {
    bots.substituirParticipantes(bot, GRUPO, [{ jid: '111@lid', telefone: '5583999990001', lid: '111@lid', admin: false }])
    orq.eventoGrupos(N, { tipo: 'participantes', jid: GRUPO, acao: 'add', membros: [{ jid: '555@lid', telefone: null, lid: '555@lid', admin: false }] })
    orq.eventoGrupos(N, { tipo: 'participantes', jid: GRUPO, acao: 'promote', membros: [{ jid: '111@lid', telefone: null, lid: '111@lid', admin: true }] })
    orq.eventoGrupos(N, { tipo: 'participantes', jid: 'outro@g.us', acao: 'add', membros: [{ jid: '9@lid', telefone: null, lid: '9@lid', admin: false }] })
    expect(bots.participantes(bot, GRUPO).map((p) => [p.jid, p.admin])).toEqual([
      ['111@lid', true],
      ['555@lid', false]
    ])
    expect(repo.db.prepare('SELECT COUNT(*) AS n FROM participantes').get()).toEqual({ n: 2 })
    grupos.salvarGrupo(N, GRUPO, 'Loja Centro', true, AGORA)
    await enviar(msg('/gestores'))
    expect(falsa.chamadas.metadados).toBe(0)
    expect(saida().at(-1)).toEqual({ tipo: 'texto', texto: '👔 Gestores deste grupo: @111', mencoes: ['111@lid'] })
    orq.eventoGrupos(N, { tipo: 'participantes', jid: GRUPO, acao: 'remove', membros: [{ jid: '555@lid', telefone: null, lid: '555@lid', admin: false }] })
    expect(bots.participantes(bot, GRUPO)).toHaveLength(1)
  })

  it('ao conectar (lista), relê os participantes de cada grupo ativo', async () => {
    orq.eventoGrupos(N, { tipo: 'lista', grupos: [{ jid: GRUPO, nome: 'Loja Centro', botAdmin: true }] })
    await orq.ocioso()
    expect(falsa.chamadas.metadados).toBe(1)
    expect(bots.participantes(bot, GRUPO)).toEqual([{ jid: '111@lid', telefone: '5583999990001', lid: '111@lid', admin: true }])
  })

  it('sincronizarGrupo devolve false com o número desconectado', async () => {
    falsa.conexao.pronta = () => false
    expect(await orq.sincronizarGrupo(bot, GRUPO)).toBe(false)
    expect(falsa.chamadas.metadados).toBe(0)
  })
})
