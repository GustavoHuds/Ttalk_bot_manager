import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { parse } from 'yaml'
import { readFileSync } from 'node:fs'
import { validarMensagens, validarProcesso } from '../src/config/carregar.js'
import type { ConfigCarregada, Processo } from '../src/config/tipos.js'

export const log = pino({ level: 'silent' })

export const padrao = validarMensagens(
  parse(readFileSync(join(import.meta.dirname, '..', 'config', 'mensagens-padrao.yaml'), 'utf8')),
  'padrao'
)

/** 10/10/2026 12:00 em Brasília */
export const AGORA = Date.UTC(2026, 9, 10, 15)

export function processo(extra: Record<string, unknown> = {}): Processo {
  return validarProcesso(
    {
      codigo: 'VEND-OUT26',
      vaga: 'Vendedor(a) de loja',
      status: 'aberto',
      abre_em: '2026-10-06',
      encerra_em: '2026-10-31',
      retencao_meses: 12,
      perguntas: [
        { chave: 'nome', tipo: 'texto', validacao: 'nome_completo' },
        { chave: 'cidade', tipo: 'texto' },
        { chave: 'disponibilidade', tipo: 'enquete', opcoes: ['Manhã', 'Tarde', 'Integral', 'Escala 6x1'] },
        { chave: 'pretensao', tipo: 'texto' },
        { chave: 'curriculo', tipo: 'arquivo', formatos: ['pdf', 'docx', 'jpg', 'png'], tamanho_max_mb: 10 }
      ],
      ...extra
    },
    padrao,
    'teste.yaml'
  )
}

export function config(processos: Processo[]): ConfigCarregada {
  return { processos, padrao, empresa: 'Loja Exemplo', erros: [], carregadaEm: AGORA }
}

export function pastaTemp(): string {
  return mkdtempSync(join(tmpdir(), 'bot-rh-'))
}

export const PDF = Buffer.from('%PDF-1.7\n conteúdo de teste')
export const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
