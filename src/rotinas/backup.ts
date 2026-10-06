import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import * as tar from 'tar'
import type { Banco } from '../db/banco.js'

const MAGICO = Buffer.from('BELBK1')
const TAM_SAL = 16
const TAM_IV = 12
const TAM_TAG = 16
const CABECALHO = MAGICO.length + TAM_SAL + TAM_IV
const DIA_MS = 24 * 60 * 60 * 1000

function chave(senha: string, sal: Buffer): Buffer {
  return scryptSync(senha, sal, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
}

/**
 * Gera data/backups/backup-AAAA-MM-DD.tar.gz.enc com o banco (cópia consistente),
 * os currículos e a sessão do WhatsApp. Cifra AES-256-GCM com chave derivada da senha.
 */
export async function fazerBackup(o: { db: Banco; dados: string; senha: string; agora: number }): Promise<string> {
  const pasta = join(o.dados, 'backups')
  const temp = join(pasta, `.tmp-${o.agora}`)
  await mkdir(temp, { recursive: true, mode: 0o700 })
  const dia = new Date(o.agora - 3 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const destino = join(pasta, `backup-${dia}.tar.gz.enc`)
  try {
    await o.db.backup(join(temp, 'banco.sqlite'))
    const itens = [`backups/.tmp-${o.agora}/banco.sqlite`, 'curriculos', 'sessao'].filter((i) => existsSync(join(o.dados, i)))

    const sal = randomBytes(TAM_SAL)
    const iv = randomBytes(TAM_IV)
    const cifra = createCipheriv('aes-256-gcm', chave(o.senha, sal), iv)
    const saida = createWriteStream(`${destino}.parcial`, { mode: 0o600 })
    saida.write(Buffer.concat([MAGICO, sal, iv]))
    await pipeline(tar.c({ gzip: true, cwd: o.dados, portable: true }, itens), cifra, saida, { end: false })
    await new Promise<void>((ok, erro) => saida.end(cifra.getAuthTag(), (e?: Error | null) => (e ? erro(e) : ok())))
    await rename(`${destino}.parcial`, destino)
    return destino
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

/** Abre um backup e extrai para `pastaDestino`. Erra se a senha estiver errada ou o arquivo alterado. */
export async function restaurarBackup(arquivo: string, senha: string, pastaDestino: string): Promise<void> {
  const { size } = await stat(arquivo)
  const fd = await open(arquivo, 'r')
  const cab = Buffer.alloc(CABECALHO)
  const tag = Buffer.alloc(TAM_TAG)
  try {
    await fd.read(cab, 0, CABECALHO, 0)
    await fd.read(tag, 0, TAM_TAG, size - TAM_TAG)
  } finally {
    await fd.close()
  }
  if (!cab.subarray(0, MAGICO.length).equals(MAGICO)) throw new Error('arquivo não é um backup do bot')
  const sal = cab.subarray(MAGICO.length, MAGICO.length + TAM_SAL)
  const iv = cab.subarray(MAGICO.length + TAM_SAL, CABECALHO)
  const decifra = createDecipheriv('aes-256-gcm', chave(senha, sal), iv)
  decifra.setAuthTag(tag)
  await mkdir(pastaDestino, { recursive: true })
  await pipeline(
    createReadStream(arquivo, { start: CABECALHO, end: size - TAM_TAG - 1 }),
    decifra,
    tar.x({ cwd: pastaDestino })
  )
}

export async function apagarBackupsAntigos(dados: string, dias: number, agora: number): Promise<number> {
  const pasta = join(dados, 'backups')
  let apagados = 0
  for (const nome of await readdir(pasta).catch(() => [] as string[])) {
    if (!nome.startsWith('backup-')) continue
    const { mtimeMs } = await stat(join(pasta, nome))
    if (agora - mtimeMs > dias * DIA_MS) {
      await rm(join(pasta, nome), { force: true })
      apagados++
    }
  }
  return apagados
}
