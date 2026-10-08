import { randomInt } from 'node:crypto'
import type { Banco } from './banco.js'

/** Bot de grupos: entidade própria, separada do número que ele usa no momento. */
export interface BotGrupos {
  id: number
  nome: string
  /** null = ainda sem número (ou o número foi tirado dele). */
  numeroId: number | null
  ativo: boolean
  criadoEm: number
}

export interface Loja {
  id: number
  botId: number
  nome: string
}

export interface GrupoAtivo {
  botId: number
  jid: string
  lojaId: number | null
  /** Nome da loja (da lista do bot), ou null. */
  loja: string | null
  setor: string | null
  ativadoEm: number
  ativadoPor: string
}

/** Participante de um grupo ativo: só identidade e admin, nunca nome ou mensagem. */
export interface Participante {
  jid: string
  telefone: string | null
  lid: string | null
  admin: boolean
}

export interface GestorBot {
  botId: number
  funcionarioId: number
  /** Código enquanto pendente; null depois de confirmado. */
  codigo: string | null
  codigoExpiraEm: number | null
  /** null = pendente: sem poder nenhum. */
  confirmadoEm: number | null
  confirmadoJid: string | null
  /** Código certo vindo de um WhatsApp diferente do cadastro: espera alguém conferir no painel. */
  divergenteJid: string | null
  divergenteTelefone: string | null
  divergenteEm: number | null
  adicionadoPor: string
  adicionadoEm: number
}

export type QuemUsa = 'todos' | 'gestores'
export type OndeVale = 'grupo' | 'privado' | 'ambos'

/** Linha de comandos_bot: ajuste de um comando pronto ou um comando personalizado. */
export interface ComandoSalvo {
  nome: string
  ligado: boolean
  personalizado: boolean
  quem: QuemUsa | null
  onde: OndeVale | null
  descricao: string | null
  resposta: string | null
  /** Textos editados de um comando pronto ({chave: texto}); vazio = todos os originais. */
  textos: Record<string, string>
}

export interface DadosPersonalizado {
  nome: string
  descricao: string
  quem: QuemUsa
  onde: OndeVale
  resposta: string
}

export const VALIDADE_CODIGO_MS = 48 * 60 * 60 * 1000

interface LinhaBot {
  id: number
  nome: string
  numero_id: number | null
  ativo: number
  criado_em: number
}

interface LinhaGrupoAtivo {
  bot_id: number
  jid: string
  loja_id: number | null
  loja: string | null
  setor: string | null
  ativado_em: number
  ativado_por: string
}

interface LinhaGestor {
  bot_id: number
  funcionario_id: number
  codigo: string | null
  codigo_expira_em: number | null
  confirmado_em: number | null
  confirmado_jid: string | null
  divergente_jid: string | null
  divergente_telefone: string | null
  divergente_em: number | null
  adicionado_por: string
  adicionado_em: number
}

interface LinhaComando {
  nome: string
  ligado: number
  personalizado: number
  quem: QuemUsa | null
  onde: OndeVale | null
  descricao: string | null
  resposta: string | null
  textos: string | null
}

const botDe = (l: LinhaBot): BotGrupos => ({ id: l.id, nome: l.nome, numeroId: l.numero_id, ativo: l.ativo === 1, criadoEm: l.criado_em })

const grupoAtivoDe = (l: LinhaGrupoAtivo): GrupoAtivo => ({
  botId: l.bot_id,
  jid: l.jid,
  lojaId: l.loja_id,
  loja: l.loja,
  setor: l.setor,
  ativadoEm: l.ativado_em,
  ativadoPor: l.ativado_por
})

const gestorDe = (l: LinhaGestor): GestorBot => ({
  botId: l.bot_id,
  funcionarioId: l.funcionario_id,
  codigo: l.codigo,
  codigoExpiraEm: l.codigo_expira_em,
  confirmadoEm: l.confirmado_em,
  confirmadoJid: l.confirmado_jid,
  divergenteJid: l.divergente_jid,
  divergenteTelefone: l.divergente_telefone,
  divergenteEm: l.divergente_em,
  adicionadoPor: l.adicionado_por,
  adicionadoEm: l.adicionado_em
})

