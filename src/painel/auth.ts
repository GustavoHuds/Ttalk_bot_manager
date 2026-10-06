import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/** Formato guardado no .env: scrypt$<sal base64>$<hash base64> */
export function hashSenha(senha: string): string {
  const sal = randomBytes(16)
  return `scrypt$${sal.toString('base64')}$${scryptSync(senha, sal, 64).toString('base64')}`
}

export function senhaConfere(senha: string, guardado: string): boolean {
  const [alg, sal, hash] = guardado.split('$')
  if (alg !== 'scrypt' || !sal || !hash) return false
  const esperado = Buffer.from(hash, 'base64')
  const calculado = scryptSync(senha, Buffer.from(sal, 'base64'), esperado.length)
  return timingSafeEqual(esperado, calculado)
}

/** PAINEL_USUARIOS="ana:scrypt$...;joao:scrypt$..." */
export function lerUsuarios(bruto: string): Map<string, string> {
  const mapa = new Map<string, string>()
  for (const par of bruto.split(';').map((p) => p.trim()).filter(Boolean)) {
    const i = par.indexOf(':')
    if (i <= 0) throw new Error('PAINEL_USUARIOS deve ter o formato nome:hash;nome2:hash2')
    mapa.set(par.slice(0, i).trim(), par.slice(i + 1).trim())
  }
  return mapa
}

const BLOQUEIO_MS = 15 * 60 * 1000
const MAX_FALHAS = 5

/** Bloqueia o IP por 15 min depois de 5 senhas erradas. */
export class LimiteLogin {
  private falhas = new Map<string, { n: number; ate: number }>()

  bloqueado(ip: string, agora: number): boolean {
    const f = this.falhas.get(ip)
    return !!f && f.n >= MAX_FALHAS && f.ate > agora
  }

  falhou(ip: string, agora: number): void {
    const f = this.falhas.get(ip)
    const n = f && f.ate > agora ? f.n + 1 : 1
    this.falhas.set(ip, { n, ate: agora + BLOQUEIO_MS })
  }

  acertou(ip: string): void {
    this.falhas.delete(ip)
  }
}
