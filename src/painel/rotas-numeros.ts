import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import QRCode from 'qrcode'
import { PAPEIS, type Numero, type Papel } from '../db/numeros.js'
import { paginaNovoNumero, paginaNumero, paginaNumeros, rotuloSituacao, type BotDoNumero } from './paginas-numeros.js'
import type { DependenciasPainel } from './servidor.js'

/** Ferramentas que o servidor passa para os arquivos de rotas. */
export interface Ajudantes {
  html: (rep: FastifyReply, corpo: string) => FastifyReply
  usuario: (req: FastifyRequest) => string
  agora: () => number
}

/** QR sem ninguém olhando a tela do número por mais que isto: a conexão é encerrada. */
export const QR_SEM_TELA_MS = 30_000

const OK: Record<string, string> = {
  pausado: 'Número pausado.',
  retomado: 'Número de volta ao trabalho.',
  revogado: 'Número revogado. Conecte o novo pelo QR.',
  renomeado: 'Nome salvo.',
  criado: 'Número criado.'
}

export function rotasNumeros(app: FastifyInstance, d: DependenciasPainel, a: Ajudantes): void {
  const achar = (id: string) => (/^\d+$/.test(id) ? d.numeros.numero(Number(id)) : null)
  /** Última vez que a tela de cada número consultou o estado. */
  const olhando = new Map<number, number>()
  /** Números com sessão nova sendo criada agora (evita pedir duas vezes). */
  const gerando = new Set<number>()

  const botsDoNumero = (n: Numero): BotDoNumero[] =>
    n.papel === 'grupos'
      ? d.botsGrupos
          .bots()
          .filter((b) => b.numeroId === n.id)
          .map((b) => ({ nome: b.nome, href: `/grupos-bot/${b.id}` }))
      : d.bots
          .get()
          .processos.filter((p) => p.numeroId === n.id)
          .map((p) => ({ nome: p.vaga, href: `/bots/${encodeURIComponent(p.codigo)}` }))

  const estado = (n: Numero) => (n.ativo ? d.conexoes.estado(n.id) : null)

  /** Liga a conexão (para mostrar o QR) quando a tela do número está aberta e ele não está conectado. */
  const garantirQr = async (n: Numero): Promise<void> => {
    if (gerando.has(n.id)) return
    gerando.add(n.id)
    try {
      if (!n.ativo) {
        d.numeros.definirAtivo(n.id, true)
        await d.conexoes.ativar({ ...n, ativo: true })
      } else if (d.conexoes.estado(n.id)?.status === 'desconectado') {
        await d.conexoes.novaSessao(n.id)
      }
    } catch (err) {
      d.log.error({ err, numero: n.id }, 'falha ao preparar o QR do número')
    } finally {
      gerando.delete(n.id)
    }
  }

  // Ninguém olhando a tela e o número esperando QR: encerra (só volta quando a tela abrir de novo).
  const vigia = setInterval(() => {
    const agora = a.agora()
    for (const n of d.numeros.listar()) {
      const e = n.ativo ? d.conexoes.estado(n.id) : null
      if (e?.status !== 'aguardando_qr') continue
      const visto = Math.max(olhando.get(n.id) ?? 0, e.desde)
      if (agora - visto < QR_SEM_TELA_MS) continue
      d.numeros.definirAtivo(n.id, false)
      olhando.delete(n.id)
      void d.conexoes.desativar(n.id).catch((err) => d.log.error({ err, numero: n.id }, 'falha ao encerrar o QR'))
    }
  }, 10_000)
  vigia.unref()
  app.addHook('onClose', async () => clearInterval(vigia))

  const lista = () => d.numeros.listar().map((numero) => ({ numero, estado: estado(numero), bots: botsDoNumero(numero) }))

  // Endereço antigo, de quando havia um número só.
  app.get('/conexao', async (_req, rep) => rep.redirect('/numeros', 303))

  app.get<{ Querystring: { ok?: string } }>('/numeros', async (req, rep) => {
    const ok = req.query.ok && Object.hasOwn(OK, req.query.ok) ? OK[req.query.ok]! : null
    return a.html(rep, paginaNumeros(lista(), a.usuario(req), ok))
  })

  app.get('/numeros/novo', async (req, rep) => a.html(rep, paginaNovoNumero(a.usuario(req), null)))

  app.post<{ Body: { nome?: string; papel?: string } }>('/numeros', async (req, rep) => {
    const nome = (req.body?.nome ?? '').trim().replace(/\s+/g, ' ')
    const papel = req.body?.papel as Papel
    if (!nome || nome.length > 40 || !PAPEIS.includes(papel)) {
      return a.html(rep.code(400), paginaNovoNumero(a.usuario(req), 'Informe um nome (até 40 caracteres) e o uso do número.', nome))
    }
    const n = d.repo.transacao(() => {
      const criado = d.numeros.criar(nome, papel, a.agora())
      // Só conecta quando a tela dele abrir (é lá que o QR aparece).
      d.numeros.definirAtivo(criado.id, false)
      d.repo.auditar(a.usuario(req), 'criar_numero', `${criado.id} ${nome} (${papel})`, a.agora())
      return criado
    })
    return rep.redirect(`/numeros/${n.id}`, 303)
  })

  app.get<{ Params: { id: string }; Querystring: { ok?: string; erro?: string } }>('/numeros/:id', async (req, rep) => {
    const n = achar(req.params.id)
    if (!n) return rep.code(404).send('Número não encontrado')
    olhando.set(n.id, a.agora())
    const ok = req.query.ok && Object.hasOwn(OK, req.query.ok) ? OK[req.query.ok]! : null
    const erro = req.query.erro ? 'Não foi possível falar com o WhatsApp agora. Tente de novo em instantes.' : null
    return a.html(rep, paginaNumero(n, estado(n), botsDoNumero(n), a.usuario(req), ok, erro))
  })

  /** Consultado pela tela do número a cada poucos segundos: mantém o QR vivo enquanto ela está aberta. */
  app.get<{ Params: { id: string } }>('/numeros/:id/estado', async (req, rep) => {
    let n = achar(req.params.id)
    if (!n) return rep.code(404).send({ erro: 'número não encontrado' })
    olhando.set(n.id, a.agora())
    if (!n.ativo || d.conexoes.estado(n.id)?.status === 'desconectado') {
      await garantirQr(n)
      n = d.numeros.numero(n.id)!
    }
    const e = estado(n)
    const qr = e?.qr ? await QRCode.toDataURL(e.qr, { margin: 1, width: 280 }) : null
    return rep.send({ status: e?.status ?? 'desligado', situacao: rotuloSituacao(n, e), qr })
  })

  const acao = (caminho: string, fazer: (n: Numero, usuario: string) => Promise<string>) =>
    app.post<{ Params: { id: string } }>(`/numeros/:id/${caminho}`, async (req, rep) => {
      const n = achar(req.params.id)
      if (!n) return rep.code(404).send('Número não encontrado')
      try {
        return rep.redirect(`/numeros/${n.id}?ok=${await fazer(n, a.usuario(req))}`, 303)
      } catch (err) {
        d.log.error({ err, numero: n.id }, `falha ao ${caminho} o número`)
        return rep.redirect(`/numeros/${n.id}?erro=1`, 303)
      }
    })

  acao('pausar', async (n, usuario) => {
    d.repo.transacao(() => {
      d.numeros.definirPausado(n.id, true)
      d.repo.auditar(usuario, 'pausar_numero', `${n.id} ${n.nome}`, a.agora())
    })
    return 'pausado'
  })

  acao('retomar', async (n, usuario) => {
    d.repo.transacao(() => {
      d.numeros.definirPausado(n.id, false)
      d.repo.auditar(usuario, 'retomar_numero', `${n.id} ${n.nome}`, a.agora())
    })
    return 'retomado'
  })

  /** Tira o WhatsApp conectado e começa uma sessão nova (o QR aparece na tela do número). */
  acao('revogar', async (n, usuario) => {
    d.repo.transacao(() => {
      d.numeros.definirPausado(n.id, false)
      d.repo.auditar(usuario, 'revogar_numero', `${n.id} ${n.nome}`, a.agora())
    })
    olhando.set(n.id, a.agora())
    if (n.ativo) await d.conexoes.revogar(n.id)
    else await garantirQr(n)
    return 'revogado'
  })

  app.post<{ Params: { id: string }; Body: { nome?: string } }>('/numeros/:id/renomear', async (req, rep) => {
    const n = achar(req.params.id)
    if (!n) return rep.code(404).send('Número não encontrado')
    const nome = (req.body?.nome ?? '').trim().replace(/\s+/g, ' ')
    if (!nome || nome.length > 40) return rep.redirect(`/numeros/${n.id}`, 303)
    d.repo.transacao(() => {
      d.numeros.renomear(n.id, nome)
      d.repo.auditar(a.usuario(req), 'renomear_numero', `${n.id} ${n.nome} → ${nome}`, a.agora())
    })
    return rep.redirect(`/numeros/${n.id}?ok=renomeado`, 303)
  })
}
