import type { FastifyInstance, FastifyReply } from 'fastify'
import { semAcento } from '../conversa/textos.js'
import type { BotGrupos } from '../db/bots-grupos.js'
import { paginaFormGrupo, paginaGrupos, paginaSemBotGrupos } from './paginas-grupos.js'
import type { Ajudantes } from './rotas-numeros.js'
import type { DependenciasPainel } from './servidor.js'

const OK: Record<string, string> = {
  ativado: 'Grupo ativado: o bot já responde comandos nele.',
  ativado_depois: 'Grupo ativado. Os participantes serão lidos quando o número conectar.',
  salvo: 'Grupo salvo.',
  desativado: 'Grupo desativado: o bot não responde mais nele.'
}

const limpar = (v: string | undefined, max: number) => (v ?? '').trim().replace(/\s+/g, ' ').slice(0, max)

interface CorpoGrupo {
  bot?: string
  jid?: string
  loja_id?: string
  loja_nova?: string
  setor?: string
}

export function rotasGrupos(app: FastifyInstance, d: DependenciasPainel, a: Ajudantes): void {
  const b = d.botsGrupos
  const g = d.grupos

  const acharBot = (id: string | undefined): BotGrupos | null => (id && /^\d+$/.test(id) ? b.bot(Number(id)) : null)

  app.get<{ Querystring: { bot?: string; ok?: string } }>('/grupos', async (req, rep) => {
    const bots = b.bots()
    if (bots.length === 0) return a.html(rep, paginaSemBotGrupos(a.usuario(req)))
    const bot = acharBot(req.query.bot) ?? bots[0]!
    const numero = bot.numeroId ? d.numeros.numero(bot.numeroId) : null
    const doNumero = numero ? g.todosGrupos().filter((x) => x.numeroId === numero.id) : []
    const porJid = new Map(doNumero.map((x) => [x.jid, x]))
    const contagem = b.contagemParticipantes(bot.id)
    const ativos = b
      .gruposAtivos(bot.id)
      .map((ativo) => ({ ativo, geral: porJid.get(ativo.jid) ?? null, participantes: contagem.get(ativo.jid) ?? null }))
      .sort((x, y) => (x.geral?.nome ?? x.ativo.jid).localeCompare(y.geral?.nome ?? y.ativo.jid, 'pt-BR'))
    const jaAtivos = new Set(ativos.map((x) => x.ativo.jid))
    const disponiveis = doNumero.filter((x) => x.ativo && !jaAtivos.has(x.jid)).sort((x, y) => x.nome.localeCompare(y.nome, 'pt-BR'))
    const ok = req.query.ok && Object.hasOwn(OK, req.query.ok) ? OK[req.query.ok]! : null
    return a.html(
      rep,
      paginaGrupos(
        { bots, bot, numero, estado: numero?.ativo ? d.conexoes.estado(numero.id) : null, ativos, disponiveis },
        a.usuario(req),
        ok,
        null
      )
    )
  })

  /** Setores já usados nos grupos ativos de todos os bots e na equipe (sugestões). */
  const setores = (): string[] => {
    const todos = new Map<string, string>()
    for (const bot of b.bots()) for (const x of b.gruposAtivos(bot.id)) if (x.setor) todos.set(semAcento(x.setor), x.setor)
    for (const f of g.funcionarios()) if (f.setor) todos.set(semAcento(f.setor), f.setor)
    return [...todos.values()].sort((x, y) => x.localeCompare(y, 'pt-BR'))
  }

  /** O grupo precisa estar na lista geral do número do bot (para ativar) ou já ativo (para editar). */
  const formulario = (rep: FastifyReply, usuario: string, bot: BotGrupos, jid: string, editando: boolean, erro: string | null = null, status = 200) => {
    const ativo = b.grupoAtivo(bot.id, jid)
    const geral = bot.numeroId ? g.grupo(bot.numeroId, jid) : null
    if (editando ? !ativo : !geral?.ativo) return rep.code(404).send('Grupo não encontrado')
    return a.html(
      rep.code(status),
      paginaFormGrupo(
        { bot, jid, nome: geral?.nome ?? jid, lojas: b.lojas(bot.id), lojaId: ativo?.lojaId ?? null, setor: ativo?.setor ?? '', setores: setores(), editando },
        usuario,
        erro
      )
    )
  }

  app.get<{ Querystring: { bot?: string; jid?: string } }>('/grupos/ativar', async (req, rep) => {
    const bot = acharBot(req.query.bot)
    if (!bot || !req.query.jid) return rep.code(404).send('Grupo não encontrado')
    if (b.grupoAtivo(bot.id, req.query.jid)) return rep.redirect(`/grupos/editar?bot=${bot.id}&jid=${encodeURIComponent(req.query.jid)}`, 303)
    return formulario(rep, a.usuario(req), bot, req.query.jid, false)
  })

  app.get<{ Querystring: { bot?: string; jid?: string } }>('/grupos/editar', async (req, rep) => {
    const bot = acharBot(req.query.bot)
    if (!bot || !req.query.jid) return rep.code(404).send('Grupo não encontrado')
    return formulario(rep, a.usuario(req), bot, req.query.jid, true)
  })

  /** Loja do formulário: uma nova (criada agora, ou a existente com o mesmo nome) ou uma da lista do bot. */
  const lojaDoFormulario = (bot: BotGrupos, corpo: CorpoGrupo): { id: number | null } | { erro: string } => {
    const nova = limpar(corpo.loja_nova, 60)
    if (nova) {
      const existente = b.lojas(bot.id).find((l) => semAcento(l.nome) === semAcento(nova))
      return { id: existente?.id ?? b.criarLoja(bot.id, nova) }
    }
    if (!corpo.loja_id) return { id: null }
    const loja = /^\d+$/.test(corpo.loja_id) ? b.loja(Number(corpo.loja_id)) : null
    return loja && loja.botId === bot.id ? { id: loja.id } : { erro: 'Escolha uma loja deste bot.' }
  }

  const salvar = (editando: boolean) =>
    app.post<{ Body: CorpoGrupo }>(editando ? '/grupos/editar' : '/grupos/ativar', async (req, rep) => {
      const corpo = req.body ?? {}
      const bot = acharBot(corpo.bot)
      const jid = corpo.jid ?? ''
      if (!bot || !jid) return rep.code(404).send('Grupo não encontrado')
      const geral = bot.numeroId ? g.grupo(bot.numeroId, jid) : null
      if (editando ? !b.grupoAtivo(bot.id, jid) : !geral?.ativo) return rep.code(404).send('Grupo não encontrado')
      const setor = limpar(corpo.setor, 60) || null
      const r = d.repo.transacao(() => {
        const loja = lojaDoFormulario(bot, corpo)
        if ('erro' in loja) return loja
        if (editando) b.editarGrupoAtivo(bot.id, jid, loja.id, setor)
        else b.ativarGrupo(bot.id, jid, loja.id, setor, a.usuario(req), a.agora())
        const nomeLoja = loja.id ? b.loja(loja.id)?.nome : null
        d.repo.auditar(
          a.usuario(req),
          editando ? 'editar_grupo' : 'ativar_grupo',
          `${bot.nome}: ${geral?.nome ?? jid} (${nomeLoja ?? 'sem loja'}${setor ? ` · ${setor}` : ''})`,
          a.agora()
        )
        return loja
      })
      if ('erro' in r) return formulario(rep, a.usuario(req), bot, jid, editando, r.erro, 400)
      if (editando) return rep.redirect(`/grupos?bot=${bot.id}&ok=salvo`, 303)
      // Lê os participantes já (o bot passa a precisar deles); com o número fora do ar, fica para quando conectar.
      let lidos = false
      try {
        lidos = (await d.sincronizarGrupo?.(bot.id, jid)) ?? false
      } catch (err) {
        d.log.warn({ err, bot: bot.id }, 'não foi possível ler os participantes do grupo ativado')
      }
      return rep.redirect(`/grupos?bot=${bot.id}&ok=${lidos ? 'ativado' : 'ativado_depois'}`, 303)
    })
  salvar(false)
  salvar(true)

  app.post<{ Body: { bot?: string; jid?: string } }>('/grupos/desativar', async (req, rep) => {
    const bot = acharBot(req.body?.bot)
    const jid = req.body?.jid ?? ''
    if (!bot || !b.grupoAtivo(bot.id, jid)) return rep.code(404).send('Grupo não encontrado')
    const nome = (bot.numeroId ? g.grupo(bot.numeroId, jid)?.nome : null) ?? jid
    d.repo.transacao(() => {
      b.desativarGrupo(bot.id, jid)
      d.repo.auditar(a.usuario(req), 'desativar_grupo', `${bot.nome}: ${nome}`, a.agora())
    })
    return rep.redirect(`/grupos?bot=${bot.id}&ok=desativado`, 303)
  })
}
