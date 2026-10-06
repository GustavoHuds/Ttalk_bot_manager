import { createHash, randomBytes } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { NovoArquivo } from './db/repositorio.js'

export class ErroAssinatura extends Error {}

const ASSINATURAS: Record<string, number[][]> = {
  pdf: [[0x25, 0x50, 0x44, 0x46]], // %PDF
  docx: [[0x50, 0x4b, 0x03, 0x04]], // ZIP
  doc: [[0xd0, 0xcf, 0x11, 0xe0]], // OLE
  jpg: [[0xff, 0xd8, 0xff]],
  png: [[0x89, 0x50, 0x4e, 0x47]]
}

/** Confere os primeiros bytes: um "currículo.pdf" que não é PDF não entra. */
export function assinaturaConfere(ext: string, dados: Buffer): boolean {
  const opcoes = ASSINATURAS[ext]
  if (!opcoes) return false
  return opcoes.some((bytes) => bytes.every((b, i) => dados[i] === b))
}

/**
 * Currículos ficam fora de qualquer pasta pública, com nome aleatório.
 * O nome do candidato nunca aparece no caminho; ele fica só no banco.
 */
export class ArmazemArquivos {
  readonly raiz: string

  constructor(pastaDados: string) {
    this.raiz = resolve(pastaDados)
  }

  async salvar(processo: string, ext: string, mimetype: string, dados: Buffer, agora: number): Promise<NovoArquivo> {
    if (!assinaturaConfere(ext, dados)) throw new ErroAssinatura(`conteúdo não é ${ext}`)
    const d = new Date(agora)
    const mes = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    const caminho = ['curriculos', processo, mes, `${randomBytes(16).toString('hex')}.${ext}`].join('/')
    const absoluto = this.absoluto(caminho)
    await mkdir(dirname(absoluto), { recursive: true, mode: 0o700 })
    await writeFile(absoluto, dados, { mode: 0o600, flag: 'wx' })
    return { caminho, ext, mimetype, tamanho: dados.length, hash: createHash('sha256').update(dados).digest('hex') }
  }

  async apagar(caminho: string): Promise<void> {
    await rm(this.absoluto(caminho), { force: true })
  }

  /** Resolve o caminho guardado no banco sem deixar escapar da pasta de dados. */
  absoluto(caminho: string): string {
    const abs = resolve(join(this.raiz, caminho))
    if (!abs.startsWith(this.raiz + sep)) throw new Error('caminho fora da pasta de dados')
    return abs
  }
}
