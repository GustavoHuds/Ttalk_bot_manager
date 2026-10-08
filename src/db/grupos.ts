import type { Banco } from './banco.js'

export interface Grupo {
  numeroId: number
  jid: string
  nome: string
  botAdmin: boolean
  /** false quando o número saiu ou foi removido do grupo. */
  ativo: boolean
  atualizadoEm: number
}

export interface DadosFuncionario {
  nome: string
  /** Chave do telefone: brasileiro canônico (55+DDD+número com o 9) ou dígitos com DDI para outros países. */
  telefone: string | null
  /** JID @lid, quando o WhatsApp esconde o número. Só o WhatsApp o informa. */
  lid: string | null
  setor: string | null
  loja: string | null
  cargo: string | null
  /** AAAA-MM-DD */
  nascimento: string | null
  ativo: boolean
}

export interface Funcionario extends DadosFuncionario {
  id: number
  /** Quando a pessoa provou, por código no privado de um bot, que este WhatsApp é dela. */
  confirmadoEm: number | null
}

export interface ItemSaidaGrupo {
  id: number
  jid: string
  conteudo: string
  tentativas: number
  proximaEm: number
  criadaEm: number
}

interface LinhaGrupo {
  numero_id: number
  jid: string
  nome: string
  bot_admin: number
  ativo: number
  atualizado_em: number
}

interface LinhaFuncionario {
  id: number
  nome: string
  telefone: string | null
  lid: string | null
  setor: string | null
  loja: string | null
  cargo: string | null
  nascimento: string | null
  ativo: number
  confirmado_em: number | null
}

const grupoDe = (l: LinhaGrupo): Grupo => ({
  numeroId: l.numero_id,
  jid: l.jid,
  nome: l.nome,
  botAdmin: l.bot_admin === 1,
  ativo: l.ativo === 1,
  atualizadoEm: l.atualizado_em
})

const funcionarioDe = (l: LinhaFuncionario): Funcionario => ({
  id: l.id,
  nome: l.nome,
  telefone: l.telefone,
  lid: l.lid,
  setor: l.setor,
  loja: l.loja,
  cargo: l.cargo,
  nascimento: l.nascimento,
  ativo: l.ativo === 1,
  confirmadoEm: l.confirmado_em
})

const COLUNAS_FUNCIONARIO = `id, nome, telefone, lid, setor, loja, cargo, nascimento, ativo, confirmado_em`
const COLUNAS_GRUPO = `numero_id, jid, nome, bot_admin, ativo, atualizado_em`

/** Grupos de cada número (lista geral), equipe e caixa de saída do bot de grupos. Usa o mesmo banco (e as mesmas transações) do Repositorio. */
export class RepoGrupos {
  constructor(private readonly db: Banco) {}

  // --- grupos ---------------------------------------------------------------------

  /** Grupos onde o bot está, neste número. */
  grupos(numeroId: number): Grupo[] {
    return (
      this.db
        .prepare(`SELECT ${COLUNAS_GRUPO} FROM grupos WHERE numero_id = ? AND ativo = 1 ORDER BY nome COLLATE NOCASE`)
        .all(numeroId) as LinhaGrupo[]
    ).map(grupoDe)
  }

  /** Todos, de todos os números, inclusive os que o bot deixou (para o painel). */
  todosGrupos(): Grupo[] {
    return (
      this.db
        .prepare(`SELECT ${COLUNAS_GRUPO} FROM grupos ORDER BY numero_id, ativo DESC, nome COLLATE NOCASE`)
        .all() as LinhaGrupo[]
    ).map(grupoDe)
  }

  grupo(numeroId: number, jid: string): Grupo | null {
    const l = this.db.prepare(`SELECT ${COLUNAS_GRUPO} FROM grupos WHERE numero_id = ? AND jid = ?`).get(numeroId, jid) as
      | LinhaGrupo
      | undefined
    return l ? grupoDe(l) : null
  }

