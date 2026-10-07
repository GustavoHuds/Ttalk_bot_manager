import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import type { ConfigCarregada, FormatoArquivo, Mensagens, Pergunta, Processo, StatusProcesso } from './tipos.js'

const STATUS: StatusProcesso[] = ['rascunho', 'aberto', 'encerrado']
const FORMATOS: FormatoArquivo[] = ['pdf', 'docx', 'doc', 'jpg', 'png']
/** Chaves usadas pelo próprio motor; não podem ser nomes de pergunta. */
const CHAVES_RESERVADAS = new Set(['telefone', 'fim', 'substituindo'])
/** Brasília não tem horário de verão desde 2019: UTC-3 fixo. */
const FUSO_MS = 3 * 60 * 60 * 1000
const DIA_MS = 24 * 60 * 60 * 1000

export class ErroConfig extends Error {}

function dataParaMs(valor: unknown, campo: string): number {
  let ano: number, mes: number, dia: number
  if (valor instanceof Date) {
    ano = valor.getUTCFullYear()
    mes = valor.getUTCMonth() + 1
    dia = valor.getUTCDate()
  } else {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(valor ?? '').trim())
    if (!m) throw new ErroConfig(`${campo} deve ser uma data no formato AAAA-MM-DD`)
    ano = Number(m[1])
    mes = Number(m[2])
    dia = Number(m[3])
  }
  return Date.UTC(ano, mes - 1, dia) + FUSO_MS
}

function texto(valor: unknown, campo: string): string {
  if (typeof valor !== 'string' || !valor.trim()) throw new ErroConfig(`${campo} é obrigatório`)
  return valor.trim()
}

export function validarMensagens(bruto: unknown, origem: string): Mensagens {
  if (bruto == null) return {}
  if (typeof bruto !== 'object' || Array.isArray(bruto)) throw new ErroConfig(`${origem}: "mensagens" deve ser um mapa chave: texto`)
  const saida: Mensagens = {}
  for (const [chave, valor] of Object.entries(bruto)) {
    if (typeof valor === 'string' && valor.trim()) saida[chave] = valor
    else if (Array.isArray(valor) && valor.length > 0 && valor.every((v) => typeof v === 'string' && v.trim())) saida[chave] = valor
    else throw new ErroConfig(`${origem}: a mensagem "${chave}" deve ser um texto ou uma lista de textos`)
  }
  return saida
}

function validarPergunta(bruto: unknown, i: number, mensagens: Mensagens): Pergunta {
  const onde = `pergunta ${i + 1}`
  if (!bruto || typeof bruto !== 'object') throw new ErroConfig(`${onde} inválida`)
  const p = bruto as Record<string, unknown>
  const chave = texto(p.chave, `${onde}: chave`)
  if (!/^[a-z][a-z0-9_]*$/.test(chave)) throw new ErroConfig(`${onde}: a chave "${chave}" deve ter só letras minúsculas, números e _`)
  if (CHAVES_RESERVADAS.has(chave)) throw new ErroConfig(`${onde}: a chave "${chave}" é reservada pelo bot`)
  const textoPergunta = p.texto === undefined ? undefined : texto(p.texto, `${onde}: texto`)
  if (!textoPergunta && !mensagens[`pede_${chave}`]) {
    throw new ErroConfig(`${onde}: defina "texto" na pergunta ou a mensagem "pede_${chave}"`)
  }
  const base = { chave, ...(textoPergunta ? { texto: textoPergunta } : {}) }

  switch (p.tipo) {
    case 'texto': {
      const v = p.validacao
      if (v !== undefined && v !== 'nome_completo' && v !== 'telefone') {
        throw new ErroConfig(`${onde}: validacao deve ser nome_completo ou telefone`)
      }
      return { ...base, tipo: 'texto', ...(v ? { validacao: v } : {}) }
    }
    case 'enquete': {
      const opcoes = p.opcoes
      if (!Array.isArray(opcoes) || opcoes.length < 2 || opcoes.length > 12) {
        throw new ErroConfig(`${onde}: a enquete precisa de 2 a 12 opções`)
      }
      const lista = opcoes.map((o, j) => texto(typeof o === 'number' ? String(o) : o, `${onde}: opção ${j + 1}`))
      if (new Set(lista.map((o) => o.toLowerCase())).size !== lista.length) throw new ErroConfig(`${onde}: opções repetidas`)
      return { ...base, tipo: 'enquete', opcoes: lista }
    }
    case 'arquivo': {
      const formatos = p.formatos ?? ['pdf', 'docx', 'jpg', 'png']
      if (!Array.isArray(formatos) || formatos.length === 0 || !formatos.every((f) => FORMATOS.includes(f as FormatoArquivo))) {
        throw new ErroConfig(`${onde}: formatos aceitos são ${FORMATOS.join(', ')}`)
      }
      const tamanho = p.tamanho_max_mb ?? 10
      if (typeof tamanho !== 'number' || tamanho <= 0 || tamanho > 100) throw new ErroConfig(`${onde}: tamanho_max_mb deve ser entre 1 e 100`)
      return { ...base, tipo: 'arquivo', formatos: formatos as FormatoArquivo[], tamanho_max_mb: tamanho }
    }
    default:
      throw new ErroConfig(`${onde}: tipo deve ser texto, enquete ou arquivo`)
  }
}

