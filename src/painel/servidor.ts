import { createReadStream } from 'node:fs'
import cookie from '@fastify/cookie'
import formbody from '@fastify/formbody'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import type { ArmazemArquivos } from '../arquivos.js'
import { botModelo, paraEditor, prepararBot, type FonteBots } from '../config/bots.js'
import type { StatusProcesso } from '../config/tipos.js'
import type { RepoGrupos } from '../db/grupos.js'
import type { Numero, RepoNumeros } from '../db/numeros.js'
import type { Repositorio } from '../db/repositorio.js'
import type { EstadoConexao } from '../whatsapp/baileys.js'
import { LimiteLogin, senhaConfere } from './auth.js'
import { paginaEditorBot } from './editor.js'
import { gerarZip } from './exportar.js'
import { paginaAuditoria, paginaLogin, paginaProcesso, paginaProcessos, paginaSaude } from './paginas.js'
import { rotasEquipe } from './rotas-equipe.js'
import { rotasNumeros } from './rotas-numeros.js'

/** O que o painel controla nas conexões (o GerenciadorConexoes, em produção). */
export interface ControleConexoes {
  estado(numeroId: number): EstadoConexao | null
  novaSessao(numeroId: number): Promise<void>
  ativar(numero: Numero): Promise<void>
  desativar(numeroId: number): Promise<void>
}

export interface DependenciasPainel {
  repo: Repositorio
  bots: FonteBots
  numeros: RepoNumeros
  grupos: RepoGrupos
  armazem: ArmazemArquivos
  conexoes: ControleConexoes
  usuarios: Map<string, string>
  segredo: string
  cookieSeguro: boolean
  backupAtivo: boolean
  alertaAtivo: boolean
  relogio?: () => number
}

const COOKIE = 'sessao'
const DURACAO_SESSAO_MS = 12 * 60 * 60 * 1000

declare module 'fastify' {
  interface FastifyRequest {
    usuario: string | null
  }
}

