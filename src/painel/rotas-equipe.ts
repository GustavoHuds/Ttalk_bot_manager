import type { FastifyInstance } from 'fastify'
import { semAcento } from '../conversa/textos.js'
import type { DadosFuncionario, Funcionario } from '../db/grupos.js'
import { ErroEquipe, lerCsvEquipe, validarFuncionario, type LinhaCsv } from '../grupos/equipe.js'
import { formatarTelefone } from '../grupos/pessoas.js'
import { gerarCsvEquipe } from './exportar.js'
import {
  FILTROS_SITUACAO,
  paginaEquipe,
  paginaFuncionario,
  paginaImportar,
  situacaoWhatsApp,
  type FiltroSituacao,
  type FormFuncionario,
  type GestorDaPessoa,
  type LinhaEquipe,
  type LinhaPrevia,
  type PerfilPessoa
} from './paginas-equipe.js'
import { mensagemOk } from './rotas-bot-grupos.js'
import type { Ajudantes } from './rotas-numeros.js'
import type { DependenciasPainel } from './servidor.js'

interface CorpoFuncionario {
  id?: string
  nome?: string
  telefone?: string
  setor?: string
  loja?: string
  cargo?: string
  nascimento?: string
  ativo?: string
}

export function rotasEquipe(app: FastifyInstance, d: DependenciasPainel, a: Ajudantes): void {
  const g = d.grupos
  const b = d.botsGrupos
  const porId = (id: string) => (/^\d+$/.test(id) ? g.funcionario(Number(id)) : null)

  /** Gestor em cada bot, por pessoa. */
  const gestoresPorPessoa = (): Map<number, GestorDaPessoa[]> => {
    const mapa = new Map<number, GestorDaPessoa[]>()
    for (const bot of b.bots()) {
      for (const x of b.gestores(bot.id)) {
        const situacao = x.confirmadoEm ? 'confirmado' : x.divergenteEm ? 'divergente' : 'pendente'
        mapa.set(x.funcionarioId, [...(mapa.get(x.funcionarioId) ?? []), { botId: bot.id, bot: bot.nome, situacao }])
      }
    }
    return mapa
  }

  const filtro = (v: string | undefined): FiltroSituacao => (v && Object.hasOwn(FILTROS_SITUACAO, v) ? (v as FiltroSituacao) : '')

  app.get<{ Querystring: { q?: string; loja?: string; situacao?: string; salvo?: string; excluido?: string; importados?: string } }>(
    '/equipe',
    async (req, rep) => {
      const q = (req.query.q ?? '').trim()
      const loja = (req.query.loja ?? '').trim()
      const situacao = filtro(req.query.situacao)
      const termo = semAcento(q)
      const digitos = q.replace(/\D/g, '')
      const gestores = gestoresPorPessoa()
      const todas: LinhaEquipe[] = g
        .funcionarios()
        .map((f) => ({ f, gestor: gestores.get(f.id) ?? [], grupos: b.gruposDaPessoa(f.telefone, f.lid).length }))
      const passa = ({ f, gestor, grupos }: LinhaEquipe): boolean => {
        if (situacao === 'inativos' ? f.ativo : !f.ativo) return false
        const s = situacaoWhatsApp(f, grupos)
        if (situacao === 'confirmados' && s !== 'confirmado') return false
        if (situacao === 'nao_confirmados' && s === 'confirmado') return false
        if (situacao === 'nunca_vistos' && s !== 'nunca') return false
        if (situacao === 'gestores' && !gestor.some((x) => x.situacao === 'confirmado')) return false
        if (situacao === 'pendentes' && !gestor.some((x) => x.situacao !== 'confirmado')) return false
        if (loja && semAcento(f.loja ?? '') !== semAcento(loja)) return false
        if (!q) return true
        return (
          semAcento([f.nome, f.setor, f.loja, f.cargo].filter(Boolean).join(' ')).includes(termo) ||
          (digitos.length >= 4 && (f.telefone ?? '').includes(digitos))
        )
      }
      const ativas = todas.filter((x) => x.f.ativo)
      const msg = req.query.salvo
        ? 'Cadastro salvo.'
        : req.query.excluido
          ? 'Pessoa excluída do cadastro.'
          : req.query.importados
            ? `${Number(req.query.importados)} pessoa(s) importada(s).`
            : null
      const lojas = [...new Map(todas.flatMap(({ f }) => (f.loja ? [[semAcento(f.loja), f.loja] as const] : []))).values()].sort((x, y) =>
        x.localeCompare(y, 'pt-BR')
      )
      return a.html(
        rep,
        paginaEquipe(
          {
            linhas: todas.filter(passa),
            q,
            loja,
            situacao,
            lojas,
            contagem: {
              ativos: ativas.length,
              confirmados: ativas.filter((x) => x.f.confirmadoEm).length,
              nuncaVistos: ativas.filter((x) => situacaoWhatsApp(x.f, x.grupos) === 'nunca').length,
              gestores: ativas.filter((x) => x.gestor.some((y) => y.situacao === 'confirmado')).length
            }
          },
          a.usuario(req),
          msg
        )
      )
    }
  )

  const vazio: FormFuncionario = { id: null, nome: '', telefone: '', setor: '', loja: '', cargo: '', nascimento: '', ativo: true, lid: null }

  app.get('/equipe/novo', async (req, rep) => a.html(rep, paginaFuncionario(vazio, a.usuario(req), null, b.nomesDeLojas())))

  app.get('/equipe/importar', async (req, rep) => a.html(rep, paginaImportar(a.usuario(req), '', null, null)))

  app.get('/equipe/exportar', async (req, rep) => {
    const lista = g.funcionarios()
    d.repo.auditar(a.usuario(req), 'exportar_equipe', `${lista.length} pessoas`, a.agora())
    const dia = new Date(a.agora()).toISOString().slice(0, 10)
    const gestores = new Set(b.bots().flatMap((bot) => b.gestoresConfirmados(bot.id)))
    return rep
      .type('text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="equipe-${dia}.csv"`)
      .send(gerarCsvEquipe(lista, gestores))
  })

  /** Formulário preenchido com o cadastro, e o telefone formatado. */
  const formDe = (f: Funcionario): FormFuncionario => ({
    id: f.id,
    nome: f.nome,
    // Formatado ("+55 83 …" ou "+<DDI>…"): a chave crua de um estrangeiro, sem o "+", voltaria como
    // brasileira ao salvar (telefoneDigitado) e ganharia um 55 inventado.
    telefone: f.telefone ? formatarTelefone(f.telefone) : '',
    setor: f.setor ?? '',
    loja: f.loja ?? '',
    cargo: f.cargo ?? '',
    nascimento: f.nascimento ?? '',
    ativo: f.ativo,
    lid: f.lid
  })

  const perfilDe = (f: Funcionario): PerfilPessoa => {
    const bots = b.bots()
    const nomeBot = new Map(bots.map((x) => [x.id, x]))
    const grupos = b.gruposDaPessoa(f.telefone, f.lid).map(({ botId, jid }) => {
      const bot = nomeBot.get(botId)
      const geral = bot?.numeroId ? g.grupo(bot.numeroId, jid) : null
      return { bot: bot?.nome ?? `#${botId}`, nome: geral?.nome ?? jid, loja: b.grupoAtivo(botId, jid)?.loja ?? null }
    })
    return {
      pessoa: f,
      grupos,
      gestores: bots.map((bot) => {
        const gestor = b.gestor(bot.id, f.id)
        return {
          bot,
          linha: gestor ? { gestor, pessoa: f } : null,
          telefoneBot: bot.numeroId ? (d.conexoes.estado(bot.numeroId)?.numero ?? null) : null
        }
      }),
      historico: d.repo.auditoriaDaPessoa(f.id, 30),
      agora: a.agora()
    }
  }

  app.get<{ Params: { id: string }; Querystring: { ok?: string; erro?: string } }>('/equipe/:id', async (req, rep) => {
    const f = porId(req.params.id)
    if (!f) return rep.code(404).send('Pessoa não encontrada')
    const erro = req.query.erro ? String(req.query.erro).slice(0, 200) : null
    return a.html(rep, paginaFuncionario(formDe(f), a.usuario(req), erro, b.nomesDeLojas(), perfilDe(f), mensagemOk(req.query.ok)))
  })

  app.post<{ Body: CorpoFuncionario }>('/equipe/salvar', async (req, rep) => {
    const corpo = req.body ?? {}
    const id = corpo.id && /^\d+$/.test(corpo.id) ? Number(corpo.id) : null
    const atual = id ? g.funcionario(id) : null
    if (id && !atual) return rep.code(404).send('Pessoa não encontrada')
    const form: FormFuncionario = {
      id,
      nome: corpo.nome ?? '',
      telefone: corpo.telefone ?? '',
      setor: corpo.setor ?? '',
      loja: corpo.loja ?? '',
      cargo: corpo.cargo ?? '',
      nascimento: corpo.nascimento ?? '',
      ativo: corpo.ativo === '1',
      lid: atual?.lid ?? null
    }
    try {
      // Sem telefone só fica quem o WhatsApp já identificou pelo LID.
      const dados = validarFuncionario(
        { nome: form.nome, telefone: form.telefone, setor: form.setor, loja: form.loja, cargo: form.cargo, nascimento: form.nascimento, ativo: form.ativo },
        { telefoneObrigatorio: !atual?.lid, lid: atual?.lid ?? null }
      )
      const dono = dados.telefone ? g.porTelefone(dados.telefone) : null
      if (dono && dono.id !== id) throw new ErroEquipe(`esse telefone já é de ${dono.nome}`)
      d.repo.transacao(() => {
        const salvo = g.salvarFuncionario(id, dados, a.agora())
        if (atual?.confirmadoEm && atual.telefone !== dados.telefone) g.desconfirmarFuncionario(salvo, a.agora())
        d.repo.auditar(a.usuario(req), id ? 'editar_funcionario' : 'criar_funcionario', `${salvo} ${dados.nome}`, a.agora(), salvo)
      })
      return rep.redirect('/equipe?salvo=1', 303)
    } catch (e) {
      if (!(e instanceof ErroEquipe)) throw e
      return a.html(rep.code(400), paginaFuncionario(form, a.usuario(req), e.message, b.nomesDeLojas(), atual ? perfilDe(atual) : null))
    }
  })

  app.post<{ Params: { id: string } }>('/equipe/:id/excluir', async (req, rep) => {
    const f = porId(req.params.id)
    if (!f) return rep.code(404).send('Pessoa não encontrada')
    d.repo.transacao(() => {
      g.excluirFuncionario(f.id)
      // Só o id neste registro: o nome não é repetido na exclusão. Registros anteriores da mesma pessoa
      // (criar, editar, gestor) continuam com o nome: a auditoria não é apagada nem reescrita.
      d.repo.auditar(a.usuario(req), 'excluir_funcionario', `#${f.id}`, a.agora(), f.id)
    })
    return rep.redirect('/equipe?excluido=1', 303)
  })

  app.post<{ Body: { csv?: string; confirmar?: string } }>('/equipe/importar', async (req, rep) => {
    const csv = req.body?.csv ?? ''
    let linhas: LinhaCsv[]
    try {
      linhas = lerCsvEquipe(csv)
    } catch (e) {
      if (!(e instanceof ErroEquipe)) throw e
      return a.html(rep.code(400), paginaImportar(a.usuario(req), csv, null, e.message))
    }
    if (req.body?.confirmar !== '1') {
      const previa: LinhaPrevia[] = linhas.map((l) => ({
        ...l,
        situacao: !l.dados ? 'erro' : g.porTelefone(l.dados.telefone!) ? 'atualiza' : 'novo'
      }))
      return a.html(rep, paginaImportar(a.usuario(req), csv, previa, linhas.length ? null : 'Nenhuma linha encontrada.'))
    }
    const validas = linhas.filter((l): l is LinhaCsv & { dados: DadosFuncionario } => !!l.dados)
    d.repo.transacao(() => {
      for (const { dados } of validas) {
        const atual = g.porTelefone(dados.telefone!)
        // LID e situação vêm do que já existe: a planilha não sabe deles. Célula vazia (setor, loja,
        // cargo, nascimento) não apaga o que já estava lá: só confirma quando a planilha traz algo.
        const mesclado: DadosFuncionario = {
          ...dados,
          setor: dados.setor ?? atual?.setor ?? null,
          loja: dados.loja ?? atual?.loja ?? null,
          cargo: dados.cargo ?? atual?.cargo ?? null,
          nascimento: dados.nascimento ?? atual?.nascimento ?? null,
          lid: atual?.lid ?? null,
          ativo: atual?.ativo ?? true
        }
        g.salvarFuncionario(atual?.id ?? null, mesclado, a.agora())
      }
      d.repo.auditar(a.usuario(req), 'importar_equipe', `${validas.length} pessoas (${linhas.length - validas.length} linhas com erro)`, a.agora())
    })
    return rep.redirect(`/equipe?importados=${validas.length}`, 303)
  })
}