const COLUNAS_BOT = `id, nome, numero_id, ativo, criado_em`
const SELECT_GRUPO_ATIVO = `SELECT a.bot_id, a.jid, a.loja_id, l.nome AS loja, a.setor, a.ativado_em, a.ativado_por
  FROM grupos_ativos a LEFT JOIN lojas l ON l.id = a.loja_id`
const COLUNAS_GESTOR = `bot_id, funcionario_id, codigo, codigo_expira_em, confirmado_em, confirmado_jid, divergente_jid,
  divergente_telefone, divergente_em, adicionado_por, adicionado_em`

/** Bots de grupos e tudo o que é de cada um: lojas, grupos ativos, participantes, gestores e comandos. */
export class RepoBotsGrupos {
  constructor(private readonly db: Banco) {}

  // --- bots -----------------------------------------------------------------------

  bots(): BotGrupos[] {
    return (this.db.prepare(`SELECT ${COLUNAS_BOT} FROM bots_grupos ORDER BY nome COLLATE NOCASE, id`).all() as LinhaBot[]).map(botDe)
  }

  bot(id: number): BotGrupos | null {
    const l = this.db.prepare(`SELECT ${COLUNAS_BOT} FROM bots_grupos WHERE id = ?`).get(id) as LinhaBot | undefined
    return l ? botDe(l) : null
  }

  /** O bot que atende este número agora. Bot desativado não atende ninguém. */
  botDoNumero(numeroId: number): BotGrupos | null {
    const l = this.db.prepare(`SELECT ${COLUNAS_BOT} FROM bots_grupos WHERE numero_id = ? AND ativo = 1`).get(numeroId) as
      | LinhaBot
      | undefined
    return l ? botDe(l) : null
  }

  /** Número já usado por outro bot viola UNIQUE e lança erro. */
  criarBot(nome: string, numeroId: number | null, agora: number): number {
    const r = this.db.prepare(`INSERT INTO bots_grupos (nome, numero_id, ativo, criado_em) VALUES (?, ?, 1, ?)`).run(nome, numeroId, agora)
    return Number(r.lastInsertRowid)
  }

  editarBot(id: number, d: { nome: string; numeroId: number | null; ativo: boolean }): void {
    this.db.prepare(`UPDATE bots_grupos SET nome = ?, numero_id = ?, ativo = ? WHERE id = ?`).run(d.nome, d.numeroId, d.ativo ? 1 : 0, id)
  }

  /** Apaga junto lojas, grupos ativos (e participantes), gestores e comandos (FK em cascata). */
  excluirBot(id: number): boolean {
    return this.db.prepare(`DELETE FROM bots_grupos WHERE id = ?`).run(id).changes === 1
  }

  // --- lojas ----------------------------------------------------------------------

  lojas(botId: number): Loja[] {
    return (
      this.db.prepare(`SELECT id, bot_id AS botId, nome FROM lojas WHERE bot_id = ? ORDER BY nome COLLATE NOCASE`).all(botId) as Loja[]
    )
  }

  loja(id: number): Loja | null {
    return (this.db.prepare(`SELECT id, bot_id AS botId, nome FROM lojas WHERE id = ?`).get(id) as Loja | undefined) ?? null
  }

  /** Nome repetido no mesmo bot (sem diferenciar maiúsculas) viola UNIQUE e lança erro. */
  criarLoja(botId: number, nome: string): number {
    return Number(this.db.prepare(`INSERT INTO lojas (bot_id, nome) VALUES (?, ?)`).run(botId, nome).lastInsertRowid)
  }

  /**
   * Renomeia e leva junto quem estava na equipe com exatamente o nome antigo (sem diferenciar
   * maiúsculas): a loja da pessoa é texto livre, mas quase sempre é uma destas.
   */
  renomearLoja(id: number, nome: string): void {
    const atual = this.loja(id)
    if (!atual) throw new Error('loja não encontrada')
    this.db.transaction(() => {
      this.db.prepare(`UPDATE lojas SET nome = ? WHERE id = ?`).run(nome, id)
      this.db.prepare(`UPDATE funcionarios SET loja = ? WHERE loja = ? COLLATE NOCASE`).run(nome, atual.nome)
    })()
  }

  /** Grupos com esta loja continuam ativos, só ficam sem loja (FK SET NULL). */
  excluirLoja(id: number): boolean {
    return this.db.prepare(`DELETE FROM lojas WHERE id = ?`).run(id).changes === 1
  }

