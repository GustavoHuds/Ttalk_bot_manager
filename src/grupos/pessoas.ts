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
 * Chave de comparação de telefones de qualquer país.
 * Brasileiro (55 + 12/13 dígitos, DDD+8 digitado localmente com 10 dígitos, ou celular DDD+9+8 com
 * 11 dígitos) vira a forma canônica; já internacional (8 a 15 dígitos) fica como veio — o JID sempre
 * traz o código do país, então não há o que canonicalizar. O resto é null.
 */
export function chaveTelefone(texto: string | null | undefined): string | null {
  if (!texto) return null
  let dig = texto.replace(/\D/g, '')
  if (dig.length > 0 && dig[0] === '0') dig = dig.slice(1)
  const brasileiro =
    (dig.startsWith('55') && (dig.length === 12 || dig.length === 13)) || dig.length === 10 || (dig.length === 11 && CELULAR_LOCAL.test(dig))
  if (brasileiro) return telefoneCanonico(texto)
  if (dig.length >= 8 && dig.length <= 15) return dig
  return null
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

/**
 * Pessoa a partir de um JID solto (menção, mensagem citada).
 * O JID sempre traz o código do país: só canonicaliza (regra do 9 brasileiro) quando ele é
 * o 55 do Brasil; para outros países guarda os dígitos exatamente como vieram, identificáveis
 * mas sem essa lógica — sem isso um celular dos EUA (55155...) virava um número brasileiro inventado.
 */
export function pessoaDoJid(jid: string): Pessoa {
  const usuario = usuarioDoJid(jid)
  const telefone = jid.endsWith('@s.whatsapp.net')
    ? /^55\d{10,11}$/.test(usuario)
      ? telefoneCanonico(usuario)
      : /^\d{8,15}$/.test(usuario)
        ? usuario
        : null
    : null
  return {
    jid,
    telefone,
    lid: jid.endsWith('@lid') ? `${usuario}@lid` : null
  }
}

/** Acha no cadastro: pelo telefone, senão pelo LID. */
export function acharFuncionario(funcionarios: Funcionario[], p: Pessoa): Funcionario | null {
  const tel = chaveTelefone(p.telefone)
  return (tel ? funcionarios.find((f) => f.telefone === tel) : undefined) ?? (p.lid ? funcionarios.find((f) => f.lid === p.lid) : undefined) ?? null
}

/** Quem está no cadastro pelo telefone e ainda não tem LID ganha o LID visto agora (se ninguém mais o tiver). */
export function vinculosDeLid(funcionarios: Funcionario[], pessoas: Pessoa[]): { id: number; lid: string }[] {
  const lidsUsados = new Set(funcionarios.map((f) => f.lid).filter((l): l is string => !!l))
  const ligados = new Set<number>()
  const vinculos: { id: number; lid: string }[] = []
  for (const p of pessoas) {
    const tel = chaveTelefone(p.telefone)
    if (!tel || !p.lid || lidsUsados.has(p.lid)) continue
    const f = funcionarios.find((x) => x.telefone === tel)
    if (!f || f.lid || ligados.has(f.id)) continue
    vinculos.push({ id: f.id, lid: p.lid })
    lidsUsados.add(p.lid)
    ligados.add(f.id)
  }
  return vinculos
}
