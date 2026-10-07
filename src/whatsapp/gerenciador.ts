import { existsSync } from 'node:fs'
import { cp, mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Logger } from 'pino'
import type { Numero } from '../db/numeros.js'
import type { EstadoConexao } from './baileys.js'

/** O que o gerenciador precisa de uma conexão (ConexaoBaileys hoje). */
export interface ConexaoGerida {
  readonly estadoAtual: EstadoConexao
  iniciar(): Promise<void>
  parar(): Promise<void>
  novaSessao(): Promise<void>
}

/** Expedidor de recrutamento ou de grupos. */
export interface ExpedidorGerido {
  iniciar(): void
  parar(): void
  acordar(): Promise<void>
}

export interface LinhaNumero<C extends ConexaoGerida> {
  conexao: C
  expedidor: ExpedidorGerido
}

export function pastaSessaoNumero(dados: string, numeroId: number): string {
  return join(dados, 'sessoes', String(numeroId))
}

/**
 * A sessão de antes dos vários números (data/sessao) vira a do número 1, sem precisar
 * ler o QR de novo. Só move se o destino ainda não existe.
 */
export async function moverSessaoAntiga(dados: string): Promise<boolean> {
  const antiga = join(dados, 'sessao')
  const nova = pastaSessaoNumero(dados, 1)
  if (!existsSync(antiga) || existsSync(nova)) return false
  await mkdir(join(dados, 'sessoes'), { recursive: true, mode: 0o700 })
  try {
    await rename(antiga, nova)
  } catch (err) {
    // Windows/OneDrive e volumes Docker podem não permitir rename entre dispositivos.
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await cp(antiga, nova, { recursive: true })
    await rm(antiga, { recursive: true, force: true })
  }
  return true
}

/** Uma conexão e um expedidor por número ativo, no mesmo processo. */
export class GerenciadorConexoes<C extends ConexaoGerida> {
  private linhas = new Map<number, LinhaNumero<C>>()

  constructor(
    private readonly criar: (numero: Numero) => LinhaNumero<C>,
    private readonly log: Logger
  ) {}

  async iniciarTodos(numeros: Numero[]): Promise<void> {
    for (const n of numeros) if (n.ativo) await this.adicionar(n)
  }

  /** Liga um número. Chamar de novo para um número já ligado não faz nada. */
  async adicionar(numero: Numero): Promise<void> {
    if (this.linhas.has(numero.id)) return
    let linha: LinhaNumero<C>
    try {
      linha = this.criar(numero)
    } catch (err) {
      this.linhas.delete(numero.id)
      throw err
    }
    this.linhas.set(numero.id, linha)
    try {
      await linha.conexao.iniciar()
    } catch (err) {
      // A conexão tenta de novo sozinha quando cai; aqui só falhou a primeira abertura (pasta, rede).
      this.log.error({ err, numero: numero.id }, 'falha ao iniciar a conexão do número')
    }
    linha.expedidor.iniciar()
  }

  async parar(numeroId: number): Promise<void> {
    const linha = this.linhas.get(numeroId)
    if (!linha) return
    this.linhas.delete(numeroId)
    linha.expedidor.parar()
    await linha.conexao.parar()
  }

  async pararTodos(): Promise<void> {
    for (const id of [...this.linhas.keys()]) await this.parar(id)
  }

  async novaSessao(numeroId: number): Promise<void> {
    const linha = this.linhas.get(numeroId)
    if (!linha) throw new Error('número desativado')
    await linha.conexao.novaSessao()
  }

  conexao(numeroId: number): C | null {
    return this.linhas.get(numeroId)?.conexao ?? null
  }

  estado(numeroId: number): EstadoConexao | null {
    return this.linhas.get(numeroId)?.conexao.estadoAtual ?? null
  }

  estados(): Map<number, EstadoConexao> {
    return new Map([...this.linhas].map(([id, l]) => [id, l.conexao.estadoAtual]))
  }

  /** Avisa o expedidor do número que há algo novo na caixa de saída. */
  acordar(numeroId: number): void {
    void this.linhas.get(numeroId)?.expedidor.acordar()
  }
}
