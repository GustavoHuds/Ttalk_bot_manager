import type { FastifyInstance, FastifyReply } from 'fastify'
import { semAcento } from '../conversa/textos.js'
import type { BotGrupos } from '../db/bots-grupos.js'
import { TEXTOS, comandosDoBot, validarPersonalizado, validarTexto } from '../grupos/catalogo.js'
import { COMANDOS, acharComando, type NomeComando } from '../grupos/comandos.js'
import {
  paginaComandos,
  paginaGeralBot,
  paginaGestores,
  paginaLojas,
  paginaNovoBotGrupos,
  paginaPersonalizado,
  paginaTextos,
  type CabecalhoBot,
  type FormPersonalizado,
  type OpcaoNumero
} from './paginas-bot-grupos.js'
import type { Ajudantes } from './rotas-numeros.js'
import type { DependenciasPainel } from './servidor.js'

/** Mensagens de sucesso, pelo ?ok= do redirecionamento. */
const OK: Record<string, string> = {
  salvo: 'Bot salvo.',
  criado: 'Bot criado. Agora ative os grupos em que ele deve atuar e indique os gestores.',
  loja: 'Loja adicionada.',
  renomeada: 'Loja renomeada.',
  loja_excluida: 'Loja excluída.',
  indicado: 'Pessoa indicada. Mande o código (ou o link) para ela confirmar.',
  codigo: 'Novo código gerado. O anterior não vale mais.',
  removido: 'Gestor removido.',
  confirmado: 'Cadastro corrigido e gestor confirmado.',
  descartado: 'Divergência descartada. O código continua valendo para a pessoa certa.',
  ligado: 'Comando ligado.',
  desligado: 'Comando desligado.',
  textos: 'Respostas salvas.',
  original: 'Respostas de volta ao original.',
  cmd_criado: 'Comando criado.',
  cmd_salvo: 'Comando salvo.',
  cmd_excluido: 'Comando excluído.'
}

export const mensagemOk = (chave: string | undefined): string | null => (chave && Object.hasOwn(OK, chave) ? OK[chave]! : null)

const limpar = (v: string | undefined, max: number) => (v ?? '').trim().replace(/\s+/g, ' ').slice(0, max)

/** Só volta para páginas do próprio painel (nada de redirecionamento aberto). */
function voltarSeguro(v: string | undefined, padrao: string): string {
  return v && /^\/(equipe|grupos-bot)\/[\w/-]*$/.test(v) ? v : padrao
}