export async function criarPainel(d: DependenciasPainel): Promise<FastifyInstance> {
  const agora = d.relogio ?? Date.now
  const limite = new LimiteLogin()
  // trustProxy: o IP real vem do Caddy, para o bloqueio de senha errada funcionar por pessoa.
  const app = Fastify({ logger: false, trustProxy: true })
  await app.register(cookie, { secret: d.segredo })
  await app.register(formbody)
  app.decorateRequest('usuario', null)

  app.addHook('onRequest', async (req, rep) => {
    rep.header('X-Frame-Options', 'DENY')
    rep.header('X-Content-Type-Options', 'nosniff')
    rep.header('Referrer-Policy', 'no-referrer')
    rep.header('Cache-Control', 'no-store')
    const bruto = req.cookies[COOKIE]
    if (bruto) {
      const v = req.unsignCookie(bruto)
      if (v.valid && v.value) {
        const [usuario, expira] = v.value.split('|')
        if (usuario && d.usuarios.has(usuario) && Number(expira) > agora()) req.usuario = usuario
      }
    }
    const publica = req.url === '/login' || req.url === '/healthz'
    if (!publica && !req.usuario) return rep.redirect('/login', 303)
  })

  const html = (rep: FastifyReply, corpo: string) => rep.type('text/html; charset=utf-8').send(corpo)
  const usuario = (req: FastifyRequest) => req.usuario!

  /** Para o Uptime Kuma: ok só com todos os números ativos conectados, sem nenhum dado. */
  app.get('/healthz', async (_req, rep) => {
    const ativos = d.numeros.listar().filter((n) => n.ativo)
    const ok = ativos.length > 0 && ativos.every((n) => d.conexoes.estado(n.id)?.status === 'conectado')
    return rep.code(ok ? 200 : 503).send({ ok })
  })

  app.get('/login', async (req, rep) => (req.usuario ? rep.redirect('/', 303) : html(rep, paginaLogin(null))))

  app.post<{ Body: { usuario?: string; senha?: string } }>('/login', async (req, rep) => {
    if (limite.bloqueado(req.ip, agora())) {
      return html(rep.code(429), paginaLogin('Muitas tentativas. Espere 15 minutos.'))
    }
    const nome = (req.body?.usuario ?? '').trim()
    const hash = d.usuarios.get(nome)
    if (!hash || !senhaConfere(req.body?.senha ?? '', hash)) {
      limite.falhou(req.ip, agora())
      d.repo.auditar(nome || '?', 'login_falhou', req.ip, agora())
      return html(rep.code(401), paginaLogin('Usuário ou senha incorretos.'))
    }
    limite.acertou(req.ip)
    d.repo.auditar(nome, 'login', req.ip, agora())
    rep.setCookie(COOKIE, `${nome}|${agora() + DURACAO_SESSAO_MS}`, {
      signed: true,
      httpOnly: true,
      secure: d.cookieSeguro,
      sameSite: 'strict',
      path: '/',
      maxAge: DURACAO_SESSAO_MS / 1000
    })
    return rep.redirect('/', 303)
  })

  app.post('/sair', async (_req, rep) => {
    rep.clearCookie(COOKIE, { path: '/' })
    return rep.redirect('/login', 303)
  })

  // Só números ativos entram na lista; o número atual do bot (editando) continua oferecido mesmo desativado.
  const numerosRecrutamento = (incluirId: number | null = null) => {
    const todos = d.numeros.listar().filter((n) => n.papel === 'recrutamento')
    const ativos = todos.filter((n) => n.ativo)
    if (incluirId === null || ativos.some((n) => n.id === incluirId)) return ativos
    const atual = todos.find((n) => n.id === incluirId)
    return atual ? [...ativos, atual] : ativos
  }

  app.get<{ Querystring: { salvo?: string; excluido?: string } }>('/', async (req, rep) => {
    const aviso = req.query.salvo ? `Bot ${req.query.salvo} salvo.` : req.query.excluido ? `Bot ${req.query.excluido} excluído.` : null
    const numeros = numerosRecrutamento().map((n) => ({ id: n.id, nome: n.nome, telefone: d.conexoes.estado(n.id)?.numero ?? null }))
    return html(rep, paginaProcessos(d.bots.get(), d.repo.resumoPorProcesso(), numeros, usuario(req), agora(), aviso))
  })

  // --- bots ---------------------------------------------------------------------------

  const hoje = () => new Date(agora() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const editor = (
    rep: FastifyReply,
    req: FastifyRequest,
    o: Omit<Parameters<typeof paginaEditorBot>[0], 'padrao' | 'usuario' | 'numeros'>
  ) =>
    html(
      rep,
      paginaEditorBot({
        ...o,
        padrao: d.bots.padrao,
        usuario: usuario(req),
        numeros: numerosRecrutamento(o.original !== null ? o.dados.numero_id : null).map(({ id, nome }) => ({ id, nome }))
      })
    )

  app.get<{ Querystring: { de?: string } }>('/bots/novo', async (req, rep) => {
    const origem = req.query.de ? d.repo.bot(req.query.de.toUpperCase()) : null
    const dados = origem
      ? { ...paraEditor(JSON.parse(origem), d.bots.padrao), codigo: '', status: 'rascunho' as const, abre_em: hoje(), encerra_em: hoje() }
      : botModelo(hoje())
    return editor(rep, req, { dados, original: null, candidaturas: 0, erro: null })
  })

  app.get<{ Params: { codigo: string } }>('/bots/:codigo', async (req, rep) => {
    const codigo = req.params.codigo.toUpperCase()
    const bruto = d.repo.bot(codigo)
    if (!bruto) return rep.code(404).send('Bot não encontrado')
    const dados = paraEditor(JSON.parse(bruto), d.bots.padrao)
    return editor(rep, req, { dados, original: codigo, candidaturas: d.repo.contarCandidaturas(codigo), erro: null })
  })

  app.post<{ Body: { dados?: string; original?: string; acao?: string } }>('/bots/salvar', async (req, rep) => {
    const original = req.body?.original?.trim().toUpperCase() || null
    const status: StatusProcesso = req.body?.acao === 'aberto' || req.body?.acao === 'encerrado' ? req.body.acao : 'rascunho'
    let entrada: unknown = null
    try {
      entrada = JSON.parse(req.body?.dados ?? '')
    } catch {
      return rep.code(400).send('Formulário inválido')
    }
    try {
      const numeroAtual = original ? d.repo.numeroDoBot(original) : null
      const { dados } = prepararBot(entrada, d.bots.padrao, status, numerosRecrutamento(numeroAtual).map((n) => n.id))
      if (original && dados.codigo !== original) throw new Error('o código de um bot existente não pode mudar')
      if (original && !d.repo.bot(original)) throw new Error('bot não encontrado')
      if (!original && (d.repo.bot(dados.codigo) || d.repo.contarCandidaturas(dados.codigo) > 0)) {
        throw new Error(`o código ${dados.codigo} já foi usado; escolha outro`)
      }
      if (original && numeroAtual !== null && numeroAtual !== dados.numero_id && d.repo.contarCandidaturas(original) > 0) {
        throw new Error('o número de um bot com candidaturas não pode mudar')
      }
      d.repo.transacao(() => {
        d.repo.salvarBot(dados.codigo, JSON.stringify(dados), dados.numero_id, usuario(req), agora())
        d.repo.auditar(usuario(req), original ? 'editar_bot' : 'criar_bot', `${dados.codigo} (${status})`, agora())
      })
      d.bots.invalidar()
      return rep.redirect(`/?salvo=${encodeURIComponent(dados.codigo)}`, 303)
    } catch (e) {
      const dados = { ...paraEditor(entrada, d.bots.padrao), status: original ? status : ('rascunho' as const) }
      if (original) dados.codigo = original
      const candidaturas = original ? d.repo.contarCandidaturas(original) : 0
      return editor(rep.code(400), req, { dados, original, candidaturas, erro: (e as Error).message })
    }
  })

  app.post<{ Params: { codigo: string } }>('/bots/:codigo/excluir', async (req, rep) => {
    const codigo = req.params.codigo.toUpperCase()
    if (!d.repo.bot(codigo)) return rep.code(404).send('Bot não encontrado')
    if (d.repo.contarCandidaturas(codigo) > 0) return rep.code(409).send('Este bot tem candidaturas. Encerre as inscrições em vez de excluir.')
    d.repo.transacao(() => {
      d.repo.excluirBot(codigo)
      d.repo.auditar(usuario(req), 'excluir_bot', codigo, agora())
    })
    d.bots.invalidar()
    return rep.redirect(`/?excluido=${encodeURIComponent(codigo)}`, 303)
  })

  app.get<{ Params: { codigo: string } }>('/processos/:codigo', async (req, rep) => {
    const codigo = req.params.codigo.toUpperCase()
    const p = d.bots.get().processos.find((x) => x.codigo === codigo)
    const candidatos = d.repo.candidatosDoProcesso(codigo)
    if (!p && candidatos.length === 0) return rep.code(404).send('Processo não encontrado')
    d.repo.auditar(usuario(req), 'ver_candidatos', codigo, agora())
    return html(rep, paginaProcesso(codigo, p, candidatos, usuario(req)))
  })

  app.get<{ Params: { codigo: string } }>('/processos/:codigo/exportar', async (req, rep) => {
    const codigo = req.params.codigo.toUpperCase()
    const p = d.bots.get().processos.find((x) => x.codigo === codigo)
    const candidatos = d.repo.candidatosDoProcesso(codigo)
    if (!p && candidatos.length === 0) return rep.code(404).send('Processo não encontrado')
    d.repo.auditar(usuario(req), 'exportar', `${codigo}: ${candidatos.length} candidaturas`, agora())
    const dia = new Date(agora()).toISOString().slice(0, 10)
    return rep
      .type('application/zip')
      .header('Content-Disposition', `attachment; filename="${codigo}-${dia}.zip"`)
      .send(gerarZip(p, candidatos, d.armazem))
  })

  app.get<{ Params: { id: string } }>('/arquivos/:id', async (req, rep) => {
    const a = d.repo.arquivo(Number(req.params.id))
    if (!a) return rep.code(404).send('Arquivo não encontrado')
    d.repo.auditar(usuario(req), 'download', `${a.protocolo} arquivo ${a.id}`, agora())
    return rep
      .type(a.mimetype)
      .header('Content-Disposition', `attachment; filename="${a.protocolo}-${a.id}.${a.ext}"`)
      .send(createReadStream(d.armazem.absoluto(a.caminho)))
  })

  app.post<{ Params: { id: string } }>('/candidaturas/:id/excluir', async (req, rep) => {
    const id = Number(req.params.id)
    const c = d.repo.candidatura(id)
    if (!c) return rep.code(404).send('Candidatura não encontrada')
    const caminhos = d.repo.transacao(() => {
      d.repo.auditar(usuario(req), 'excluir', c.protocolo, agora())
      return d.repo.excluirCandidatura(id)
    })
    for (const caminho of caminhos) await d.armazem.apagar(caminho)
    return rep.redirect(`/processos/${encodeURIComponent(c.processo)}`, 303)
  })

  app.get('/saude', async (req, rep) => {
    const ultimas = d.repo.ultimaRecebidaPorNumero()
    const numeros = d.numeros.listar().map((numero) => ({
      numero,
      estado: numero.ativo ? d.conexoes.estado(numero.id) : null,
      ultimaMensagem: ultimas.get(numero.id) ?? null
    }))
    return html(
      rep,
      paginaSaude(
        {
          numeros,
          filas: d.repo.filas(),
          ultimoBackup: d.repo.meta('ultimo_backup'),
          backupAtivo: d.backupAtivo,
          alertaAtivo: d.alertaAtivo,
          config: d.bots.get()
        },
        usuario(req)
      )
    )
  })

  app.get('/auditoria', async (req, rep) => html(rep, paginaAuditoria(d.repo.auditoriaRecente(200), usuario(req))))

  rotasNumeros(app, d, { html, usuario, agora })
  rotasEquipe(app, d, { html, usuario, agora })

  return app
}
