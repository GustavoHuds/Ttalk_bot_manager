import type { FastifyInstance } from 'fastify'
import { semAcento } from '../conversa/textos.js'
import type { DadosFuncionario } from '../db/grupos.js'
import { ErroEquipe, lerCsvEquipe, validarFuncionario, type LinhaCsv } from '../grupos/equipe.js'
import { formatarTelefone } from '../grupos/pessoas.js'
import { gerarCsvEquipe } from './exportar.js'
import { paginaEquipe, paginaFuncionario, paginaGrupos, paginaImportar, type FormFuncionario, type LinhaPrevia } from './paginas-equipe.js'
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
  const porId = (id: string) => (/^\d+$/.test(id) ? g.funcionario(Number(id)) : null)

  app.get<{ Querystring: { salvo?: string } }>('/grupos', async (req, rep) => {
    const todos = g.todosGrupos()
    const blocos = d.numeros
      .listar()
      .filter((n) => n.papel === 'grupos')
      .map((numero) => ({ numero, grupos: todos.filter((x) => x.numeroId === numero.id) }))
    return a.html(rep, paginaGrupos(blocos, a.usuario(req), req.query.salvo ? 'Etiquetas salvas.' : null))
  })

  app.post<{ Body: { numero_id?: string; jid?: string; setor?: string; loja?: string } }>('/grupos/etiquetar', async (req, rep) => {
    const numeroId = Number(req.body?.numero_id)
    const jid = req.body?.jid ?? ''
    const limpar = (v?: string) => (v ?? '').trim().replace(/\s+/g, ' ').slice(0, 60) || null
    const setor = limpar(req.body?.setor)
    const loja = limpar(req.body?.loja)
    const ok = d.repo.transacao(() => {
      if (!g.etiquetarGrupo(numeroId, jid, setor, loja, a.agora())) return false
      d.repo.auditar(a.usuario(req), 'etiquetar_grupo', `${g.grupo(numeroId, jid)?.nome ?? jid}: ${setor ?? '—'} · ${loja ?? '—'}`, a.agora())
      return true
    })
    if (!ok) return rep.code(404).send('Grupo não encontrado')
    return rep.redirect('/grupos?salvo=1', 303)
  })

  app.get<{ Querystring: { q?: string; salvo?: string; excluido?: string; importados?: string } }>('/equipe', async (req, rep) => {
    const q = (req.query.q ?? '').trim()
    const termo = semAcento(q)
    const digitos = q.replace(/\D/g, '')
    const lista = g
      .funcionarios()
      .filter(
        (f) =>
          !q ||
          semAcento([f.nome, f.setor, f.loja, f.cargo].filter(Boolean).join(' ')).includes(termo) ||
          (digitos.length >= 4 && (f.telefone ?? '').includes(digitos))
      )
    const msg = req.query.salvo
      ? 'Cadastro salvo.'
      : req.query.excluido
        ? 'Pessoa excluída do cadastro.'
        : req.query.importados
          ? `${Number(req.query.importados)} pessoa(s) importada(s).`
          : null
    return a.html(rep, paginaEquipe(lista, new Set(g.gestores()), q, a.usuario(req), msg))
  })

  const vazio: FormFuncionario = { id: null, nome: '', telefone: '', setor: '', loja: '', cargo: '', nascimento: '', ativo: true, lid: null }

  app.get('/equipe/novo', async (req, rep) => a.html(rep, paginaFuncionario(vazio, a.usuario(req), null)))

  app.get('/equipe/importar', async (req, rep) => a.html(rep, paginaImportar(a.usuario(req), '', null, null)))

  app.get('/equipe/exportar', async (req, rep) => {
    const lista = g.funcionarios()
    d.repo.auditar(a.usuario(req), 'exportar_equipe', `${lista.length} pessoas`, a.agora())
    const dia = new Date(a.agora()).toISOString().slice(0, 10)
    return rep
      .type('text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="equipe-${dia}.csv"`)
      .send(gerarCsvEquipe(lista, new Set(g.gestores())))
  })

  app.get<{ Params: { id: string } }>('/equipe/:id', async (req, rep) => {
    const f = porId(req.params.id)
    if (!f) return rep.code(404).send('Pessoa não encontrada')
    const form: FormFuncionario = {
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
    }
    return a.html(rep, paginaFuncionario(form, a.usuario(req), null))
  })

  app.post<{ Body: CorpoFuncionario }>('/equipe/salvar', async (req, rep) => {
    const b = req.body ?? {}
    const id = b.id && /^\d+$/.test(b.id) ? Number(b.id) : null
    const atual = id ? g.funcionario(id) : null
    if (id && !atual) return rep.code(404).send('Pessoa não encontrada')
    const form: FormFuncionario = {
      id,
      nome: b.nome ?? '',
      telefone: b.telefone ?? '',
      setor: b.setor ?? '',
      loja: b.loja ?? '',
      cargo: b.cargo ?? '',
      nascimento: b.nascimento ?? '',
      ativo: b.ativo === '1',
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
        d.repo.auditar(a.usuario(req), id ? 'editar_funcionario' : 'criar_funcionario', `${salvo} ${dados.nome}`, a.agora())
      })
      return rep.redirect('/equipe?salvo=1', 303)
    } catch (e) {
      if (!(e instanceof ErroEquipe)) throw e
      return a.html(rep.code(400), paginaFuncionario(form, a.usuario(req), e.message))
    }
  })

  app.post<{ Params: { id: string }; Body: { ativo?: string } }>('/equipe/:id/gestor', async (req, rep) => {
    const f = porId(req.params.id)
    if (!f) return rep.code(404).send('Pessoa não encontrada')
    const ativo = req.body?.ativo === '1'
    if (ativo && !f.ativo) return rep.code(409).send('Cadastro inativo não pode ser gestor.')
    d.repo.transacao(() => {
      if (ativo) g.adicionarGestor(f.id, `painel:${a.usuario(req)}`, a.agora())
      else g.removerGestor(f.id)
      d.repo.auditar(a.usuario(req), ativo ? 'gestor_adicionado' : 'gestor_removido', `#${f.id} ${f.nome}`, a.agora())
    })
    return rep.redirect('/equipe', 303)
  })

  app.post<{ Params: { id: string } }>('/equipe/:id/excluir', async (req, rep) => {
    const f = porId(req.params.id)
    if (!f) return rep.code(404).send('Pessoa não encontrada')
    d.repo.transacao(() => {
      g.excluirFuncionario(f.id)
      // Só o id neste registro: o nome não é repetido na exclusão. Registros anteriores da mesma pessoa
      // (criar, editar, gestor) continuam com o nome: a auditoria não é apagada nem reescrita.
      d.repo.auditar(a.usuario(req), 'excluir_funcionario', `#${f.id}`, a.agora())
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
