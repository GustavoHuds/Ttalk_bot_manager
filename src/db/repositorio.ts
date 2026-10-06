import type { CandidaturaVista, EstadoConversa, StatusCandidatura } from '../conversa/tipos.js'
import type { Banco } from './banco.js'

const DIA_MS = 24 * 60 * 60 * 1000

interface LinhaCandidatura {
  id: number
  processo: string
  protocolo: string
  jid: string
  telefone: string | null
  lid: string | null
  passo: string
  status: StatusCandidatura
  lote: number
  finalizar_em: number | null
  criada_em: number
  atualizada_em: number
  ultima_interacao: number
  concluida_em: number | null
}

export interface NovoArquivo {
  caminho: string
  ext: string
  mimetype: string
  tamanho: number
  hash: string
}

export interface ArquivoLinha extends NovoArquivo {
  id: number
  candidatura_id: number
  lote: number
  recebido_em: number
}

export interface CandidatoPainel {
  id: number
  protocolo: string
  processo: string
  telefone: string | null
  status: StatusCandidatura
  passo: string
  criadaEm: number
  concluidaEm: number | null
  respostas: Record<string, string>
  arquivos: ArquivoLinha[]
}

export interface ItemSaida {
  id: number
  jid: string
  conteudo: string
  tentativas: number
}

/** Todo acesso ao SQLite passa por aqui. Métodos síncronos (better-sqlite3). */
export class Repositorio {
  constructor(readonly db: Banco) {}

  transacao<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  // --- caixa de entrada ----------------------------------------------------------

  /** Grava a mensagem antes de processar. Devolve false se o ID já foi visto. */
  registrarRecebida(id: string, jid: string, recebidaEm: number, payload: string): boolean {
    const r = this.db
      .prepare(`INSERT OR IGNORE INTO mensagens_processadas (id, jid, recebida_em, status, payload) VALUES (?, ?, ?, 'pendente', ?)`)
      .run(id, jid, recebidaEm, payload)
    if (r.changes === 1) this.tocarConversa(jid, recebidaEm)
    return r.changes === 1
  }

  pendentes(): { id: string; jid: string }[] {
    return this.db
      .prepare(`SELECT id, jid FROM mensagens_processadas WHERE status = 'pendente' ORDER BY recebida_em, rowid`)
      .all() as { id: string; jid: string }[]
  }

  lerPendente(id: string): { jid: string; payload: string; tentativas: number; recebidaEm: number } | null {
    const r = this.db
      .prepare(`SELECT jid, payload, tentativas, recebida_em AS recebidaEm FROM mensagens_processadas WHERE id = ? AND status = 'pendente'`)
      .get(id) as { jid: string; payload: string; tentativas: number; recebidaEm: number } | undefined
    return r ?? null
  }

  /** O conteúdo é apagado assim que processado: no banco fica só o ID, para descartar repetidas. */
  marcarProcessada(id: string): void {
    this.db.prepare(`UPDATE mensagens_processadas SET status = 'processada', payload = NULL WHERE id = ?`).run(id)
  }

  registrarFalha(id: string, desistir: boolean): void {
    this.db
      .prepare(
        `UPDATE mensagens_processadas SET tentativas = tentativas + 1,
           status = CASE WHEN ? THEN 'erro' ELSE status END,
           payload = CASE WHEN ? THEN NULL ELSE payload END
         WHERE id = ?`
      )
      .run(desistir ? 1 : 0, desistir ? 1 : 0, id)
  }

  // --- conversa ------------------------------------------------------------------

  private tocarConversa(jid: string, em: number): void {
    this.db
      .prepare(
        `INSERT INTO conversas (jid, ultima_recebida) VALUES (?, ?)
         ON CONFLICT (jid) DO UPDATE SET ultima_recebida = MAX(ultima_recebida, excluded.ultima_recebida)`
      )
      .run(jid, em)
  }

  conversa(jid: string): { candidaturaId: number | null; estado: EstadoConversa | null; ultimaRecebida: number } | null {
    const r = this.db.prepare(`SELECT candidatura_id, estado, ultima_recebida FROM conversas WHERE jid = ?`).get(jid) as
      | { candidatura_id: number | null; estado: string | null; ultima_recebida: number }
      | undefined
    if (!r) return null
    return {
      candidaturaId: r.candidatura_id,
      estado: r.estado ? (JSON.parse(r.estado) as EstadoConversa) : null,
      ultimaRecebida: r.ultima_recebida
    }
  }

