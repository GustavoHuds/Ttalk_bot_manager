import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { MIGRACOES, migrar } from '../src/db/banco.js'

/** Banco como estava na versão 1.0.0 (user_version 2), com uma linha em cada tabela afetada. */
function bancoV2() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrar(db, 2)
  db.exec(`
    INSERT INTO processos (codigo, dados, criado_em, atualizado_em, atualizado_por) VALUES ('VEND-OUT26', '{}', 1, 1, 'rh');
    INSERT INTO candidaturas (id, processo, protocolo, jid, passo, status, criada_em, atualizada_em, ultima_interacao)
      VALUES (7, 'VEND-OUT26', 'VEND-OUT26-0001', 'a@s.whatsapp.net', 'nome', 'em_andamento', 1, 1, 1);
    INSERT INTO conversas (jid, candidatura_id, estado, ultima_recebida) VALUES ('a@s.whatsapp.net', 7, NULL, 5);
    INSERT INTO mensagens_processadas (id, jid, recebida_em, status, payload) VALUES ('M1', 'a@s.whatsapp.net', 5, 'pendente', '{}');
    INSERT INTO saida (jid, conteudo, criada_em) VALUES ('a@s.whatsapp.net', '{}', 5);
    INSERT INTO enquetes (id, jid, chave, opcoes, segredo, criada_em) VALUES ('E1', 'a@s.whatsapp.net', 'k', '[]', x'00', 5);
    INSERT INTO enviadas (id, conteudo, criada_em) VALUES ('S1', '{}', 5);
  `)
  return db
}

