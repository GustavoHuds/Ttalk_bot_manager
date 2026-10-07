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

interface SistemaArquivos {
  rename: typeof rename
  cp: typeof cp
  rm: typeof rm
  mkdir: typeof mkdir
}

const fsPadrao: SistemaArquivos = { rename, cp, rm, mkdir }

function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const CODIGOS_TEMPORARIOS = new Set(['EPERM', 'EBUSY', 'EACCES'])

/**
 * Tenta renomear até 5 vezes, com uma pequena espera entre tentativas: no Windows/OneDrive
 * o antivírus ou o indexador pode segurar a pasta por um instante (EPERM/EBUSY/EACCES).
 * Devolve false em EXDEV, ou se insistir não ajudou, para o chamador cair para a cópia.
 */
async function tentarRenomear(fs: SistemaArquivos, antiga: string, nova: string): Promise<boolean> {
  for (let tentativa = 1; tentativa <= 5; tentativa++) {
    try {
      await fs.rename(antiga, nova)
      return true
    } catch (err) {
      const codigo = (err as NodeJS.ErrnoException).code
      if (codigo === 'EXDEV') return false
      if (!codigo || !CODIGOS_TEMPORARIOS.has(codigo)) throw err
      if (tentativa < 5) await esperar(200)
    }
  }
  return false
}

/**
 * A sessão de antes dos vários números (data/sessao) vira a do número 1, sem precisar
 * ler o QR de novo. Só move se o destino ainda não existe.
 */
export async function moverSessaoAntiga(dados: string, fs: SistemaArquivos = fsPadrao): Promise<boolean> {
  const antiga = join(dados, 'sessao')
  const nova = pastaSessaoNumero(dados, 1)
  if (!existsSync(antiga) || existsSync(nova)) return false
  await fs.mkdir(join(dados, 'sessoes'), { recursive: true, mode: 0o700 })

  if (await tentarRenomear(fs, antiga, nova)) return true

  // EXDEV, ou EPERM/EBUSY/EACCES que não cederam: Windows/OneDrive e volumes Docker podem não
  // permitir mover entre dispositivos. Copia para uma pasta parcial e só troca o nome no final,
  // para nunca deixar a pasta do número 1 pela metade.
  const parcial = `${nova}.parcial`
  if (existsSync(parcial)) await fs.rm(parcial, { recursive: true, force: true })
  try {
    await fs.cp(antiga, parcial, { recursive: true })
    await fs.rename(parcial, nova)
  } catch (err) {
    await fs.rm(parcial, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }
  // Se só a limpeza da pasta antiga falhar, a sessão já está em sessoes/1: não é erro.
  // Quem chamou (main.ts) é quem loga o sucesso; aqui não há log nenhum de propósito.
  await fs.rm(antiga, { recursive: true, force: true }).catch(() => undefined)
  return true
}

/** Uma conexão e um expedidor por número ativo, no mesmo processo. */
export class GerenciadorConexoes<C extends ConexaoGerida> {
  private linhas = new Map<number, LinhaNumero<C>>()
  /** Uma fila por número: adicionar/parar/novaSessao do mesmo número nunca correm ao mesmo tempo. */
  private fila = new Map<number, Promise<unknown>>()

  constructor(
    private readonly criar: (numero: Numero) => LinhaNumero<C>,
    private readonly log: Logger
  ) {}

  /**
   * Encadeia `fn` depois da última operação pendente para este número (ignorando se ela
   * falhou), para que duas chamadas para o mesmo número nunca rodem em paralelo. Sem isso,
   * um parar/novaSessao no meio de um adicionar() (que espera a abertura da sessão, às vezes
   * por segundos) deixaria um soquete ou um expedidor órfão.
   */
  private porNumero<T>(id: number, fn: () => Promise<T>): Promise<T> {
    const anterior = this.fila.get(id) ?? Promise.resolve()
    const vez = anterior.then(fn, fn)
    const encadeada = vez.then(
      () => undefined,
      () => undefined
    )
    this.fila.set(id, encadeada)
    void encadeada.finally(() => {
      if (this.fila.get(id) === encadeada) this.fila.delete(id)
    })
    return vez
  }

  async iniciarTodos(numeros: Numero[]): Promise<void> {
    for (const n of numeros) if (n.ativo) await this.adicionar(n)
  }

  /** Liga um número. Chamar de novo para um número já ligado não faz nada. */
  async adicionar(numero: Numero): Promise<void> {
    return this.porNumero(numero.id, () => this.adicionarAgora(numero))
  }

  private async adicionarAgora(numero: Numero): Promise<void> {
    if (this.linhas.has(numero.id)) return
    const linha = this.criar(numero)
    this.linhas.set(numero.id, linha)
    try {
      await linha.conexao.iniciar()
    } catch (err) {
      // A conexão tenta de novo sozinha quando cai; aqui só falhou a primeira abertura (pasta, rede).
      this.log.error({ err, numero: numero.id }, 'falha ao iniciar a conexão do número')
    }
    // Um parar()/novaSessao() pode ter tirado esta linha do mapa enquanto iniciar() esperava:
    // só liga o expedidor se a linha ainda for a mesma, senão fica um expedidor órfão.
    if (this.linhas.get(numero.id) === linha) linha.expedidor.iniciar()
  }

  async parar(numeroId: number): Promise<void> {
    const linha = this.linhas.get(numeroId)
    if (!linha) return
    // Tira a linha do mapa já, na hora: é o que avisa um adicionar() em andamento (via a
    // checagem acima) que esta conexão não é mais a atual.
    this.linhas.delete(numeroId)
    return this.porNumero(numeroId, async () => {
      linha.expedidor.parar()
      try {
        await linha.conexao.parar()
      } catch (err) {
        this.log.error({ err, numero: numeroId }, 'falha ao parar a conexão do número')
      }
    })
  }

  async pararTodos(): Promise<void> {
    for (const id of [...this.linhas.keys()]) {
      try {
        await this.parar(id)
      } catch (err) {
        this.log.error({ err, numero: id }, 'falha ao parar o número')
      }
    }
  }

  async novaSessao(numeroId: number): Promise<void> {
    return this.porNumero(numeroId, async () => {
      const linha = this.linhas.get(numeroId)
      if (!linha) throw new Error('número desativado')
      await linha.conexao.novaSessao()
    })
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
    const expedidor = this.linhas.get(numeroId)?.expedidor
    if (!expedidor) return
    void expedidor.acordar().catch((err) => this.log.error({ err, numero: numeroId }, 'falha ao acordar o expedidor'))
  }
}
