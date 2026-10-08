import { semAcento } from '../conversa/textos.js'
import type { ComandoSalvo, DadosPersonalizado, OndeVale, QuemUsa } from '../db/bots-grupos.js'
import { APELIDOS, COMANDOS, type NomeComando } from './comandos.js'

/** Um texto de resposta que o painel deixa editar. */
export interface TextoPadrao {
  chave: string
  /** Para que serve, no painel. */
  rotulo: string
  padrao: string
  /** Campos que o texto pode usar, sem as chaves: "nome" vira {nome}. */
  campos: string[]
}

/** Textos editáveis de cada comando pronto. Mensagens de uso e de permissão não entram: são do sistema. */
export const TEXTOS: Record<NomeComando, TextoPadrao[]> = {
  menu: [{ chave: 'titulo', rotulo: 'Título da lista de comandos', padrao: '📖 Comandos', campos: [] }],
  gestores: [
    { chave: 'lista', rotulo: 'Quando há gestores no grupo', padrao: '👔 Gestores deste grupo: {lista}', campos: ['lista'] },
    { chave: 'vazio', rotulo: 'Quando não há nenhum', padrao: 'Nenhum gestor cadastrado está neste grupo.', campos: [] }
  ],
  quem: [{ chave: 'nao_encontrado', rotulo: 'Pessoa fora do cadastro', padrao: 'Não encontrei essa pessoa no cadastro.', campos: [] }],
  cadastrar: [{ chave: 'sucesso', rotulo: 'Cadastro feito', padrao: '✅ {nome} {acao}: {resumo}.', campos: ['nome', 'acao', 'resumo'] }],
  setores: [
    { chave: 'titulo', rotulo: 'Título', padrao: '📋 Setores e lojas — {total} pessoas', campos: ['total'] },
    { chave: 'vazio', rotulo: 'Ninguém cadastrado', padrao: 'Ninguém cadastrado ainda.', campos: [] }
  ],
  desconhecidos: [
    { chave: 'todos', rotulo: 'Todos cadastrados', padrao: '✅ Todos os participantes deste grupo estão cadastrados.', campos: [] },
    { chave: 'titulo', rotulo: 'Título da lista', padrao: '❓ {total} sem cadastro:', campos: ['total'] },
    { chave: 'rodape', rotulo: 'Rodapé da lista', padrao: 'Cadastre com /cadastrar @pessoa Nome | Setor | Loja', campos: [] }
  ],
  grupos: [
    { chave: 'titulo', rotulo: 'Título', padrao: '👥 Grupos ativos ({total})', campos: ['total'] },
    { chave: 'vazio', rotulo: 'Nenhum grupo ativo', padrao: 'Nenhum grupo ativo neste bot.', campos: [] }
  ],
  gestor: [
    {
      chave: 'pendente',
      rotulo: 'Indicado, aguardando confirmação',
      padrao: '⏳ {nome} foi indicado(a) como gestor(a). Para ativar, {nome} deve mandar /confirmar no meu privado.',
      campos: ['nome']
    },
    { chave: 'removido', rotulo: 'Gestor removido', padrao: '{nome} não é mais gestor(a).', campos: ['nome'] }
  ],
  status: [
    {
      chave: 'resumo',
      rotulo: 'Resumo',
      padrao: '🤖 {conexao} · {grupos} grupos ativos · {pessoas} pessoas cadastradas ({gestores} gestores)',
      campos: ['conexao', 'grupos', 'pessoas', 'gestores']
    }
  ],
  log: [{ chave: 'titulo', rotulo: 'Título', padrao: '📜 Últimas ações', campos: [] }],
  confirmar: [
    { chave: 'confirmado', rotulo: 'Confirmação feita', padrao: '✅ Pronto, {nome}! Você agora é gestor(a) do {bot}.', campos: ['nome', 'bot'] },
    {
      chave: 'invalido',
      rotulo: 'Código errado ou vencido',
      padrao: 'Código inválido ou vencido. Peça um novo código a quem cadastrou você.',
      campos: []
    }
  ]
}

export const TAMANHO_MAXIMO_TEXTO = 1000

/** Troca {campo} pelo valor. Campo sem valor fica como está (o painel já não deixa salvar campo desconhecido). */
export function preencher(modelo: string, valores: Record<string, string | number> = {}): string {
  return modelo.replace(/\{(\w+)\}/g, (inteiro, campo: string) => (Object.hasOwn(valores, campo) ? String(valores[campo]) : inteiro))
}

