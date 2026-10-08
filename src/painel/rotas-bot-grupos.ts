import type { FastifyInstance, FastifyReply } from 'fastify'
import type { BotGrupos, Midia, Programada, TipoMidia, VariacaoMensagem } from '../db/bots-grupos.js'
import { COMANDOS } from '../grupos/comandos.js'
import { horario } from '../grupos/motor.js'
import { telefoneDigitado } from '../grupos/pessoas.js'
import { diaBR } from '../grupos/agenda.js'
import { extensaoDe } from '../whatsapp/normalizar.js'
import {
  MAX_MIDIA_BYTES,
  paginaComandos,
  paginaFormProgramada,
  paginaGeralBot,
  paginaGestores,
  paginaGruposBot,
  paginaNovoBotGrupos,
  paginaProgramadas,
  type CabecalhoBot,
  type FormProgramada,
  type OpcaoNumero
} from './paginas-bot-grupos.js'
import type { Ajudantes } from './rotas-numeros.js'
import type { DependenciasPainel } from './servidor.js'

/** Mensagens de sucesso, pelo ?ok= do redirecionamento. */
const OK: Record<string, string> = {
  salvo: 'Bot salvo.',
  criado: 'Bot criado.',
  ativado: 'Grupo ativado.',
  desativado: 'Grupo desativado.',
  indicado: 'Gestor adicionado. Envie o código (ou o link) para ele confirmar.',
  ja: 'Esta pessoa já é gestora deste bot.',
  codigo: 'Novo código gerado.',
  removido: 'Gestor removido.',
  confirmado: 'WhatsApp atualizado e gestor confirmado.',
  descartado: 'Divergência descartada.',
  ligado: 'Comando ligado.',
  desligado: 'Comando desligado.',
  programada: 'Mensagem programada.',
  programada_salva: 'Mensagem salva.',
  programada_excluida: 'Mensagem excluída.',
  programada_pausada: 'Mensagem pausada.',
  programada_ativada: 'Mensagem ativada.'
}

export const mensagemOk = (chave: string | undefined): string | null => (chave && Object.hasOwn(OK, chave) ? OK[chave]! : null)

const limpar = (v: string | undefined, max: number) => (v ?? '').trim().replace(/\s+/g, ' ').slice(0, max)

const comOk = (url: string, chave: string) => `${url}${url.includes('?') ? '&' : '?'}ok=${chave}`

function tipoDoArquivo(mimetype: string): TipoMidia {
  if (mimetype.startsWith('image/')) return 'imagem'
  if (mimetype.startsWith('video/')) return 'video'
  if (mimetype.startsWith('audio/')) return 'audio'
  return 'documento'
}

type CorpoProgramada = Record<string, string | undefined>