  definirEstado(jid: string, estado: EstadoConversa | null): void {
    this.db.prepare(`UPDATE conversas SET estado = ? WHERE jid = ?`).run(estado ? JSON.stringify(estado) : null, jid)
  }

  focar(jid: string, candidaturaId: number): void {
    this.db.prepare(`UPDATE conversas SET candidatura_id = ? WHERE jid = ?`).run(candidaturaId, jid)
  }

  // --- candidaturas ----------------------------------------------------------------

  candidaturasDoContato(jid: string): CandidaturaVista[] {
    const linhas = this.db.prepare(`SELECT * FROM candidaturas WHERE jid = ? ORDER BY id`).all(jid) as LinhaCandidatura[]
    return linhas.map((l) => this.vista(l))
  }

  candidatura(id: number): CandidaturaVista | null {
    const l = this.db.prepare(`SELECT * FROM candidaturas WHERE id = ?`).get(id) as LinhaCandidatura | undefined
    return l ? this.vista(l) : null
  }

  private vista(l: LinhaCandidatura): CandidaturaVista {
    const { n } = this.db
      .prepare(`SELECT COUNT(*) AS n FROM arquivos WHERE candidatura_id = ? AND lote = ?`)
      .get(l.id, l.lote) as { n: number }
    return {
      id: l.id,
      processo: l.processo,
      protocolo: l.protocolo,
      passo: l.passo,
      status: l.status,
      telefone: l.telefone,
      respostas: this.respostas(l.id),
      arquivosNoLote: n,
      ultimaInteracao: l.ultima_interacao
    }
  }

  private respostas(id: number): Record<string, string> {
    const linhas = this.db.prepare(`SELECT chave, valor FROM respostas WHERE candidatura_id = ?`).all(id) as {
      chave: string
      valor: string
    }[]
    return Object.fromEntries(linhas.map((r) => [r.chave, r.valor]))
  }

  criarCandidatura(processo: string, jid: string, telefone: string | null, lid: string | null, agora: number): number {
    const { ultimo } = this.db
      .prepare(
        `INSERT INTO contadores (processo, ultimo) VALUES (?, 1)
         ON CONFLICT (processo) DO UPDATE SET ultimo = ultimo + 1 RETURNING ultimo`
      )
      .get(processo) as { ultimo: number }
    const protocolo = `${processo}-${String(ultimo).padStart(4, '0')}`
    const r = this.db
      .prepare(
        `INSERT INTO candidaturas (processo, protocolo, jid, telefone, lid, passo, status, criada_em, atualizada_em, ultima_interacao)
         VALUES (?, ?, ?, ?, ?, '', 'em_andamento', ?, ?, ?)`
      )
      .run(processo, protocolo, jid, telefone, lid, agora, agora, agora)
    return Number(r.lastInsertRowid)
  }

  definirPasso(id: number, passo: string, agora: number): void {
    this.db.prepare(`UPDATE candidaturas SET passo = ?, atualizada_em = ? WHERE id = ?`).run(passo, agora, id)
  }

  registrarInteracao(id: number, agora: number): void {
    this.db.prepare(`UPDATE candidaturas SET ultima_interacao = ?, atualizada_em = ? WHERE id = ?`).run(agora, agora, id)
  }

  salvarResposta(id: number, chave: string, valor: string, agora: number): void {
    this.db
      .prepare(
        `INSERT INTO respostas (candidatura_id, chave, valor, respondida_em) VALUES (?, ?, ?, ?)
         ON CONFLICT (candidatura_id, chave) DO UPDATE SET valor = excluded.valor, respondida_em = excluded.respondida_em`
      )
      .run(id, chave, valor, agora)
  }

  definirTelefone(id: number, telefone: string): void {
    this.db.prepare(`UPDATE candidaturas SET telefone = ? WHERE id = ?`).run(telefone, id)
  }

