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

export interface GrupoAtivo {
  botId: number
  jid: string
  ativadoEm: number
  ativadoPor: string
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

/** Grupo fechado pelo /mutegroup. Sem horário: fechado até o /unmute. Com horário: todo dia, de inicio a fim. */
export interface Silencio {
  botId: number
  jid: string
  inicio: string | null
  fim: string | null
  /** O que foi aplicado por último no WhatsApp; null = nada ainda. */
  fechado: boolean | null
}

export type TipoMidia = 'imagem' | 'video' | 'audio' | 'documento'

export interface Midia {
  /** Caminho relativo dentro da pasta de dados. */
  caminho: string
  tipo: TipoMidia
  mimetype: string
  nome: string | null
}

/** Uma das variações de uma mensagem programada: texto, mídia ou os dois (o texto vira legenda). */
export interface VariacaoMensagem {
  texto: string | null
  midia: Midia | null
}

export type OrigemProgramada = 'painel' | 'repeat'

export interface DadosProgramada {
  jid: string
  origem: OrigemProgramada
  /** "HH:MM", em ordem. */
  horarios: string[]
  /** Dias da semana (0 = domingo). Todos os 7 = todo dia. */
  dias: number[]
  /** "AAAA-MM-DD": envia uma vez só, nesse dia. null = repete nos dias escolhidos. */
  data: string | null
  /** Sorteia entre as variações; desligado, só a primeira sai. */
  variar: boolean
  /** Menciona todos do grupo em segredo. */
  mencionar: boolean
  variacoes: VariacaoMensagem[]
}

export interface Programada extends DadosProgramada {
  id: number
  botId: number
  ativa: boolean
  ultimoEnvio: number | null
  ultimaVariacao: number | null
  criadoPor: string
  criadoEm: number
}

export const VALIDADE_CODIGO_MS = 48 * 60 * 60 * 1000

interface LinhaBot {
  id: number
  nome: string
  numero_id: number | null
  ativo: number
  criado_em: number
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

interface LinhaProgramada {
  id: number
  bot_id: number
  jid: string
  origem: OrigemProgramada
  horarios: string
  dias: string
  data: string | null
  variar: number
  mencionar: number
  ativa: number
  ultimo_envio: number | null
  ultima_variacao: number | null
  criado_por: string
  criado_em: number
}

interface LinhaVariacao {
  ordem: number
  texto: string | null
  midia: string | null
  midia_tipo: TipoMidia | null
  mimetype: string | null
  nome_arquivo: string | null
}

const botDe = (l: LinhaBot): BotGrupos => ({ id: l.id, nome: l.nome, numeroId: l.numero_id, ativo: l.ativo === 1, criadoEm: l.criado_em })

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
const COLUNAS_GESTOR = `bot_id, funcionario_id, codigo, codigo_expira_em, confirmado_em, confirmado_jid, divergente_jid,
  divergente_telefone, divergente_em, adicionado_por, adicionado_em`

/** Bots de grupos e tudo o que é de cada um: grupos ativos, gestores, comandos, moderação e mensagens programadas. */
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

  /** Apaga junto grupos ativos, gestores, comandos e programadas (FK em cascata). */
  excluirBot(id: number): boolean {
    return this.db.transaction(() => {
      this.db.prepare(`DELETE FROM programadas WHERE bot_id = ?`).run(id)
      return this.db.prepare(`DELETE FROM bots_grupos WHERE id = ?`).run(id).changes === 1
    })()
  }

  // --- grupos ativos --------------------------------------------------------------

  gruposAtivos(botId: number): GrupoAtivo[] {
    return (
      this.db
        .prepare(`SELECT bot_id AS botId, jid, ativado_em AS ativadoEm, ativado_por AS ativadoPor FROM grupos_ativos WHERE bot_id = ? ORDER BY ativado_em, jid`)
        .all(botId) as GrupoAtivo[]
    )
  }

  grupoAtivo(botId: number, jid: string): GrupoAtivo | null {
    return (
      (this.db
        .prepare(`SELECT bot_id AS botId, jid, ativado_em AS ativadoEm, ativado_por AS ativadoPor FROM grupos_ativos WHERE bot_id = ? AND jid = ?`)
        .get(botId, jid) as GrupoAtivo | undefined) ?? null
    )
  }

