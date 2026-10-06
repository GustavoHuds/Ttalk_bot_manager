import type { Logger } from 'pino'
import type { ArmazemArquivos } from '../arquivos.js'
import { situacao } from '../config/carregar.js'
import type { ConfigCarregada } from '../config/tipos.js'
import type { Repositorio } from '../db/repositorio.js'

export function somarMeses(ms: number, meses: number): number {
  const d = new Date(ms)
  d.setUTCMonth(d.getUTCMonth() + meses)
  return d.getTime()
}

export interface ResultadoRetencao {
  apagados: { processo: string; candidaturas: number }[]
  semConfig: string[]
}

/**
 * Apaga candidaturas, respostas e currículos de processos encerrados há mais de
 * `retencao_meses`. Processos sem YAML não são tocados (ficam listados para conferência).
 */
export async function aplicarRetencao(d: {
  repo: Repositorio
  config: ConfigCarregada
  armazem: ArmazemArquivos
  log: Logger
  agora: number
}): Promise<ResultadoRetencao> {
  const resultado: ResultadoRetencao = { apagados: [], semConfig: [] }
  for (const codigo of d.repo.processosComDados()) {
    const p = d.config.processos.find((x) => x.codigo === codigo)
    if (!p) {
      resultado.semConfig.push(codigo)
      continue
    }
    if (situacao(p, d.agora) !== 'fechado') continue
    const fim = p.status === 'encerrado' ? Math.min(p.encerraEm, d.agora) : p.encerraEm
    if (d.agora <= somarMeses(fim, p.retencaoMeses)) continue

    const { quantidade, caminhos } = d.repo.transacao(() => {
      const r = d.repo.excluirProcesso(codigo)
      d.repo.auditar('sistema', 'retencao', `${codigo}: ${r.quantidade} candidaturas apagadas`, d.agora)
      return r
    })
    for (const c of caminhos) await d.armazem.apagar(c)
    resultado.apagados.push({ processo: codigo, candidaturas: quantidade })
    d.log.info({ processo: codigo, quantidade }, 'retenção aplicada')
  }
  if (resultado.semConfig.length) d.log.warn({ processos: resultado.semConfig }, 'há dados de processos sem arquivo YAML')
  d.repo.limparRegistrosTecnicos(d.agora)
  return resultado
}