describe('migrações', () => {
  it('banco da versão 2 sobe para a atual com tudo no número 1', () => {
    const db = bancoV2()
    migrar(db)
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRACOES.length)
    expect(db.prepare('SELECT id, nome, papel, ativo FROM numeros').all()).toEqual([
      { id: 1, nome: 'Principal', papel: 'recrutamento', ativo: 1 }
    ])
    for (const t of ['processos', 'candidaturas', 'conversas', 'mensagens_processadas', 'saida', 'enquetes', 'enviadas']) {
      expect(db.prepare(`SELECT DISTINCT numero_id AS n FROM ${t}`).all(), t).toEqual([{ n: 1 }])
    }
    expect(db.prepare('SELECT candidatura_id, ultima_recebida FROM conversas').get()).toEqual({ candidatura_id: 7, ultima_recebida: 5 })
    expect(db.prepare('SELECT status, payload FROM mensagens_processadas').get()).toEqual({ status: 'pendente', payload: '{}' })
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'mensagens_pendentes'`).get()
    ).toBeDefined()
    db.exec('DELETE FROM candidaturas WHERE id = 7')
    expect(db.prepare(`SELECT candidatura_id FROM conversas WHERE jid = 'a@s.whatsapp.net'`).get()).toEqual({ candidatura_id: null })
  })

  it('a mesma pessoa conversa com dois números e o mesmo ID de mensagem chega aos dois', () => {
    const db = bancoV2()
    migrar(db)
    db.exec(`INSERT INTO numeros (id, nome, papel, criado_em) VALUES (2, 'Segundo', 'recrutamento', 1)`)
    db.exec(`INSERT INTO conversas (numero_id, jid, ultima_recebida) VALUES (2, 'a@s.whatsapp.net', 9)`)
    db.exec(`INSERT INTO mensagens_processadas (numero_id, id, jid, recebida_em, status) VALUES (2, 'M1', 'a@s.whatsapp.net', 9, 'processada')`)
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversas').get()).toEqual({ n: 2 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM mensagens_processadas').get()).toEqual({ n: 2 })
  })

  it('papel desconhecido é recusado', () => {
    const db = bancoV2()
    migrar(db)
    expect(() => db.exec(`INSERT INTO numeros (nome, papel, criado_em) VALUES ('x', 'outro', 1)`)).toThrow()
  })

  it('cria as tabelas do bot de grupos', () => {
    const db = bancoV2()
    migrar(db)
    const tabelas = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name)
    expect(tabelas).toEqual(
      expect.arrayContaining(['grupos', 'funcionarios', 'gestores_bot', 'saida_grupos', 'bots_grupos', 'lojas', 'grupos_ativos', 'participantes', 'comandos_bot'])
    )
    expect(tabelas).not.toContain('gestores')
  })

  it('versão 4 → 5: número de grupos vira bot, gestores antigos ficam pendentes, etiquetas saem de grupos', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrar(db, 4)
    db.exec(`
      INSERT INTO numeros (id, nome, papel, criado_em) VALUES (2, 'Avisos', 'grupos', 50);
      INSERT INTO funcionarios (id, nome, telefone, criado_em, atualizado_em) VALUES (9, 'Ana', '5583999990001', 1, 1);
      INSERT INTO gestores (funcionario_id, adicionado_por, adicionado_em) VALUES (9, 'painel:rh', 7);
      INSERT INTO grupos (numero_id, jid, nome, setor, loja, atualizado_em) VALUES (2, 'g@g.us', 'Loja', 'Vendas', 'Centro', 1);
    `)
    migrar(db)
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRACOES.length)
    expect(db.prepare('SELECT id, nome, numero_id, ativo, criado_em FROM bots_grupos').all()).toEqual([
      { id: 1, nome: 'Avisos', numero_id: 2, ativo: 1, criado_em: 50 }
    ])
    expect(db.prepare('SELECT bot_id, funcionario_id, confirmado_em, codigo, adicionado_por FROM gestores_bot').all()).toEqual([
      { bot_id: 1, funcionario_id: 9, confirmado_em: null, codigo: null, adicionado_por: 'painel:rh' }
    ])
    const colunas = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)
    expect(colunas('grupos')).not.toContain('setor')
    expect(colunas('grupos')).not.toContain('loja')
    expect(colunas('funcionarios')).toContain('confirmado_em')
    expect(colunas('auditoria')).toContain('funcionario_id')
    expect(db.prepare('SELECT COUNT(*) AS n FROM grupos_ativos').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT nome FROM grupos').get()).toEqual({ nome: 'Loja' })
  })

  it('versão 4 → 5 sem número de grupos: gestores antigos somem sem erro', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrar(db, 4)
    db.exec(`
      INSERT INTO funcionarios (id, nome, telefone, criado_em, atualizado_em) VALUES (9, 'Ana', '5583999990001', 1, 1);
      INSERT INTO gestores (funcionario_id, adicionado_por, adicionado_em) VALUES (9, 'painel:rh', 7);
    `)
    migrar(db)
    expect(db.prepare('SELECT COUNT(*) AS n FROM bots_grupos').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM gestores_bot').get()).toEqual({ n: 0 })
  })

  it('participantes somem quando o grupo deixa de ser ativo; loja apagada deixa o grupo sem loja', () => {
    const db = bancoV2()
    migrar(db)
    db.exec(`
      INSERT INTO numeros (id, nome, papel, criado_em) VALUES (2, 'Avisos', 'grupos', 1);
      INSERT INTO bots_grupos (id, nome, numero_id, criado_em) VALUES (1, 'Avisos', 2, 1);
      INSERT INTO lojas (id, bot_id, nome) VALUES (3, 1, 'Centro');
      INSERT INTO grupos_ativos (bot_id, jid, loja_id, ativado_em, ativado_por) VALUES (1, 'g@g.us', 3, 1, 'rh');
      INSERT INTO participantes (bot_id, grupo_jid, jid) VALUES (1, 'g@g.us', '1@lid');
    `)
    expect(() => db.exec(`INSERT INTO lojas (bot_id, nome) VALUES (1, 'centro')`)).toThrow()
    db.exec('DELETE FROM lojas WHERE id = 3')
    expect(db.prepare('SELECT loja_id FROM grupos_ativos').get()).toEqual({ loja_id: null })
    db.exec(`DELETE FROM grupos_ativos WHERE jid = 'g@g.us'`)
    expect(db.prepare('SELECT COUNT(*) AS n FROM participantes').get()).toEqual({ n: 0 })
  })
})