  /** Completa telefone/LID quando a conexão passa a conhecê-los. */
  completarIdentidade(jid: string, telefone: string | null, lid: string | null): void {
    if (telefone) this.db.prepare(`UPDATE candidaturas SET telefone = ? WHERE jid = ? AND telefone IS NULL`).run(telefone, jid)
    if (lid) this.db.prepare(`UPDATE candidaturas SET lid = ? WHERE jid = ? AND lid IS NULL`).run(lid, jid)
  }

  concluir(id: number, agora: number): void {
    this.db
      .prepare(`UPDATE candidaturas SET status = 'concluida', concluida_em = ?, atualizada_em = ? WHERE id = ?`)
      .run(agora, agora, id)
  }

  agendarFinalizacao(id: number, em: number | null): void {
    this.db.prepare(`UPDATE candidaturas SET finalizar_em = ? WHERE id = ?`).run(em, id)
  }

  paraFinalizar(agora: number): { id: number; jid: string }[] {
    return this.db
      .prepare(`SELECT id, jid FROM candidaturas WHERE finalizar_em IS NOT NULL AND finalizar_em <= ?`)
      .all(agora) as { id: number; jid: string }[]
  }

  registrarArquivo(candidaturaId: number, a: NovoArquivo, agora: number): void {
    this.db
      .prepare(
        `INSERT INTO arquivos (candidatura_id, lote, caminho, ext, mimetype, tamanho, hash, recebido_em)
         SELECT id, lote, ?, ?, ?, ?, ?, ? FROM candidaturas WHERE id = ?`
      )
      .run(a.caminho, a.ext, a.mimetype, a.tamanho, a.hash, agora, candidaturaId)
  }

  novoLote(id: number): void {
    this.db.prepare(`UPDATE candidaturas SET lote = lote + 1 WHERE id = ?`).run(id)
  }

  /** Remove os arquivos de lotes anteriores e devolve os caminhos para apagar do disco. */
  descartarLotesAntigos(id: number): string[] {
    const antigos = this.db
      .prepare(
        `SELECT caminho FROM arquivos WHERE candidatura_id = ? AND lote < (SELECT lote FROM candidaturas WHERE id = ?)`
      )
      .all(id, id) as { caminho: string }[]
    this.db
      .prepare(`DELETE FROM arquivos WHERE candidatura_id = ? AND lote < (SELECT lote FROM candidaturas WHERE id = ?)`)
      .run(id, id)
    return antigos.map((a) => a.caminho)
  }

  private excluirCandidaturas(ids: number[]): string[] {
    const caminhos: string[] = []
    for (const id of ids) {
      const arqs = this.db.prepare(`SELECT caminho FROM arquivos WHERE candidatura_id = ?`).all(id) as { caminho: string }[]
      caminhos.push(...arqs.map((a) => a.caminho))
      this.db.prepare(`DELETE FROM candidaturas WHERE id = ?`).run(id)
    }
    return caminhos
  }

  /** Exclusão a pedido do candidato: tudo que estiver ligado ao número ou ao chat. */
  excluirDadosDoContato(jid: string, telefone: string | null): string[] {
    const ids = (
      this.db.prepare(`SELECT id FROM candidaturas WHERE jid = ? OR (telefone IS NOT NULL AND telefone = ?)`).all(jid, telefone) as {
        id: number
      }[]
    ).map((r) => r.id)
    return this.excluirCandidaturas(ids)
  }

  excluirCandidatura(id: number): string[] {
    return this.excluirCandidaturas([id])
  }

  excluirProcesso(processo: string): { quantidade: number; caminhos: string[] } {
    const ids = (this.db.prepare(`SELECT id FROM candidaturas WHERE processo = ?`).all(processo) as { id: number }[]).map(
      (r) => r.id
    )
    return { quantidade: ids.length, caminhos: this.excluirCandidaturas(ids) }
  }

  // --- caixa de saída ---------------------------------------------------------------

  enfileirarSaida(jid: string, conteudo: string, agora: number): void {
    this.db.prepare(`INSERT INTO saida (jid, conteudo, criada_em) VALUES (?, ?, ?)`).run(jid, conteudo, agora)
  }