export function validarProcesso(bruto: unknown, padrao: Mensagens, arquivoOrigem: string): Processo {
  if (!bruto || typeof bruto !== 'object') throw new ErroConfig('arquivo vazio ou inválido')
  const d = bruto as Record<string, unknown>
  const codigo = texto(d.codigo, 'codigo').toUpperCase()
  if (!/^[A-Z0-9][A-Z0-9-]{1,30}$/.test(codigo)) throw new ErroConfig('codigo deve ter só letras, números e hífen (até 31 caracteres)')
  const vaga = texto(d.vaga, 'vaga')
  const status = d.status as StatusProcesso
  if (!STATUS.includes(status)) throw new ErroConfig('status deve ser rascunho, aberto ou encerrado')
  const abreEm = d.abre_em == null ? null : dataParaMs(d.abre_em, 'abre_em')
  const encerraEm = dataParaMs(d.encerra_em, 'encerra_em') + DIA_MS - 1
  if (abreEm !== null && abreEm > encerraEm) throw new ErroConfig('abre_em é depois de encerra_em')
  const retencaoMeses = d.retencao_meses
  if (typeof retencaoMeses !== 'number' || !Number.isInteger(retencaoMeses) || retencaoMeses < 1 || retencaoMeses > 60) {
    throw new ErroConfig('retencao_meses deve ser um número inteiro entre 1 e 60')
  }
  const numeroId = d.numero_id ?? 1
  if (typeof numeroId !== 'number' || !Number.isInteger(numeroId) || numeroId < 1) throw new ErroConfig('numero_id deve ser o id de um número')
  const mensagens = { ...padrao, ...validarMensagens(d.mensagens, 'processo') }
  if (!Array.isArray(d.perguntas) || d.perguntas.length === 0) throw new ErroConfig('o processo precisa de pelo menos uma pergunta')
  const perguntas = d.perguntas.map((p, i) => validarPergunta(p, i, mensagens))
  const chaves = perguntas.map((p) => p.chave)
  if (new Set(chaves).size !== chaves.length) throw new ErroConfig('há perguntas com a mesma chave')
  return { codigo, vaga, status, abreEm, encerraEm, retencaoMeses, numeroId, perguntas, mensagens, arquivoOrigem }
}

/** Textos padrão de fábrica (config/mensagens-padrao.yaml). Cada bot sobrescreve o que quiser pelo painel. */
export function lerPadrao(dir: string): Mensagens {
  return validarMensagens(parse(readFileSync(join(dir, 'mensagens-padrao.yaml'), 'utf8')), 'mensagens-padrao.yaml')
}

/** Lê os YAML antigos de config/processos, usados só para a importação inicial para o banco. */
export function lerYamlProcessos(dir: string): { arquivo: string; dados: unknown }[] {
  const pasta = join(dir, 'processos')
  let arquivos: string[] = []
  try {
    arquivos = readdirSync(pasta).filter((a) => /\.ya?ml$/i.test(a)).sort()
  } catch {
    return []
  }
  return arquivos.map((arquivo) => ({ arquivo, dados: parse(readFileSync(join(pasta, arquivo), 'utf8')) as unknown }))
}

/** Valida cada bot; um bot com erro fica de fora sem derrubar os outros. */
export function montarConfig(
  padrao: Mensagens,
  itens: { origem: string; dados: unknown }[],
  agora = Date.now(),
  empresa = 'nossa empresa'
): ConfigCarregada {
  const erros: string[] = []
  const processos: Processo[] = []
  for (const { origem, dados } of itens) {
    try {
      const p = validarProcesso(dados, padrao, origem)
      const repetido = processos.find((x) => x.codigo === p.codigo)
      if (repetido) throw new ErroConfig(`código ${p.codigo} já usado em ${repetido.arquivoOrigem}`)
      processos.push(p)
    } catch (e) {
      erros.push(`${origem}: ${(e as Error).message}`)
    }
  }
  return { processos, padrao, empresa, erros, carregadaEm: agora }
}

export function lerConfig(dir: string, agora = Date.now()): ConfigCarregada {
  return montarConfig(
    lerPadrao(dir),
    lerYamlProcessos(dir).map((y) => ({ origem: y.arquivo, dados: y.dados })),
    agora
  )
}

export type Situacao = 'rascunho' | 'aberto' | 'fechado'

export function situacao(p: Processo, agora: number): Situacao {
  if (p.status === 'rascunho') return 'rascunho'
  if (p.status === 'encerrado') return 'fechado'
  if (p.abreEm !== null && agora < p.abreEm) return 'fechado'
  if (agora > p.encerraEm) return 'fechado'
  return 'aberto'
}
