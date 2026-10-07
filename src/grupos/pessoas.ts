import { normalizarTelefone } from '../conversa/motor.js'
import type { Funcionario } from '../db/grupos.js'
import type { Pessoa } from './tipos.js'

/** Celular brasileiro digitado localmente: DDD (11-99, sem zero em nenhuma posição) + 9 + 8 dígitos. */
const CELULAR_LOCAL = /^[1-9][1-9]9\d{8}$/

/**
 * Forma única de guardar e comparar telefones brasileiros: 55 + DDD + número, com o 9 dos celulares.
 * O WhatsApp ainda entrega alguns celulares antigos com 8 dígitos (55 83 9999-0001); aqui o 9 volta.
 * Um zero de discagem na frente do DDD ("083...") é descartado; DDD não existe começando em 0, então é rejeitado.
 * 11 dígitos sem o 55 só é brasileiro quando bate com o formato DDD+9+8 (celular); senão não é número
 * nosso — por exemplo um celular dos EUA também tem 11 dígitos, mas a terceira posição não é '9'.
 */
export function telefoneCanonico(texto: string | null | undefined): string | null {
  if (!texto) return null
  let dig = texto.replace(/\D/g, '')
  if (dig.length > 0 && dig[0] === '0') dig = dig.slice(1)
  if (dig.length === 11 && !CELULAR_LOCAL.test(dig)) return null
  const t = normalizarTelefone(dig)
  if (!t) return null
  if (t[2] === '0') return null
  // 55 + DDD + 8 dígitos começando em 6-9 é celular sem o 9.
  if (t.length === 12 && /[6-9]/.test(t[4]!)) return `${t.slice(0, 4)}9${t.slice(4)}`
  return t
}

/**
 * Telefone como o WhatsApp entrega: o usuário de um JID (ou dígitos crus, sempre com o código do país).
 * Só o prefixo "55" decide se é brasileiro (vira a forma canônica); qualquer outro país fica com os
 * dígitos exatamente como vieram (8 a 15). Nunca usar o tamanho para adivinhar o país: um número
 * estrangeiro de 10 ou 11 dígitos (ex.: Dinamarca +45 12345678 → "4512345678") não é um DDD brasileiro
 * só porque bate no mesmo tamanho — essa confusão já causou gente cadastrada com o 55 inventado.
 * Não confundir com telefoneDoJid (whatsapp/normalizar.ts): dígitos crus, sem chave, usado pelo recrutamento.
 */
export function chaveTelefoneDeJid(v: string | null | undefined): string | null {
  if (!v) return null
  const dig = v.split('@')[0]!.split(':')[0]!.replace(/\D/g, '')
  if (/^55\d{10,11}$/.test(dig)) return telefoneCanonico(dig)
  if (dig.length >= 8 && dig.length <= 15) return dig
  return null
}

/**
 * Telefone digitado por uma pessoa (painel, planilha CSV, /cadastrar no privado): sem "+" assume o
 * Brasil e exige DDD válido (telefoneCanonico); com "+" e não "+55" é estrangeiro — fica com os dígitos
 * como vieram (8 a 15), a mesma forma que chaveTelefoneDeJid produziria para esse mesmo número vindo do
 * WhatsApp, para os dois lados sempre baterem. Um apóstrofo na frente (neutralização de fórmula do
 * Excel, ao reimportar um CSV exportado por aqui) é ignorado.
 */
export function telefoneDigitado(bruto: string | null | undefined): string | null {
  const texto = (bruto ?? '').trim().replace(/^'/, '')
  if (!texto) return null
  if (texto.startsWith('+') && !texto.startsWith('+55')) {
    const dig = texto.replace(/\D/g, '')
    return dig.length >= 8 && dig.length <= 15 ? dig : null
  }
  return telefoneCanonico(texto)
}

/** "+55 83 99999-0001"; números não brasileiros caem no formato genérico "+<dígitos>". */
export function formatarTelefone(t: string): string {
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(t)
  return m ? `+55 ${m[1]} ${m[2]}-${m[3]}` : `+${t}`
}

/** Parte antes do @, sem o ":dispositivo". */
export function usuarioDoJid(jid: string): string {
  return jid.split('@')[0]!.split(':')[0]!
}

/** Pessoa a partir de um JID solto (menção, mensagem citada). */
export function pessoaDoJid(jid: string): Pessoa {
  const usuario = usuarioDoJid(jid)
  return {
    jid,
    telefone: jid.endsWith('@s.whatsapp.net') ? chaveTelefoneDeJid(usuario) : null,
    lid: jid.endsWith('@lid') ? `${usuario}@lid` : null
  }
}

/**
 * Acha no cadastro: pelo telefone, senão pelo LID. Pessoa.telefone já chega como chave
 * (chaveTelefoneDeJid para quem veio do WhatsApp, telefoneDigitado para quem foi digitado): compara direto,
 * sem reprocessar — reprocessar um valor que já é a chave é o que inventava o 55 em número estrangeiro.
 */
export function acharFuncionario(funcionarios: Funcionario[], p: Pessoa): Funcionario | null {
  return (p.telefone ? funcionarios.find((f) => f.telefone === p.telefone) : undefined) ?? (p.lid ? funcionarios.find((f) => f.lid === p.lid) : undefined) ?? null
}

/** Quem está no cadastro pelo telefone e ainda não tem LID ganha o LID visto agora (se ninguém mais o tiver). */
export function vinculosDeLid(funcionarios: Funcionario[], pessoas: Pessoa[]): { id: number; lid: string }[] {
  const lidsUsados = new Set(funcionarios.map((f) => f.lid).filter((l): l is string => !!l))
  const ligados = new Set<number>()
  const vinculos: { id: number; lid: string }[] = []
  for (const p of pessoas) {
    if (!p.telefone || !p.lid || lidsUsados.has(p.lid)) continue
    const f = funcionarios.find((x) => x.telefone === p.telefone)
    if (!f || f.lid || ligados.has(f.id)) continue
    vinculos.push({ id: f.id, lid: p.lid })
    lidsUsados.add(p.lid)
    ligados.add(f.id)
  }
  return vinculos
}
