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
})