  /** Número entrou ou o grupo foi relido: grava nome e admin. */
  salvarGrupo(numeroId: number, jid: string, nome: string, botAdmin: boolean, agora: number): void {
    this.db
      .prepare(
        `INSERT INTO grupos (numero_id, jid, nome, bot_admin, ativo, atualizado_em) VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT (numero_id, jid) DO UPDATE SET nome = excluded.nome, bot_admin = excluded.bot_admin, ativo = 1,
           atualizado_em = excluded.atualizado_em`
      )
      .run(numeroId, jid, nome, botAdmin ? 1 : 0, agora)
  }

  definirBotAdmin(numeroId: number, jid: string, admin: boolean, agora: number): void {
    this.db
      .prepare(`UPDATE grupos SET bot_admin = ?, atualizado_em = ? WHERE numero_id = ? AND jid = ?`)
      .run(admin ? 1 : 0, agora, numeroId, jid)
  }

  renomearGrupo(numeroId: number, jid: string, nome: string, agora: number): void {
    this.db.prepare(`UPDATE grupos SET nome = ?, atualizado_em = ? WHERE numero_id = ? AND jid = ?`).run(nome, agora, numeroId, jid)
  }

  desativarGrupo(numeroId: number, jid: string, agora: number): void {
    this.db
      .prepare(`UPDATE grupos SET ativo = 0, bot_admin = 0, atualizado_em = ? WHERE numero_id = ? AND jid = ?`)
      .run(agora, numeroId, jid)
  }

  /**
   * Depois de reler a lista completa do WhatsApp: o que não veio é grupo de onde o bot saiu.
   * Quem chama já roda isto dentro de uma transação.
   */
  desativarAusentes(numeroId: number, presentes: string[], agora: number): number {
    const presentesSet = new Set(presentes)
    const sairam = this.grupos(numeroId).filter((g) => !presentesSet.has(g.jid))
    for (const g of sairam) this.desativarGrupo(numeroId, g.jid, agora)
    return sairam.length
  }

  // --- equipe ---------------------------------------------------------------------

  funcionarios(): Funcionario[] {
    return (
      this.db.prepare(`SELECT ${COLUNAS_FUNCIONARIO} FROM funcionarios ORDER BY nome COLLATE NOCASE, id`).all() as LinhaFuncionario[]
    ).map(funcionarioDe)
  }

  funcionario(id: number): Funcionario | null {
    const l = this.db.prepare(`SELECT ${COLUNAS_FUNCIONARIO} FROM funcionarios WHERE id = ?`).get(id) as LinhaFuncionario | undefined
    return l ? funcionarioDe(l) : null
  }

  porTelefone(telefone: string): Funcionario | null {
    const l = this.db.prepare(`SELECT ${COLUNAS_FUNCIONARIO} FROM funcionarios WHERE telefone = ?`).get(telefone) as
      | LinhaFuncionario
      | undefined
    return l ? funcionarioDe(l) : null
  }

