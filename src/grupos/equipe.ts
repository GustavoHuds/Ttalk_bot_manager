import { semAcento } from '../conversa/textos.js'
import type { DadosFuncionario } from '../db/grupos.js'
import { telefoneDigitado } from './pessoas.js'

export class ErroEquipe extends Error {}

/** Campos como chegam do formulário ou da planilha (tudo texto). */
export interface EntradaFuncionario {
  nome?: string | undefined
  telefone?: string | undefined
  setor?: string | undefined
  loja?: string | undefined
  cargo?: string | undefined
  nascimento?: string | undefined
  ativo?: boolean | undefined
}

export const MAX_LINHAS_CSV = 2000

function opcional(v: string | undefined, campo: string): string | null {
  const t = (v ?? '').trim().replace(/\s+/g, ' ')
  if (t.length > 60) throw new ErroEquipe(`${campo} passa de 60 caracteres`)
  return t || null
}

/** Aceita DD/MM/AAAA ou AAAA-MM-DD; devolve AAAA-MM-DD. */
export function dataNascimento(v: string | undefined): string | null {
  const t = (v ?? '').trim()
  if (!t) return null
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t)
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t)
  if (!iso && !br) throw new ErroEquipe('nascimento deve ser DD/MM/AAAA ou AAAA-MM-DD')
  const [ano, mes, dia] = iso ? [iso[1]!, iso[2]!, iso[3]!] : [br![3]!, br![2]!, br![1]!]
  const d = new Date(Date.UTC(Number(ano), Number(mes) - 1, Number(dia)))
  if (d.getUTCMonth() !== Number(mes) - 1 || d.getUTCDate() !== Number(dia) || Number(ano) < 1900) {
    throw new ErroEquipe('nascimento não é uma data válida')
  }
  return `${ano}-${mes}-${dia}`
}

/** Valida o que veio do painel ou da planilha. O LID nunca vem daqui: só o WhatsApp o informa. */
export function validarFuncionario(e: EntradaFuncionario, o: { telefoneObrigatorio: boolean; lid: string | null }): DadosFuncionario {
  const nome = (e.nome ?? '').trim().replace(/\s+/g, ' ')
  if (!/\p{L}{2,}/u.test(nome) || nome.length > 80) throw new ErroEquipe('nome é obrigatório (até 80 caracteres)')
  const bruto = (e.telefone ?? '').trim().replace(/^'/, '')
  const telefone = telefoneDigitado(bruto)
  if (bruto && !telefone) {
    const estrangeiro = bruto.startsWith('+') && !bruto.startsWith('+55')
    throw new ErroEquipe(estrangeiro ? `telefone "${bruto}" deve ter de 8 a 15 dígitos` : `telefone "${bruto}" não parece um número brasileiro com DDD`)
  }
  if (!telefone && o.telefoneObrigatorio) throw new ErroEquipe('telefone é obrigatório')
  return {
    nome,
    telefone,
    lid: o.lid,
    setor: opcional(e.setor, 'setor'),
    loja: opcional(e.loja, 'loja'),
    cargo: opcional(e.cargo, 'cargo'),
    nascimento: dataNascimento(e.nascimento),
    ativo: e.ativo ?? true
  }
}

/** Uma linha de CSV com ";" e aspas opcionais ("a;b" fica inteiro, "" dentro de aspas vira "). */
export function dividirLinhaCsv(linha: string, separador = ';'): string[] {
  const campos: string[] = []
  let atual = ''
  let aspas = false
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i]!
    if (aspas) {
      if (c === '"' && linha[i + 1] === '"') {
        atual += '"'
        i++
      } else if (c === '"') aspas = false
      else atual += c
    } else if (c === '"') aspas = true
    else if (c === separador) {
      campos.push(atual)
      atual = ''
    } else atual += c
  }
  campos.push(atual)
  return campos.map((c) => c.trim())
}

export interface LinhaCsv {
  /** Número da linha no arquivo (1 = primeira). */
  linha: number
  dados: DadosFuncionario | null
  erro: string | null
}

/** Conta ";" e "," fora de aspas na primeira linha; o separador é o que aparece mais (";" no empate). */
function detectarSeparador(linha: string): string {
  let aspas = false
  let pontoVirgula = 0
  let virgula = 0
  for (const c of linha) {
    if (c === '"') aspas = !aspas
    else if (!aspas && c === ';') pontoVirgula++
    else if (!aspas && c === ',') virgula++
  }
  return virgula > pontoVirgula ? ',' : ';'
}

/** Planilha: nome;telefone;setor;loja;cargo;nascimento (cabeçalho opcional; aceita "," ou ";"; colunas a mais são ignoradas). */
export function lerCsvEquipe(texto: string): LinhaCsv[] {
  const semBom = texto.replace(/^﻿/, '')
  // '�' é o sinal clássico de um arquivo lido com a codificação errada (ex.: Latin-1 lido como UTF-8).
  if (semBom.includes('�')) {
    throw new ErroEquipe('o arquivo não parece estar em UTF-8 (caracteres ilegíveis); salve o CSV como "UTF-8" e tente de novo')
  }
  const linhas = semBom.split(/\r?\n/)
  const primeiraIdx = linhas.findIndex((l) => l.trim())
  const naoVazias = linhas.filter((l) => l.trim())
  const separador = naoVazias[0] ? detectarSeparador(naoVazias[0]) : ';'
  const primeiroCampo = naoVazias[0] ? dividirLinhaCsv(naoVazias[0], separador)[0] : ''
  const temCabecalho = semAcento(primeiroCampo ?? '') === 'nome'
  const linhasDeDados = temCabecalho ? naoVazias.length - 1 : naoVazias.length
  if (linhasDeDados > MAX_LINHAS_CSV) {
    throw new ErroEquipe(`a planilha passa de ${MAX_LINHAS_CSV} linhas; divida em partes`)
  }
  const resultado: LinhaCsv[] = []
  const vistos = new Map<string, number>()
  linhas.forEach((bruta, i) => {
    if (!bruta.trim()) return
    if (i === primeiraIdx && temCabecalho) return
    const [nome, telefone, setor, loja, cargo, nascimento] = dividirLinhaCsv(bruta, separador)
    const n = i + 1
    try {
      const dados = validarFuncionario({ nome, telefone, setor, loja, cargo, nascimento }, { telefoneObrigatorio: true, lid: null })
      const antes = vistos.get(dados.telefone!)
      if (antes) throw new ErroEquipe(`telefone repetido (já está na linha ${antes})`)
      vistos.set(dados.telefone!, n)
      resultado.push({ linha: n, dados, erro: null })
    } catch (e) {
      if (!(e instanceof ErroEquipe)) throw e
      resultado.push({ linha: n, dados: null, erro: e.message })
    }
  })
  return resultado
}
