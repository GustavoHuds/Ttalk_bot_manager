import { semAcento } from '../conversa/textos.js'
import type { DadosFuncionario, Funcionario } from '../db/grupos.js'
import { texto, type Personalizado } from './catalogo.js'
import { COMANDOS, acharComando, type Comando, type DefComando, type NomeComando } from './comandos.js'
import { acharFuncionario, formatarTelefone, telefoneDigitado, usuarioDoJid } from './pessoas.js'
import type { AcaoGrupo, ContextoGrupos, Pessoa } from './tipos.js'

/** Listas longas no WhatsApp ficam ilegíveis: corta e diz quantos faltaram. */
const MAX_LISTA = 40

export function horaBR(ms: number): string {
  return new Date(ms).toLocaleString('pt-BR', {
    timeZone: 'America/Fortaleza',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function responder(texto: string, mencoes?: string[]): AcaoGrupo[] {
  return [{ tipo: 'responder', texto, ...(mencoes?.length ? { mencoes } : {}) }]
}

function listar(linhas: string[]): string {
  const extra = linhas.length - MAX_LISTA
  return [...linhas.slice(0, MAX_LISTA), ...(extra > 0 ? [`… e mais ${extra}`] : [])].join('\n')
}

function descrever(f: Funcionario): string {
  const onde = [f.setor, f.loja, f.cargo].filter(Boolean).join(' · ') || 'sem setor'
  return `${f.nome} — ${onde}${f.ativo ? '' : ' (inativo)'}`
}

/**
 * "/cadastrar 5583999990001 Nome | ..." no privado: o primeiro termo é o telefone, na mesma regra
 * de quem digita no painel ou na planilha (telefoneDigitado): sem "+" assume o Brasil; com "+" e não
 * "+55" é estrangeiro e mantém os dígitos como vieram.
 */
function separarTelefone(texto: string): { pessoa: Pessoa | null; resto: string } {
  const [primeiro = '', ...resto] = texto.split(' ')
  if (!/^\+?[\d().-]{10,}$/.test(primeiro)) return { pessoa: null, resto: texto }
  const tel = telefoneDigitado(primeiro)
  if (!tel) return { pessoa: null, resto: texto }
  return { pessoa: { jid: `${tel}@s.whatsapp.net`, telefone: tel, lid: null }, resto: resto.join(' ') }
}

/**
 * Regras do bot de grupos. Puro: recebe o retrato do momento e devolve ações;
 * não toca no WhatsApp, no banco nem no relógio.
 */
export function processarComando(ctx: ContextoGrupos, cmd: Comando): AcaoGrupo[] {
  const autor = acharFuncionario(ctx.funcionarios, ctx.remetente)
  const gestor = !!autor && autor.ativo && ctx.gestores.has(autor.id)
  const def = acharComando(cmd.nome)
  // /confirmar é o único comando de quem ainda não tem poder nenhum (o gestor indicado).
  if (def?.nome === 'confirmar') return confirmar(ctx, cmd)
  // No privado só gestores são atendidos: um estranho escrevendo para o número não recebe nada.
  if (!ctx.ehGrupo && !gestor) return []
  if (!def) {
    const p = ctx.comandos.personalizados.find((x) => x.nome === cmd.nome)
    if (p) return personalizado(ctx, p, gestor)
    return gestor ? responder('Não reconheço esse comando. Veja /menu.') : []
  }
  // Comando de gestor vindo de outra pessoa: silêncio, para o bot não virar ferramenta de spam no grupo.
  if (def.gestor && !gestor) return []
  if (ctx.comandos.desligados.has(def.nome)) return gestor ? responder('Este comando está desligado neste bot.') : []
  const fora = foraDoLugar(def.nome, def.onde, ctx.ehGrupo)
  if (fora) return fora
  if (def.precisaAdmin && !ctx.grupo?.botAdmin) return responder('Preciso ser admin deste grupo para isso.')
  if (def.precisaMembros && !ctx.membros) return responder('Não consegui ler os participantes agora. Tente de novo em instantes.')
  return new Execucao(ctx, cmd, def, gestor).rodar()
}

function foraDoLugar(nome: string, onde: 'grupo' | 'privado' | 'ambos', ehGrupo: boolean): AcaoGrupo[] | null {
  if (onde === 'grupo' && !ehGrupo) return responder(`O /${nome} funciona dentro de um grupo.`)
  if (onde === 'privado' && ehGrupo) return responder(`Use /${nome} no privado comigo.`)
  return null
}

function personalizado(ctx: ContextoGrupos, p: Personalizado, gestor: boolean): AcaoGrupo[] {
  if (p.quem === 'gestores' && !gestor) return []
  return foraDoLugar(p.nome, p.onde, ctx.ehGrupo) ?? responder(p.resposta)
}

/**
 * "/confirmar 123456" no privado: o código liga o WhatsApp de quem mandou ao gestor indicado — mas só
 * se for o mesmo WhatsApp do cadastro (telefone ou LID). Código certo vindo de outro WhatsApp não dá
 * poder: fica guardado como divergência para alguém conferir no painel (é assim que um telefone
 * digitado errado aparece). No grupo, nunca olha o código: só manda usar no privado.
 */
function confirmar(ctx: ContextoGrupos, cmd: Comando): AcaoGrupo[] {
  if (ctx.ehGrupo) return responder('Use /confirmar no privado comigo.')
  const codigo = cmd.args.replace(/\D/g, '')
  const pendente = /^\d{6}$/.test(codigo)
    ? ctx.pendentes.find((p) => p.codigo === codigo && p.expiraEm !== null && p.expiraEm > ctx.agora)
    : undefined
  const f = pendente ? ctx.funcionarios.find((x) => x.id === pendente.funcionarioId) : undefined
  if (!f) return [{ tipo: 'codigo_errado' }, ...responder(texto(ctx.comandos, 'confirmar', 'invalido'))]
  const r = ctx.remetente
  const mesmo = (!!r.telefone && f.telefone === r.telefone) || (!!r.lid && f.lid === r.lid)
  if (mesmo) {
    return [
      { tipo: 'confirmar_gestor', funcionarioId: f.id, pessoa: r },
      { tipo: 'auditar', acao: 'gestor_confirmado', detalhe: `${f.nome} no ${ctx.bot.nome}`, funcionarioId: f.id },
      ...responder(texto(ctx.comandos, 'confirmar', 'confirmado', { nome: f.nome, bot: ctx.bot.nome }))
    ]
  }
  const origem = r.telefone ? formatarTelefone(r.telefone) : 'contato sem telefone visível'
  return [
    { tipo: 'divergencia', funcionarioId: f.id, pessoa: r },
    { tipo: 'auditar', acao: 'gestor_divergente', detalhe: `${f.nome} no ${ctx.bot.nome}: veio de ${origem}`, funcionarioId: f.id },
    ...responder(`Recebido. Este WhatsApp é diferente do cadastro de ${f.nome}; quem administra o painel precisa conferir.`)
  ]
}

class Execucao {
  constructor(
    private readonly ctx: ContextoGrupos,
    private readonly cmd: Comando,
    private readonly def: DefComando,
    private readonly gestor: boolean
  ) {}

  rodar(): AcaoGrupo[] {
    const nome = this.def.nome
    switch (nome) {
      case 'menu':
        return this.menu()
      case 'gestores':
        return this.gestores()
      case 'quem':
        return this.quem()
      case 'cadastrar':
        return this.cadastrar()
      case 'setores':
        return this.setores()
      case 'desconhecidos':
        return this.desconhecidos()
      case 'grupos':
        return this.grupos()
      case 'gestor':
        return this.gestorCmd()
      case 'status':
        return this.status()
      case 'log':
        return this.log()
      case 'confirmar':
        return confirmar(this.ctx, this.cmd)
      default: {
        const faltando: never = nome
        throw new Error(`comando sem regra: ${String(faltando)}`)
      }
    }
  }

  private t(chave: string, valores?: Record<string, string | number>): string {
    return texto(this.ctx.comandos, this.def.nome as NomeComando, chave, valores)
  }

  private uso(): AcaoGrupo[] {
    return responder(`Uso: ${this.def.uso}`)
  }

  private alvo(): Pessoa | null {
    return this.ctx.mencionados[0] ?? this.ctx.citada ?? null
  }

  private achar(p: Pessoa): Funcionario | null {
    return acharFuncionario(this.ctx.funcionarios, p)
  }

  private gestoresAtivos(): Funcionario[] {
    return this.ctx.funcionarios.filter((f) => f.ativo && this.ctx.gestores.has(f.id))
  }

  private menu(): AcaoGrupo[] {
    const aqui = this.ctx.ehGrupo ? 'grupo' : 'privado'
    const vale = (onde: 'grupo' | 'privado' | 'ambos') => onde === 'ambos' || onde === aqui
    const prontos = COMANDOS.filter(
      (d) => !d.oculto && !this.ctx.comandos.desligados.has(d.nome) && (this.gestor || !d.gestor) && vale(d.onde)
    ).map((d) => `${d.uso} — ${d.descricao}`)
    const proprios = this.ctx.comandos.personalizados
      .filter((p) => (this.gestor || p.quem === 'todos') && vale(p.onde))
      .map((p) => `/${p.nome} — ${p.descricao}`)
    return responder(`${this.t('titulo')}\n${[...prontos, ...proprios].join('\n')}`)
  }

  private gestores(): AcaoGrupo[] {
    const ids = new Set(this.gestoresAtivos().map((f) => f.id))
    const presentes = (this.ctx.membros ?? []).filter((m) => {
      const f = this.achar(m)
      return !!f && ids.has(f.id)
    })
    if (presentes.length === 0) return responder(this.t('vazio'))
    return responder(
      this.t('lista', { lista: presentes.map((m) => `@${usuarioDoJid(m.jid)}`).join(' ') }),
      presentes.map((m) => m.jid)
    )
  }

  private quem(): AcaoGrupo[] {
    const p = this.alvo()
    if (!p) return this.uso()
    const f = this.achar(p)
    if (!f) return responder(this.t('nao_encontrado'))
    const selo = f.ativo && this.ctx.gestores.has(f.id) ? ' · 👔 gestor(a)' : ''
    return responder(`🪪 ${descrever(f)}${selo}`)
  }

  private cadastrar(): AcaoGrupo[] {
    let pessoa = this.alvo()
    let resto = this.cmd.args
    if (!pessoa) ({ pessoa, resto } = separarTelefone(resto))
    if (!pessoa) return this.uso()
    const [nome = '', setor = '', loja = '', cargo = ''] = resto.split('|').map((c) => c.trim())
    const letras = nome.match(/\p{L}/gu)?.length ?? 0
    // Sem dígitos: evita que um telefone digitado (sem @menção, com citada como alvo) seja engolido pelo campo nome.
    const valido = letras >= 2 && !/\d/.test(nome) && nome.length <= 80 && !!setor && !!loja && [setor, loja, cargo].every((c) => c.length <= 60)
    if (!valido) return this.uso()

    // pessoa.telefone já chega como chave (o orquestrador resolve o JID, ou separarTelefone digitou):
    // usar direto, sem reprocessar — reprocessar um valor que já é a chave é o que inventava o 55
    // em número estrangeiro.
    const telefone = pessoa.telefone
    if (!telefone && !pessoa.lid) return responder('Não consegui identificar essa pessoa. Mencione com @ ou informe o telefone.')
    const porTelefone = telefone ? this.ctx.funcionarios.find((f) => f.telefone === telefone) : undefined
    const porLid = pessoa.lid ? this.ctx.funcionarios.find((f) => f.lid === pessoa.lid) : undefined
    if (porTelefone && porLid && porTelefone.id !== porLid.id) {
      return responder('Esse telefone e esse contato estão em cadastros diferentes. Corrija pela página Equipe do painel.')
    }
    const atual = porTelefone ?? porLid ?? null
    // Reativar por /cadastrar devolveria o poder de gestor em silêncio: exige o painel, onde isso fica visível.
    if (atual && !atual.ativo) return responder(`${atual.nome} está com o cadastro inativo. Reative pelo painel.`)
    const dados: DadosFuncionario = {
      nome,
      telefone: telefone ?? atual?.telefone ?? null,
      lid: pessoa.lid ?? atual?.lid ?? null,
      setor,
      loja,
      cargo: cargo || atual?.cargo || null,
      nascimento: atual?.nascimento ?? null,
      ativo: true
    }
    const resumo = [setor, loja, dados.cargo].filter(Boolean).join(' · ')
    return [
      { tipo: 'salvar_funcionario', id: atual?.id ?? null, dados },
      { tipo: 'auditar', acao: atual ? 'atualizar_funcionario' : 'cadastrar_funcionario', detalhe: `${nome} (${resumo})` },
      ...responder(this.t('sucesso', { nome, acao: atual ? 'atualizado(a)' : 'cadastrado(a)', resumo }))
    ]
  }

  /**
   * Indicar não dá poder: a pessoa vira pendente e o código vai para o privado de quem indicou, que o
   * repassa. Indicar de novo alguém pendente só troca o código (o anterior pode ter vencido).
   */
  private gestorCmd(): AcaoGrupo[] {
    const [sub = '', ...resto] = this.cmd.args.split(' ')
    const s = semAcento(sub)
    const adicionar = ['add', 'adicionar', 'incluir'].includes(s)
    const remover = ['remover', 'rm', 'tirar', 'del'].includes(s)
    if (!adicionar && !remover) return this.uso()
    const pessoa = this.alvo() ?? separarTelefone(resto.join(' ')).pessoa
    if (!pessoa) return this.uso()
    const f = this.achar(pessoa)
    if (!f) return responder('Essa pessoa não está no cadastro. Use /cadastrar primeiro.')
    const confirmado = this.ctx.gestores.has(f.id)
    const pendente = this.ctx.pendentes.some((p) => p.funcionarioId === f.id)
    if (adicionar) {
      if (!f.ativo) return responder(`${f.nome} está com o cadastro inativo.`)
      if (confirmado) return responder(`${f.nome} já é gestor(a).`)
      return [
        { tipo: 'indicar_gestor', funcionarioId: f.id, avisar: this.ctx.remetente },
        { tipo: 'auditar', acao: 'gestor_indicado', detalhe: `${f.nome} no ${this.ctx.bot.nome}`, funcionarioId: f.id },
        ...responder(this.t('pendente', { nome: f.nome }))
      ]
    }
    if (!confirmado && !pendente) return responder(`${f.nome} não é gestor(a).`)
    // Alvo inativo não conta como "o último gestor": inativo já não tem poder de gestor de qualquer forma.
    if (confirmado && f.ativo && this.gestoresAtivos().length <= 1) {
      return responder('Não dá para remover o último gestor. Adicione outro antes ou use o painel.')
    }
    return [
      { tipo: 'remover_gestor', funcionarioId: f.id },
      { tipo: 'auditar', acao: 'gestor_removido', detalhe: `${f.nome} no ${this.ctx.bot.nome}`, funcionarioId: f.id },
      ...responder(this.t('removido', { nome: f.nome }))
    ]
  }

  private setores(): AcaoGrupo[] {
    const ativos = this.ctx.funcionarios.filter((f) => f.ativo)
    if (ativos.length === 0) return responder(this.t('vazio'))
    const porSetor = new Map<string, Map<string, number>>()
    for (const f of ativos) {
      const lojas = porSetor.get(f.setor ?? 'Sem setor') ?? new Map<string, number>()
      lojas.set(f.loja ?? 'sem loja', (lojas.get(f.loja ?? 'sem loja') ?? 0) + 1)
      porSetor.set(f.setor ?? 'Sem setor', lojas)
    }
    const ordem = (a: string, b: string) => a.localeCompare(b, 'pt-BR')
    const linhas = [...porSetor.entries()]
      .sort(([a], [b]) => ordem(a, b))
      .map(([setor, lojas]) => {
        const total = [...lojas.values()].reduce((s, n) => s + n, 0)
        const detalhe = [...lojas.entries()]
          .sort(([a], [b]) => ordem(a, b))
          .map(([loja, n]) => `${loja} ${n}`)
          .join(', ')
        return `• ${setor}: ${total} (${detalhe})`
      })
    return responder(`${this.t('titulo', { total: ativos.length })}\n${listar(linhas)}`)
  }

  private desconhecidos(): AcaoGrupo[] {
    const fora = (this.ctx.membros ?? []).filter((m) => !this.achar(m))
    if (fora.length === 0) return responder(this.t('todos'))
    // LGPD: quem participa pelo LID tem o número escondido pelo WhatsApp para o grupo; mesmo que o bot
    // o conheça (lidMapping), não o expõe aqui. Só mostra telefone de quem já aparece com ele no grupo.
    const linhas = fora.map((m) => {
      const visivel = m.jid.endsWith('@s.whatsapp.net') && m.telefone
      return `• ${visivel ? formatarTelefone(m.telefone!) : `contato oculto (${usuarioDoJid(m.jid)})`}`
    })
    return responder(`${this.t('titulo', { total: fora.length })}\n${listar(linhas)}\n\n${this.t('rodape')}`)
  }

  private grupos(): AcaoGrupo[] {
    if (this.ctx.grupos.length === 0) return responder(this.t('vazio'))
    const linhas = this.ctx.grupos.map((g) => {
      const etiquetas = [g.loja, g.setor].filter(Boolean).join(' · ')
      return `• ${g.nome} — ${g.botAdmin ? 'admin ✅' : 'sem admin ❌'}${etiquetas ? ` — ${etiquetas}` : ''}`
    })
    return responder(`${this.t('titulo', { total: this.ctx.grupos.length })}\n${listar(linhas)}`)
  }

  private status(): AcaoGrupo[] {
    const ativos = this.ctx.funcionarios.filter((f) => f.ativo).length
    const conexao = this.ctx.conectadoDesde ? `Conectado desde ${horaBR(this.ctx.conectadoDesde)}` : 'Conexão instável'
    return responder(
      this.t('resumo', { conexao, grupos: this.ctx.grupos.length, pessoas: ativos, gestores: this.gestoresAtivos().length })
    )
  }

  private log(): AcaoGrupo[] {
    // Só cai para o padrão (10) quando não vem número; "/log 0" é 0, não "nenhum número" — vira 1, não 10.
    const pedido = this.cmd.args.trim() === '' ? NaN : Number.parseInt(this.cmd.args, 10)
    const n = Math.min(30, Math.max(1, Number.isNaN(pedido) ? 10 : pedido))
    const linhas = this.ctx.auditoria
      .slice(0, n)
      .map((l) => `${horaBR(l.em)} · ${l.usuario} · ${l.acao}${l.detalhe ? ` · ${l.detalhe}` : ''}`)
      .map((l) => (l.length > 200 ? l.slice(0, 200) : l))
    if (linhas.length === 0) return responder('Nada registrado ainda.')
    return responder(`${this.t('titulo')}\n${linhas.join('\n')}`)
  }
}