  /**
   * Cria (id null) ou substitui todos os campos. Telefone ou LID repetidos violam UNIQUE e lançam erro.
   * Lança erro também se `id` não existir.
   */
  salvarFuncionario(id: number | null, d: DadosFuncionario, agora: number): number {
    const valores = [d.nome, d.telefone, d.lid, d.setor, d.loja, d.cargo, d.nascimento, d.ativo ? 1 : 0]
    if (id === null) {
      const r = this.db
        .prepare(
          `INSERT INTO funcionarios (nome, telefone, lid, setor, loja, cargo, nascimento, ativo, criado_em, atualizado_em)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(...valores, agora, agora)
      return Number(r.lastInsertRowid)
    }
    const r = this.db
      .prepare(
        `UPDATE funcionarios SET nome = ?, telefone = ?, lid = ?, setor = ?, loja = ?, cargo = ?, nascimento = ?, ativo = ?,
           atualizado_em = ? WHERE id = ?`
      )
      .run(...valores, agora, id)
    if (r.changes !== 1) throw new Error('funcionário não encontrado')
    return id
  }

  /** Liga o LID visto no WhatsApp a quem ainda não tinha. Nunca troca um LID já gravado. */
  vincularLid(id: number, lid: string, agora: number): void {
    this.db.prepare(`UPDATE funcionarios SET lid = ?, atualizado_em = ? WHERE id = ? AND lid IS NULL`).run(lid, agora, id)
  }

  /** Correção feita pelo painel (divergência aceita) ou telefone que faltava, visto na confirmação. */
  definirTelefone(id: number, telefone: string, agora: number): void {
    this.db.prepare(`UPDATE funcionarios SET telefone = ?, atualizado_em = ? WHERE id = ?`).run(telefone, agora, id)
  }

  /** Ao contrário de vincularLid, troca um LID já gravado: só a confirmação por código pode fazer isso. */
  definirLid(id: number, lid: string, agora: number): void {
    this.db.prepare(`UPDATE funcionarios SET lid = ?, atualizado_em = ? WHERE id = ?`).run(lid, agora, id)
  }

  confirmarFuncionario(id: number, agora: number): void {
    this.db.prepare(`UPDATE funcionarios SET confirmado_em = ?, atualizado_em = ? WHERE id = ?`).run(agora, agora, id)
  }

  excluirFuncionario(id: number): boolean {
    return this.db.prepare(`DELETE FROM funcionarios WHERE id = ?`).run(id).changes === 1
  }

  // --- caixa de entrada: só o ID do comando, para descartar repetidas -------------

  comandoVisto(numeroId: number, id: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM mensagens_processadas WHERE numero_id = ? AND id = ?`).get(numeroId, id)
  }

  /** Devolve false se outra entrega da mesma mensagem já foi registrada. Nada do conteúdo é guardado. */
  registrarComando(numeroId: number, id: string, chat: string, recebidaEm: number): boolean {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO mensagens_processadas (numero_id, id, jid, recebida_em, status) VALUES (?, ?, ?, ?, 'processada')`
      )
      .run(numeroId, id, chat, recebidaEm)
    return r.changes === 1
  }

  // --- caixa de saída -------------------------------------------------------------

  enfileirarSaida(numeroId: number, jid: string, conteudo: string, agora: number): void {
    this.db.prepare(`INSERT INTO saida_grupos (numero_id, jid, conteudo, criada_em) VALUES (?, ?, ?, ?)`).run(numeroId, jid, conteudo, agora)
  }

  /** Só o jid cuja mensagem mais antiga (a próxima a sair) já está pronta: uma com reenvio agendado segura as de trás. */
  jidsComSaida(numeroId: number, agora: number): string[] {
    return (
      this.db
        .prepare(
          `SELECT jid FROM saida_grupos s WHERE numero_id = ? AND proxima_em <= ?
             AND id = (SELECT MIN(id) FROM saida_grupos WHERE numero_id = s.numero_id AND jid = s.jid)
           ORDER BY id`
        )
        .all(numeroId, agora) as { jid: string }[]
    ).map((r) => r.jid)
  }

  /** Mensagens saem na ordem em que foram criadas; uma com reenvio agendado segura as de trás. */
  proximaSaida(numeroId: number, jid: string): ItemSaidaGrupo | null {
    const r = this.db
      .prepare(
        `SELECT id, jid, conteudo, tentativas, proxima_em AS proximaEm, criada_em AS criadaEm FROM saida_grupos
         WHERE numero_id = ? AND jid = ? ORDER BY id LIMIT 1`
      )
      .get(numeroId, jid) as ItemSaidaGrupo | undefined
    return r ?? null
  }

  removerSaida(id: number): void {
    this.db.prepare(`DELETE FROM saida_grupos WHERE id = ?`).run(id)
  }

  adiarSaida(id: number, proximaEm: number): void {
    this.db.prepare(`UPDATE saida_grupos SET tentativas = tentativas + 1, proxima_em = ? WHERE id = ?`).run(proximaEm, id)
  }
}
