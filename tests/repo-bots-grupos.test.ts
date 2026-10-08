import { beforeEach, describe, expect, it } from 'vitest'
import { abrirBanco } from '../src/db/banco.js'
import { RepoBotsGrupos, VALIDADE_CODIGO_MS } from '../src/db/bots-grupos.js'
import { RepoGrupos, type DadosFuncionario } from '../src/db/grupos.js'
import { RepoNumeros } from '../src/db/numeros.js'
import { Repositorio } from '../src/db/repositorio.js'
import { AGORA } from './ajuda.js'

const ANA: DadosFuncionario = {
  nome: 'Ana Souza', telefone: '5583999990001', lid: null, setor: 'Vendas', loja: 'Centro',
  cargo: 'Gerente', nascimento: null, ativo: true
}

describe('repositório dos bots de grupos', () => {
  let repo: Repositorio
  let g: RepoGrupos
  let b: RepoBotsGrupos
  let bot: number
  let ana: number

  beforeEach(() => {
    repo = new Repositorio(abrirBanco(':memory:'))
    const numeros = new RepoNumeros(repo.db)
    numeros.criar('Avisos', 'grupos', AGORA) // id 2
    numeros.criar('Reserva', 'grupos', AGORA) // id 3
    g = new RepoGrupos(repo.db)
    b = new RepoBotsGrupos(repo.db)
    bot = b.criarBot('Avisos', 2, AGORA)
    ana = g.salvarFuncionario(null, ANA, AGORA)
  })

  it('bot: um número atende um bot só; bot desativado não atende o número', () => {
    expect(b.botDoNumero(2)).toMatchObject({ id: bot, nome: 'Avisos', numeroId: 2, ativo: true })
    expect(() => b.criarBot('Outro', 2, AGORA)).toThrow()
    const sem = b.criarBot('Sem número', null, AGORA)
    expect(b.bot(sem)).toMatchObject({ numeroId: null })
    b.editarBot(bot, { nome: 'Avisos Belmont', numeroId: 3, ativo: false })
    expect(b.botDoNumero(3)).toBeNull()
    expect(b.bot(bot)).toMatchObject({ nome: 'Avisos Belmont', numeroId: 3, ativo: false })
    expect(b.bots().map((x) => x.nome)).toEqual(['Avisos Belmont', 'Sem número'])
  })

  it('lojas: nome único por bot sem diferenciar maiúsculas; renomear leva junto quem tinha o nome antigo', () => {
    const centro = b.criarLoja(bot, 'Centro')
    expect(() => b.criarLoja(bot, 'centro')).toThrow()
    const outro = b.criarBot('Outro', null, AGORA)
    b.criarLoja(outro, 'Centro')
    b.renomearLoja(centro, 'Loja Centro')
    expect(g.funcionario(ana)!.loja).toBe('Loja Centro')
    expect(b.lojas(bot).map((l) => l.nome)).toEqual(['Loja Centro'])
    expect(b.nomesDeLojas()).toEqual(['Centro', 'Loja Centro'])
    b.excluirLoja(centro)
    expect(b.lojas(bot)).toEqual([])
  })

  it('grupos ativos: ativar com loja, editar, desativar apaga os participantes', () => {
    const centro = b.criarLoja(bot, 'Centro')
    b.ativarGrupo(bot, 'a@g.us', centro, 'Vendas', 'rh', AGORA)
    expect(b.grupoAtivo(bot, 'a@g.us')).toMatchObject({ lojaId: centro, loja: 'Centro', setor: 'Vendas', ativadoPor: 'rh' })
    b.editarGrupoAtivo(bot, 'a@g.us', null, null)
    expect(b.grupoAtivo(bot, 'a@g.us')).toMatchObject({ lojaId: null, loja: null, setor: null })
    b.substituirParticipantes(bot, 'a@g.us', [
      { jid: '111@lid', telefone: '5583999990001', lid: '111@lid', admin: true },
      { jid: '222@lid', telefone: null, lid: '222@lid', admin: false }
    ])
    expect(b.participantes(bot, 'a@g.us')).toHaveLength(2)
    expect(b.contagemParticipantes(bot).get('a@g.us')).toEqual({ total: 2, semCadastro: 1 })
    expect(b.gruposDaPessoa('5583999990001', null)).toEqual([{ botId: bot, jid: 'a@g.us' }])
    b.removerParticipantes(bot, 'a@g.us', ['222@lid'])
    b.adicionarParticipantes(bot, 'a@g.us', [{ jid: '333@lid', telefone: null, lid: '333@lid', admin: false }])
    b.definirAdminParticipante(bot, 'a@g.us', '333@lid', true)
    expect(b.participantes(bot, 'a@g.us').map((p) => [p.jid, p.admin])).toEqual([
      ['111@lid', true],
      ['333@lid', true]
    ])
    expect(b.desativarGrupo(bot, 'a@g.us')).toBe(true)
    expect(b.gruposAtivos(bot)).toEqual([])
    expect(b.participantes(bot, 'a@g.us')).toEqual([])
  })

  it('gestor: código de 6 dígitos, vence em 48 h, confirmar apaga o código', () => {
    const codigo = b.indicarGestor(bot, ana, 'painel:rh', AGORA)
    expect(codigo).toMatch(/^\d{6}$/)
    expect(b.gestorPorCodigo(bot, codigo, AGORA + 1)).toMatchObject({ funcionarioId: ana, confirmadoEm: null })
    expect(b.gestorPorCodigo(bot, codigo, AGORA + VALIDADE_CODIGO_MS + 1)).toBeNull()
    const outro = b.criarBot('Outro', null, AGORA)
    expect(b.gestorPorCodigo(outro, codigo, AGORA)).toBeNull()
    expect(b.gestoresConfirmados(bot)).toEqual([])
    const novo = b.novoCodigo(bot, ana, AGORA + 10)
    expect(b.gestorPorCodigo(bot, codigo, AGORA + 11)).toBeNull()
    b.confirmarGestor(bot, ana, '111@lid', AGORA + 20)
    expect(b.gestorPorCodigo(bot, novo, AGORA + 21)).toBeNull()
    expect(b.gestoresConfirmados(bot)).toEqual([ana])
    expect(b.gestores(bot)[0]).toMatchObject({ confirmadoEm: AGORA + 20, confirmadoJid: '111@lid', codigo: null })
    expect(b.gestoresDaPessoa(ana).map((x) => x.botId)).toEqual([bot])
  })

  it('gestor: divergência fica guardada até ser descartada; remover e excluir a pessoa limpam tudo', () => {
    b.indicarGestor(bot, ana, 'painel:rh', AGORA)
    b.registrarDivergencia(bot, ana, '999@lid', '5583988887777', AGORA + 5)
    expect(b.gestores(bot)[0]).toMatchObject({ divergenteJid: '999@lid', divergenteTelefone: '5583988887777', divergenteEm: AGORA + 5 })
    b.descartarDivergencia(bot, ana)
    expect(b.gestores(bot)[0]).toMatchObject({ divergenteJid: null, divergenteTelefone: null, divergenteEm: null })
    b.removerGestor(bot, ana)
    expect(b.gestores(bot)).toEqual([])
    b.indicarGestor(bot, ana, 'painel:rh', AGORA)
    g.excluirFuncionario(ana)
    expect(b.gestores(bot)).toEqual([])
  })

  it('comandos: desligar, textos editados e personalizados ficam por bot', () => {
    b.ligarComando(bot, 'quem', false)
    b.salvarTextos(bot, 'status', { resumo: 'Tudo certo: {grupos} grupos' })
    b.salvarPersonalizado(bot, { nome: 'horario', descricao: 'horário das lojas', quem: 'todos', onde: 'ambos', resposta: 'Seg a sáb, 8h às 18h' })
    const c = b.comandos(bot)
    expect(c.get('quem')).toMatchObject({ ligado: false, personalizado: false })
    expect(c.get('status')).toMatchObject({ ligado: true, textos: { resumo: 'Tudo certo: {grupos} grupos' } })
    expect(c.get('horario')).toMatchObject({ personalizado: true, quem: 'todos', onde: 'ambos', resposta: 'Seg a sáb, 8h às 18h' })
    b.ligarComando(bot, 'quem', true)
    b.salvarTextos(bot, 'status', {})
    expect(b.comandos(bot).get('status')!.textos).toEqual({})
    expect(b.comandos(bot).get('quem')!.ligado).toBe(true)
    expect(b.excluirPersonalizado(bot, 'horario')).toBe(true)
    expect(b.excluirPersonalizado(bot, 'status')).toBe(false)
    expect(b.comandos(b.criarBot('Outro', null, AGORA)).size).toBe(0)
  })

  it('excluir o bot apaga lojas, grupos ativos, gestores e comandos dele', () => {
    const loja = b.criarLoja(bot, 'Centro')
    b.ativarGrupo(bot, 'a@g.us', loja, null, 'rh', AGORA)
    b.indicarGestor(bot, ana, 'rh', AGORA)
    b.ligarComando(bot, 'quem', false)
    b.excluirBot(bot)
    for (const t of ['lojas', 'grupos_ativos', 'gestores_bot', 'comandos_bot']) {
      expect(repo.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get(), t).toEqual({ n: 0 })
    }
  })

  it('auditoria por pessoa', () => {
    repo.auditar('rh', 'editar_funcionario', 'Ana', AGORA, ana)
    repo.auditar('rh', 'outra', null, AGORA + 1)
    expect(repo.auditoriaDaPessoa(ana, 10)).toEqual([{ em: AGORA, usuario: 'rh', acao: 'editar_funcionario', detalhe: 'Ana' }])
  })
})