/** Mensagem de erro para o painel, ou null se o texto pode ser salvo. */
export function validarTexto(cmd: NomeComando, chave: string, texto: string): string | null {
  const def = TEXTOS[cmd]?.find((t) => t.chave === chave)
  if (!def) return 'Texto desconhecido.'
  if (texto.length > TAMANHO_MAXIMO_TEXTO) return `Texto longo demais (máximo ${TAMANHO_MAXIMO_TEXTO} caracteres).`
  for (const [, campo] of texto.matchAll(/\{(\w+)\}/g)) {
    if (!def.campos.includes(campo!)) {
      const uso = def.campos.length ? `Use: ${def.campos.map((c) => `{${c}}`).join(', ')}.` : 'Este texto não usa campos.'
      return `Campo desconhecido: {${campo}}. ${uso}`
    }
  }
  return null
}

export type Personalizado = DadosPersonalizado

const QUEM: QuemUsa[] = ['todos', 'gestores']
const ONDE: OndeVale[] = ['grupo', 'privado', 'ambos']

/** Nome como o parser enxerga: sem barra, minúsculo e sem acento. */
export function nomeDeComando(bruto: string): string {
  return semAcento(bruto.trim().replace(/^\//, ''))
}

export function validarPersonalizado(p: Partial<DadosPersonalizado>): { ok: DadosPersonalizado } | { erro: string } {
  const nome = nomeDeComando(p.nome ?? '')
  if (!/^[a-z0-9_]{2,20}$/.test(nome)) return { erro: 'Nome: de 2 a 20 letras, números ou _, sem espaços.' }
  if (COMANDOS.some((c) => c.nome === nome) || Object.hasOwn(APELIDOS, nome)) return { erro: `O comando /${nome} já existe. Escolha outro nome.` }
  const descricao = (p.descricao ?? '').trim().replace(/\s+/g, ' ')
  if (!descricao || descricao.length > 80) return { erro: 'Escreva uma descrição curta (até 80 caracteres) para o /menu.' }
  if (!QUEM.includes(p.quem as QuemUsa) || !ONDE.includes(p.onde as OndeVale)) return { erro: 'Escolha quem pode usar e onde vale.' }
  const resposta = (p.resposta ?? '').trim()
  if (!resposta || resposta.length > TAMANHO_MAXIMO_TEXTO) return { erro: `Escreva a resposta (até ${TAMANHO_MAXIMO_TEXTO} caracteres).` }
  return { ok: { nome, descricao, quem: p.quem as QuemUsa, onde: p.onde as OndeVale, resposta } }
}

/** Como um bot configurou os comandos: o que o motor precisa saber. */
export interface ComandosDoBot {
  desligados: Set<NomeComando>
  textos: Map<NomeComando, Record<string, string>>
  personalizados: DadosPersonalizado[]
}

export const COMANDOS_PADRAO: ComandosDoBot = { desligados: new Set(), textos: new Map(), personalizados: [] }

const ehPronto = (nome: string): nome is NomeComando => COMANDOS.some((c) => c.nome === nome)

export function comandosDoBot(salvos: Map<string, ComandoSalvo>): ComandosDoBot {
  const c: ComandosDoBot = { desligados: new Set(), textos: new Map(), personalizados: [] }
  for (const s of salvos.values()) {
    if (s.personalizado) {
      if (s.quem && s.onde && s.resposta) {
        c.personalizados.push({ nome: s.nome, descricao: s.descricao ?? '', quem: s.quem, onde: s.onde, resposta: s.resposta })
      }
      continue
    }
    if (!ehPronto(s.nome)) continue
    const fixo = COMANDOS.find((d) => d.nome === s.nome)!.fixo
    if (!s.ligado && !fixo) c.desligados.add(s.nome)
    if (Object.keys(s.textos).length) c.textos.set(s.nome, s.textos)
  }
  return c
}

/** Texto editado do bot (ou o original), já com os campos preenchidos. */
export function texto(c: ComandosDoBot, cmd: NomeComando, chave: string, valores: Record<string, string | number> = {}): string {
  const editado = c.textos.get(cmd)?.[chave]
  const padrao = TEXTOS[cmd].find((t) => t.chave === chave)?.padrao
  if (padrao === undefined) throw new Error(`texto sem padrão: ${cmd}.${chave}`)
  return preencher(editado || padrao, valores)
}