export function rotasBotGrupos(app: FastifyInstance, d: DependenciasPainel, a: Ajudantes): void {
  const b = d.botsGrupos
  const g = d.grupos

  const acharBot = (id: string): BotGrupos | null => (/^\d+$/.test(id) ? b.bot(Number(id)) : null)

  const cabecalho = (bot: BotGrupos): CabecalhoBot => {
    const numero = bot.numeroId ? d.numeros.numero(bot.numeroId) : null
    return { bot, numero, estado: numero?.ativo ? d.conexoes.estado(numero.id) : null }
  }

  const telefoneBot = (bot: BotGrupos): string | null => (bot.numeroId ? (d.conexoes.estado(bot.numeroId)?.numero ?? null) : null)

  /** Números de grupos; os usados por outro bot vêm marcados (e desabilitados no formulário). */
  const opcoesNumero = (botId: number | null): OpcaoNumero[] => {
    const donos = new Map(b.bots().filter((x) => x.numeroId !== null && x.id !== botId).map((x) => [x.numeroId!, x.nome]))
    return d.numeros
      .listar()
      .filter((n) => n.papel === 'grupos')
      .map((n) => ({ id: n.id, nome: n.nome, usadoPor: donos.get(n.id) ?? null }))
  }

  /** Número escolhido no formulário: vazio = sem número; precisa ser de grupos e livre. */
  const numeroEscolhido = (bruto: string | undefined, botId: number | null): { id: number | null } | { erro: string } => {
    if (!bruto) return { id: null }
    const op = opcoesNumero(botId).find((n) => String(n.id) === bruto)
    if (!op) return { erro: 'Escolha um número de grupos.' }
    if (op.usadoPor) return { erro: `O número ${op.nome} já é usado pelo bot ${op.usadoPor}.` }
    return { id: op.id }
  }

  const naoAchou = (rep: FastifyReply) => rep.code(404).send('Bot não encontrado')

  /** Nome de cada grupo ativo (da lista geral do número atual). */
  const nomesDosGrupos = (bot: BotGrupos): Map<string, string> => {
    const geral = new Map((bot.numeroId ? g.todosGrupos().filter((x) => x.numeroId === bot.numeroId) : []).map((x) => [x.jid, x.nome]))
    return new Map(b.gruposAtivos(bot.id).map((x) => [x.jid, geral.get(x.jid) ?? 'Grupo']))
  }

  /** Apaga do disco as mídias que nenhuma programada usa mais. */
  const limparMidias = async (caminhos: string[]) => {
    const emUso = b.midiasEmUso()
    for (const c of caminhos) if (!emUso.has(c)) await d.armazem.apagar(c).catch(() => undefined)
  }

  // --- criar ---------------------------------------------------------------------

  app.get('/grupos-bot/novo', async (req, rep) => a.html(rep, paginaNovoBotGrupos(opcoesNumero(null), a.usuario(req), null)))

  app.post<{ Body: { nome?: string; numero_id?: string } }>('/grupos-bot', async (req, rep) => {
    const nome = limpar(req.body?.nome, 40)
    const numero = numeroEscolhido(req.body?.numero_id, null)
    const erro = !nome ? 'Dê um nome ao bot.' : 'erro' in numero ? numero.erro : null
    if (erro || 'erro' in numero) return a.html(rep.code(400), paginaNovoBotGrupos(opcoesNumero(null), a.usuario(req), erro, nome))
    const id = d.repo.transacao(() => {
      const novo = b.criarBot(nome, numero.id, a.agora())
      d.repo.auditar(a.usuario(req), 'criar_bot_grupos', `${novo} ${nome}`, a.agora())
      return novo
    })
    return rep.redirect(`/grupos-bot/${id}?ok=criado`, 303)
  })

  // --- geral ---------------------------------------------------------------------

  const paginaGeral = (bot: BotGrupos, usuario: string, ok: string | null, erro: string | null) => {
    const gestores = b.gestores(bot.id)
    return paginaGeralBot(
      {
        cab: cabecalho(bot),
        opcoes: opcoesNumero(bot.id),
        gruposAtivos: b.gruposAtivos(bot.id).length,
        gestoresConfirmados: gestores.filter((x) => x.confirmadoEm).length,
        gestoresPendentes: gestores.filter((x) => !x.confirmadoEm).length,
        programadas: b.programadas(bot.id).filter((p) => p.ativa).length
      },
      usuario,
      ok,
      erro
    )
  }

  app.get<{ Params: { id: string }; Querystring: { ok?: string } }>('/grupos-bot/:id', async (req, rep) => {
    const bot = acharBot(req.params.id)
    if (!bot) return naoAchou(rep)
    return a.html(rep, paginaGeral(bot, a.usuario(req), mensagemOk(req.query.ok), null))
  })

  app.post<{ Params: { id: string }; Body: { nome?: string; numero_id?: string; ativo?: string } }>('/grupos-bot/:id', async (req, rep) => {
    const bot = acharBot(req.params.id)
    if (!bot) return naoAchou(rep)
    const nome = limpar(req.body?.nome, 40)
    const numero = numeroEscolhido(req.body?.numero_id, bot.id)
    const erro = !nome ? 'Dê um nome ao bot.' : 'erro' in numero ? numero.erro : null
    if (erro || 'erro' in numero) return a.html(rep.code(400), paginaGeral(bot, a.usuario(req), null, erro))
    const ativo = req.body?.ativo === '1'
    d.repo.transacao(() => {
      b.editarBot(bot.id, { nome, numeroId: numero.id, ativo })
      const mudou = [
        nome !== bot.nome ? `nome: ${nome}` : null,
        numero.id !== bot.numeroId ? `número: ${numero.id ?? 'nenhum'}` : null,
        ativo !== bot.ativo ? (ativo ? 'ativado' : 'desativado') : null
      ].filter(Boolean)
      d.repo.auditar(a.usuario(req), 'editar_bot_grupos', `${bot.id} ${bot.nome}${mudou.length ? ` (${mudou.join(', ')})` : ''}`, a.agora())
    })
    return rep.redirect(`/grupos-bot/${bot.id}?ok=salvo`, 303)
  })

  app.post<{ Params: { id: string } }>('/grupos-bot/:id/excluir', async (req, rep) => {
    const bot = acharBot(req.params.id)
    if (!bot) return naoAchou(rep)
    if (b.gruposAtivos(bot.id).length) return rep.code(409).send('Desative os grupos deste bot antes de excluí-lo.')
    const midias = b.programadas(bot.id).flatMap((p) => p.variacoes.flatMap((v) => (v.midia ? [v.midia.caminho] : [])))
    const pessoas = b.gestores(bot.id).map((x) => x.funcionarioId)
    d.repo.transacao(() => {
      b.excluirBot(bot.id)
      for (const f of pessoas) if (b.botsDaPessoa(f) === 0) g.excluirFuncionario(f)
      d.repo.auditar(a.usuario(req), 'excluir_bot_grupos', `${bot.id} ${bot.nome}`, a.agora())
    })
    await limparMidias(midias)
    return rep.redirect('/', 303)
  })

  // --- grupos --------------------------------------------------------------------

  app.get<{ Params: { id: string }; Querystring: { ok?: string; erro?: string } }>('/grupos-bot/:id/grupos', async (req, rep) => {
    const bot = acharBot(req.params.id)
    if (!bot) return naoAchou(rep)
    const doNumero = bot.numeroId ? g.todosGrupos().filter((x) => x.numeroId === bot.numeroId) : []
    const porJid = new Map(doNumero.map((x) => [x.jid, x]))
    const palavras = b.palavrasDoBot(bot.id)
    const silencios = new Map(b.silencios(bot.id).map((s) => [s.jid, s]))
    const repeticoes = new Map<string, number>()
    for (const p of b.programadas(bot.id)) if (p.origem === 'repeat' && p.ativa) repeticoes.set(p.jid, (repeticoes.get(p.jid) ?? 0) + 1)
    const ativos = b
      .gruposAtivos(bot.id)
      .map((x) => ({
        jid: x.jid,
        geral: porJid.get(x.jid) ?? null,
        ativadoEm: x.ativadoEm,
        palavras: palavras.get(x.jid)?.length ?? 0,
        silencio: silencios.get(x.jid) ?? null,
        repeticoes: repeticoes.get(x.jid) ?? 0
      }))
      .sort((x, y) => (x.geral?.nome ?? '').localeCompare(y.geral?.nome ?? '', 'pt-BR'))
    const ja = new Set(ativos.map((x) => x.jid))
    const disponiveis = doNumero.filter((x) => x.ativo && !ja.has(x.jid)).sort((x, y) => x.nome.localeCompare(y.nome, 'pt-BR'))
    return a.html(rep, paginaGruposBot({ cab: cabecalho(bot), ativos, disponiveis }, a.usuario(req), mensagemOk(req.query.ok), null))
  })

  app.post<{ Params: { id: string }; Body: { jid?: string } }>('/grupos-bot/:id/grupos/ativar', async (req, rep) => {
    const bot = acharBot(req.params.id)
    const jid = req.body?.jid ?? ''
    const geral = bot?.numeroId ? g.grupo(bot.numeroId, jid) : null
    if (!bot || !geral?.ativo) return rep.code(404).send('Grupo não encontrado')
    d.repo.transacao(() => {
      b.ativarGrupo(bot.id, jid, a.usuario(req), a.agora())
      d.repo.auditar(a.usuario(req), 'ativar_grupo', `${bot.nome}: ${geral.nome}`, a.agora())
    })
    return rep.redirect(`/grupos-bot/${bot.id}/grupos?ok=ativado`, 303)
  })

  app.post<{ Params: { id: string }; Body: { jid?: string } }>('/grupos-bot/:id/grupos/desativar', async (req, rep) => {
    const bot = acharBot(req.params.id)
    const jid = req.body?.jid ?? ''
    if (!bot || !b.grupoAtivo(bot.id, jid)) return rep.code(404).send('Grupo não encontrado')
    const nome = nomesDosGrupos(bot).get(jid) ?? jid
    const midias = b
      .programadas(bot.id)
      .filter((p) => p.jid === jid)
      .flatMap((p) => p.variacoes.flatMap((v) => (v.midia ? [v.midia.caminho] : [])))
    d.repo.transacao(() => {
      b.desativarGrupo(bot.id, jid)
      d.repo.auditar(a.usuario(req), 'desativar_grupo', `${bot.nome}: ${nome}`, a.agora())
    })
    await limparMidias(midias)
    return rep.redirect(`/grupos-bot/${bot.id}/grupos?ok=desativado`, 303)
  })

  // --- gestores ------------------------------------------------------------------

  const paginaDeGestores = (bot: BotGrupos, usuario: string, ok: string | null, erro: string | null, form = { nome: '', telefone: '' }) =>
    paginaGestores(
      {
        cab: cabecalho(bot),
        linhas: b.gestores(bot.id).flatMap((x) => {
          const pessoa = g.funcionario(x.funcionarioId)
          return pessoa ? [{ gestor: x, pessoa }] : []
        }),
        telefoneBot: telefoneBot(bot),
        agora: a.agora(),
        form
      },
      usuario,
      ok,
      erro
    )

  app.get<{ Params: { id: string }; Querystring: { ok?: string; erro?: string } }>('/grupos-bot/:id/gestores', async (req, rep) => {
    const bot = acharBot(req.params.id)
    if (!bot) return naoAchou(rep)
    return a.html(rep, paginaDeGestores(bot, a.usuario(req), mensagemOk(req.query.ok), req.query.erro ? String(req.query.erro).slice(0, 200) : null))
  })

  /** Nome e WhatsApp: cria a pessoa (ou reaproveita quem já tem esse telefone) e indica com um código. */
  app.post<{ Params: { id: string }; Body: { nome?: string; telefone?: string } }>('/grupos-bot/:id/gestores', async (req, rep) => {
    const bot = acharBot(req.params.id)
    if (!bot) return naoAchou(rep)
    const nome = limpar(req.body?.nome, 80)
    const bruto = (req.body?.telefone ?? '').trim()
    const tel = telefoneDigitado(bruto)
    const erro = !/\p{L}{2,}/u.test(nome) ? 'Escreva o nome.' : !tel ? 'WhatsApp inválido: use DDD + número (ou +código do país).' : null
    if (erro || !tel) return a.html(rep.code(400), paginaDeGestores(bot, a.usuario(req), null, erro, { nome, telefone: bruto }))
    const r = d.repo.transacao(() => {
      const existente = g.porTelefone(tel)
      if (existente && b.gestor(bot.id, existente.id)?.confirmadoEm) return 'ja'
      const fid = existente?.id ?? g.salvarFuncionario(null, { nome, telefone: tel, lid: null, ativo: true }, a.agora())
      if (existente && !existente.ativo) g.salvarFuncionario(existente.id, { ...existente, ativo: true }, a.agora())
      b.indicarGestor(bot.id, fid, `painel:${a.usuario(req)}`, a.agora())
      d.repo.auditar(a.usuario(req), 'gestor_indicado', `${existente?.nome ?? nome} no ${bot.nome}`, a.agora(), fid)
      return 'indicado'
    })
    return rep.redirect(`/grupos-bot/${bot.id}/gestores?ok=${r}`, 303)
  })

  /** Ações sobre um gestor (pendente ou confirmado) deste bot. */
  const acaoGestor = (caminho: string, fazer: (bot: BotGrupos, fid: number, usuario: string) => { ok: string } | { erro: string }) =>
    app.post<{ Params: { id: string; f: string } }>(`/grupos-bot/:id/gestores/:f/${caminho}`, async (req, rep) => {
      const bot = acharBot(req.params.id)
      const fid = /^\d+$/.test(req.params.f) ? Number(req.params.f) : null
      if (!bot || fid === null || !b.gestor(bot.id, fid)) return rep.code(404).send('Gestor não encontrado')
      const voltar = `/grupos-bot/${bot.id}/gestores`
      const r = d.repo.transacao(() => fazer(bot, fid, a.usuario(req)))
      if ('erro' in r) return rep.redirect(`${voltar}?erro=${encodeURIComponent(r.erro)}`, 303)
      return rep.redirect(comOk(voltar, r.ok), 303)
    })

  const nomeDe = (fid: number) => g.funcionario(fid)?.nome ?? `#${fid}`

  acaoGestor('codigo', (bot, fid, usuario) => {
    if (b.gestor(bot.id, fid)?.confirmadoEm) return { erro: 'Esta pessoa já está confirmada.' }
    b.novoCodigo(bot.id, fid, a.agora())
    d.repo.auditar(usuario, 'gestor_novo_codigo', `${nomeDe(fid)} no ${bot.nome}`, a.agora(), fid)
    return { ok: 'codigo' }
  })

  /** Quem deixa de ser gestor de todos os bots sai do cadastro (o cadastro é só de gestores). */
  acaoGestor('remover', (bot, fid, usuario) => {
    const nome = nomeDe(fid)
    b.removerGestor(bot.id, fid)
    if (b.botsDaPessoa(fid) === 0) g.excluirFuncionario(fid)
    d.repo.auditar(usuario, 'gestor_removido', `${nome} no ${bot.nome}`, a.agora(), fid)
    return { ok: 'removido' }
  })

  acaoGestor('descartar-divergencia', (bot, fid, usuario) => {
    b.descartarDivergencia(bot.id, fid)
    d.repo.auditar(usuario, 'gestor_divergencia_descartada', `${nomeDe(fid)} no ${bot.nome}`, a.agora(), fid)
    return { ok: 'descartado' }
  })

  /** O código certo veio de outro WhatsApp e a pessoa é mesmo ela: o cadastro passa a ser este WhatsApp. */
  acaoGestor('aceitar-divergencia', (bot, fid, usuario) => {
    const gestor = b.gestor(bot.id, fid)!
    const f = g.funcionario(fid)
    if (!f || !gestor.divergenteJid) return { erro: 'Não há divergência para aceitar.' }
    const outros = g.funcionarios().filter((x) => x.id !== fid)
    const telefone = gestor.divergenteTelefone
    const lid = gestor.divergenteJid.endsWith('@lid') ? gestor.divergenteJid : null
    const dono = outros.find((x) => (telefone && x.telefone === telefone) || (lid && x.lid === lid))
    if (dono) return { erro: `Esse WhatsApp já é de ${dono.nome}.` }
    const agora = a.agora()
    if (telefone) g.definirTelefone(fid, telefone, agora)
    if (lid) g.definirLid(fid, lid, agora)
    b.confirmarGestor(bot.id, fid, gestor.divergenteJid, agora)
    g.confirmarFuncionario(fid, agora)
    d.repo.auditar(usuario, 'gestor_divergencia_aceita', `${f.nome} no ${bot.nome}`, agora, fid)
    return { ok: 'confirmado' }
  })

  // --- comandos ------------------------------------------------------------------

  app.get<{ Params: { id: string }; Querystring: { ok?: string } }>('/grupos-bot/:id/comandos', async (req, rep) => {
    const bot = acharBot(req.params.id)
    if (!bot) return naoAchou(rep)
    return a.html(rep, paginaComandos(cabecalho(bot), b.desligados(bot.id), a.usuario(req), mensagemOk(req.query.ok)))
  })

  app.post<{ Params: { id: string; nome: string }; Body: { ligado?: string } }>('/grupos-bot/:id/comandos/:nome', async (req, rep) => {
    const bot = acharBot(req.params.id)
    const def = COMANDOS.find((c) => c.nome === req.params.nome && !c.oculto)
    if (!bot || !def) return rep.code(404).send('Comando não encontrado')
    if (def.fixo) return rep.code(409).send(`O /${def.nome} não pode ser desligado.`)
    const ligado = req.body?.ligado === '1'
    d.repo.transacao(() => {
      b.ligarComando(bot.id, def.nome, ligado)
      d.repo.auditar(a.usuario(req), ligado ? 'ligar_comando' : 'desligar_comando', `${bot.nome}: /${def.nome}`, a.agora())
    })
    return rep.redirect(`/grupos-bot/${bot.id}/comandos?ok=${ligado ? 'ligado' : 'desligado'}`, 303)
  })

  // --- programadas ---------------------------------------------------------------

  app.get<{ Params: { id: string }; Querystring: { ok?: string } }>('/grupos-bot/:id/programadas', async (req, rep) => {
    const bot = acharBot(req.params.id)
    if (!bot) return naoAchou(rep)
    return a.html(rep, paginaProgramadas(cabecalho(bot), b.programadas(bot.id), nomesDosGrupos(bot), a.usuario(req), mensagemOk(req.query.ok)))
  })

  const gruposDoForm = (bot: BotGrupos) =>
    [...nomesDosGrupos(bot)].map(([jid, nome]) => ({ jid, nome })).sort((x, y) => x.nome.localeCompare(y.nome, 'pt-BR'))

  const formDe = (p: Programada | null): FormProgramada => {
    const msgs = [0, 1, 2].map((i) => {
      const v = p?.variacoes[i]
      return { texto: v?.texto ?? '', midia: v?.midia ? { nome: v.midia.nome ?? v.midia.tipo, tipo: v.midia.tipo } : null }
    })
    return {
      jid: p?.jid ?? '',
      tipo: p?.data ? 'unica' : 'semanal',
      dias: p?.dias ?? [0, 1, 2, 3, 4, 5, 6],
      data: p?.data ?? diaBR(a.agora()).data,
      horarios: p?.horarios ?? [],
      variar: p?.variar ?? false,
      mencionar: p?.mencionar ?? false,
      msgs
    }
  }

  const telaForm = (rep: FastifyReply, usuario: string, bot: BotGrupos, f: FormProgramada, id: number | null, erro: string | null, codigo = 200) =>
    a.html(rep.code(codigo), paginaFormProgramada(cabecalho(bot), gruposDoForm(bot), f, id, usuario, erro))

  app.get<{ Params: { id: string; pid: string } }>('/grupos-bot/:id/programadas/:pid', async (req, rep) => {
    const bot = acharBot(req.params.id)
    if (!bot) return naoAchou(rep)
    if (req.params.pid === 'nova') return telaForm(rep, a.usuario(req), bot, formDe(null), null, null)
    const p = /^\d+$/.test(req.params.pid) ? b.programada(Number(req.params.pid)) : null
    if (!p || p.botId !== bot.id) return rep.code(404).send('Mensagem não encontrada')
    return telaForm(rep, a.usuario(req), bot, formDe(p), p.id, null)
  })

  // Mídias chegam em base64 dentro do formulário (sem dependência de upload): até 3 × 15 MB.
  app.post<{ Params: { id: string }; Body: CorpoProgramada }>('/grupos-bot/:id/programadas', { bodyLimit: 64 * 1024 * 1024 }, async (req, rep) => {
    const bot = acharBot(req.params.id)
    if (!bot) return naoAchou(rep)
    const c = req.body ?? {}
    const id = c.id && /^\d+$/.test(c.id) ? Number(c.id) : null
    const atual = id ? b.programada(id) : null
    if (id && (!atual || atual.botId !== bot.id)) return rep.code(404).send('Mensagem não encontrada')
    const tipo = c.tipo === 'unica' ? 'unica' : 'semanal'
    const dias = [0, 1, 2, 3, 4, 5, 6].filter((i) => c[`dia${i}`] === '1')
    const horarios = [...new Set([0, 1, 2, 3].map((i) => horario(c[`horario${i}`] ?? '')).filter((h): h is string => !!h))].sort()
    const data = tipo === 'unica' ? (c.data ?? '') : ''
    const novos = [0, 1, 2].map((i) => {
      const b64 = c[`arquivo${i}`] ?? ''
      return b64 ? { dados: Buffer.from(b64, 'base64'), nome: limpar(c[`arquivo_nome${i}`], 120) || 'arquivo', mimetype: c[`arquivo_tipo${i}`] || 'application/octet-stream' } : null
    })
    const form: FormProgramada = {
      jid: c.jid ?? '',
      tipo,
      dias,
      data,
      horarios,
      variar: c.variar === '1',
      mencionar: c.mencionar === '1',
      msgs: [0, 1, 2].map((i) => {
        const antiga = atual?.variacoes[i]?.midia
        const nova = novos[i]
        return {
          texto: (c[`texto${i}`] ?? '').replace(/\r\n/g, '\n').trim().slice(0, 4000),
          midia: nova ? { nome: nova.nome, tipo: tipoDoArquivo(nova.mimetype) } : antiga && c[`tirar${i}`] !== '1' ? { nome: antiga.nome ?? antiga.tipo, tipo: antiga.tipo } : null
        }
      })
    }
    const hoje = diaBR(a.agora()).data
    const erro = !b.grupoAtivo(bot.id, form.jid)
      ? 'Escolha um grupo ativo.'
      : horarios.length === 0
        ? 'Informe ao menos um horário.'
        : tipo === 'semanal' && dias.length === 0
          ? 'Escolha ao menos um dia.'
          : tipo === 'unica' && (!/^\d{4}-\d{2}-\d{2}$/.test(data) || data < hoje)
            ? 'Escolha uma data de hoje em diante.'
            : !form.msgs[0]!.texto && !form.msgs[0]!.midia
              ? 'Escreva a mensagem 1 (ou anexe uma mídia).'
              : novos.some((x) => x && (x.dados.length === 0 || x.dados.length > MAX_MIDIA_BYTES))
                ? 'Cada mídia pode ter até 15 MB.'
                : null
    if (erro) return telaForm(rep, a.usuario(req), bot, form, id, erro, 400)

    const variacoes: VariacaoMensagem[] = []
    const trocadas: string[] = []
    for (const i of [0, 1, 2]) {
      const antiga = atual?.variacoes[i]?.midia ?? null
      const nova = novos[i]
      let midia: Midia | null = antiga && c[`tirar${i}`] !== '1' ? antiga : null
      if (nova) {
        const caminho = await d.armazem.salvarMidia(extensaoDe(nova.mimetype, nova.nome), nova.dados)
        midia = { caminho, tipo: tipoDoArquivo(nova.mimetype), mimetype: nova.mimetype, nome: nova.nome }
      }
      if (antiga && midia?.caminho !== antiga.caminho) trocadas.push(antiga.caminho)
      variacoes.push({ texto: form.msgs[i]!.texto || null, midia })
    }
    d.repo.transacao(() => {
      b.salvarProgramada(
        id,
        bot.id,
        { jid: form.jid, origem: atual?.origem ?? 'painel', horarios, dias: tipo === 'unica' ? [] : dias, data: tipo === 'unica' ? data : null, variar: form.variar, mencionar: form.mencionar, variacoes },
        a.usuario(req),
        a.agora()
      )
      d.repo.auditar(a.usuario(req), id ? 'editar_programada' : 'criar_programada', `${bot.nome}: ${nomesDosGrupos(bot).get(form.jid) ?? form.jid}`, a.agora())
    })
    await limparMidias(trocadas)
    return rep.redirect(`/grupos-bot/${bot.id}/programadas?ok=${id ? 'programada_salva' : 'programada'}`, 303)
  })

  const acaoProgramada = (caminho: string, ok: string, fazer: (p: Programada, bot: BotGrupos, usuario: string) => string[]) =>
    app.post<{ Params: { id: string; pid: string } }>(`/grupos-bot/:id/programadas/:pid/${caminho}`, async (req, rep) => {
      const bot = acharBot(req.params.id)
      const p = /^\d+$/.test(req.params.pid) ? b.programada(Number(req.params.pid)) : null
      if (!bot || !p || p.botId !== bot.id) return rep.code(404).send('Mensagem não encontrada')
      const soltas = d.repo.transacao(() => fazer(p, bot, a.usuario(req)))
      await limparMidias(soltas)
      return rep.redirect(`/grupos-bot/${bot.id}/programadas?ok=${ok}`, 303)
    })

  acaoProgramada('pausar', 'programada_pausada', (p, bot, usuario) => {
    b.definirProgramadaAtiva(p.id, false)
    d.repo.auditar(usuario, 'pausar_programada', `${bot.nome}: #${p.id}`, a.agora())
    return []
  })

  acaoProgramada('ativar', 'programada_ativada', (p, bot, usuario) => {
    if (p.data && p.data < diaBR(a.agora()).data) return []
    b.definirProgramadaAtiva(p.id, true)
    d.repo.auditar(usuario, 'ativar_programada', `${bot.nome}: #${p.id}`, a.agora())
    return []
  })

  acaoProgramada('excluir', 'programada_excluida', (p, bot, usuario) => {
    d.repo.auditar(usuario, 'excluir_programada', `${bot.nome}: #${p.id}`, a.agora())
    return b.excluirProgramada(p.id)
  })
}
