import { ZipArchive } from 'archiver'
import type { Readable } from 'node:stream'
import type { ArmazemArquivos } from '../arquivos.js'
import type { Processo } from '../config/tipos.js'
import type { CandidatoPainel } from '../db/repositorio.js'

/** Excel interpreta =, +, -, @ no início como fórmula; o apóstrofo neutraliza. */
export function celula(valor: string | number | null | undefined): string {
  let s = valor == null ? '' : String(valor)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return `"${s.replace(/"/g, '""')}"`
}

export function dataBR(ms: number | null): string {
  if (ms == null) return ''
  return new Date(ms).toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' })
}

export function nomeNoZip(c: CandidatoPainel, indice: number, ext: string): string {
  return `curriculos/${c.protocolo}${indice > 0 ? `-${indice + 1}` : ''}.${ext}`
}

/** Colunas: as perguntas do YAML na ordem, mais respostas antigas que não estão mais no YAML. */
export function colunasDeResposta(p: Processo | undefined, candidatos: CandidatoPainel[]): string[] {
  const doYaml = (p?.perguntas ?? []).filter((q) => q.tipo !== 'arquivo').map((q) => q.chave)
  const extras = new Set<string>()
  for (const c of candidatos) for (const k of Object.keys(c.respostas)) if (!doYaml.includes(k)) extras.add(k)
  return [...doYaml, ...extras]
}

/** CSV com ";" e BOM, que o Excel em português abre direto. */
export function gerarCsv(p: Processo | undefined, candidatos: CandidatoPainel[]): string {
  const colunas = colunasDeResposta(p, candidatos)
  const cabecalho = ['protocolo', 'status', ...colunas, 'telefone', 'data', 'arquivos']
  const linhas = candidatos.map((c) =>
    [
      c.protocolo,
      c.status === 'concluida' ? 'concluída' : 'incompleta',
      ...colunas.map((k) => c.respostas[k] ?? ''),
      c.telefone ?? '',
      dataBR(c.concluidaEm ?? c.criadaEm),
      c.arquivos.map((a, i) => nomeNoZip(c, i, a.ext)).join(' | ')
    ]
      .map(celula)
      .join(';')
  )
  return '﻿' +[cabecalho.map(celula).join(';'), ...linhas].join('\r\n') + '\r\n'
}

export function gerarZip(p: Processo | undefined, candidatos: CandidatoPainel[], armazem: ArmazemArquivos): Readable {
  const zip = new ZipArchive({ zlib: { level: 6 } })
  zip.append(gerarCsv(p, candidatos), { name: 'candidatos.csv' })
  for (const c of candidatos) {
    c.arquivos.forEach((a, i) => zip.file(armazem.absoluto(a.caminho), { name: nomeNoZip(c, i, a.ext) }))
  }
  void zip.finalize()
  return zip
}