  /** Sugestões para o campo loja da equipe: lojas de todos os bots e as já usadas por alguém. */
  nomesDeLojas(): string[] {
    return (
      this.db
        .prepare(
          `SELECT nome FROM lojas UNION SELECT loja FROM funcionarios WHERE loja IS NOT NULL AND loja <> ''
           ORDER BY 1 COLLATE NOCASE`
        )
        .all() as { nome: string }[]
    ).map((r) => r.nome)
  }

  // --- grupos ativos --------------------------------------------------------------

  gruposAtivos(botId: number): GrupoAtivo[] {
    return (this.db.prepare(`${SELECT_GRUPO_ATIVO} WHERE a.bot_id = ? ORDER BY a.ativado_em, a.jid`).all(botId) as LinhaGrupoAtivo[]).map(
      grupoAtivoDe
    )
  }

  grupoAtivo(botId: number, jid: string): GrupoAtivo | null {
    const l = this.db.prepare(`${SELECT_GRUPO_ATIVO} WHERE a.bot_id = ? AND a.jid = ?`).get(botId, jid) as LinhaGrupoAtivo | undefined
    return l ? grupoAtivoDe(l) : null
  }

  ativarGrupo(botId: number, jid: string, lojaId: number | null, setor: string | null, por: string, agora: number): void {
    this.db
      .prepare(
        `INSERT INTO grupos_ativos (bot_id, jid, loja_id, setor, ativado_em, ativado_por) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (bot_id, jid) DO UPDATE SET loja_id = excluded.loja_id, setor = excluded.setor`
      )
      .run(botId, jid, lojaId, setor, agora, por)
  }

  editarGrupoAtivo(botId: number, jid: string, lojaId: number | null, setor: string | null): boolean {
    return this.db.prepare(`UPDATE grupos_ativos SET loja_id = ?, setor = ? WHERE bot_id = ? AND jid = ?`).run(lojaId, setor, botId, jid).changes === 1
  }

  /** Os participantes guardados saem junto (FK em cascata). */
  desativarGrupo(botId: number, jid: string): boolean {
    return this.db.prepare(`DELETE FROM grupos_ativos WHERE bot_id = ? AND jid = ?`).run(botId, jid).changes === 1
  }

  // --- participantes (só de grupos ativos) ----------------------------------------

  participantes(botId: number, jid: string): Participante[] {
    return (
      this.db
        .prepare(`SELECT jid, telefone, lid, admin FROM participantes WHERE bot_id = ? AND grupo_jid = ? ORDER BY rowid`)
        .all(botId, jid) as (Omit<Participante, 'admin'> & { admin: number })[]
    ).map((p) => ({ ...p, admin: p.admin === 1 }))
  }