const comOk = (url: string, chave: string) => `${url}${url.includes('?') ? '&' : '?'}ok=${chave}`

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
      .map((n) => ({ id: n.id, nome: n.nome, ativo: n.ativo, usadoPor: donos.get(n.id) ?? null }))
  }

  /** Número escolhido no formulário: vazio = sem número; precisa ser de grupos e livre. */
  const numeroEscolhido = (bruto: string | undefined, botId: number | null): { id: number | null } | { erro: string } => {
    if (!bruto) return { id: null }
    const op = opcoesNumero(botId).find((n) => String(n.id) === bruto)
    if (!op) return { erro: 'Escolha um número com o uso "Grupos".' }
    if (op.usadoPor) return { erro: `O número ${op.nome} já é usado pelo bot ${op.usadoPor}.` }
    return { id: op.id }
  }

  const naoAchou = (rep: FastifyReply) => rep.code(404).send('Bot não encontrado')

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
    const cmds = comandosDoBot(b.comandos(bot.id))
    const ativos = b.gruposAtivos(bot.id)
    const noNumero = new Set(bot.numeroId ? g.grupos(bot.numeroId).map((x) => x.jid) : [])
    return paginaGeralBot(
      {
        cab: cabecalho(bot),
        opcoes: opcoesNumero(bot.id),
        gruposAtivos: ativos.length,
        lojas: b.lojas(bot.id).length,
        gestoresConfirmados: gestores.filter((x) => x.confirmadoEm).length,
        gestoresPendentes: gestores.filter((x) => !x.confirmadoEm).length,
        comandosLigados: COMANDOS.filter((c) => !c.oculto && !cmds.desligados.has(c.nome)).length + cmds.personalizados.length,
        personalizados: cmds.personalizados.length,
        foraDoNumero: bot.numeroId ? ativos.filter((x) => !noNumero.has(x.jid)).length : 0
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
    d.repo.transacao(() => {
      b.excluirBot(bot.id)
      d.repo.auditar(a.usuario(req), 'excluir_bot_grupos', `${bot.id} ${bot.nome}`, a.agora())
    })
    return rep.redirect('/', 303)
  })

  // --- lojas ---------------------------------------------------------------------

  const paginaDeLojas = (bot: BotGrupos, usuario: string, ok: string | null, erro: string | null) => {
    const porLoja = new Map<number, number>()
    for (const x of b.gruposAtivos(bot.id)) if (x.lojaId) porLoja.set(x.lojaId, (porLoja.get(x.lojaId) ?? 0) + 1)
    return paginaLojas(cabecalho(bot), b.lojas(bot.id).map((l) => ({ ...l, grupos: porLoja.get(l.id) ?? 0 })), usuario, ok, erro)
  }

  app.get<{ Params: { id: string }; Querystring: { ok?: string } }>('/grupos-bot/:id/lojas', async (req, rep) => {
    const bot = acharBot(req.params.id)
    if (!bot) return naoAchou(rep)
    return a.html(rep, paginaDeLojas(bot, a.usuario(req), mensagemOk(req.query.ok), null))
  })

  const nomeLivre = (botId: number, nome: string, exceto: number | null) =>
    !b.lojas(botId).some((l) => l.id !== exceto && semAcento(l.nome) === semAcento(nome))

  app.post<{ Params: { id: string }; Body: { nome?: string } }>('/grupos-bot/:id/lojas', async (req, rep) => {
    const bot = acharBot(req.params.id)
    if (!bot) return naoAchou(rep)
    const nome = limpar(req.body?.nome, 60)
    const erro = !nome ? 'Escreva o nome da loja.' : !nomeLivre(bot.id, nome, null) ? `A loja ${nome} já existe neste bot.` : null
    if (erro) return a.html(rep.code(400), paginaDeLojas(bot, a.usuario(req), null, erro))
    d.repo.transacao(() => {
      b.criarLoja(bot.id, nome)
      d.repo.auditar(a.usuario(req), 'criar_loja', `${bot.nome}: ${nome}`, a.agora())
    })
    return rep.redirect(`/grupos-bot/${bot.id}/lojas?ok=loja`, 303)
  })

  app.post<{ Params: { id: string; loja: string }; Body: { nome?: string } }>('/grupos-bot/:id/lojas/:loja/renomear', async (req, rep) => {
    const bot = acharBot(req.params.id)
    const loja = /^\d+$/.test(req.params.loja) ? b.loja(Number(req.params.loja)) : null
    if (!bot || !loja || loja.botId !== bot.id) return rep.code(404).send('Loja não encontrada')
    const nome = limpar(req.body?.nome, 60)
    const erro = !nome ? 'Escreva o nome da loja.' : !nomeLivre(bot.id, nome, loja.id) ? `A loja ${nome} já existe neste bot.` : null
    if (erro) return a.html(rep.code(400), paginaDeLojas(bot, a.usuario(req), null, erro))
    d.repo.transacao(() => {
      b.renomearLoja(loja.id, nome)
      d.repo.auditar(a.usuario(req), 'renomear_loja', `${bot.nome}: ${loja.nome} → ${nome}`, a.agora())
    })
    return rep.redirect(`/grupos-bot/${bot.id}/lojas?ok=renomeada`, 303)
  })

  app.post<{ Params: { id: string; loja: string } }>('/grupos-bot/:id/lojas/:loja/excluir', async (req, rep) => {
    const bot = acharBot(req.params.id)
    const loja = /^\d+$/.test(req.params.loja) ? b.loja(Number(req.params.loja)) : null
    if (!bot || !loja || loja.botId !== bot.id) return rep.code(404).send('Loja não encontrada')
    d.repo.transacao(() => {
      b.excluirLoja(loja.id)
      d.repo.auditar(a.usuario(req), 'excluir_loja', `${bot.nome}: ${loja.nome}`, a.agora())
    })
    return rep.redirect(`/grupos-bot/${bot.id}/lojas?ok=loja_excluida`, 303)
  })

  // --- gestores ------------------------------------------------------------------

  app.get<{ Params: { id: string }; Querystring: { ok?: string; q?: string; erro?: string } }>('/grupos-bot/:id/gestores', async (req, rep) => {
    const bot = acharBot(req.params.id)
    if (!bot) return naoAchou(rep)
    const pessoas = new Map(g.funcionarios().map((f) => [f.id, f]))
    const gestores = b.gestores(bot.id)
    const ja = new Set(gestores.map((x) => x.funcionarioId))
    const q = (req.query.q ?? '').trim()
    const termo = semAcento(q)
    const digitos = q.replace(/\D/g, '')
    const candidatos = q
      ? [...pessoas.values()]
          .filter((f) => !ja.has(f.id))
          .filter((f) => semAcento(f.nome).includes(termo) || (digitos.length >= 4 && (f.telefone ?? '').includes(digitos)))
          .slice(0, 20)
      : null
    return a.html(
      rep,
      paginaGestores(
        {
          cab: cabecalho(bot),
          linhas: gestores.flatMap((x) => {
            const pessoa = pessoas.get(x.funcionarioId)
            return pessoa ? [{ gestor: x, pessoa }] : []
          }),
          telefoneBot: telefoneBot(bot),
          agora: a.agora(),
          busca: q,
          candidatos
        },
        a.usuario(req),
        mensagemOk(req.query.ok),
        req.query.erro ? String(req.query.erro).slice(0, 200) : null
      )
    )
  })

  app.post<{ Params: { id: string }; Body: { funcionario_id?: string; voltar?: string } }>('/grupos-bot/:id/gestores', async (req, rep) => {
    const bot = acharBot(req.params.id)
    if (!bot) return naoAchou(rep)
    const f = /^\d+$/.test(req.body?.funcionario_id ?? '') ? g.funcionario(Number(req.body!.funcionario_id)) : null
    if (!f) return rep.code(404).send('Pessoa não encontrada')
    if (!f.ativo) return rep.code(409).send('Cadastro inativo não pode ser gestor.')
    const voltar = voltarSeguro(req.body?.voltar, `/grupos-bot/${bot.id}/gestores`)
    if (b.gestor(bot.id, f.id)?.confirmadoEm) return rep.redirect(voltar, 303)
    d.repo.transacao(() => {
      b.indicarGestor(bot.id, f.id, `painel:${a.usuario(req)}`, a.agora())
      d.repo.auditar(a.usuario(req), 'gestor_indicado', `${f.nome} no ${bot.nome}`, a.agora(), f.id)
    })
    return rep.redirect(comOk(voltar, 'indicado'), 303)
  })

  /** Ações sobre um gestor (pendente ou confirmado) deste bot. */
  const acaoGestor = (
    caminho: string,
    fazer: (bot: BotGrupos, fid: number, usuario: string) => { ok: string } | { erro: string }
  ) =>
    app.post<{ Params: { id: string; f: string }; Body: { voltar?: string } }>(`/grupos-bot/:id/gestores/:f/${caminho}`, async (req, rep) => {
      const bot = acharBot(req.params.id)
      const fid = /^\d+$/.test(req.params.f) ? Number(req.params.f) : null
      if (!bot || fid === null || !b.gestor(bot.id, fid)) return rep.code(404).send('Gestor não encontrado')
      const voltar = voltarSeguro(req.body?.voltar, `/grupos-bot/${bot.id}/gestores`)
      const r = d.repo.transacao(() => fazer(bot, fid, a.usuario(req)))
      if ('erro' in r) return rep.redirect(`${voltar}${voltar.includes('?') ? '&' : '?'}erro=${encodeURIComponent(r.erro)}`, 303)
      return rep.redirect(comOk(voltar, r.ok), 303)
    })

  const nomeDe = (fid: number) => g.funcionario(fid)?.nome ?? `#${fid}`

  acaoGestor('codigo', (bot, fid, usuario) => {
    if (b.gestor(bot.id, fid)?.confirmadoEm) return { erro: 'Esta pessoa já está confirmada.' }
    b.novoCodigo(bot.id, fid, a.agora())
    d.repo.auditar(usuario, 'gestor_novo_codigo', `${nomeDe(fid)} no ${bot.nome}`, a.agora(), fid)
    return { ok: 'codigo' }
  })

  acaoGestor('remover', (bot, fid, usuario) => {
    b.removerGestor(bot.id, fid)
    d.repo.auditar(usuario, 'gestor_removido', `${nomeDe(fid)} no ${bot.nome}`, a.agora(), fid)
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
    if (dono) return { erro: `Esse WhatsApp já está no cadastro de ${dono.nome}. Corrija pela Equipe.` }
    const agora = a.agora()
    if (telefone) g.definirTelefone(fid, telefone, agora)
    if (lid) g.definirLid(fid, lid, agora)
    b.confirmarGestor(bot.id, fid, gestor.divergenteJid, agora)
    g.confirmarFuncionario(fid, agora)
    d.repo.auditar(usuario, 'gestor_divergencia_aceita', `${f.nome} no ${bot.nome}: cadastro atualizado e confirmado`, agora, fid)
    return { ok: 'confirmado' }
  })

  // --- comandos ------------------------------------------------------------------

  app.get<{ Params: { id: string }; Querystring: { ok?: string } }>('/grupos-bot/:id/comandos', async (req, rep) => {
    const bot = acharBot(req.params.id)
    if (!bot) return naoAchou(rep)
    return a.html(rep, paginaComandos(cabecalho(bot), comandosDoBot(b.comandos(bot.id)), a.usuario(req), mensagemOk(req.query.ok), null))
  })

  const comandoPronto = (nome: string): NomeComando | null => {
    const def = acharComando(nome)
    return def && def.nome === nome ? def.nome : null
  }

  app.post<{ Params: { id: string; nome: string }; Body: { ligado?: string } }>('/grupos-bot/:id/comandos/:nome/ligar', async (req, rep) => {
    const bot = acharBot(req.params.id)
    const nome = comandoPronto(req.params.nome)
    if (!bot || !nome) return rep.code(404).send('Comando não encontrado')
    if (COMANDOS.find((c) => c.nome === nome)!.fixo) return rep.code(409).send(`O /${nome} não pode ser desligado.`)
    const ligado = req.body?.ligado === '1'
    d.repo.transacao(() => {
      b.ligarComando(bot.id, nome, ligado)
      d.repo.auditar(a.usuario(req), ligado ? 'ligar_comando' : 'desligar_comando', `${bot.nome}: /${nome}`, a.agora())
    })
    return rep.redirect(`/grupos-bot/${bot.id}/comandos?ok=${ligado ? 'ligado' : 'desligado'}`, 303)
  })

  app.get<{ Params: { id: string; nome: string } }>('/grupos-bot/:id/comandos/:nome/textos', async (req, rep) => {
    const bot = acharBot(req.params.id)
    const nome = comandoPronto(req.params.nome)
    if (!bot || !nome) return rep.code(404).send('Comando não encontrado')
    return a.html(rep, paginaTextos(cabecalho(bot), nome, b.comandos(bot.id).get(nome)?.textos ?? {}, a.usuario(req), null))
  })

  app.post<{ Params: { id: string; nome: string }; Body: Record<string, string> }>('/grupos-bot/:id/comandos/:nome/textos', async (req, rep) => {
    const bot = acharBot(req.params.id)
    const nome = comandoPronto(req.params.nome)
    if (!bot || !nome) return rep.code(404).send('Comando não encontrado')
    const corpo = req.body ?? {}
    if (corpo.original === '1') {
      d.repo.transacao(() => {
        b.salvarTextos(bot.id, nome, {})
        d.repo.auditar(a.usuario(req), 'textos_originais', `${bot.nome}: /${nome}`, a.agora())
      })
      return rep.redirect(`/grupos-bot/${bot.id}/comandos?ok=original`, 303)
    }
    const textos: Record<string, string> = {}
    const enviado: Record<string, string> = {}
    for (const t of TEXTOS[nome]) {
      const valor = (corpo[`t_${t.chave}`] ?? '').replace(/\r\n/g, '\n').trim()
      enviado[t.chave] = valor
      if (!valor || valor === t.padrao) continue
      const erro = validarTexto(nome, t.chave, valor)
      if (erro) {
        return a.html(rep.code(400), paginaTextos(cabecalho(bot), nome, b.comandos(bot.id).get(nome)?.textos ?? {}, a.usuario(req), `${t.rotulo}: ${erro}`, enviado))
      }
      textos[t.chave] = valor
    }
    d.repo.transacao(() => {
      b.salvarTextos(bot.id, nome, textos)
      d.repo.auditar(a.usuario(req), 'editar_textos', `${bot.nome}: /${nome} (${Object.keys(textos).length} editado(s))`, a.agora())
    })
    return rep.redirect(`/grupos-bot/${bot.id}/comandos?ok=textos`, 303)
  })

  const vazioPersonalizado: FormPersonalizado = { nome: '', descricao: '', quem: 'todos', onde: 'grupo', resposta: '' }

  app.get<{ Params: { id: string; nome: string } }>('/grupos-bot/:id/comandos/personalizado/:nome', async (req, rep) => {
    const bot = acharBot(req.params.id)
    if (!bot) return naoAchou(rep)
    if (req.params.nome === 'novo') return a.html(rep, paginaPersonalizado(cabecalho(bot), vazioPersonalizado, null, a.usuario(req), null))
    const p = b.comandos(bot.id).get(req.params.nome)
    if (!p?.personalizado) return rep.code(404).send('Comando não encontrado')
    const f: FormPersonalizado = { nome: p.nome, descricao: p.descricao ?? '', quem: p.quem ?? 'todos', onde: p.onde ?? 'grupo', resposta: p.resposta ?? '' }
    return a.html(rep, paginaPersonalizado(cabecalho(bot), f, p.nome, a.usuario(req), null))
  })

  app.post<{ Params: { id: string }; Body: Partial<FormPersonalizado> & { original?: string } }>('/grupos-bot/:id/comandos/personalizado', async (req, rep) => {
    const bot = acharBot(req.params.id)
    if (!bot) return naoAchou(rep)
    const corpo = req.body ?? {}
    const original = corpo.original || null
    const salvos = b.comandos(bot.id)
    if (original && !salvos.get(original)?.personalizado) return rep.code(404).send('Comando não encontrado')
    // Editando, o nome não muda (o campo vem travado).
    const r = validarPersonalizado({ ...corpo, nome: original ?? corpo.nome, quem: corpo.quem as never, onde: corpo.onde as never })
    const form: FormPersonalizado = {
      nome: original ?? corpo.nome ?? '',
      descricao: corpo.descricao ?? '',
      quem: corpo.quem ?? 'todos',
      onde: corpo.onde ?? 'grupo',
      resposta: corpo.resposta ?? ''
    }
    const repetido = 'ok' in r && !original && salvos.has(r.ok.nome) ? `O comando /${r.ok.nome} já existe neste bot.` : null
    if ('erro' in r || repetido) {
      return a.html(rep.code(400), paginaPersonalizado(cabecalho(bot), form, original, a.usuario(req), 'erro' in r ? r.erro : repetido))
    }
    d.repo.transacao(() => {
      b.salvarPersonalizado(bot.id, r.ok)
      d.repo.auditar(a.usuario(req), original ? 'editar_comando' : 'criar_comando', `${bot.nome}: /${r.ok.nome}`, a.agora())
    })
    return rep.redirect(`/grupos-bot/${bot.id}/comandos?ok=${original ? 'cmd_salvo' : 'cmd_criado'}`, 303)
  })

  app.post<{ Params: { id: string; nome: string } }>('/grupos-bot/:id/comandos/personalizado/:nome/excluir', async (req, rep) => {
    const bot = acharBot(req.params.id)
    if (!bot) return naoAchou(rep)
    const ok = d.repo.transacao(() => {
      if (!b.excluirPersonalizado(bot.id, req.params.nome)) return false
      d.repo.auditar(a.usuario(req), 'excluir_comando', `${bot.nome}: /${req.params.nome}`, a.agora())
      return true
    })
    if (!ok) return rep.code(404).send('Comando não encontrado')
    return rep.redirect(`/grupos-bot/${bot.id}/comandos?ok=cmd_excluido`, 303)
  })
}