  ativarGrupo(botId: number, jid: string, por: string, agora: number): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO grupos_ativos (bot_id, jid, ativado_em, ativado_por) VALUES (?, ?, ?, ?)`)
      .run(botId, jid, agora, por)
  }

  /** Palavras proibidas, silêncio e programadas do grupo saem junto (FK em cascata). */
  desativarGrupo(botId: number, jid: string): boolean {
    return this.db.transaction(() => {
      this.db.prepare(`DELETE FROM programadas WHERE bot_id = ? AND jid = ?`).run(botId, jid)
      return this.db.prepare(`DELETE FROM grupos_ativos WHERE bot_id = ? AND jid = ?`).run(botId, jid).changes === 1
    })()
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

  /** Em quantos bots a pessoa é (ou foi indicada como) gestora. */
  botsDaPessoa(funcionarioId: number): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM gestores_bot WHERE funcionario_id = ?`).get(funcionarioId) as { n: number }).n
  }

  /** Indica como gestor (pendente) e devolve o código. Quem já está na lista só ganha código novo. */
  indicarGestor(botId: number, funcionarioId: number, por: string, agora: number): string {
    this.db
      .prepare(`INSERT OR IGNORE INTO gestores_bot (bot_id, funcionario_id, adicionado_por, adicionado_em) VALUES (?, ?, ?, ?)`)
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

  /** Nomes dos comandos desligados neste bot (ausente = ligado). */
  desligados(botId: number): Set<string> {
    return new Set(
      (this.db.prepare(`SELECT nome FROM comandos_bot WHERE bot_id = ? AND ligado = 0`).all(botId) as { nome: string }[]).map((r) => r.nome)
    )
  }

  ligarComando(botId: number, nome: string, ligado: boolean): void {
    this.db
      .prepare(`INSERT INTO comandos_bot (bot_id, nome, ligado) VALUES (?, ?, ?) ON CONFLICT (bot_id, nome) DO UPDATE SET ligado = excluded.ligado`)
      .run(botId, nome, ligado ? 1 : 0)
  }

  // --- palavras proibidas (/banword) ----------------------------------------------

  palavras(botId: number, jid: string): string[] {
    return (
      this.db.prepare(`SELECT palavra FROM palavras_proibidas WHERE bot_id = ? AND jid = ? ORDER BY palavra`).all(botId, jid) as { palavra: string }[]
    ).map((r) => r.palavra)
  }

  /** Por grupo ativo do bot (só grupos que têm alguma). */
  palavrasDoBot(botId: number): Map<string, string[]> {
    const mapa = new Map<string, string[]>()
    const linhas = this.db.prepare(`SELECT jid, palavra FROM palavras_proibidas WHERE bot_id = ? ORDER BY palavra`).all(botId) as {
      jid: string
      palavra: string
    }[]
    for (const l of linhas) mapa.set(l.jid, [...(mapa.get(l.jid) ?? []), l.palavra])
    return mapa
  }

  adicionarPalavras(botId: number, jid: string, palavras: string[]): void {
    const ins = this.db.prepare(`INSERT OR IGNORE INTO palavras_proibidas (bot_id, jid, palavra) VALUES (?, ?, ?)`)
    for (const p of palavras) ins.run(botId, jid, p)
  }

  removerPalavras(botId: number, jid: string, palavras: string[] | null): number {
    if (palavras === null) return this.db.prepare(`DELETE FROM palavras_proibidas WHERE bot_id = ? AND jid = ?`).run(botId, jid).changes
    const del = this.db.prepare(`DELETE FROM palavras_proibidas WHERE bot_id = ? AND jid = ? AND palavra = ?`)
    return palavras.reduce((n, p) => n + del.run(botId, jid, p).changes, 0)
  }

  // --- silêncio (/mutegroup) ------------------------------------------------------

  silencios(botId: number): Silencio[] {
    return (
      this.db.prepare(`SELECT bot_id, jid, inicio, fim, fechado FROM silencios WHERE bot_id = ? ORDER BY jid`).all(botId) as {
        bot_id: number
        jid: string
        inicio: string | null
        fim: string | null
        fechado: number | null
      }[]
    ).map((l) => ({ botId: l.bot_id, jid: l.jid, inicio: l.inicio, fim: l.fim, fechado: l.fechado === null ? null : l.fechado === 1 }))
  }

  silencio(botId: number, jid: string): Silencio | null {
    return this.silencios(botId).find((s) => s.jid === jid) ?? null
  }

  /** Cria ou troca o horário; o estado aplicado é mantido (o agendador decide se precisa mudar). */
  definirSilencio(botId: number, jid: string, inicio: string | null, fim: string | null, por: string, agora: number): void {
    this.db
      .prepare(
        `INSERT INTO silencios (bot_id, jid, inicio, fim, criado_por, criado_em) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (bot_id, jid) DO UPDATE SET inicio = excluded.inicio, fim = excluded.fim, criado_por = excluded.criado_por,
           criado_em = excluded.criado_em`
      )
      .run(botId, jid, inicio, fim, por, agora)
  }

  marcarSilencioAplicado(botId: number, jid: string, fechado: boolean): void {
    this.db.prepare(`UPDATE silencios SET fechado = ? WHERE bot_id = ? AND jid = ?`).run(fechado ? 1 : 0, botId, jid)
  }

  removerSilencio(botId: number, jid: string): boolean {
    return this.db.prepare(`DELETE FROM silencios WHERE bot_id = ? AND jid = ?`).run(botId, jid).changes === 1
  }

  // --- mensagens programadas e /repeat --------------------------------------------

  private variacoesDe(id: number): VariacaoMensagem[] {
    return (
      this.db
        .prepare(`SELECT ordem, texto, midia, midia_tipo, mimetype, nome_arquivo FROM programadas_msgs WHERE programada_id = ? ORDER BY ordem`)
        .all(id) as LinhaVariacao[]
    ).map((v) => ({
      texto: v.texto,
      midia: v.midia && v.midia_tipo ? { caminho: v.midia, tipo: v.midia_tipo, mimetype: v.mimetype ?? 'application/octet-stream', nome: v.nome_arquivo } : null
    }))
  }

  private programadaDe(l: LinhaProgramada): Programada {
    return {
      id: l.id,
      botId: l.bot_id,
      jid: l.jid,
      origem: l.origem,
      horarios: JSON.parse(l.horarios) as string[],
      dias: JSON.parse(l.dias) as number[],
      data: l.data,
      variar: l.variar === 1,
      mencionar: l.mencionar === 1,
      ativa: l.ativa === 1,
      ultimoEnvio: l.ultimo_envio,
      ultimaVariacao: l.ultima_variacao,
      criadoPor: l.criado_por,
      criadoEm: l.criado_em,
      variacoes: this.variacoesDe(l.id)
    }
  }

  programadas(botId: number): Programada[] {
    return (this.db.prepare(`SELECT * FROM programadas WHERE bot_id = ? ORDER BY ativa DESC, id`).all(botId) as LinhaProgramada[]).map((l) =>
      this.programadaDe(l)
    )
  }

  programada(id: number): Programada | null {
    const l = this.db.prepare(`SELECT * FROM programadas WHERE id = ?`).get(id) as LinhaProgramada | undefined
    return l ? this.programadaDe(l) : null
  }

  /**
   * Cria (id null) ou substitui. As variações vazias (sem texto nem mídia) não são gravadas. Conta como
   * "enviada agora": um horário que acabou de passar não sai na hora só porque a programada é nova.
   */
  salvarProgramada(id: number | null, botId: number, d: DadosProgramada, por: string, agora: number): number {
    return this.db.transaction(() => {
      const campos = [d.jid, d.origem, JSON.stringify(d.horarios), JSON.stringify(d.dias), d.data, d.variar ? 1 : 0, d.mencionar ? 1 : 0]
      let alvo = id
      if (alvo === null) {
        alvo = Number(
          this.db
            .prepare(
              `INSERT INTO programadas (jid, origem, horarios, dias, data, variar, mencionar, bot_id, criado_por, criado_em, ultimo_envio)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(...campos, botId, por, agora, agora).lastInsertRowid
        )
      } else {
        const r = this.db
          .prepare(
            `UPDATE programadas SET jid = ?, origem = ?, horarios = ?, dias = ?, data = ?, variar = ?, mencionar = ?, ativa = 1, ultimo_envio = ?
             WHERE id = ? AND bot_id = ?`
          )
          .run(...campos, agora, alvo, botId)
        if (r.changes !== 1) throw new Error('programada não encontrada')
        this.db.prepare(`DELETE FROM programadas_msgs WHERE programada_id = ?`).run(alvo)
      }
      const ins = this.db.prepare(
        `INSERT INTO programadas_msgs (programada_id, ordem, texto, midia, midia_tipo, mimetype, nome_arquivo) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      d.variacoes
        .filter((v) => v.texto || v.midia)
        .forEach((v, i) => ins.run(alvo, i + 1, v.texto, v.midia?.caminho ?? null, v.midia?.tipo ?? null, v.midia?.mimetype ?? null, v.midia?.nome ?? null))
      return alvo
    })()
  }

  definirProgramadaAtiva(id: number, ativa: boolean): void {
    this.db.prepare(`UPDATE programadas SET ativa = ? WHERE id = ?`).run(ativa ? 1 : 0, id)
  }

  /** Registra o horário (do slot, não do relógio) para não mandar duas vezes o mesmo horário. */
  marcarEnvio(id: number, slot: number, variacao: number, encerrar: boolean): void {
    this.db.prepare(`UPDATE programadas SET ultimo_envio = ?, ultima_variacao = ?, ativa = ? WHERE id = ?`).run(slot, variacao, encerrar ? 0 : 1, id)
  }

  /** Devolve os caminhos das mídias que deixaram de ser usadas (quem chama apaga os arquivos). */
  excluirProgramada(id: number): string[] {
    const p = this.programada(id)
    if (!p) return []
    this.db.prepare(`DELETE FROM programadas WHERE id = ?`).run(id)
    return p.variacoes.flatMap((v) => (v.midia ? [v.midia.caminho] : []))
  }

  /** /repeat stop: apaga as repetições do grupo e devolve quantas eram e as mídias soltas. */
  excluirRepeticoes(botId: number, jid: string): { total: number; midias: string[] } {
    const ids = (
      this.db.prepare(`SELECT id FROM programadas WHERE bot_id = ? AND jid = ? AND origem = 'repeat'`).all(botId, jid) as { id: number }[]
    ).map((r) => r.id)
    const midias = ids.flatMap((id) => this.excluirProgramada(id))
    return { total: ids.length, midias }
  }

  /** Todas as mídias ainda referenciadas (para limpar arquivos órfãos). */
  midiasEmUso(): Set<string> {
    return new Set((this.db.prepare(`SELECT midia FROM programadas_msgs WHERE midia IS NOT NULL`).all() as { midia: string }[]).map((r) => r.midia))
  }
}