  jidsComSaida(agora: number): string[] {
    return (
      this.db.prepare(`SELECT DISTINCT jid FROM saida WHERE proxima_em <= ? ORDER BY id`).all(agora) as { jid: string }[]
    ).map((r) => r.jid)
  }

  /** Mensagens saem na ordem em que foram criadas; uma com reenvio agendado segura as de trás. */
  proximaSaida(jid: string): (ItemSaida & { proximaEm: number }) | null {
    const r = this.db
      .prepare(`SELECT id, jid, conteudo, tentativas, proxima_em AS proximaEm FROM saida WHERE jid = ? ORDER BY id LIMIT 1`)
      .get(jid) as (ItemSaida & { proximaEm: number }) | undefined
    return r ?? null
  }

  removerSaida(id: number): void {
    this.db.prepare(`DELETE FROM saida WHERE id = ?`).run(id)
  }

  adiarSaida(id: number, proximaEm: number): void {
    this.db.prepare(`UPDATE saida SET tentativas = tentativas + 1, proxima_em = ? WHERE id = ?`).run(proximaEm, id)
  }

  // --- enquetes e mensagens enviadas -------------------------------------------------

  salvarEnquete(id: string, jid: string, chave: string, opcoes: string[], segredo: Uint8Array, agora: number): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO enquetes (id, jid, chave, opcoes, segredo, criada_em) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, jid, chave, JSON.stringify(opcoes), Buffer.from(segredo), agora)
  }

  enquete(id: string): { jid: string; chave: string; opcoes: string[]; segredo: Buffer } | null {
    const r = this.db.prepare(`SELECT jid, chave, opcoes, segredo FROM enquetes WHERE id = ?`).get(id) as
      | { jid: string; chave: string; opcoes: string; segredo: Buffer }
      | undefined
    return r ? { ...r, opcoes: JSON.parse(r.opcoes) as string[] } : null
  }

  salvarEnviada(id: string, conteudo: string, agora: number): void {
    this.db.prepare(`INSERT OR REPLACE INTO enviadas (id, conteudo, criada_em) VALUES (?, ?, ?)`).run(id, conteudo, agora)
  }

  enviada(id: string): string | null {
    const r = this.db.prepare(`SELECT conteudo FROM enviadas WHERE id = ?`).get(id) as { conteudo: string } | undefined
    return r?.conteudo ?? null
  }

  // --- painel --------------------------------------------------------------------------

  resumoPorProcesso(): Map<string, { total: number; concluidas: number }> {
    const linhas = this.db
      .prepare(
        `SELECT processo, COUNT(*) AS total, SUM(status = 'concluida') AS concluidas FROM candidaturas GROUP BY processo`
      )
      .all() as { processo: string; total: number; concluidas: number }[]
    return new Map(linhas.map((l) => [l.processo, { total: l.total, concluidas: l.concluidas }]))
  }

  candidatosDoProcesso(processo: string): CandidatoPainel[] {
    const linhas = this.db
      .prepare(`SELECT * FROM candidaturas WHERE processo = ? ORDER BY id`)
      .all(processo) as LinhaCandidatura[]
    return linhas.map((l) => this.candidatoPainel(l))
  }

  candidatoPainel(l: LinhaCandidatura): CandidatoPainel {
    return {
      id: l.id,
      protocolo: l.protocolo,
      processo: l.processo,
      telefone: l.telefone,
      status: l.status,
      passo: l.passo,
      criadaEm: l.criada_em,
      concluidaEm: l.concluida_em,
      respostas: this.respostas(l.id),
      arquivos: this.db
        .prepare(`SELECT * FROM arquivos WHERE candidatura_id = ? AND lote = ? ORDER BY id`)
        .all(l.id, l.lote) as ArquivoLinha[]
    }
  }

  arquivo(id: number): (ArquivoLinha & { protocolo: string; processo: string }) | null {
    const r = this.db
      .prepare(
        `SELECT a.*, c.protocolo, c.processo FROM arquivos a JOIN candidaturas c ON c.id = a.candidatura_id WHERE a.id = ?`
      )
      .get(id) as (ArquivoLinha & { protocolo: string; processo: string }) | undefined
    return r ?? null
  }

  auditar(usuario: string, acao: string, detalhe: string | null, agora: number): void {
    this.db.prepare(`INSERT INTO auditoria (em, usuario, acao, detalhe) VALUES (?, ?, ?, ?)`).run(agora, usuario, acao, detalhe)
  }

  auditoriaRecente(limite = 100): { em: number; usuario: string; acao: string; detalhe: string | null }[] {
    return this.db.prepare(`SELECT em, usuario, acao, detalhe FROM auditoria ORDER BY id DESC LIMIT ?`).all(limite) as {
      em: number
      usuario: string
      acao: string
      detalhe: string | null
    }[]
  }

  // --- bots ---------------------------------------------------------------------------

  listarBots(): { codigo: string; dados: string; atualizadoEm: number; atualizadoPor: string }[] {
    return this.db
      .prepare(`SELECT codigo, dados, atualizado_em AS atualizadoEm, atualizado_por AS atualizadoPor FROM processos ORDER BY criado_em, codigo`)
      .all() as { codigo: string; dados: string; atualizadoEm: number; atualizadoPor: string }[]
  }

  bot(codigo: string): string | null {
    const r = this.db.prepare(`SELECT dados FROM processos WHERE codigo = ?`).get(codigo) as { dados: string } | undefined
    return r?.dados ?? null
  }

  salvarBot(codigo: string, dados: string, usuario: string, agora: number): void {
    this.db
      .prepare(
        `INSERT INTO processos (codigo, dados, criado_em, atualizado_em, atualizado_por) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (codigo) DO UPDATE SET dados = excluded.dados, atualizado_em = excluded.atualizado_em, atualizado_por = excluded.atualizado_por`
      )
      .run(codigo, dados, agora, agora, usuario)
  }

  excluirBot(codigo: string): void {
    this.db.prepare(`DELETE FROM processos WHERE codigo = ?`).run(codigo)
  }

  contarCandidaturas(processo: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM candidaturas WHERE processo = ?`).get(processo) as { n: number }).n
  }

  // --- saúde e manutenção ------------------------------------------------------------

  filas(): { entrada: number; saida: number; erros: number } {
    const e = this.db.prepare(`SELECT COUNT(*) AS n FROM mensagens_processadas WHERE status = 'pendente'`).get() as { n: number }
    const s = this.db.prepare(`SELECT COUNT(*) AS n FROM saida`).get() as { n: number }
    const x = this.db.prepare(`SELECT COUNT(*) AS n FROM mensagens_processadas WHERE status = 'erro'`).get() as { n: number }
    return { entrada: e.n, saida: s.n, erros: x.n }
  }

  ultimaRecebida(): number | null {
    const r = this.db.prepare(`SELECT MAX(recebida_em) AS m FROM mensagens_processadas`).get() as { m: number | null }
    return r.m
  }

  processosComDados(): string[] {
    return (this.db.prepare(`SELECT DISTINCT processo FROM candidaturas`).all() as { processo: string }[]).map((r) => r.processo)
  }

  meta(chave: string): string | null {
    const r = this.db.prepare(`SELECT valor FROM meta WHERE chave = ?`).get(chave) as { valor: string } | undefined
    return r?.valor ?? null
  }

  definirMeta(chave: string, valor: string): void {
    this.db.prepare(`INSERT OR REPLACE INTO meta (chave, valor) VALUES (?, ?)`).run(chave, valor)
  }

  /** Apaga rastros técnicos que não servem mais: IDs de mensagens, conteúdo enviado, enquetes velhas. */
  limparRegistrosTecnicos(agora: number): void {
    this.db.prepare(`DELETE FROM mensagens_processadas WHERE status != 'pendente' AND recebida_em < ?`).run(agora - 30 * DIA_MS)
    this.db.prepare(`DELETE FROM enviadas WHERE criada_em < ?`).run(agora - 7 * DIA_MS)
    this.db.prepare(`DELETE FROM enquetes WHERE criada_em < ?`).run(agora - 90 * DIA_MS)
    this.db
      .prepare(`DELETE FROM conversas WHERE candidatura_id IS NULL AND ultima_recebida < ?`)
      .run(agora - 30 * DIA_MS)
  }
}
