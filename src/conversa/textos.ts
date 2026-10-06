import type { Mensagens } from '../config/tipos.js'

export type Variaveis = Record<string, string | number | undefined>

/** Escolhe a versão do texto (sorteada se for lista) e troca as {variaveis}. */
export function renderizar(mensagens: Mensagens, chave: string, vars: Variaveis, aleatorio: () => number): string {
  const bruto = mensagens[chave]
  if (bruto === undefined) throw new Error(`mensagem "${chave}" não definida`)
  const modelo = Array.isArray(bruto) ? (bruto[Math.floor(aleatorio() * bruto.length)] ?? bruto[0]!) : bruto
  return (
    modelo
      // variável desconhecida fica visível, para o erro de digitação aparecer no teste
      .replace(/\{(\w+)\}/g, (inteiro, nome: string) => (nome in vars ? String(vars[nome] ?? '') : inteiro))
      // "Obrigado, !" quando o nome não foi perguntado
      .replace(/,\s*([!.?])/g, '$1')
      .replace(/ {2,}/g, ' ')
  )
}

export function semAcento(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim()
}

export function listaNumerada(opcoes: string[]): string {
  return opcoes.map((o, i) => `${i + 1}. ${o}`).join('\n')
}

/** Aceita o número da opção ("2", "2.", "opção 2") ou o texto da opção, sem acento e sem maiúsculas. */
export function casarOpcao(resposta: string, opcoes: string[]): string | null {
  const limpo = semAcento(resposta).replace(/[.)!]+$/, '')
  const numero = /^(?:opcao\s*)?(\d{1,2})$/.exec(limpo)
  if (numero) return opcoes[Number(numero[1]) - 1] ?? null
  return opcoes.find((o) => semAcento(o) === limpo) ?? null
}

export function primeiroNome(nome: string | undefined): string {
  const p = (nome ?? '').trim().split(/\s+/)[0] ?? ''
  if (!p) return ''
  return p.charAt(0).toLocaleUpperCase('pt-BR') + p.slice(1).toLocaleLowerCase('pt-BR')
}
