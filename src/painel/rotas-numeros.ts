import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import QRCode from 'qrcode'
import { PAPEIS, type Papel } from '../db/numeros.js'
import { paginaNumero, paginaNumeros } from './paginas-numeros.js'
import type { DependenciasPainel } from './servidor.js'

/** Ferramentas que o servidor passa para os arquivos de rotas. */
export interface Ajudantes {
  html: (rep: FastifyReply, corpo: string) => FastifyReply
  usuario: (req: FastifyRequest) => string
  agora: () => number
}

export function rotasNumeros(app: FastifyInstance, d: DependenciasPainel, a: Ajudantes): void {
  const lista = () => d.numeros.listar().map((numero) => ({ numero, estado: numero.ativo ? d.conexoes.estado(numero.id) : null }))
  const achar = (id: string) => (/^\d+$/.test(id) ? d.numeros.numero(Number(id)) : null)

  // Endereço antigo, de quando havia um número só.
  app.get('/conexao', async (_req, rep) => rep.redirect('/numeros', 303))

  app.get('/numeros', async (req, rep) => a.html(rep, paginaNumeros(lista(), a.usuario(req))))

  app.post<{ Body: { nome?: string; papel?: string } }>('/numeros', async (req, rep) => {
    const nome = (req.body?.nome ?? '').trim().replace(/\s+/g, ' ')
    const papel = req.body?.papel as Papel
    if (!nome || nome.length > 40 || !PAPEIS.includes(papel)) {
      return a.html(rep.code(400), paginaNumeros(lista(), a.usuario(req), 'Informe um nome (até 40 caracteres) e o uso do número.'))
    }
    const n = d.repo.transacao(() => {
      const criado = d.numeros.criar(nome, papel, a.agora())
      d.repo.auditar(a.usuario(req), 'criar_numero', `${criado.id} ${nome} (${papel})`, a.agora())
      return criado
    })
    try {
      await d.conexoes.ativar(n)
    } catch (err) {
      req.log.error({ err, numero: n.id }, 'falha ao ativar número novo')
      return rep.redirect(`/numeros/${n.id}?erro=1`, 303)
    }
    return rep.redirect(`/numeros/${n.id}`, 303)
  })

  app.get<{ Params: { id: string }; Querystring: { erro?: string } }>('/numeros/:id', async (req, rep) => {
    const n = achar(req.params.id)
    if (!n) return rep.code(404).send('Número não encontrado')
    const e = n.ativo ? d.conexoes.estado(n.id) : null
    const qr = e?.qr ? await QRCode.toDataURL(e.qr, { margin: 1, width: 280 }) : null
    return a.html(rep, paginaNumero(n, e, qr, a.usuario(req), req.query.erro === '1'))
  })

  app.post<{ Params: { id: string } }>('/numeros/:id/nova-sessao', async (req, rep) => {
    const n = achar(req.params.id)
    if (!n) return rep.code(404).send('Número não encontrado')
    if (!n.ativo) return rep.code(409).send('Ative o número antes de gerar um QR.')
    // Audita só depois de confirmar sucesso; se falhar, a auditoria registra a falha em vez da ação.
    try {
      await d.conexoes.novaSessao(n.id)
    } catch (err) {
      req.log.error({ err, numero: n.id }, 'falha ao gerar nova sessão')
      d.repo.auditar(a.usuario(req), 'nova_sessao_falhou', `${n.id} ${n.nome}`, a.agora())
      return rep.redirect(`/numeros/${n.id}?erro=1`, 303)
    }
    d.repo.auditar(a.usuario(req), 'nova_sessao', `${n.id} ${n.nome}`, a.agora())
    return rep.redirect(`/numeros/${n.id}`, 303)
  })

  app.post<{ Params: { id: string } }>('/numeros/:id/ativar', async (req, rep) => {
    const n = achar(req.params.id)
    if (!n) return rep.code(404).send('Número não encontrado')
    if (n.ativo) return rep.redirect(`/numeros/${n.id}`, 303) // já está ativo: nada a fazer
    d.repo.transacao(() => {
      d.numeros.definirAtivo(n.id, true)
      d.repo.auditar(a.usuario(req), 'ativar_numero', `${n.id} ${n.nome}`, a.agora())
    })
    try {
      await d.conexoes.ativar({ ...n, ativo: true })
    } catch (err) {
      // O banco já marcou o número como ativo; não desfazemos isso, só avisamos.
      req.log.error({ err, numero: n.id }, 'falha ao ativar número')
      return rep.redirect(`/numeros/${n.id}?erro=1`, 303)
    }
    return rep.redirect(`/numeros/${n.id}`, 303)
  })

  app.post<{ Params: { id: string } }>('/numeros/:id/desativar', async (req, rep) => {
    const n = achar(req.params.id)
    if (!n) return rep.code(404).send('Número não encontrado')
    if (!n.ativo) return rep.redirect(`/numeros/${n.id}`, 303) // já está desativado: nada a fazer
    d.repo.transacao(() => {
      d.numeros.definirAtivo(n.id, false)
      d.repo.auditar(a.usuario(req), 'desativar_numero', `${n.id} ${n.nome}`, a.agora())
    })
    try {
      await d.conexoes.desativar(n.id)
    } catch (err) {
      // O banco já marcou o número como desativado; não desfazemos isso, só avisamos.
      req.log.error({ err, numero: n.id }, 'falha ao desativar número')
      return rep.redirect(`/numeros/${n.id}?erro=1`, 303)
    }
    return rep.redirect(`/numeros/${n.id}`, 303)
  })
}
