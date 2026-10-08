import type { Banco } from './banco.js'

/** Um número tem um uso só, para os perfis anti-bloqueio não se misturarem. */
export type Papel = 'recrutamento' | 'grupos'
export const PAPEIS: Papel[] = ['recrutamento', 'grupos']

export interface Numero {
  id: number
  nome: string
  papel: Papel
  /** Sem conexão: só volta a ligar quando a tela do número é aberta (para ler o QR). */
  ativo: boolean
  /** Conectado, mas o bot não lê nem envia nada. */
  pausado: boolean
  criadoEm: number
}

interface LinhaNumero {
  id: number
  nome: string
  papel: Papel
  ativo: number
  pausado: number
  criado_em: number
}

const deLinha = (l: LinhaNumero): Numero => ({ id: l.id, nome: l.nome, papel: l.papel, ativo: l.ativo === 1, pausado: l.pausado === 1, criadoEm: l.criado_em })

/** Números de WhatsApp. Nunca são apagados (outras tabelas guardam numero_id); só desativados. */
export class RepoNumeros {
  constructor(private readonly db: Banco) {}

  listar(): Numero[] {
    return (this.db.prepare(`SELECT * FROM numeros ORDER BY id`).all() as LinhaNumero[]).map(deLinha)
  }

  numero(id: number): Numero | null {
    const l = this.db.prepare(`SELECT * FROM numeros WHERE id = ?`).get(id) as LinhaNumero | undefined
    return l ? deLinha(l) : null
  }

  criar(nome: string, papel: Papel, agora: number): Numero {
    const r = this.db.prepare(`INSERT INTO numeros (nome, papel, ativo, criado_em) VALUES (?, ?, 1, ?)`).run(nome, papel, agora)
    return this.numero(Number(r.lastInsertRowid))!
  }

  definirAtivo(id: number, ativo: boolean): void {
    this.db.prepare(`UPDATE numeros SET ativo = ? WHERE id = ?`).run(ativo ? 1 : 0, id)
  }

  definirPausado(id: number, pausado: boolean): void {
    this.db.prepare(`UPDATE numeros SET pausado = ? WHERE id = ?`).run(pausado ? 1 : 0, id)
  }

  renomear(id: number, nome: string): void {
    this.db.prepare(`UPDATE numeros SET nome = ? WHERE id = ?`).run(nome, id)
  }
}
