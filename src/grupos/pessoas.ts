import { normalizarTelefone } from '../conversa/motor.js'
import type { Funcionario } from '../db/grupos.js'
import type { Pessoa } from './tipos.js'

/**
 * Forma única de guardar e comparar telefones: 55 + DDD + número, com o 9 dos celulares.
 * O WhatsApp ainda entrega alguns celulares antigos com 8 dígitos (55 83 9999-0001); aqui o 9 volta.
 */
export function telefoneCanonico(texto: string | null | undefined): string | null {
  if (!texto) return null
  const t = normalizarTelefone(texto)
  if (!t) return null
  // 55 + DDD + 8 dígitos começando em 6-9 é celular sem o 9.
  if (t.length === 12 && /[6-9]/.test(t[4]!)) return `${t.slice(0, 4)}9${t.slice(4)}`
  return t
}

/** "+55 83 99999-0001" */
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
    telefone: jid.endsWith('@s.whatsapp.net') ? telefoneCanonico(usuario) : null,
    lid: jid.endsWith('@lid') ? `${usuario}@lid` : null
  }
}

/** Acha no cadastro: pelo telefone, senão pelo LID. */
export function acharFuncionario(funcionarios: Funcionario[], p: Pessoa): Funcionario | null {
  const tel = telefoneCanonico(p.telefone)
  return (tel ? funcionarios.find((f) => f.telefone === tel) : undefined) ?? (p.lid ? funcionarios.find((f) => f.lid === p.lid) : undefined) ?? null
}

/** Quem está no cadastro pelo telefone e ainda não tem LID ganha o LID visto agora (se ninguém mais o tiver). */
export function vinculosDeLid(funcionarios: Funcionario[], pessoas: Pessoa[]): { id: number; lid: string }[] {
  const lidsUsados = new Set(funcionarios.map((f) => f.lid).filter((l): l is string => !!l))
  const ligados = new Set<number>()
  const vinculos: { id: number; lid: string }[] = []
  for (const p of pessoas) {
    const tel = telefoneCanonico(p.telefone)
    if (!tel || !p.lid || lidsUsados.has(p.lid)) continue
    const f = funcionarios.find((x) => x.telefone === tel)
    if (!f || f.lid || ligados.has(f.id)) continue
    vinculos.push({ id: f.id, lid: p.lid })
    lidsUsados.add(p.lid)
    ligados.add(f.id)
  }
  return vinculos
}