  /** Releitura completa do grupo. Quem chama já roda isto dentro de uma transação, ou aceita duas escritas. */
  substituirParticipantes(botId: number, jid: string, lista: Participante[]): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM participantes WHERE bot_id = ? AND grupo_jid = ?`).run(botId, jid)
      this.adicionarParticipantes(botId, jid, lista)
    })()
  }

  adicionarParticipantes(botId: number, jid: string, lista: Participante[]): void {
    const ins = this.db.prepare(
      `INSERT INTO participantes (bot_id, grupo_jid, jid, telefone, lid, admin) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (bot_id, grupo_jid, jid) DO UPDATE SET telefone = COALESCE(excluded.telefone, telefone),
         lid = COALESCE(excluded.lid, lid), admin = excluded.admin`
    )
    for (const p of lista) ins.run(botId, jid, p.jid, p.telefone, p.lid, p.admin ? 1 : 0)
  }

  removerParticipantes(botId: number, jid: string, jids: string[]): void {
    const del = this.db.prepare(`DELETE FROM participantes WHERE bot_id = ? AND grupo_jid = ? AND jid = ?`)
    for (const j of jids) del.run(botId, jid, j)
  }

  definirAdminParticipante(botId: number, jid: string, participante: string, admin: boolean): void {
    this.db
      .prepare(`UPDATE participantes SET admin = ? WHERE bot_id = ? AND grupo_jid = ? AND jid = ?`)
      .run(admin ? 1 : 0, botId, jid, participante)
  }

  /** Grupos ativos onde a pessoa aparece (pelo telefone ou pelo LID). */
  gruposDaPessoa(telefone: string | null, lid: string | null): { botId: number; jid: string }[] {
    if (!telefone && !lid) return []
    return this.db
      .prepare(
        `SELECT DISTINCT bot_id AS botId, grupo_jid AS jid FROM participantes
         WHERE (? IS NOT NULL AND telefone = ?) OR (? IS NOT NULL AND lid = ?) ORDER BY bot_id, grupo_jid`
      )
      .all(telefone, telefone, lid, lid) as { botId: number; jid: string }[]
  }

  /** Por grupo ativo do bot: quantos participantes e quantos sem cadastro na equipe. */
  contagemParticipantes(botId: number): Map<string, { total: number; semCadastro: number }> {
    const linhas = this.db
      .prepare(
        `SELECT p.grupo_jid AS jid, COUNT(*) AS total,
           SUM(CASE WHEN EXISTS (SELECT 1 FROM funcionarios f WHERE (p.telefone IS NOT NULL AND f.telefone = p.telefone)
             OR (p.lid IS NOT NULL AND f.lid = p.lid)) THEN 0 ELSE 1 END) AS semCadastro
         FROM participantes p WHERE p.bot_id = ? GROUP BY p.grupo_jid`
      )
      .all(botId) as { jid: string; total: number; semCadastro: number }[]
    return new Map(linhas.map((l) => [l.jid, { total: l.total, semCadastro: l.semCadastro }]))
  }

  // --- gestores -------------------------------------------------------------------

  gestores(botId: number): GestorBot[] {
    return (
      this.db.prepare(`SELECT ${COLUNAS_GESTOR} FROM gestores_bot WHERE bot_id = ? ORDER BY adicionado_em, funcionario_id`).all(botId) as LinhaGestor[]
    ).map(gestorDe)
  }

  gestor(botId: number, funcionarioId: number): GestorBot | null {
    const l = this.db.prepare(`SELECT ${COLUNAS_GESTOR} FROM gestores_bot WHERE bot_id = ? AND funcionario_id = ?`).get(botId, funcionarioId) as
      | LinhaGestor
      | undefined
    return l ? gestorDe(l) : null
  }

  gestoresDaPessoa(funcionarioId: number): GestorBot[] {
    return (
      this.db.prepare(`SELECT ${COLUNAS_GESTOR} FROM gestores_bot WHERE funcionario_id = ? ORDER BY bot_id`).all(funcionarioId) as LinhaGestor[]
    ).map(gestorDe)
  }

  /** Pendente com este código, ainda dentro da validade. */
  gestorPorCodigo(botId: number, codigo: string, agora: number): GestorBot | null {
    const l = this.db
      .prepare(`SELECT ${COLUNAS_GESTOR} FROM gestores_bot WHERE bot_id = ? AND codigo = ? AND codigo_expira_em > ? AND confirmado_em IS NULL`)
      .get(botId, codigo, agora) as LinhaGestor | undefined
    return l ? gestorDe(l) : null
  }

  /** IDs de funcionário com poder de gestor neste bot (só os confirmados). */
  gestoresConfirmados(botId: number): number[] {
    return (
      this.db
        .prepare(`SELECT funcionario_id AS id FROM gestores_bot WHERE bot_id = ? AND confirmado_em IS NOT NULL ORDER BY confirmado_em, funcionario_id`)
        .all(botId) as { id: number }[]
    ).map((r) => r.id)
  }

  /** Indica como gestor (pendente) e devolve o código. Quem já está na lista só ganha código novo. */
  indicarGestor(botId: number, funcionarioId: number, por: string, agora: number): string {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO gestores_bot (bot_id, funcionario_id, adicionado_por, adicionado_em) VALUES (?, ?, ?, ?)`
      )
      .run(botId, funcionarioId, por, agora)
    return this.novoCodigo(botId, funcionarioId, agora)
  }

  /** Troca o código (o anterior deixa de valer) e renova a validade. */
  novoCodigo(botId: number, funcionarioId: number, agora: number): string {
    const existe = this.db.prepare(`SELECT 1 FROM gestores_bot WHERE bot_id = ? AND codigo = ?`)
    for (let i = 0; i < 10; i++) {
      const codigo = String(randomInt(0, 1_000_000)).padStart(6, '0')
      if (existe.get(botId, codigo)) continue
      this.db
        .prepare(`UPDATE gestores_bot SET codigo = ?, codigo_expira_em = ? WHERE bot_id = ? AND funcionario_id = ?`)
        .run(codigo, agora + VALIDADE_CODIGO_MS, botId, funcionarioId)
      return codigo
    }
    throw new Error('não foi possível gerar um código livre')
  }

  confirmarGestor(botId: number, funcionarioId: number, jid: string, agora: number): void {
    this.db
      .prepare(
        `UPDATE gestores_bot SET confirmado_em = ?, confirmado_jid = ?, codigo = NULL, codigo_expira_em = NULL,
           divergente_jid = NULL, divergente_telefone = NULL, divergente_em = NULL
         WHERE bot_id = ? AND funcionario_id = ?`
      )
      .run(agora, jid, botId, funcionarioId)
  }

  registrarDivergencia(botId: number, funcionarioId: number, jid: string, telefone: string | null, agora: number): void {
    this.db
      .prepare(`UPDATE gestores_bot SET divergente_jid = ?, divergente_telefone = ?, divergente_em = ? WHERE bot_id = ? AND funcionario_id = ?`)
      .run(jid, telefone, agora, botId, funcionarioId)
  }

  descartarDivergencia(botId: number, funcionarioId: number): void {
    this.db
      .prepare(`UPDATE gestores_bot SET divergente_jid = NULL, divergente_telefone = NULL, divergente_em = NULL WHERE bot_id = ? AND funcionario_id = ?`)
      .run(botId, funcionarioId)
  }

  removerGestor(botId: number, funcionarioId: number): boolean {
    return this.db.prepare(`DELETE FROM gestores_bot WHERE bot_id = ? AND funcionario_id = ?`).run(botId, funcionarioId).changes === 1
  }

  // --- comandos -------------------------------------------------------------------

  /** Só o que foi mudado: comando pronto ausente daqui está ligado e com os textos originais. */
  comandos(botId: number): Map<string, ComandoSalvo> {
    const linhas = this.db
      .prepare(`SELECT nome, ligado, personalizado, quem, onde, descricao, resposta, textos FROM comandos_bot WHERE bot_id = ? ORDER BY nome`)
      .all(botId) as LinhaComando[]
    return new Map(
      linhas.map((l) => [
        l.nome,
        {
          nome: l.nome,
          ligado: l.ligado === 1,
          personalizado: l.personalizado === 1,
          quem: l.quem,
          onde: l.onde,
          descricao: l.descricao,
          resposta: l.resposta,
          textos: l.textos ? (JSON.parse(l.textos) as Record<string, string>) : {}
        }
      ])
    )
  }

  ligarComando(botId: number, nome: string, ligado: boolean): void {
    this.db
      .prepare(
        `INSERT INTO comandos_bot (bot_id, nome, ligado) VALUES (?, ?, ?)
         ON CONFLICT (bot_id, nome) DO UPDATE SET ligado = excluded.ligado`
      )
      .run(botId, nome, ligado ? 1 : 0)
  }

  /** Substitui todos os textos editados do comando; {} volta todos ao original. */
  salvarTextos(botId: number, nome: string, textos: Record<string, string>): void {
    const json = Object.keys(textos).length ? JSON.stringify(textos) : null
    this.db
      .prepare(
        `INSERT INTO comandos_bot (bot_id, nome, textos) VALUES (?, ?, ?)
         ON CONFLICT (bot_id, nome) DO UPDATE SET textos = excluded.textos`
      )
      .run(botId, nome, json)
  }

  /** Cria ou substitui um comando personalizado (quem chama já validou o nome). */
  salvarPersonalizado(botId: number, p: DadosPersonalizado): void {
    this.db
      .prepare(
        `INSERT INTO comandos_bot (bot_id, nome, ligado, personalizado, quem, onde, descricao, resposta) VALUES (?, ?, 1, 1, ?, ?, ?, ?)
         ON CONFLICT (bot_id, nome) DO UPDATE SET quem = excluded.quem, onde = excluded.onde, descricao = excluded.descricao,
           resposta = excluded.resposta`
      )
      .run(botId, p.nome, p.quem, p.onde, p.descricao, p.resposta)
  }

  excluirPersonalizado(botId: number, nome: string): boolean {
    return this.db.prepare(`DELETE FROM comandos_bot WHERE bot_id = ? AND nome = ? AND personalizado = 1`).run(botId, nome).changes === 1
  }
}
