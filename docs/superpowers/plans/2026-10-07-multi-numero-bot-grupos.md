# Multi-number + group bot core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run N WhatsApp numbers in one process (each with one role: `recrutamento` or `grupos`) and ship the group bot core: groups registry, team registry, managers, WhatsApp commands, audit, and the panel pages to set it up.

**Architecture:** One Node process, one SQLite database, one `ConexaoBaileys` per number managed by `GerenciadorConexoes`. Recruitment keeps its engine → orchestrator → outbox → sender layering, now scoped by `numero_id`. The group bot copies that layering in `src/grupos/`: pure parser (`comandos.ts`) → pure engine (`motor.ts`) → orchestrator (identity resolution, one transaction for dedupe + state + outbox + audit) → its own sender (`expedidor.ts`).

**Tech Stack:** TypeScript (strict, NodeNext ESM), Baileys 7.0.0-rc14 (pinned), better-sqlite3, Fastify 5, Vitest 5.

**Spec:** `docs/superpowers/specs/2026-10-07-multi-numero-bot-grupos-design.md`

---

## Ground rules for every task

- Commands: `npx vitest run <file>` for one file, `npm test` for all, `npm run typecheck` for types. Both must be green at the end of every task (the baseline is 90 tests, typecheck clean).
- Identifiers and user-facing text are Portuguese; follow the file you're editing. Comment density: short JSDoc on exported things, a line where a rule isn't obvious. No content of messages or personal data in logs: IDs only.
- Only files in `src/whatsapp/` import Baileys.
- State + replies go in one transaction. Never send from an orchestrator.
- Commit after every task with the message given in the task, ending with the attribution line:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

## Decisions this plan adds to the spec

1. **`candidaturas` also gets `numero_id`.** The spec lists the tables keyed by contact; without it, a person who applied on number 1 and writes to number 2 would see number 1's applications in the engine. The test "two recruitment numbers don't share conversation state" needs it.
2. **`mensagens_processadas` primary key becomes `(numero_id, id)`.** Two group numbers in the same group receive the same message ID.
3. **No `REFERENCES` on columns added by `ALTER TABLE`.** SQLite refuses `ADD COLUMN ... REFERENCES ... DEFAULT 1` while `foreign_keys = ON`. Numbers are never deleted (only deactivated), so integrity holds without the FK. New tables (migration 4) keep their FKs.
4. **`processos.numero_id` is authoritative.** The bot JSON also carries `numero_id` (the editor needs it), always written together with the column; `FonteBots` reads the column.
5. **Data deletion requested by a candidate stays global** (by chat or phone, across numbers): the safer LGPD reading.
6. **Phones are stored canonically:** `55 + DDD + number`, with the mobile `9` re-inserted when WhatsApp delivers an old 12-digit mobile (`telefoneCanonico`). Every comparison goes through it.
7. **Group commands are not retried after a crash.** Async work (LID lookup, group metadata) runs first; then dedupe row + state + replies + audit commit in one transaction. If the process dies before that, the command simply did not happen and the manager sends it again. Commands older than 10 minutes (queue flushed on reconnect) are ignored.
8. **Private chat with a group number: only managers get any answer**, including `/menu` (spec decision "private messages from non-managers are ignored silently" wins over the table row).
9. **Number role is fixed at creation.** To change role, add a new number.

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/db/banco.ts` | modify | migrations 3 and 4; export `MIGRACOES`, `migrar(db, alvo?)` |
| `src/db/numeros.ts` | create | `RepoNumeros`, `Numero`, `Papel` |
| `src/db/repositorio.ts` | modify | recruitment queries scoped by `numeroId`; `listarBots/salvarBot` with number; `filas()` counts both outboxes |
| `src/db/grupos.ts` | create | `RepoGrupos`: groups, employees, managers, command dedupe, group outbox |
| `src/config/tipos.ts`, `carregar.ts`, `bots.ts` | modify | `Processo.numeroId`, `DadosBot.numero_id`, validation |
| `src/conversa/orquestrador.ts` | modify | `MensagemRecebida.numeroId`, queue key `${numeroId}:${jid}`, scoped repo calls |
| `src/whatsapp/limite.ts` | create | `LimitePorMinuto` (sliding window shared by both senders) |
| `src/whatsapp/expedidor.ts` | modify | one per recruitment number |
| `src/grupos/tipos.ts` | create | group bot types and the `ConexaoGrupos` port |
| `src/grupos/pessoas.ts` | create | phone canonical form, JID helpers, employee lookup, LID linking |
| `src/grupos/comandos.ts` | create | command table + pure parser |
| `src/grupos/motor.ts` | create | pure engine |
| `src/grupos/orquestrador.ts` | create | inbox → engine → transaction; group events |
| `src/grupos/expedidor.ts` | create | group outbox sender |
| `src/grupos/equipe.ts` | create | employee validation + CSV reader |
| `src/whatsapp/normalizar.ts` | modify | group-side pure helpers |
| `src/whatsapp/baileys.ts` | modify | `numeroId`, `papel`, implements `ConexaoGrupos`, group events |
| `src/whatsapp/gerenciador.ts` | create | `GerenciadorConexoes`, session folders, legacy session move |
| `src/rotinas/alerta.ts`, `backup.ts` | modify | alert per number; back up `sessoes/` |
| `src/painel/*` | modify/create | Números, Grupos, Equipe pages; `/healthz`, `/saude`, bot editor number |
| `src/main.ts` | modify | wiring |
| tests | create/modify | one test file per new unit, existing tests updated |

---

### Task 1: Migration 3 — numbers table and `numero_id` everywhere

**Files:**
- Modify: `src/db/banco.ts`
- Test: `tests/migracao.test.ts` (create)

- [ ] **Step 1: Write the failing test** — create `tests/migracao.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it** — `npx vitest run tests/migracao.test.ts` → FAIL (`MIGRACOES`/`migrar` are not exported).

- [ ] **Step 3: Implement** in `src/db/banco.ts`:
  - change `const MIGRACOES: string[] = [` to `export const MIGRACOES: string[] = [`
  - append this third element after the `processos` migration (keep the first two untouched):

```ts
  `
  -- Números de WhatsApp. Nunca são apagados (só desativados): por isso as colunas numero_id abaixo
  -- não têm REFERENCES (o SQLite não aceita ADD COLUMN com REFERENCES e DEFAULT 1 com as FKs ligadas).
  CREATE TABLE numeros (
    id INTEGER PRIMARY KEY,
    nome TEXT NOT NULL,
    papel TEXT NOT NULL CHECK (papel IN ('recrutamento', 'grupos')),
    ativo INTEGER NOT NULL DEFAULT 1,
    criado_em INTEGER NOT NULL
  );
  INSERT INTO numeros (id, nome, papel, ativo, criado_em) VALUES (1, 'Principal', 'recrutamento', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000);

  ALTER TABLE processos ADD COLUMN numero_id INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE candidaturas ADD COLUMN numero_id INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE saida ADD COLUMN numero_id INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE enquetes ADD COLUMN numero_id INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE enviadas ADD COLUMN numero_id INTEGER NOT NULL DEFAULT 1;
  CREATE INDEX candidaturas_numero_jid ON candidaturas (numero_id, jid);
  CREATE INDEX saida_numero ON saida (numero_id, proxima_em);

  -- A mesma pessoa pode conversar com dois números.
  CREATE TABLE conversas_nova (
    numero_id INTEGER NOT NULL,
    jid TEXT NOT NULL,
    candidatura_id INTEGER REFERENCES candidaturas (id) ON DELETE SET NULL,
    estado TEXT,
    ultima_recebida INTEGER NOT NULL,
    PRIMARY KEY (numero_id, jid)
  );
  INSERT INTO conversas_nova (numero_id, jid, candidatura_id, estado, ultima_recebida)
    SELECT 1, jid, candidatura_id, estado, ultima_recebida FROM conversas;
  DROP TABLE conversas;
  ALTER TABLE conversas_nova RENAME TO conversas;

  -- O mesmo ID de mensagem chega a dois números quando os dois estão no mesmo grupo.
  CREATE TABLE mensagens_nova (
    numero_id INTEGER NOT NULL,
    id TEXT NOT NULL,
    jid TEXT NOT NULL,
    recebida_em INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pendente', 'processada', 'erro')),
    tentativas INTEGER NOT NULL DEFAULT 0,
    payload TEXT,
    PRIMARY KEY (numero_id, id)
  );
  INSERT INTO mensagens_nova (numero_id, id, jid, recebida_em, status, tentativas, payload)
    SELECT 1, id, jid, recebida_em, status, tentativas, payload FROM mensagens_processadas;
  DROP TABLE mensagens_processadas;
  ALTER TABLE mensagens_nova RENAME TO mensagens_processadas;
  CREATE INDEX mensagens_pendentes ON mensagens_processadas (status) WHERE status = 'pendente';
  `
```

  - replace the private `migrar` with an exported one that can stop at a version (tests build old databases with it):

```ts
/** Aplica as migrações que faltam, cada uma na sua transação. `alvo` serve aos testes de migração. */
export function migrar(db: Banco, alvo = MIGRACOES.length): void {
  const versao = db.pragma('user_version', { simple: true }) as number
  for (let v = versao; v < alvo; v++) {
    db.transaction(() => {
      db.exec(MIGRACOES[v]!)
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
}
```

- [ ] **Step 4: Run** `npx vitest run tests/migracao.test.ts` → PASS. Do not run the whole suite yet: the repository still uses the old `conversas`/`mensagens_processadas` shape until Task 3, so `npm test` is expected to fail on recruitment tests between Task 1 and Task 3. **Do not commit Task 1 alone**; Tasks 1–3 are committed together at the end of Task 3 (one green commit). Run `npm run typecheck` → PASS.

---

### Task 2: Numbers repository and bots bound to a number

**Files:**
- Create: `src/db/numeros.ts`
- Modify: `src/config/tipos.ts`, `src/config/carregar.ts`, `src/config/bots.ts`, `src/db/repositorio.ts` (bots section only), `src/painel/editor.ts`, `src/painel/servidor.ts`
- Test: `tests/numeros.test.ts` (create), `tests/bots.test.ts`, `tests/editor-ui.test.ts`, `tests/painel.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/numeros.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { abrirBanco } from '../src/db/banco.js'
import { RepoNumeros } from '../src/db/numeros.js'
import { AGORA } from './ajuda.js'

describe('números', () => {
  it('começa com o Principal; cria, lista e desativa sem apagar', () => {
    const numeros = new RepoNumeros(abrirBanco(':memory:'))
    expect(numeros.listar().map((n) => [n.id, n.nome, n.papel, n.ativo])).toEqual([[1, 'Principal', 'recrutamento', true]])
    const g = numeros.criar('Avisos', 'grupos', AGORA)
    expect(g).toEqual({ id: 2, nome: 'Avisos', papel: 'grupos', ativo: true, criadoEm: AGORA })
    numeros.definirAtivo(2, false)
    expect(numeros.numero(2)!.ativo).toBe(false)
    expect(numeros.numero(99)).toBeNull()
  })
})
```

Append to the `describe('bots no banco', ...)` block in `tests/bots.test.ts`:

```ts
  it('o número do bot vem da coluna, não do JSON', () => {
    const repo = new Repositorio(abrirBanco(':memory:'))
    const fonte = new FonteBots(repo, lerPadrao(CONFIG))
    fonte.importarYaml(lerYamlProcessos(CONFIG), AGORA)
    const bruto = JSON.parse(repo.bot('VEND-OUT26')!)
    repo.salvarBot('VEND-OUT26', JSON.stringify({ ...bruto, numero_id: 9 }), 2, 'teste', AGORA)
    fonte.invalidar()
    expect(fonte.get().processos[0]!.numeroId).toBe(2)
  })
```

and change the existing call on line 23 to the new signature: `repo.salvarBot('X-1', JSON.stringify({ codigo: 'X-1', vaga: 'X' }), 1, 'teste', AGORA)`.

In `tests/editor-ui.test.ts` change both `prepararBot(dados, padrao, 'aberto')` calls to `prepararBot(dados, padrao, 'aberto', [1])`, and append inside its top-level `describe`:

```ts
  it('bot só pode ficar num número de recrutamento', () => {
    const dados = { ...botModelo('2026-10-06'), codigo: 'X-1', vaga: 'X', encerra_em: '2026-10-31', numero_id: 3 }
    expect(() => prepararBot(dados, padrao, 'aberto', [1, 2])).toThrow('número de recrutamento')
    expect(prepararBot({ ...dados, numero_id: 2 }, padrao, 'aberto', [1, 2]).processo.numeroId).toBe(2)
  })
```

(Read `tests/editor-ui.test.ts` first: if `botModelo` is not imported there, it already is on line 3 — `import { botModelo, prepararBot }`.)

In `tests/painel.test.ts`:
  - add `import { RepoNumeros } from '../src/db/numeros.js'`
  - in `painelComBot`, change `repo.salvarBot('VEND-OUT26', JSON.stringify({...}), 'teste', AGORA)` to pass `1` before `'teste'`, and add `numeros: new RepoNumeros(repo.db),` to the `criarPainel({...})` object.
  - append inside `describe('editor de bots', ...)`:

```ts
  it('bot fica no número escolhido; número de grupos não aparece e é recusado', async () => {
    const numeros = new RepoNumeros(repo.db)
    const sul = numeros.criar('Loja Sul', 'recrutamento', AGORA)
    const avisos = numeros.criar('Avisos', 'grupos', AGORA)
    expect((await salvar(novo({ numero_id: avisos.id }), 'aberto')).body).toContain('número de recrutamento')
    expect((await salvar(novo({ numero_id: sul.id }), 'aberto')).statusCode).toBe(303)
    expect(bots.get().processos[0]!.numeroId).toBe(sul.id)
    const form = await app.inject({ url: '/bots/CAIXA-NOV26', headers: { cookie } })
    expect(form.body).toContain(`<option value="${sul.id}" selected>Loja Sul</option>`)
    expect(form.body).not.toContain('Avisos')
  })
```

- [ ] **Step 2: Run** `npx vitest run tests/numeros.test.ts tests/bots.test.ts tests/editor-ui.test.ts` → FAIL (module `numeros.js` missing, `numeroId` undefined).

- [ ] **Step 3: Implement**

Create `src/db/numeros.ts`:

```ts
import type { Banco } from './banco.js'

/** Um número tem um uso só, para os perfis anti-bloqueio não se misturarem. */
export type Papel = 'recrutamento' | 'grupos'
export const PAPEIS: Papel[] = ['recrutamento', 'grupos']

export interface Numero {
  id: number
  nome: string
  papel: Papel
  ativo: boolean
  criadoEm: number
}

interface LinhaNumero {
  id: number
  nome: string
  papel: Papel
  ativo: number
  criado_em: number
}

const deLinha = (l: LinhaNumero): Numero => ({ id: l.id, nome: l.nome, papel: l.papel, ativo: l.ativo === 1, criadoEm: l.criado_em })

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
}
```

`src/config/tipos.ts` — add to `Processo`, after `retencaoMeses: number`:

```ts
  /** Número de WhatsApp que atende este bot. */
  numeroId: number
```

`src/config/carregar.ts` — in `validarProcesso`, before `const mensagens = ...`:

```ts
  const numeroId = d.numero_id ?? 1
  if (typeof numeroId !== 'number' || !Number.isInteger(numeroId) || numeroId < 1) throw new ErroConfig('numero_id deve ser o id de um número')
```

and return it: `return { codigo, vaga, status, abreEm, encerraEm, retencaoMeses, numeroId, perguntas, mensagens, arquivoOrigem }`.

`src/config/bots.ts`:
  - `DadosBot`: add after `retencao_meses: number`:
    ```ts
      /** Número de recrutamento que atende o bot. A coluna processos.numero_id é quem vale; aqui vai junto para o editor. */
      numero_id: number
    ```
  - `botModelo(hoje: string, numeroId = 1)`: add `numero_id: numeroId,` after `retencao_meses: 12,`.
  - `paraEditor`: add `numero_id: Number(d.numero_id ?? 1),` after `retencao_meses: ...`.
  - `prepararBot` signature becomes `prepararBot(entrada: unknown, padrao: Mensagens, status: StatusProcesso, numerosRecrutamento: number[])`; right before `const dados: DadosBot = {` add:
    ```ts
      const numeroId = Number(e.numero_id)
      if (!numerosRecrutamento.includes(numeroId)) throw new ErroConfig('escolha um número de recrutamento para o bot')
    ```
    and add `numero_id: numeroId,` to `dados` after `retencao_meses`.
  - `FonteBots.get()`: map with the column winning:
    ```ts
          this.repo.listarBots().map((b) => ({ origem: `bot ${b.codigo}`, dados: { ...(JSON.parse(b.dados) as object), numero_id: b.numeroId } })),
    ```
  - `importarYaml`: `this.repo.salvarBot(p.codigo, JSON.stringify({ ...ed, codigo: p.codigo, numero_id: 1 }), 1, 'importacao', agora)`.

`src/db/repositorio.ts` — bots section:

```ts
  listarBots(): { codigo: string; dados: string; numeroId: number; atualizadoEm: number; atualizadoPor: string }[] {
    return this.db
      .prepare(
        `SELECT codigo, dados, numero_id AS numeroId, atualizado_em AS atualizadoEm, atualizado_por AS atualizadoPor
         FROM processos ORDER BY criado_em, codigo`
      )
      .all() as { codigo: string; dados: string; numeroId: number; atualizadoEm: number; atualizadoPor: string }[]
  }

  salvarBot(codigo: string, dados: string, numeroId: number, usuario: string, agora: number): void {
    this.db
      .prepare(
        `INSERT INTO processos (codigo, dados, numero_id, criado_em, atualizado_em, atualizado_por) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (codigo) DO UPDATE SET dados = excluded.dados, numero_id = excluded.numero_id,
           atualizado_em = excluded.atualizado_em, atualizado_por = excluded.atualizado_por`
      )
      .run(codigo, dados, numeroId, agora, agora, usuario)
  }
```

`src/painel/editor.ts`:
  - `OpcoesEditor`: add `/** Números de recrutamento que o bot pode usar. */ numeros: { id: number; nome: string }[]`
  - inside `<div class="grade">`, after the `Código` label, add:
    ```ts
            <label>Número do WhatsApp<select id="numero_id">${o.numeros
              .map((n) => `<option value="${n.id}"${n.id === d.numero_id ? ' selected' : ''}>${esc(n.nome)}</option>`)
              .join('')}</select></label>
    ```
  - in `SCRIPT`, in the final `JSON.stringify({...})`, add `numero_id:Number(v('numero_id')),` right after `codigo:v('codigo'),`.

`src/painel/servidor.ts`:
  - `import type { RepoNumeros } from '../db/numeros.js'`; add `numeros: RepoNumeros` to `DependenciasPainel` (after `repo`).
  - add a helper inside `criarPainel`, next to `hoje`:
    ```ts
      const numerosRecrutamento = () => d.numeros.listar().filter((n) => n.papel === 'recrutamento')
    ```
  - `editor` helper passes the list: `html(rep, paginaEditorBot({ ...o, padrao: d.bots.padrao, usuario: usuario(req), numeros: numerosRecrutamento().map(({ id, nome }) => ({ id, nome })) }))` and its type becomes `Omit<Parameters<typeof paginaEditorBot>[0], 'padrao' | 'usuario' | 'numeros'>`.
  - `/bots/salvar`: `prepararBot(entrada, d.bots.padrao, status, numerosRecrutamento().map((n) => n.id))` and `d.repo.salvarBot(dados.codigo, JSON.stringify(dados), dados.numero_id, usuario(req), agora())`.

`src/main.ts`: `import { RepoNumeros } from './db/numeros.js'` and pass `numeros: new RepoNumeros(db),` to `criarPainel({...})`.

- [ ] **Step 4: Run** `npx vitest run tests/numeros.test.ts tests/bots.test.ts tests/editor-ui.test.ts tests/config.test.ts` → PASS. The painel/fluxo/expedidor tests still fail until Task 3 (the repository still writes the old `conversas` shape); that is expected. `npm run typecheck` → PASS (only `servidor.ts` and `bots.ts` call `salvarBot`/`prepararBot`). Do not commit yet.

---

### Task 3: Recruitment scoped by number (repository, orchestrator, sender, adapter)

**Files:**
- Create: `src/whatsapp/limite.ts`
- Modify: `src/db/repositorio.ts`, `src/conversa/orquestrador.ts`, `src/whatsapp/expedidor.ts`, `src/whatsapp/baileys.ts`, `src/main.ts`
- Test: `tests/fluxo.test.ts`, `tests/expedidor.test.ts`, `tests/painel.test.ts`, `tests/rotinas.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/fluxo.test.ts`:
  - make the bot list switchable: in the `describe` add `let processos: Processo[]` (import `type Processo` from `'../src/config/tipos.js'`), set `processos = [processo()]` at the top of `beforeEach`, and use `config: () => config(processos),`.
  - `baixarMidia: async (_numeroId, bruto) => {` (first parameter added).
  - `msg()` returns `{ numeroId: 1, id: \`M${seq}\`, jid: JID, ... }`.
  - `saida()` uses `repo.proximaSaida(1, JID)`; give it an optional number: `function saida(numeroId = 1): string[]` and `repo.proximaSaida(numeroId, JID)`.
  - line 126: `repo.registrarRecebida(1, m.id, m.jid, m.recebidaEm, JSON.stringify(m))`.
  - every other direct call in this file to `repo.conversa(`, `repo.candidaturasDoContato(`, `repo.definirEstado(`, `repo.focar(`, `repo.criarCandidatura(` gets `1, ` as first argument (search the file for `repo.`; `candidatosDoProcesso`, `filas`, `arquivo` stay as they are).
  - append this test:

```ts
  it('dois números de recrutamento não dividem a conversa', async () => {
    processos = [processo(), processo({ codigo: 'CAIXA-NOV26', vaga: 'Operador(a) de caixa', numero_id: 2 })]
    await enviar({ tipo: 'texto', texto: 'oi' })
    await enviar({ tipo: 'texto', texto: 'oi' }, { numeroId: 2 })
    expect(repo.candidaturasDoContato(1, JID).map((c) => c.processo)).toEqual(['VEND-OUT26'])
    expect(repo.candidaturasDoContato(2, JID).map((c) => c.processo)).toEqual(['CAIXA-NOV26'])
    expect(repo.conversa(1, JID)!.candidaturaId).not.toBe(repo.conversa(2, JID)!.candidaturaId)
    expect(saida(2).join('\n')).toContain('Operador(a) de caixa')
    expect(saida(1).join('\n')).toContain('Vendedor(a) de loja')
  })
```

(If the welcome text does not contain the job title, assert on `saida(2).length).toBeGreaterThan(0)` and on the protocol prefix instead; read `config/mensagens-padrao.yaml` `boas_vindas` to decide. The two `candidaturasDoContato` assertions are the essential ones.)

`tests/expedidor.test.ts`:
  - `const exp = new Expedidor({ numeroId: 1, repo, ...` 
  - `receber`: `repo.registrarRecebida(1, \`in-${jid}-${em}\`, jid, em, '{}')`
  - `fila`: `repo.enfileirarSaida(1, jid, JSON.stringify({ tipo: 'texto', texto }), t)`
  - last test: `repo.proximaSaida(1, 'a@s.whatsapp.net')`
  - append:

```ts
  it('cada número drena só a própria fila', async () => {
    const { exp, eventos, repo, tempo } = montar()
    repo.registrarRecebida(2, 'in-b', 'b@s.whatsapp.net', tempo(), '{}')
    repo.enfileirarSaida(2, 'b@s.whatsapp.net', JSON.stringify({ tipo: 'texto', texto: 'oi' }), tempo())
    await exp.acordar()
    expect(eventos).toEqual([])
    expect(repo.proximaSaida(2, 'b@s.whatsapp.net')).not.toBeNull()
  })
```

`tests/painel.test.ts` and `tests/rotinas.test.ts`: every `repo.criarCandidatura(` / `new Repositorio(db).criarCandidatura(` gets `1, ` as first argument (5 calls in total).

- [ ] **Step 2: Run** `npm test` → FAIL (signatures don't take `numeroId` yet).

- [ ] **Step 3: Implement**

Create `src/whatsapp/limite.ts`:

```ts
/** Janela deslizante de 60 s: no máximo `limite` envios por minuto. A vaga é reservada antes de esperar. */
export class LimitePorMinuto {
  private envios: number[] = []

  constructor(
    private readonly limite: number,
    private readonly relogio: () => number,
    private readonly esperar: (ms: number) => Promise<void>
  ) {}

  async reservar(): Promise<void> {
    for (;;) {
      const agora = this.relogio()
      this.envios = this.envios.filter((t) => agora - t < 60_000)
      if (this.envios.length < this.limite) {
        this.envios.push(agora)
        return
      }
      await this.esperar(this.envios[0]! + 60_000 - agora)
    }
  }
}
```

`src/db/repositorio.ts` — replace these methods (everything else stays):

```ts
  // --- caixa de entrada ----------------------------------------------------------

  /** Grava a mensagem antes de processar. Devolve false se o ID já foi visto neste número. */
  registrarRecebida(numeroId: number, id: string, jid: string, recebidaEm: number, payload: string): boolean {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO mensagens_processadas (numero_id, id, jid, recebida_em, status, payload) VALUES (?, ?, ?, ?, 'pendente', ?)`
      )
      .run(numeroId, id, jid, recebidaEm, payload)
    if (r.changes === 1) this.tocarConversa(numeroId, jid, recebidaEm)
    return r.changes === 1
  }

  pendentes(): { numeroId: number; id: string; jid: string }[] {
    return this.db
      .prepare(`SELECT numero_id AS numeroId, id, jid FROM mensagens_processadas WHERE status = 'pendente' ORDER BY recebida_em, rowid`)
      .all() as { numeroId: number; id: string; jid: string }[]
  }

  lerPendente(numeroId: number, id: string): { jid: string; payload: string; tentativas: number; recebidaEm: number } | null {
    const r = this.db
      .prepare(
        `SELECT jid, payload, tentativas, recebida_em AS recebidaEm FROM mensagens_processadas
         WHERE numero_id = ? AND id = ? AND status = 'pendente'`
      )
      .get(numeroId, id) as { jid: string; payload: string; tentativas: number; recebidaEm: number } | undefined
    return r ?? null
  }

  /** O conteúdo é apagado assim que processado: no banco fica só o ID, para descartar repetidas. */
  marcarProcessada(numeroId: number, id: string): void {
    this.db
      .prepare(`UPDATE mensagens_processadas SET status = 'processada', payload = NULL WHERE numero_id = ? AND id = ?`)
      .run(numeroId, id)
  }

  registrarFalha(numeroId: number, id: string, desistir: boolean): void {
    this.db
      .prepare(
        `UPDATE mensagens_processadas SET tentativas = tentativas + 1,
           status = CASE WHEN ? THEN 'erro' ELSE status END,
           payload = CASE WHEN ? THEN NULL ELSE payload END
         WHERE numero_id = ? AND id = ?`
      )
      .run(desistir ? 1 : 0, desistir ? 1 : 0, numeroId, id)
  }

  // --- conversa ------------------------------------------------------------------

  private tocarConversa(numeroId: number, jid: string, em: number): void {
    this.db
      .prepare(
        `INSERT INTO conversas (numero_id, jid, ultima_recebida) VALUES (?, ?, ?)
         ON CONFLICT (numero_id, jid) DO UPDATE SET ultima_recebida = MAX(ultima_recebida, excluded.ultima_recebida)`
      )
      .run(numeroId, jid, em)
  }

  conversa(numeroId: number, jid: string): { candidaturaId: number | null; estado: EstadoConversa | null; ultimaRecebida: number } | null {
    const r = this.db
      .prepare(`SELECT candidatura_id, estado, ultima_recebida FROM conversas WHERE numero_id = ? AND jid = ?`)
      .get(numeroId, jid) as { candidatura_id: number | null; estado: string | null; ultima_recebida: number } | undefined
    if (!r) return null
    return {
      candidaturaId: r.candidatura_id,
      estado: r.estado ? (JSON.parse(r.estado) as EstadoConversa) : null,
      ultimaRecebida: r.ultima_recebida
    }
  }

  definirEstado(numeroId: number, jid: string, estado: EstadoConversa | null): void {
    this.db
      .prepare(`UPDATE conversas SET estado = ? WHERE numero_id = ? AND jid = ?`)
      .run(estado ? JSON.stringify(estado) : null, numeroId, jid)
  }

  focar(numeroId: number, jid: string, candidaturaId: number): void {
    this.db.prepare(`UPDATE conversas SET candidatura_id = ? WHERE numero_id = ? AND jid = ?`).run(candidaturaId, numeroId, jid)
  }

  // --- candidaturas ----------------------------------------------------------------

  candidaturasDoContato(numeroId: number, jid: string): CandidaturaVista[] {
    const linhas = this.db
      .prepare(`SELECT * FROM candidaturas WHERE numero_id = ? AND jid = ? ORDER BY id`)
      .all(numeroId, jid) as LinhaCandidatura[]
    return linhas.map((l) => this.vista(l))
  }
```

`criarCandidatura`:

```ts
  criarCandidatura(numeroId: number, processo: string, jid: string, telefone: string | null, lid: string | null, agora: number): number {
    const { ultimo } = this.db
      .prepare(
        `INSERT INTO contadores (processo, ultimo) VALUES (?, 1)
         ON CONFLICT (processo) DO UPDATE SET ultimo = ultimo + 1 RETURNING ultimo`
      )
      .get(processo) as { ultimo: number }
    const protocolo = `${processo}-${String(ultimo).padStart(4, '0')}`
    const r = this.db
      .prepare(
        `INSERT INTO candidaturas (numero_id, processo, protocolo, jid, telefone, lid, passo, status, criada_em, atualizada_em, ultima_interacao)
         VALUES (?, ?, ?, ?, ?, ?, '', 'em_andamento', ?, ?, ?)`
      )
      .run(numeroId, processo, protocolo, jid, telefone, lid, agora, agora, agora)
    return Number(r.lastInsertRowid)
  }
```

`completarIdentidade`:

```ts
  /** Completa telefone/LID quando a conexão passa a conhecê-los. */
  completarIdentidade(numeroId: number, jid: string, telefone: string | null, lid: string | null): void {
    if (telefone) {
      this.db.prepare(`UPDATE candidaturas SET telefone = ? WHERE numero_id = ? AND jid = ? AND telefone IS NULL`).run(telefone, numeroId, jid)
    }
    if (lid) this.db.prepare(`UPDATE candidaturas SET lid = ? WHERE numero_id = ? AND jid = ? AND lid IS NULL`).run(lid, numeroId, jid)
  }
```

`paraFinalizar`:

```ts
  paraFinalizar(agora: number): { id: number; numeroId: number; jid: string }[] {
    return this.db
      .prepare(`SELECT id, numero_id AS numeroId, jid FROM candidaturas WHERE finalizar_em IS NOT NULL AND finalizar_em <= ?`)
      .all(agora) as { id: number; numeroId: number; jid: string }[]
  }
```

`excluirDadosDoContato` keeps its signature; add one line to its JSDoc: `Vale para todos os números: o pedido é da pessoa, não do chat.`

Outbox, polls, sent messages:

```ts
  enfileirarSaida(numeroId: number, jid: string, conteudo: string, agora: number): void {
    this.db.prepare(`INSERT INTO saida (numero_id, jid, conteudo, criada_em) VALUES (?, ?, ?, ?)`).run(numeroId, jid, conteudo, agora)
  }

  jidsComSaida(numeroId: number, agora: number): string[] {
    return (
      this.db
        .prepare(`SELECT DISTINCT jid FROM saida WHERE numero_id = ? AND proxima_em <= ? ORDER BY id`)
        .all(numeroId, agora) as { jid: string }[]
    ).map((r) => r.jid)
  }

  /** Mensagens saem na ordem em que foram criadas; uma com reenvio agendado segura as de trás. */
  proximaSaida(numeroId: number, jid: string): (ItemSaida & { proximaEm: number }) | null {
    const r = this.db
      .prepare(
        `SELECT id, jid, conteudo, tentativas, proxima_em AS proximaEm FROM saida WHERE numero_id = ? AND jid = ? ORDER BY id LIMIT 1`
      )
      .get(numeroId, jid) as (ItemSaida & { proximaEm: number }) | undefined
    return r ?? null
  }

  salvarEnquete(numeroId: number, id: string, jid: string, chave: string, opcoes: string[], segredo: Uint8Array, agora: number): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO enquetes (numero_id, id, jid, chave, opcoes, segredo, criada_em) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(numeroId, id, jid, chave, JSON.stringify(opcoes), Buffer.from(segredo), agora)
  }

  enquete(numeroId: number, id: string): { jid: string; chave: string; opcoes: string[]; segredo: Buffer } | null {
    const r = this.db.prepare(`SELECT jid, chave, opcoes, segredo FROM enquetes WHERE numero_id = ? AND id = ?`).get(numeroId, id) as
      | { jid: string; chave: string; opcoes: string; segredo: Buffer }
      | undefined
    return r ? { ...r, opcoes: JSON.parse(r.opcoes) as string[] } : null
  }

  salvarEnviada(numeroId: number, id: string, conteudo: string, agora: number): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO enviadas (numero_id, id, conteudo, criada_em) VALUES (?, ?, ?, ?)`)
      .run(numeroId, id, conteudo, agora)
  }

  enviada(numeroId: number, id: string): string | null {
    const r = this.db.prepare(`SELECT conteudo FROM enviadas WHERE numero_id = ? AND id = ?`).get(numeroId, id) as
      | { conteudo: string }
      | undefined
    return r?.conteudo ?? null
  }
```

Health — add after `ultimaRecebida()`:

```ts
  ultimaRecebidaPorNumero(): Map<number, number> {
    const linhas = this.db
      .prepare(`SELECT numero_id AS n, MAX(recebida_em) AS m FROM mensagens_processadas GROUP BY numero_id`)
      .all() as { n: number; m: number }[]
    return new Map(linhas.map((l) => [l.n, l.m]))
  }
```

`src/conversa/orquestrador.ts`:
  - `MensagemRecebida`: add first field `/** Número que recebeu a mensagem. */ numeroId: number`.
  - `DependenciasOrquestrador`: `baixarMidia: (numeroId: number, bruto: string) => Promise<Buffer>` and `aoEnfileirar?: (numeroId: number) => void`.
  - Replace the class body methods as follows (unchanged methods: `ocioso`, `aplicarNaCandidatura`):

```ts
  /** Grava e enfileira. Devolve false se a mensagem já tinha sido recebida. */
  receber(m: MensagemRecebida): boolean {
    if (!this.d.repo.registrarRecebida(m.numeroId, m.id, m.jid, m.recebidaEm, JSON.stringify(m))) return false
    if (m.telefone || m.lid) this.d.repo.completarIdentidade(m.numeroId, m.jid, m.telefone, m.lid)
    this.agendar(m.numeroId, m.jid, () => this.processarMensagem(m.numeroId, m.id))
    return true
  }

  /** Reprocessa o que ficou pendente (queda do processo, erro temporário). */
  retomarPendentes(): void {
    for (const p of this.d.repo.pendentes()) this.agendar(p.numeroId, p.jid, () => this.processarMensagem(p.numeroId, p.id))
  }

  /** Fecha os lotes de arquivos cujo prazo de 60 s acabou. */
  verificarFinalizacoes(): void {
    for (const c of this.d.repo.paraFinalizar(this.relogio())) {
      this.agendar(c.numeroId, c.jid, () => this.finalizarArquivos(c.id))
    }
  }

  /** Uma fila por contato em cada número: a mesma pessoa em dois números são duas conversas. */
  private agendar(numeroId: number, jid: string, tarefa: () => Promise<void>): void {
    const chave = `${numeroId}:${jid}`
    const anterior = this.filas.get(chave) ?? Promise.resolve()
    const proxima = anterior
      .then(tarefa)
      .catch((err) => this.d.log.error({ err }, 'falha inesperada na fila do contato'))
      .finally(() => {
        if (this.filas.get(chave) === proxima) this.filas.delete(chave)
      })
    this.filas.set(chave, proxima)
  }

  private async processarMensagem(numeroId: number, id: string): Promise<void> {
    const pendente = this.d.repo.lerPendente(numeroId, id)
    if (!pendente) return
    // Mensagens gravadas antes dos vários números não têm numeroId no conteúdo.
    const m = { ...(JSON.parse(pendente.payload) as MensagemRecebida), numeroId }
    try {
      await this.executar(numeroId, m.jid, m.entrada, m)
    } catch (err) {
      const desistir = pendente.tentativas + 1 >= MAX_TENTATIVAS
      this.d.log.error({ err, mensagem: id, numero: numeroId, desistir }, 'erro ao processar mensagem')
      this.d.repo.registrarFalha(numeroId, id, desistir)
    }
  }

  private async finalizarArquivos(candidaturaId: number): Promise<void> {
    const ainda = this.d.repo.paraFinalizar(this.relogio()).find((c) => c.id === candidaturaId)
    if (!ainda) return
    try {
      await this.executar(ainda.numeroId, ainda.jid, { tipo: 'finalizar_arquivos' })
    } catch (err) {
      this.d.log.error({ err, candidatura: candidaturaId }, 'erro ao finalizar arquivos')
    }
  }

  private contexto(numeroId: number, jid: string, telefone: string | null): Contexto {
    const config = this.d.config()
    const conversa = this.d.repo.conversa(numeroId, jid)
    const candidaturas = this.d.repo.candidaturasDoContato(numeroId, jid)
    return {
      agora: this.relogio(),
      // Cada número só enxerga os bots dele.
      processos: config.processos.filter((p) => p.numeroId === numeroId),
      padrao: config.padrao,
      empresa: config.empresa,
      estado: conversa?.estado ?? null,
      ativaId: conversa?.candidaturaId ?? null,
      candidaturas,
      telefone: telefone ?? candidaturas.find((c) => c.telefone)?.telefone ?? null,
      aleatorio: this.aleatorio
    }
  }
```

  In `executar`:
  - signature `private async executar(numeroId: number, jid: string, entrada: Entrada, m?: MensagemRecebida): Promise<void>` and first line `const ctx = this.contexto(numeroId, jid, m?.telefone ?? null)`.
  - `const dados = await this.d.baixarMidia(numeroId, m.bruto)`.
  - every `this.enfileirar(jid, ...)` becomes `this.enfileirar(numeroId, jid, ...)`.
  - `this.d.repo.marcarProcessada(m.id)` / `r.marcarProcessada(m.id)` → `(numeroId, m.id)`.
  - `r.definirEstado(numeroId, jid, a.estado)`; `foco = r.criarCandidatura(numeroId, a.processo, jid, m?.telefone ?? null, m?.lid ?? null, agora)`; `r.focar(numeroId, jid, foco)` (both places).
  - both `this.d.aoEnfileirar?.()` → `this.d.aoEnfileirar?.(numeroId)`.
  - `enfileirar` helper:
    ```ts
      private enfileirar(numeroId: number, jid: string, envio: Envio, agora: number): void {
        this.d.repo.enfileirarSaida(numeroId, jid, JSON.stringify(envio), agora)
      }
    ```

`src/whatsapp/expedidor.ts`:
  - `import { LimitePorMinuto } from './limite.js'`
  - `OpcoesExpedidor`: add first field `numeroId: number`.
  - JSDoc of the class: `... no máximo 20 envios por minuto por número.`
  - fields: remove `private envios: number[] = []` and `private readonly limite: number`; add `private readonly limite: LimitePorMinuto`. In the constructor: `this.limite = new LimitePorMinuto(o.limitePorMinuto ?? 20, this.relogio, this.esperar)` (after `relogio`/`esperar` are set).
  - `acordar`: `this.o.repo.jidsComSaida(this.o.numeroId, this.relogio())`.
  - `drenar`: `this.o.repo.proximaSaida(this.o.numeroId, jid)`, `this.o.repo.conversa(this.o.numeroId, jid)`, `await this.limite.reservar()` instead of `await this.reservarVaga()`.
  - delete the `reservarVaga` method.

`src/whatsapp/baileys.ts`:
  - `OpcoesBaileys`: add first field `/** Número (tabela numeros) desta conexão. */ numeroId: number`.
  - `getMessage`: `const conteudo = key.id ? this.o.repo.enviada(this.o.numeroId, key.id) : null`.
  - in `tratarRecebida`, the object `m` gets `numeroId: this.o.numeroId,` as first field.
  - `lerVoto`: `this.o.repo.enquete(this.o.numeroId, idEnquete)`.
  - `enviarEnquete`: `this.o.repo.salvarEnquete(this.o.numeroId, enviada.key.id, jid, chave, opcoes, segredo, Date.now())`.
  - `guardarEnviada`: `this.o.repo.salvarEnviada(this.o.numeroId, m.key.id, JSON.stringify(m.message, BufferJSON.replacer), Date.now())`.

`src/main.ts` (temporary single-number wiring; Task 14 rewrites it):
  - `new ConexaoBaileys({ numeroId: 1, pastaSessao: ...`
  - orchestrator: `baixarMidia: (_numeroId, bruto) => conexao.baixarMidia(bruto),` and `aoEnfileirar: () => void expedidor?.acordar()` (unchanged shape is fine: extra parameter is ignored).
  - `expedidor = new Expedidor({ numeroId: 1, repo, conexao, log, janelaMs: amb.janelaMs })`

- [ ] **Step 4: Run** `npm test` → all PASS (90 old + 3 migration + 1 numbers + 2 bots/editor + 1 painel + 1 fluxo + 1 expedidor). `npm run typecheck` → PASS.

- [ ] **Step 5: Commit Tasks 1–3 together**

```bash
git add src/db tests src/config src/conversa src/whatsapp src/painel src/main.ts
git commit -m "feat: vários números de recrutamento (numero_id em todo o fluxo)

Migração 3 cria a tabela numeros e liga processos, candidaturas, conversas,
caixas de entrada e saída, enquetes e enviadas a um número. Cada bot pertence
a um número de recrutamento; o orquestrador e o expedidor trabalham por número.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Migration 4 and the group repository

**Files:**
- Modify: `src/db/banco.ts`, `src/db/repositorio.ts` (`filas()` only)
- Create: `src/db/grupos.ts`
- Test: `tests/repo-grupos.test.ts` (create), `tests/migracao.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/migracao.test.ts` inside the `describe`:

```ts
  it('cria as tabelas do bot de grupos', () => {
    const db = bancoV2()
    migrar(db)
    const tabelas = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((t) => t.name)
    expect(tabelas).toEqual(expect.arrayContaining(['grupos', 'funcionarios', 'gestores', 'saida_grupos']))
  })
```

Create `tests/repo-grupos.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { abrirBanco } from '../src/db/banco.js'
import { RepoGrupos, type DadosFuncionario } from '../src/db/grupos.js'
import { RepoNumeros } from '../src/db/numeros.js'
import { Repositorio } from '../src/db/repositorio.js'
import { AGORA } from './ajuda.js'

const ANA: DadosFuncionario = {
  nome: 'Ana Souza',
  telefone: '5583999990001',
  lid: null,
  setor: 'Vendas',
  loja: 'Centro',
  cargo: 'Gerente',
  nascimento: null,
  ativo: true
}

describe('repositório do bot de grupos', () => {
  let repo: Repositorio
  let g: RepoGrupos
  const N = 2

  beforeEach(() => {
    repo = new Repositorio(abrirBanco(':memory:'))
    new RepoNumeros(repo.db).criar('Avisos', 'grupos', AGORA)
    g = new RepoGrupos(repo.db)
  })

  it('grupo relido mantém as etiquetas; o que sumiu da lista fica inativo', () => {
    g.salvarGrupo(N, 'a@g.us', 'Loja Centro', false, AGORA)
    g.salvarGrupo(N, 'b@g.us', 'Loja Sul', true, AGORA)
    expect(g.etiquetarGrupo(N, 'a@g.us', 'Vendas', 'Centro', AGORA)).toBe(true)
    g.salvarGrupo(N, 'a@g.us', 'Loja Centro (novo)', true, AGORA + 1)
    expect(g.grupo(N, 'a@g.us')).toMatchObject({ nome: 'Loja Centro (novo)', botAdmin: true, setor: 'Vendas', loja: 'Centro', ativo: true })
    expect(g.desativarAusentes(N, ['a@g.us'], AGORA + 2)).toBe(1)
    expect(g.grupos(N).map((x) => x.jid)).toEqual(['a@g.us'])
    expect(g.grupo(N, 'b@g.us')).toMatchObject({ ativo: false, botAdmin: false })
    expect(g.todosGrupos()).toHaveLength(2)
  })

  it('funcionário: telefone é único, LID só é gravado uma vez, gestor sai junto com o cadastro', () => {
    const id = g.salvarFuncionario(null, ANA, AGORA)
    expect(g.porTelefone('5583999990001')!.id).toBe(id)
    expect(() => g.salvarFuncionario(null, { ...ANA, nome: 'Outra' }, AGORA)).toThrow()
    g.vincularLid(id, '111@lid', AGORA)
    g.vincularLid(id, '222@lid', AGORA)
    expect(g.funcionario(id)!.lid).toBe('111@lid')
    g.salvarFuncionario(id, { ...ANA, cargo: null, ativo: false, lid: '111@lid' }, AGORA)
    expect(g.funcionario(id)).toMatchObject({ cargo: null, ativo: false })
    g.adicionarGestor(id, 'painel:rh', AGORA)
    g.adicionarGestor(id, 'painel:rh', AGORA)
    expect(g.gestores()).toEqual([id])
    expect(g.excluirFuncionario(id)).toBe(true)
    expect(g.gestores()).toEqual([])
  })

  it('comando: a mesma mensagem só é registrada uma vez por número', () => {
    expect(g.comandoVisto(N, 'X')).toBe(false)
    expect(g.registrarComando(N, 'X', 'a@g.us', AGORA)).toBe(true)
    expect(g.registrarComando(N, 'X', 'a@g.us', AGORA)).toBe(false)
    expect(g.comandoVisto(N, 'X')).toBe(true)
    expect(g.registrarComando(3, 'X', 'a@g.us', AGORA)).toBe(true)
    expect(repo.filas().entrada).toBe(0)
  })

  it('caixa de saída dos grupos sai em ordem, por número, e conta na fila geral', () => {
    g.enfileirarSaida(N, 'a@g.us', '{"n":1}', AGORA)
    g.enfileirarSaida(N, 'a@g.us', '{"n":2}', AGORA)
    g.enfileirarSaida(3, 'c@g.us', '{"n":3}', AGORA)
    expect(g.jidsComSaida(N, AGORA)).toEqual(['a@g.us'])
    const primeiro = g.proximaSaida(N, 'a@g.us')!
    expect(primeiro.conteudo).toBe('{"n":1}')
    g.adiarSaida(primeiro.id, AGORA + 5000)
    expect(g.jidsComSaida(N, AGORA)).toEqual([])
    expect(g.proximaSaida(N, 'a@g.us')).toMatchObject({ tentativas: 1, proximaEm: AGORA + 5000 })
    g.removerSaida(primeiro.id)
    expect(g.proximaSaida(N, 'a@g.us')!.conteudo).toBe('{"n":2}')
    expect(repo.filas().saida).toBe(2)
  })
})
```

- [ ] **Step 2: Run** `npx vitest run tests/repo-grupos.test.ts tests/migracao.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

Append a fourth element to `MIGRACOES` in `src/db/banco.ts`:

```ts
  `
  -- Bot de grupos: grupos de cada número, cadastro da equipe, gestores e caixa de saída própria.
  CREATE TABLE grupos (
    numero_id INTEGER NOT NULL REFERENCES numeros (id),
    jid TEXT NOT NULL,
    nome TEXT NOT NULL,
    bot_admin INTEGER NOT NULL DEFAULT 0,
    setor TEXT,
    loja TEXT,
    ativo INTEGER NOT NULL DEFAULT 1,
    atualizado_em INTEGER NOT NULL,
    PRIMARY KEY (numero_id, jid)
  );

  CREATE TABLE funcionarios (
    id INTEGER PRIMARY KEY,
    nome TEXT NOT NULL,
    telefone TEXT UNIQUE,
    lid TEXT UNIQUE,
    setor TEXT,
    loja TEXT,
    cargo TEXT,
    nascimento TEXT,
    ativo INTEGER NOT NULL DEFAULT 1,
    criado_em INTEGER NOT NULL,
    atualizado_em INTEGER NOT NULL
  );

  -- Gestores valem para todos os números de grupos. Ser admin no WhatsApp não dá poder no bot.
  CREATE TABLE gestores (
    funcionario_id INTEGER PRIMARY KEY REFERENCES funcionarios (id) ON DELETE CASCADE,
    adicionado_por TEXT NOT NULL,
    adicionado_em INTEGER NOT NULL
  );

  CREATE TABLE saida_grupos (
    id INTEGER PRIMARY KEY,
    numero_id INTEGER NOT NULL REFERENCES numeros (id),
    jid TEXT NOT NULL,
    conteudo TEXT NOT NULL,
    criada_em INTEGER NOT NULL,
    tentativas INTEGER NOT NULL DEFAULT 0,
    proxima_em INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX saida_grupos_numero ON saida_grupos (numero_id, proxima_em);
  `
```

In `src/db/repositorio.ts`, `filas()` counts both outboxes:

```ts
    const s = this.db.prepare(`SELECT (SELECT COUNT(*) FROM saida) + (SELECT COUNT(*) FROM saida_grupos) AS n`).get() as { n: number }
```

Create `src/db/grupos.ts`:

```ts
import type { Banco } from './banco.js'

export interface Grupo {
  numeroId: number
  jid: string
  nome: string
  botAdmin: boolean
  setor: string | null
  loja: string | null
  /** false quando o bot saiu ou foi removido do grupo. */
  ativo: boolean
  atualizadoEm: number
}

export interface DadosFuncionario {
  nome: string
  /** 55 + DDD + número, sempre na forma de telefoneCanonico. */
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
}

export interface ItemSaidaGrupo {
  id: number
  jid: string
  conteudo: string
  tentativas: number
  proximaEm: number
}

interface LinhaGrupo {
  numero_id: number
  jid: string
  nome: string
  bot_admin: number
  setor: string | null
  loja: string | null
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
}

const grupoDe = (l: LinhaGrupo): Grupo => ({
  numeroId: l.numero_id,
  jid: l.jid,
  nome: l.nome,
  botAdmin: l.bot_admin === 1,
  setor: l.setor,
  loja: l.loja,
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
  ativo: l.ativo === 1
})

const COLUNAS_FUNCIONARIO = `id, nome, telefone, lid, setor, loja, cargo, nascimento, ativo`

/** Grupos, equipe, gestores e caixa de saída do bot de grupos. Usa o mesmo banco (e as mesmas transações) do Repositorio. */
export class RepoGrupos {
  constructor(private readonly db: Banco) {}

  // --- grupos ---------------------------------------------------------------------

  /** Grupos onde o bot está, neste número. */
  grupos(numeroId: number): Grupo[] {
    return (
      this.db.prepare(`SELECT * FROM grupos WHERE numero_id = ? AND ativo = 1 ORDER BY nome COLLATE NOCASE`).all(numeroId) as LinhaGrupo[]
    ).map(grupoDe)
  }

  /** Todos, de todos os números, inclusive os que o bot deixou (para o painel). */
  todosGrupos(): Grupo[] {
    return (
      this.db.prepare(`SELECT * FROM grupos ORDER BY numero_id, ativo DESC, nome COLLATE NOCASE`).all() as LinhaGrupo[]
    ).map(grupoDe)
  }

  grupo(numeroId: number, jid: string): Grupo | null {
    const l = this.db.prepare(`SELECT * FROM grupos WHERE numero_id = ? AND jid = ?`).get(numeroId, jid) as LinhaGrupo | undefined
    return l ? grupoDe(l) : null
  }

  /** Bot entrou ou o grupo foi relido: grava nome e admin, sem mexer nas etiquetas de setor e loja. */
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

  /** Depois de reler a lista completa do WhatsApp: o que não veio é grupo de onde o bot saiu. */
  desativarAusentes(numeroId: number, presentes: string[], agora: number): number {
    const sairam = this.grupos(numeroId).filter((g) => !presentes.includes(g.jid))
    for (const g of sairam) this.desativarGrupo(numeroId, g.jid, agora)
    return sairam.length
  }

  etiquetarGrupo(numeroId: number, jid: string, setor: string | null, loja: string | null, agora: number): boolean {
    const r = this.db
      .prepare(`UPDATE grupos SET setor = ?, loja = ?, atualizado_em = ? WHERE numero_id = ? AND jid = ?`)
      .run(setor, loja, agora, numeroId, jid)
    return r.changes === 1
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

  /** Cria (id null) ou substitui todos os campos. Telefone ou LID repetidos violam UNIQUE e lançam erro. */
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
    this.db
      .prepare(
        `UPDATE funcionarios SET nome = ?, telefone = ?, lid = ?, setor = ?, loja = ?, cargo = ?, nascimento = ?, ativo = ?,
           atualizado_em = ? WHERE id = ?`
      )
      .run(...valores, agora, id)
    return id
  }

  /** Liga o LID visto no WhatsApp a quem ainda não tinha. Nunca troca um LID já gravado. */
  vincularLid(id: number, lid: string, agora: number): void {
    this.db.prepare(`UPDATE funcionarios SET lid = ?, atualizado_em = ? WHERE id = ? AND lid IS NULL`).run(lid, agora, id)
  }

  excluirFuncionario(id: number): boolean {
    return this.db.prepare(`DELETE FROM funcionarios WHERE id = ?`).run(id).changes === 1
  }

  // --- gestores -------------------------------------------------------------------

  /** IDs de funcionário com poder de gestor. */
  gestores(): number[] {
    return (this.db.prepare(`SELECT funcionario_id AS id FROM gestores ORDER BY adicionado_em, funcionario_id`).all() as { id: number }[]).map(
      (r) => r.id
    )
  }

  adicionarGestor(funcionarioId: number, por: string, agora: number): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO gestores (funcionario_id, adicionado_por, adicionado_em) VALUES (?, ?, ?)`)
      .run(funcionarioId, por, agora)
  }

  removerGestor(funcionarioId: number): void {
    this.db.prepare(`DELETE FROM gestores WHERE funcionario_id = ?`).run(funcionarioId)
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

  jidsComSaida(numeroId: number, agora: number): string[] {
    return (
      this.db
        .prepare(`SELECT DISTINCT jid FROM saida_grupos WHERE numero_id = ? AND proxima_em <= ? ORDER BY id`)
        .all(numeroId, agora) as { jid: string }[]
    ).map((r) => r.jid)
  }

  /** Mensagens saem na ordem em que foram criadas; uma com reenvio agendado segura as de trás. */
  proximaSaida(numeroId: number, jid: string): ItemSaidaGrupo | null {
    const r = this.db
      .prepare(
        `SELECT id, jid, conteudo, tentativas, proxima_em AS proximaEm FROM saida_grupos
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
```

Note: the test uses number `3` for "another number" in `registrarComando`/`enfileirarSaida`. `mensagens_processadas.numero_id` has no FK (fine), but `saida_grupos.numero_id` does — create number 3 in `beforeEach` as well: add `new RepoNumeros(repo.db).criar('Outro', 'grupos', AGORA)` right after the first `criar` (ids 2 and 3).

- [ ] **Step 4: Run** `npx vitest run tests/repo-grupos.test.ts tests/migracao.test.ts` → PASS; `npm test` → PASS; `npm run typecheck` → PASS.

- [ ] **Step 5: Commit** — `git add src/db tests && git commit -m "feat: tabelas e repositório do bot de grupos (migração 4)"` (+ attribution line).

---

### Task 5: Group types, identity helpers and command parser

**Files:**
- Create: `src/grupos/tipos.ts`, `src/grupos/pessoas.ts`, `src/grupos/comandos.ts`
- Test: `tests/comandos.test.ts` (create)

- [ ] **Step 1: Write the failing test** — create `tests/comandos.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Funcionario } from '../src/db/grupos.js'
import { COMANDOS, acharComando, ehComando, interpretar } from '../src/grupos/comandos.js'
import { acharFuncionario, formatarTelefone, pessoaDoJid, telefoneCanonico, usuarioDoJid, vinculosDeLid } from '../src/grupos/pessoas.js'

const f = (id: number, telefone: string | null, lid: string | null): Funcionario => ({
  id,
  nome: `F${id}`,
  telefone,
  lid,
  setor: null,
  loja: null,
  cargo: null,
  nascimento: null,
  ativo: true
})

describe('parser de comandos', () => {
  it('reconhece só texto que começa com /palavra', () => {
    expect(ehComando('/menu')).toBe(true)
    expect(ehComando('  /Cadastrar x')).toBe(true)
    expect(ehComando('bom dia /menu')).toBe(false)
    expect(ehComando('/ 1')).toBe(false)
    expect(ehComando('/')).toBe(false)
    expect(ehComando(null)).toBe(false)
  })

  it('nome sem acento e minúsculo; menções saem dos argumentos; | separa campos', () => {
    const c = interpretar('/CADASTRAR @5583999990001 Ana  Souza | Vendas |Centro', ['5583999990001@s.whatsapp.net'], null)!
    expect(c).toEqual({
      nome: 'cadastrar',
      args: 'Ana Souza | Vendas |Centro',
      campos: ['Ana Souza', 'Vendas', 'Centro'],
      mencionados: ['5583999990001@s.whatsapp.net'],
      citada: null
    })
    expect(interpretar('/Gestóres')!.nome).toBe('gestores')
    expect(interpretar('/quem', [], '111@lid')!.citada).toBe('111@lid')
    expect(interpretar('/menu')!.campos).toEqual([])
    expect(interpretar('oi')).toBeNull()
    expect(interpretar(`/menu ${'x'.repeat(3000)}`)).toBeNull()
  })

  it('apelidos levam ao comando certo; desconhecido devolve null', () => {
    expect(acharComando('ajuda')!.nome).toBe('menu')
    expect(acharComando('help')!.nome).toBe('menu')
    expect(acharComando('cadastrar')!.gestor).toBe(true)
    expect(acharComando('xyz')).toBeNull()
    expect(new Set(COMANDOS.map((c) => c.nome)).size).toBe(COMANDOS.length)
  })
})

describe('pessoas', () => {
  it('telefone canônico: 55 + DDD + número, com o 9 dos celulares', () => {
    expect(telefoneCanonico('(83) 99999-0001')).toBe('5583999990001')
    expect(telefoneCanonico('+55 83 99999-0001')).toBe('5583999990001')
    expect(telefoneCanonico('558399990001')).toBe('5583999990001')
    expect(telefoneCanonico('558332220000')).toBe('558332220000')
    expect(telefoneCanonico('123')).toBeNull()
    expect(telefoneCanonico(null)).toBeNull()
    expect(formatarTelefone('5583999990001')).toBe('+55 83 99999-0001')
  })

  it('JID solto vira pessoa; dispositivo é ignorado', () => {
    expect(usuarioDoJid('5583999990001:12@s.whatsapp.net')).toBe('5583999990001')
    expect(pessoaDoJid('558399990001@s.whatsapp.net')).toEqual({
      jid: '558399990001@s.whatsapp.net',
      telefone: '5583999990001',
      lid: null
    })
    expect(pessoaDoJid('111:3@lid')).toEqual({ jid: '111:3@lid', telefone: null, lid: '111@lid' })
  })

  it('acha no cadastro pelo telefone, senão pelo LID', () => {
    const lista = [f(1, '5583999990001', null), f(2, null, '222@lid')]
    expect(acharFuncionario(lista, { jid: 'x', telefone: '558399990001', lid: null })!.id).toBe(1)
    expect(acharFuncionario(lista, { jid: 'x', telefone: null, lid: '222@lid' })!.id).toBe(2)
    expect(acharFuncionario(lista, { jid: 'x', telefone: null, lid: '333@lid' })).toBeNull()
  })

  it('LID novo só é ligado a quem tem o telefone e ainda não tem LID', () => {
    const lista = [f(1, '5583999990001', null), f(2, '5583999990002', '222@lid'), f(3, '5583999990003', null)]
    const pessoas = [
      { jid: 'a', telefone: '5583999990001', lid: '111@lid' },
      { jid: 'b', telefone: '5583999990001', lid: '111@lid' },
      { jid: 'c', telefone: '5583999990002', lid: '999@lid' },
      { jid: 'd', telefone: '5583999990003', lid: '222@lid' },
      { jid: 'e', telefone: null, lid: '444@lid' }
    ]
    expect(vinculosDeLid(lista, pessoas)).toEqual([{ id: 1, lid: '111@lid' }])
  })
})
```

- [ ] **Step 2: Run** `npx vitest run tests/comandos.test.ts` → FAIL (modules missing).

- [ ] **Step 3: Implement**

Create `src/grupos/tipos.ts`:

```ts
import type { DadosFuncionario, Funcionario, Grupo } from '../db/grupos.js'

/** Alguém no WhatsApp: o JID visto, o telefone (quando se sabe) e o LID (quando existe). */
export interface Pessoa {
  jid: string
  /** 55 + DDD + número, canônico. */
  telefone: string | null
  /** JID @lid sem dispositivo. */
  lid: string | null
}

export interface MembroGrupo extends Pessoa {
  admin: boolean
}

/** Comando como o adaptador entrega. Conversa comum nunca chega aqui. */
export interface MensagemGrupo {
  numeroId: number
  id: string
  /** Onde responder: o grupo (@g.us) ou a conversa privada. */
  chat: string
  ehGrupo: boolean
  remetente: Pessoa
  texto: string
  /** JIDs mencionados na mensagem. */
  mencionados: string[]
  /** Autor da mensagem respondida (citada), se houver. */
  citada: string | null
  recebidaEm: number
}

export interface InfoGrupo {
  jid: string
  nome: string
  botAdmin: boolean
}

export interface MetadadosGrupo extends InfoGrupo {
  /** Participantes, sem o próprio bot. */
  membros: MembroGrupo[]
}

/** Mudanças nos grupos, já traduzidas pelo adaptador. */
export type EventoGrupos =
  /** Lista completa (ao conectar): o que não vier é grupo de onde o bot saiu. */
  | { tipo: 'lista'; grupos: InfoGrupo[] }
  | { tipo: 'entrou'; grupos: InfoGrupo[] }
  | { tipo: 'renomeado'; jid: string; nome: string }
  | { tipo: 'admin'; jid: string; admin: boolean }
  | { tipo: 'saiu'; jid: string }

/** O que o bot de grupos precisa de uma conexão de WhatsApp. */
export interface ConexaoGrupos {
  pronta(): boolean
  digitando(jid: string): Promise<void>
  enviarTexto(jid: string, texto: string, mencoes?: string[]): Promise<void>
  listarGrupos(): Promise<InfoGrupo[]>
  metadados(jid: string): Promise<MetadadosGrupo>
  /** Telefone por trás de um LID, se o WhatsApp já informou. */
  telefoneDoLid(lid: string): Promise<string | null>
}

/** Conteúdo de um item de saida_grupos. */
export type EnvioGrupo = { tipo: 'texto'; texto: string; mencoes?: string[] }

export interface LinhaAuditoria {
  em: number
  usuario: string
  acao: string
  detalhe: string | null
}

/** Retrato do momento entregue ao motor. */
export interface ContextoGrupos {
  agora: number
  chat: string
  ehGrupo: boolean
  remetente: Pessoa
  /** Mencionados, na ordem, já com telefone quando foi possível descobrir. */
  mencionados: Pessoa[]
  citada: Pessoa | null
  funcionarios: Funcionario[]
  /** IDs de funcionário que são gestores. */
  gestores: Set<number>
  /** Grupo da mensagem; null no privado. */
  grupo: Grupo | null
  /** Grupos ativos deste número. */
  grupos: Grupo[]
  /** Participantes do grupo, só quando o comando precisa (senão null). */
  membros: MembroGrupo[] | null
  /** Auditoria mais recente primeiro (até 30). */
  auditoria: LinhaAuditoria[]
  /** Desde quando este número está conectado. */
  conectadoDesde: number | null
}

export type AcaoGrupo =
  | { tipo: 'responder'; texto: string; mencoes?: string[] }
  /** id null cria; senão substitui os campos. */
  | { tipo: 'salvar_funcionario'; id: number | null; dados: DadosFuncionario }
  | { tipo: 'gestor'; funcionarioId: number; ativo: boolean }
  | { tipo: 'auditar'; acao: string; detalhe: string }
```

Create `src/grupos/pessoas.ts`:

```ts
import { normalizarTelefone } from '../conversa/motor.js'
import type { Funcionario } from '../db/grupos.js'
import type { Pessoa } from './tipos.js'

/**
 * Forma única de guardar e comparar telefones: 55 + DDD + número, com o 9 dos celulares.
 * O WhatsApp ainda entrega alguns celulares antigos com 8 dígitos (55 83 9999-0001); aqui o 9 volta.
 */
export function telefoneCanonico(texto: string | null | undefined): string | null {
  if (!texto) return null
  const t = normalizarTelefone(texto)
  if (!t) return null
  // 55 + DDD + 8 dígitos começando em 6-9 é celular sem o 9.
  if (t.length === 12 && /[6-9]/.test(t[4]!)) return `${t.slice(0, 4)}9${t.slice(4)}`
  return t
}

/** "+55 83 99999-0001" */
export function formatarTelefone(t: string): string {
  const m = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(t)
  return m ? `+55 ${m[1]} ${m[2]}-${m[3]}` : `+${t}`
}

/** Parte antes do @, sem o ":dispositivo". */
export function usuarioDoJid(jid: string): string {
  return jid.split('@')[0]!.split(':')[0]!
}

/** Pessoa a partir de um JID solto (menção, mensagem citada). */
export function pessoaDoJid(jid: string): Pessoa {
  const usuario = usuarioDoJid(jid)
  return {
    jid,
    telefone: jid.endsWith('@s.whatsapp.net') ? telefoneCanonico(usuario) : null,
    lid: jid.endsWith('@lid') ? `${usuario}@lid` : null
  }
}

/** Acha no cadastro: pelo telefone, senão pelo LID. */
export function acharFuncionario(funcionarios: Funcionario[], p: Pessoa): Funcionario | null {
  const tel = telefoneCanonico(p.telefone)
  return (tel ? funcionarios.find((f) => f.telefone === tel) : undefined) ?? (p.lid ? funcionarios.find((f) => f.lid === p.lid) : undefined) ?? null
}

/** Quem está no cadastro pelo telefone e ainda não tem LID ganha o LID visto agora (se ninguém mais o tiver). */
export function vinculosDeLid(funcionarios: Funcionario[], pessoas: Pessoa[]): { id: number; lid: string }[] {
  const lidsUsados = new Set(funcionarios.map((f) => f.lid).filter((l): l is string => !!l))
  const ligados = new Set<number>()
  const vinculos: { id: number; lid: string }[] = []
  for (const p of pessoas) {
    const tel = telefoneCanonico(p.telefone)
    if (!tel || !p.lid || lidsUsados.has(p.lid)) continue
    const f = funcionarios.find((x) => x.telefone === tel)
    if (!f || f.lid || ligados.has(f.id)) continue
    vinculos.push({ id: f.id, lid: p.lid })
    lidsUsados.add(p.lid)
    ligados.add(f.id)
  }
  return vinculos
}
```

Create `src/grupos/comandos.ts`:

```ts
import { semAcento } from '../conversa/textos.js'

export type NomeComando = 'menu' | 'gestores' | 'quem' | 'cadastrar' | 'setores' | 'desconhecidos' | 'grupos' | 'gestor' | 'status' | 'log'

export interface DefComando {
  nome: NomeComando
  /** Só gestores podem usar (os outros são ignorados em silêncio). */
  gestor: boolean
  onde: 'grupo' | 'privado' | 'ambos'
  uso: string
  descricao: string
  /** Precisa da lista de participantes do grupo. */
  precisaMembros?: true
  /** Precisa que o bot seja admin do grupo (nenhum nesta entrega; usado a partir dos avisos). */
  precisaAdmin?: true
}

/** Tabela única: permissões, onde vale, texto do /menu. O motor e o orquestrador leem daqui. */
export const COMANDOS: DefComando[] = [
  { nome: 'menu', gestor: false, onde: 'ambos', uso: '/menu', descricao: 'mostra os comandos' },
  { nome: 'gestores', gestor: false, onde: 'grupo', uso: '/gestores', descricao: 'chama os gestores deste grupo', precisaMembros: true },
  { nome: 'quem', gestor: false, onde: 'grupo', uso: '/quem @pessoa', descricao: 'nome, setor e loja de alguém' },
  {
    nome: 'cadastrar',
    gestor: true,
    onde: 'ambos',
    uso: '/cadastrar @pessoa Nome | Setor | Loja | Cargo',
    descricao: 'cadastra ou atualiza alguém (cargo é opcional; no privado use o telefone no lugar do @)'
  },
  { nome: 'setores', gestor: true, onde: 'ambos', uso: '/setores', descricao: 'setores e lojas com o número de pessoas' },
  { nome: 'desconhecidos', gestor: true, onde: 'grupo', uso: '/desconhecidos', descricao: 'quem está no grupo sem cadastro', precisaMembros: true },
  { nome: 'grupos', gestor: true, onde: 'privado', uso: '/grupos', descricao: 'grupos deste número' },
  { nome: 'gestor', gestor: true, onde: 'ambos', uso: '/gestor add @pessoa  ·  /gestor remover @pessoa', descricao: 'dá ou tira o poder de gestor' },
  { nome: 'status', gestor: true, onde: 'ambos', uso: '/status', descricao: 'situação do bot' },
  { nome: 'log', gestor: true, onde: 'privado', uso: '/log 10', descricao: 'últimas ações registradas (até 30)' }
]

const APELIDOS: Record<string, NomeComando> = { ajuda: 'menu', help: 'menu', comandos: 'menu' }

export interface Comando {
  /** Nome sem a barra, minúsculo e sem acento ("cadastrar"). */
  nome: string
  /** O resto do texto, sem as menções "@123..." e com espaços simples. */
  args: string
  /** args separado por "|", cada parte aparada. Vazio quando não há args. */
  campos: string[]
  /** JIDs mencionados, na ordem. */
  mencionados: string[]
  /** Autor da mensagem citada. */
  citada: string | null
}

const PREFIXO = /^\s*\/(\p{L}[\p{L}\d_-]*)/u
/** Comando é coisa curta; texto enorme não é interpretado. */
const TAMANHO_MAXIMO = 2000

export function ehComando(texto: string | null | undefined): boolean {
  return !!texto && PREFIXO.test(texto)
}

export function interpretar(texto: string, mencionados: string[] = [], citada: string | null = null): Comando | null {
  if (texto.length > TAMANHO_MAXIMO) return null
  const m = PREFIXO.exec(texto)
  if (!m) return null
  const args = texto
    .slice(m[0].length)
    .replace(/@\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return {
    nome: semAcento(m[1]!),
    args,
    campos: args ? args.split('|').map((c) => c.trim()) : [],
    mencionados,
    citada
  }
}

export function acharComando(nome: string): DefComando | null {
  const alvo = APELIDOS[nome] ?? nome
  return COMANDOS.find((c) => c.nome === alvo) ?? null
}
```

- [ ] **Step 4: Run** `npx vitest run tests/comandos.test.ts` → PASS; `npm run typecheck` → PASS.

- [ ] **Step 5: Commit** — `git add src/grupos tests/comandos.test.ts && git commit -m "feat: tipos, identidade e parser de comandos do bot de grupos"` (+ attribution).

---

### Task 6: Group engine (pure)

**Files:**
- Create: `src/grupos/motor.ts`
- Test: `tests/motor-grupos.test.ts` (create)

- [ ] **Step 1: Write the failing test** — create `tests/motor-grupos.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Funcionario, Grupo } from '../src/db/grupos.js'
import { interpretar } from '../src/grupos/comandos.js'
import { processarComando } from '../src/grupos/motor.js'
import type { AcaoGrupo, ContextoGrupos, MembroGrupo, Pessoa } from '../src/grupos/tipos.js'
import { AGORA } from './ajuda.js'

const ANA: Funcionario = {
  id: 1, nome: 'Ana Souza', telefone: '5583999990001', lid: '111@lid',
  setor: 'Vendas', loja: 'Centro', cargo: 'Gerente', nascimento: null, ativo: true
}
const BETO: Funcionario = {
  id: 2, nome: 'Beto Lima', telefone: '5583999990002', lid: null,
  setor: 'Caixa', loja: 'Sul', cargo: null, nascimento: null, ativo: true
}
const GRUPO: Grupo = {
  numeroId: 2, jid: '120363-1@g.us', nome: 'Loja Centro', botAdmin: false,
  setor: null, loja: 'Centro', ativo: true, atualizadoEm: AGORA
}
const ANA_LID: Pessoa = { jid: '111@lid', telefone: null, lid: '111@lid' }
const BETO_TEL: Pessoa = { jid: '5583999990002@s.whatsapp.net', telefone: '5583999990002', lid: null }
const ESTRANHO: Pessoa = { jid: '999@lid', telefone: null, lid: '999@lid' }
const membro = (p: Pessoa): MembroGrupo => ({ ...p, admin: false })

function ctx(extra: Partial<ContextoGrupos> = {}): ContextoGrupos {
  return {
    agora: AGORA, chat: GRUPO.jid, ehGrupo: true, remetente: ANA_LID, mencionados: [], citada: null,
    funcionarios: [ANA, BETO], gestores: new Set([1]), grupo: GRUPO, grupos: [GRUPO], membros: null,
    auditoria: [], conectadoDesde: AGORA - 3_600_000, ...extra
  }
}
const privado = (extra: Partial<ContextoGrupos> = {}) => ctx({ chat: '111@lid', ehGrupo: false, grupo: null, ...extra })
const rodar = (c: ContextoGrupos, texto: string) => processarComando(c, interpretar(texto, c.mencionados.map((p) => p.jid), c.citada?.jid ?? null)!)
const textos = (acoes: AcaoGrupo[]) => acoes.flatMap((a) => (a.tipo === 'responder' ? [a.texto] : []))

describe('motor do bot de grupos: permissões', () => {
  it('quem não é gestor: comando de gestor e comando desconhecido são ignorados em silêncio', () => {
    const beto = ctx({ remetente: BETO_TEL, mencionados: [ESTRANHO] })
    expect(rodar(beto, '/cadastrar @999 Carla Dias | Estoque | Norte')).toEqual([])
    expect(rodar(beto, '/xyz')).toEqual([])
  })

  it('no privado, só gestores recebem resposta (nem /menu para estranhos)', () => {
    expect(rodar(privado({ remetente: ESTRANHO }), '/menu')).toEqual([])
    expect(rodar(privado({ remetente: BETO_TEL }), '/menu')).toEqual([])
    expect(textos(rodar(privado(), '/menu'))[0]).toContain('/grupos')
  })

  it('gestor ouve que o comando não existe', () => {
    expect(textos(rodar(ctx(), '/xyz'))).toEqual(['Não reconheço esse comando. Veja /menu.'])
  })

  it('/menu mostra só o que a pessoa pode usar ali', () => {
    const beto = textos(rodar(ctx({ remetente: BETO_TEL }), '/menu'))[0]!
    expect(beto).toContain('/quem')
    expect(beto).not.toContain('/cadastrar')
    const ana = textos(rodar(ctx(), '/menu'))[0]!
    expect(ana).toContain('/cadastrar')
    expect(ana).not.toContain('/grupos')
  })

  it('comando de grupo no privado e de privado no grupo explicam onde usar', () => {
    expect(textos(rodar(privado(), '/desconhecidos'))[0]).toContain('dentro de um grupo')
    expect(textos(rodar(ctx(), '/grupos'))[0]).toContain('no privado comigo')
  })

  it('cadastro inativo perde o poder de gestor', () => {
    expect(rodar(ctx({ funcionarios: [{ ...ANA, ativo: false }, BETO] }), '/status')).toEqual([])
  })
})

describe('motor do bot de grupos: comandos', () => {
  it('/cadastrar @pessoa cria com o LID, audita e confirma', () => {
    const carla: Pessoa = { jid: '777@lid', telefone: null, lid: '777@lid' }
    const acoes = rodar(ctx({ mencionados: [carla] }), '/cadastrar @777 Carla Dias | Estoque | Norte')
    expect(acoes).toEqual([
      {
        tipo: 'salvar_funcionario', id: null,
        dados: { nome: 'Carla Dias', telefone: null, lid: '777@lid', setor: 'Estoque', loja: 'Norte', cargo: null, nascimento: null, ativo: true }
      },
      { tipo: 'auditar', acao: 'cadastrar_funcionario', detalhe: 'Carla Dias (Estoque · Norte)' },
      { tipo: 'responder', texto: '✅ Carla Dias cadastrado(a): Estoque · Norte.' }
    ])
  })

  it('/cadastrar no privado aceita o telefone e atualiza quem já existe', () => {
    const acoes = rodar(privado(), '/cadastrar 83999990002 Beto Lima | Caixa | Sul | Operador')
    expect(acoes[0]).toMatchObject({ tipo: 'salvar_funcionario', id: 2, dados: { telefone: '5583999990002', cargo: 'Operador' } })
    expect(textos(acoes)).toEqual(['✅ Beto Lima atualizado(a): Caixa · Sul · Operador.'])
  })

  it('/cadastrar incompleto mostra o uso', () => {
    const carla: Pessoa = { jid: '777@lid', telefone: null, lid: '777@lid' }
    expect(textos(rodar(ctx({ mencionados: [carla] }), '/cadastrar @777 Carla'))[0]).toMatch(/^Uso: \/cadastrar/)
    expect(textos(rodar(ctx(), '/cadastrar Carla | Estoque | Norte'))[0]).toMatch(/^Uso:/)
  })

  it('/cadastrar recusa telefone e LID que são de cadastros diferentes', () => {
    const misturado: Pessoa = { jid: '111@lid', telefone: '5583999990002', lid: '111@lid' }
    expect(textos(rodar(ctx({ mencionados: [misturado] }), '/cadastrar @111 X Y | A | B'))[0]).toContain('cadastros diferentes')
  })

  it('/gestor add e remover; o último gestor não sai', () => {
    const add = rodar(ctx({ mencionados: [BETO_TEL] }), '/gestor add @5583999990002')
    expect(add.slice(0, 2)).toEqual([
      { tipo: 'gestor', funcionarioId: 2, ativo: true },
      { tipo: 'auditar', acao: 'gestor_adicionado', detalhe: 'Beto Lima' }
    ])
    expect(textos(rodar(ctx({ mencionados: [ANA_LID] }), '/gestor remover @111'))[0]).toContain('último gestor')
    const rem = rodar(ctx({ mencionados: [BETO_TEL], gestores: new Set([1, 2]) }), '/gestor remover @5583999990002')
    expect(rem[0]).toEqual({ tipo: 'gestor', funcionarioId: 2, ativo: false })
    expect(textos(rodar(ctx({ mencionados: [ESTRANHO] }), '/gestor add @999'))[0]).toContain('não está no cadastro')
    expect(textos(rodar(privado(), '/gestor add 83999990002'))[0]).toContain('agora é gestor')
  })

  it('/quem responde pela menção ou pela mensagem citada', () => {
    expect(textos(rodar(ctx({ remetente: BETO_TEL, mencionados: [ANA_LID] }), '/quem @111'))).toEqual([
      '🪪 Ana Souza — Vendas · Centro · Gerente · 👔 gestor(a)'
    ])
    expect(textos(rodar(ctx({ citada: BETO_TEL }), '/quem'))).toEqual(['🪪 Beto Lima — Caixa · Sul'])
    expect(textos(rodar(ctx({ mencionados: [ESTRANHO] }), '/quem @999'))).toEqual(['Não encontrei essa pessoa no cadastro.'])
  })

  it('/gestores menciona os gestores presentes no grupo', () => {
    const acoes = rodar(ctx({ membros: [membro(ANA_LID), membro(BETO_TEL)] }), '/gestores')
    expect(acoes).toEqual([{ tipo: 'responder', texto: '👔 Gestores deste grupo: @111', mencoes: ['111@lid'] }])
    expect(textos(rodar(ctx({ membros: [membro(BETO_TEL)] }), '/gestores'))[0]).toContain('Nenhum gestor')
    expect(textos(rodar(ctx(), '/gestores'))[0]).toContain('Não consegui ler os participantes')
  })

  it('/desconhecidos lista quem não está no cadastro', () => {
    const t = textos(rodar(ctx({ membros: [membro(ANA_LID), membro(BETO_TEL), membro(ESTRANHO)] }), '/desconhecidos'))[0]!
    expect(t).toContain('1 sem cadastro')
    expect(t).toContain('contato oculto')
    expect(textos(rodar(ctx({ membros: [membro(ANA_LID)] }), '/desconhecidos'))[0]).toContain('Todos os participantes')
  })

  it('/setores conta por setor e loja', () => {
    const extra: Funcionario = { ...BETO, id: 3, nome: 'Caio', telefone: '5583999990003', loja: 'Centro' }
    const t = textos(rodar(ctx({ funcionarios: [ANA, BETO, extra] }), '/setores'))[0]!
    expect(t).toContain('3 pessoas')
    expect(t).toContain('• Caixa: 2 (Centro 1, Sul 1)')
    expect(t).toContain('• Vendas: 1 (Centro 1)')
  })

  it('/grupos, /status e /log', () => {
    expect(textos(rodar(privado(), '/grupos'))[0]).toContain('Loja Centro — sem admin ❌ — Centro')
    expect(textos(rodar(ctx(), '/status'))[0]).toContain('1 grupos · 2 pessoas cadastradas (1 gestores)')
    const auditoria = Array.from({ length: 40 }, (_, i) => ({ em: AGORA - i, usuario: 'rh', acao: `a${i}`, detalhe: null }))
    expect(textos(rodar(privado({ auditoria }), '/log 99'))[0]!.split('\n')).toHaveLength(31)
    expect(textos(rodar(privado({ auditoria }), '/log'))[0]!.split('\n')).toHaveLength(11)
  })
})
```

- [ ] **Step 2: Run** `npx vitest run tests/motor-grupos.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** — create `src/grupos/motor.ts`:

```ts
import { semAcento } from '../conversa/textos.js'
import type { DadosFuncionario, Funcionario } from '../db/grupos.js'
import { COMANDOS, acharComando, type Comando, type DefComando } from './comandos.js'
import { acharFuncionario, formatarTelefone, telefoneCanonico, usuarioDoJid } from './pessoas.js'
import type { AcaoGrupo, ContextoGrupos, Pessoa } from './tipos.js'

/** Listas longas no WhatsApp ficam ilegíveis: corta e diz quantos faltaram. */
const MAX_LISTA = 40

export function horaBR(ms: number): string {
  return new Date(ms).toLocaleString('pt-BR', {
    timeZone: 'America/Fortaleza',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function responder(texto: string, mencoes?: string[]): AcaoGrupo[] {
  return [{ tipo: 'responder', texto, ...(mencoes?.length ? { mencoes } : {}) }]
}

function listar(linhas: string[]): string {
  const extra = linhas.length - MAX_LISTA
  return [...linhas.slice(0, MAX_LISTA), ...(extra > 0 ? [`… e mais ${extra}`] : [])].join('\n')
}

function descrever(f: Funcionario): string {
  const onde = [f.setor, f.loja, f.cargo].filter(Boolean).join(' · ') || 'sem setor'
  return `${f.nome} — ${onde}${f.ativo ? '' : ' (inativo)'}`
}

/** "/cadastrar 5583999990001 Nome | ..." no privado: o primeiro termo é o telefone. */
function separarTelefone(texto: string): { pessoa: Pessoa | null; resto: string } {
  const [primeiro = '', ...resto] = texto.split(' ')
  const tel = /^\+?[\d().-]{10,}$/.test(primeiro) ? telefoneCanonico(primeiro) : null
  if (!tel) return { pessoa: null, resto: texto }
  return { pessoa: { jid: `${tel}@s.whatsapp.net`, telefone: tel, lid: null }, resto: resto.join(' ') }
}

/**
 * Regras do bot de grupos. Puro: recebe o retrato do momento e devolve ações;
 * não toca no WhatsApp, no banco nem no relógio.
 */
export function processarComando(ctx: ContextoGrupos, cmd: Comando): AcaoGrupo[] {
  const autor = acharFuncionario(ctx.funcionarios, ctx.remetente)
  const gestor = !!autor && autor.ativo && ctx.gestores.has(autor.id)
  // No privado só gestores são atendidos: um estranho escrevendo para o número não recebe nada.
  if (!ctx.ehGrupo && !gestor) return []
  const def = acharComando(cmd.nome)
  if (!def) return gestor ? responder('Não reconheço esse comando. Veja /menu.') : []
  // Comando de gestor vindo de outra pessoa: silêncio, para o bot não virar ferramenta de spam no grupo.
  if (def.gestor && !gestor) return []
  if (def.onde === 'grupo' && !ctx.ehGrupo) return responder(`O /${def.nome} funciona dentro de um grupo.`)
  if (def.onde === 'privado' && ctx.ehGrupo) return responder(`Use /${def.nome} no privado comigo.`)
  if (def.precisaAdmin && !ctx.grupo?.botAdmin) return responder('Preciso ser admin deste grupo para isso.')
  if (def.precisaMembros && !ctx.membros) return responder('Não consegui ler os participantes agora. Tente de novo em instantes.')
  return new Execucao(ctx, cmd, def, gestor).rodar()
}

class Execucao {
  constructor(
    private readonly ctx: ContextoGrupos,
    private readonly cmd: Comando,
    private readonly def: DefComando,
    private readonly gestor: boolean
  ) {}

  rodar(): AcaoGrupo[] {
    const nome = this.def.nome
    switch (nome) {
      case 'menu':
        return this.menu()
      case 'gestores':
        return this.gestores()
      case 'quem':
        return this.quem()
      case 'cadastrar':
        return this.cadastrar()
      case 'setores':
        return this.setores()
      case 'desconhecidos':
        return this.desconhecidos()
      case 'grupos':
        return this.grupos()
      case 'gestor':
        return this.gestorCmd()
      case 'status':
        return this.status()
      case 'log':
        return this.log()
      default: {
        const faltando: never = nome
        throw new Error(`comando sem regra: ${String(faltando)}`)
      }
    }
  }

  private uso(): AcaoGrupo[] {
    return responder(`Uso: ${this.def.uso}`)
  }

  private alvo(): Pessoa | null {
    return this.ctx.mencionados[0] ?? this.ctx.citada ?? null
  }

  private achar(p: Pessoa): Funcionario | null {
    return acharFuncionario(this.ctx.funcionarios, p)
  }

  private gestoresAtivos(): Funcionario[] {
    return this.ctx.funcionarios.filter((f) => f.ativo && this.ctx.gestores.has(f.id))
  }

  private menu(): AcaoGrupo[] {
    const aqui = this.ctx.ehGrupo ? 'grupo' : 'privado'
    const linhas = COMANDOS.filter((d) => (this.gestor || !d.gestor) && (d.onde === 'ambos' || d.onde === aqui)).map(
      (d) => `${d.uso} — ${d.descricao}`
    )
    return responder(`📖 Comandos\n${linhas.join('\n')}`)
  }

  private gestores(): AcaoGrupo[] {
    const ids = new Set(this.gestoresAtivos().map((f) => f.id))
    const presentes = (this.ctx.membros ?? []).filter((m) => {
      const f = this.achar(m)
      return !!f && ids.has(f.id)
    })
    if (presentes.length === 0) return responder('Nenhum gestor cadastrado está neste grupo.')
    return responder(
      `👔 Gestores deste grupo: ${presentes.map((m) => `@${usuarioDoJid(m.jid)}`).join(' ')}`,
      presentes.map((m) => m.jid)
    )
  }

  private quem(): AcaoGrupo[] {
    const p = this.alvo()
    if (!p) return this.uso()
    const f = this.achar(p)
    if (!f) return responder('Não encontrei essa pessoa no cadastro.')
    const selo = f.ativo && this.ctx.gestores.has(f.id) ? ' · 👔 gestor(a)' : ''
    return responder(`🪪 ${descrever(f)}${selo}`)
  }

  private cadastrar(): AcaoGrupo[] {
    let pessoa = this.alvo()
    let resto = this.cmd.args
    if (!pessoa) ({ pessoa, resto } = separarTelefone(resto))
    if (!pessoa) return this.uso()
    const [nome = '', setor = '', loja = '', cargo = ''] = resto.split('|').map((c) => c.trim())
    const valido = /\p{L}{2,}/u.test(nome) && nome.length <= 80 && !!setor && !!loja && [setor, loja, cargo].every((c) => c.length <= 60)
    if (!valido) return this.uso()

    const telefone = telefoneCanonico(pessoa.telefone)
    if (!telefone && !pessoa.lid) return responder('Não consegui identificar essa pessoa. Mencione com @ ou informe o telefone.')
    const porTelefone = telefone ? this.ctx.funcionarios.find((f) => f.telefone === telefone) : undefined
    const porLid = pessoa.lid ? this.ctx.funcionarios.find((f) => f.lid === pessoa.lid) : undefined
    if (porTelefone && porLid && porTelefone.id !== porLid.id) {
      return responder('Esse telefone e esse contato estão em cadastros diferentes. Corrija pela página Equipe do painel.')
    }
    const atual = porTelefone ?? porLid ?? null
    const dados: DadosFuncionario = {
      nome,
      telefone: telefone ?? atual?.telefone ?? null,
      lid: pessoa.lid ?? atual?.lid ?? null,
      setor,
      loja,
      cargo: cargo || atual?.cargo || null,
      nascimento: atual?.nascimento ?? null,
      ativo: true
    }
    const resumo = [setor, loja, dados.cargo].filter(Boolean).join(' · ')
    return [
      { tipo: 'salvar_funcionario', id: atual?.id ?? null, dados },
      { tipo: 'auditar', acao: atual ? 'atualizar_funcionario' : 'cadastrar_funcionario', detalhe: `${nome} (${resumo})` },
      ...responder(`✅ ${nome} ${atual ? 'atualizado(a)' : 'cadastrado(a)'}: ${resumo}.`)
    ]
  }

  private gestorCmd(): AcaoGrupo[] {
    const [sub = '', ...resto] = this.cmd.args.split(' ')
    const s = semAcento(sub)
    const adicionar = ['add', 'adicionar', 'incluir'].includes(s)
    const remover = ['remover', 'rm', 'tirar', 'del'].includes(s)
    if (!adicionar && !remover) return this.uso()
    const pessoa = this.alvo() ?? separarTelefone(resto.join(' ')).pessoa
    if (!pessoa) return this.uso()
    const f = this.achar(pessoa)
    if (!f) return responder('Essa pessoa não está no cadastro. Use /cadastrar primeiro.')
    const ja = this.ctx.gestores.has(f.id)
    if (adicionar) {
      if (!f.ativo) return responder(`${f.nome} está com o cadastro inativo.`)
      if (ja) return responder(`${f.nome} já é gestor(a).`)
      return [
        { tipo: 'gestor', funcionarioId: f.id, ativo: true },
        { tipo: 'auditar', acao: 'gestor_adicionado', detalhe: f.nome },
        ...responder(`👔 ${f.nome} agora é gestor(a).`)
      ]
    }
    if (!ja) return responder(`${f.nome} não é gestor(a).`)
    if (this.gestoresAtivos().length <= 1) return responder('Não dá para remover o último gestor. Adicione outro antes ou use o painel.')
    return [
      { tipo: 'gestor', funcionarioId: f.id, ativo: false },
      { tipo: 'auditar', acao: 'gestor_removido', detalhe: f.nome },
      ...responder(`${f.nome} não é mais gestor(a).`)
    ]
  }

  private setores(): AcaoGrupo[] {
    const ativos = this.ctx.funcionarios.filter((f) => f.ativo)
    if (ativos.length === 0) return responder('Ninguém cadastrado ainda.')
    const porSetor = new Map<string, Map<string, number>>()
    for (const f of ativos) {
      const lojas = porSetor.get(f.setor ?? 'Sem setor') ?? new Map<string, number>()
      lojas.set(f.loja ?? 'sem loja', (lojas.get(f.loja ?? 'sem loja') ?? 0) + 1)
      porSetor.set(f.setor ?? 'Sem setor', lojas)
    }
    const ordem = (a: string, b: string) => a.localeCompare(b, 'pt-BR')
    const linhas = [...porSetor.entries()]
      .sort(([a], [b]) => ordem(a, b))
      .map(([setor, lojas]) => {
        const total = [...lojas.values()].reduce((s, n) => s + n, 0)
        const detalhe = [...lojas.entries()]
          .sort(([a], [b]) => ordem(a, b))
          .map(([loja, n]) => `${loja} ${n}`)
          .join(', ')
        return `• ${setor}: ${total} (${detalhe})`
      })
    return responder(`📋 Setores e lojas — ${ativos.length} pessoas\n${listar(linhas)}`)
  }

  private desconhecidos(): AcaoGrupo[] {
    const fora = (this.ctx.membros ?? []).filter((m) => !this.achar(m))
    if (fora.length === 0) return responder('✅ Todos os participantes deste grupo estão cadastrados.')
    const linhas = fora.map((m) => `• ${m.telefone ? formatarTelefone(m.telefone) : `contato oculto (${usuarioDoJid(m.jid)})`}`)
    return responder(
      `❓ ${fora.length} sem cadastro:\n${listar(linhas)}\n\nCadastre com /cadastrar @pessoa Nome | Setor | Loja`
    )
  }

  private grupos(): AcaoGrupo[] {
    if (this.ctx.grupos.length === 0) return responder('Este número não está em nenhum grupo.')
    const linhas = this.ctx.grupos.map((g) => {
      const etiquetas = [g.setor, g.loja].filter(Boolean).join(' · ')
      return `• ${g.nome} — ${g.botAdmin ? 'admin ✅' : 'sem admin ❌'}${etiquetas ? ` — ${etiquetas}` : ''}`
    })
    return responder(`👥 Grupos deste número (${this.ctx.grupos.length})\n${listar(linhas)}`)
  }

  private status(): AcaoGrupo[] {
    const ativos = this.ctx.funcionarios.filter((f) => f.ativo).length
    const conexao = this.ctx.conectadoDesde ? `Conectado desde ${horaBR(this.ctx.conectadoDesde)}` : 'Conexão instável'
    return responder(
      `🤖 ${conexao} · ${this.ctx.grupos.length} grupos · ${ativos} pessoas cadastradas (${this.gestoresAtivos().length} gestores)`
    )
  }

  private log(): AcaoGrupo[] {
    const n = Math.min(30, Math.max(1, Number.parseInt(this.cmd.args, 10) || 10))
    const linhas = this.ctx.auditoria
      .slice(0, n)
      .map((l) => `${horaBR(l.em)} · ${l.usuario} · ${l.acao}${l.detalhe ? ` · ${l.detalhe}` : ''}`)
    if (linhas.length === 0) return responder('Nada registrado ainda.')
    return responder(`📜 Últimas ações\n${linhas.join('\n')}`)
  }
}
```

- [ ] **Step 4: Run** `npx vitest run tests/motor-grupos.test.ts` → PASS; `npm run typecheck` → PASS.

- [ ] **Step 5: Commit** — `git add src/grupos/motor.ts tests/motor-grupos.test.ts && git commit -m "feat: motor de comandos do bot de grupos"` (+ attribution).

---

### Task 7: Group orchestrator

**Files:**
- Create: `src/grupos/orquestrador.ts`
- Test: `tests/orquestrador-grupos.test.ts` (create)

- [ ] **Step 1: Write the failing test** — create `tests/orquestrador-grupos.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { abrirBanco } from '../src/db/banco.js'
import { RepoGrupos } from '../src/db/grupos.js'
import { RepoNumeros } from '../src/db/numeros.js'
import { Repositorio } from '../src/db/repositorio.js'
import { JANELA_COMANDO_MS, OrquestradorGrupos } from '../src/grupos/orquestrador.js'
import type { ConexaoGrupos, MensagemGrupo, MetadadosGrupo } from '../src/grupos/tipos.js'
import { AGORA, log } from './ajuda.js'

const GRUPO = '120363-1@g.us'

function conexaoFalsa() {
  const lids = new Map<string, string>()
  const chamadas = { metadados: 0 }
  const metadados: MetadadosGrupo = {
    jid: GRUPO,
    nome: 'Loja Centro',
    botAdmin: true,
    membros: [{ jid: '111@lid', telefone: null, lid: '111@lid', admin: true }]
  }
  const conexao: ConexaoGrupos = {
    pronta: () => true,
    digitando: async () => {},
    enviarTexto: async () => {},
    listarGrupos: async () => [],
    metadados: async () => {
      chamadas.metadados++
      return metadados
    },
    telefoneDoLid: async (lid) => lids.get(lid) ?? null
  }
  return { conexao, lids, chamadas }
}

describe('orquestrador do bot de grupos', () => {
  let t: number
  let seq: number
  let repo: Repositorio
  let grupos: RepoGrupos
  let falsa: ReturnType<typeof conexaoFalsa>
  let orq: OrquestradorGrupos
  let ana: number
  let acordados: number[]
  const N = 2

  beforeEach(() => {
    t = AGORA
    seq = 0
    acordados = []
    repo = new Repositorio(abrirBanco(':memory:'))
    new RepoNumeros(repo.db).criar('Avisos', 'grupos', AGORA)
    grupos = new RepoGrupos(repo.db)
    ana = grupos.salvarFuncionario(
      null,
      { nome: 'Ana Souza', telefone: '5583999990001', lid: null, setor: 'Vendas', loja: 'Centro', cargo: null, nascimento: null, ativo: true },
      AGORA
    )
    grupos.adicionarGestor(ana, 'painel:rh', AGORA)
    falsa = conexaoFalsa()
    falsa.lids.set('111@lid', '5583999990001')
    orq = new OrquestradorGrupos({
      repo,
      grupos,
      conexao: () => falsa.conexao,
      log,
      relogio: () => t,
      conectadoDesde: () => AGORA,
      aoEnfileirar: (n) => void acordados.push(n)
    })
  })

  function msg(texto: string, extra: Partial<MensagemGrupo> = {}): MensagemGrupo {
    seq++
    return {
      numeroId: N, id: `C${seq}`, chat: GRUPO, ehGrupo: true,
      remetente: { jid: '111@lid', telefone: null, lid: '111@lid' },
      texto, mencionados: [], citada: null, recebidaEm: t, ...extra
    }
  }

  async function enviar(m: MensagemGrupo) {
    orq.receber(m)
    await orq.ocioso()
  }

  function saida(chat = GRUPO): { texto: string; mencoes?: string[] }[] {
    const r: { texto: string; mencoes?: string[] }[] = []
    for (;;) {
      const item = grupos.proximaSaida(N, chat)
      if (!item) return r
      r.push(JSON.parse(item.conteudo) as { texto: string; mencoes?: string[] })
      grupos.removerSaida(item.id)
    }
  }

  const dedupe = () => (repo.db.prepare(`SELECT COUNT(*) AS n FROM mensagens_processadas`).get() as { n: number }).n

  it('descobre o telefone do LID, reconhece o gestor e grava o LID no cadastro', async () => {
    await enviar(msg('/status'))
    expect(saida()).toHaveLength(1)
    expect(grupos.funcionario(ana)!.lid).toBe('111@lid')
    expect(acordados).toEqual([N])
  })

  it('a mesma mensagem entregue duas vezes gera uma resposta só', async () => {
    const m = msg('/status')
    orq.receber(m)
    orq.receber(m)
    await orq.ocioso()
    expect(saida()).toHaveLength(1)
  })

  it('comando de gestor vindo de outra pessoa: só a linha de dedupe, nenhum dado', async () => {
    await enviar(msg('/cadastrar @999 Carla Dias | Estoque | Norte', { remetente: { jid: '999@lid', telefone: null, lid: '999@lid' }, mencionados: ['999@lid'] }))
    expect(saida()).toEqual([])
    expect(grupos.funcionarios()).toHaveLength(1)
    expect(dedupe()).toBe(1)
    expect(repo.auditoriaRecente(5)).toEqual([])
  })

  it('/cadastrar grava funcionário (com telefone do LID) e auditoria na mesma transação', async () => {
    falsa.lids.set('777@lid', '5583988887777')
    await enviar(msg('/cadastrar @777 Carla Dias | Estoque | Norte', { mencionados: ['777@lid'] }))
    const carla = grupos.porTelefone('5583988887777')!
    expect(carla).toMatchObject({ nome: 'Carla Dias', lid: '777@lid', setor: 'Estoque', loja: 'Norte' })
    expect(repo.auditoriaRecente(1)[0]).toMatchObject({ usuario: 'wa:5583999990001', acao: 'cadastrar_funcionario' })
    expect(saida()[0]!.texto).toContain('Carla Dias cadastrado(a)')
  })

  it('falha ao gravar desfaz tudo e avisa que não conseguiu', async () => {
    vi.spyOn(grupos, 'salvarFuncionario').mockImplementation(() => {
      throw new Error('disco cheio')
    })
    await enviar(msg('/cadastrar @777 Carla Dias | Estoque | Norte', { mencionados: ['777@lid'] }))
    expect(saida().map((s) => s.texto)).toEqual(['Não consegui concluir esse comando agora. Tente de novo em instantes.'])
    expect(repo.auditoriaRecente(5)).toEqual([])
  })

  it('grupo desconhecido é lido uma vez e gravado; membros só quando o comando pede', async () => {
    expect(grupos.grupo(N, GRUPO)).toBeNull()
    await enviar(msg('/status'))
    expect(grupos.grupo(N, GRUPO)).toMatchObject({ nome: 'Loja Centro', botAdmin: true, ativo: true })
    expect(falsa.chamadas.metadados).toBe(1)
    await enviar(msg('/status'))
    expect(falsa.chamadas.metadados).toBe(1)
    await enviar(msg('/gestores'))
    expect(falsa.chamadas.metadados).toBe(2)
    expect(saida().at(-1)).toEqual({ tipo: 'texto', texto: '👔 Gestores deste grupo: @111', mencoes: ['111@lid'] })
  })

  it('comando velho (fila ao reconectar) é ignorado sem deixar rastro', async () => {
    await enviar(msg('/status', { recebidaEm: t - JANELA_COMANDO_MS - 1 }))
    expect(saida()).toEqual([])
    expect(dedupe()).toBe(0)
  })

  it('privado de estranho: nada é respondido', async () => {
    await enviar(msg('/menu', { chat: '999@lid', ehGrupo: false, remetente: { jid: '999@lid', telefone: null, lid: '999@lid' } }))
    expect(saida('999@lid')).toEqual([])
  })

  it('eventos: lista completa desativa ausentes; bot vira admin; bot sai; renomeado', () => {
    orq.eventoGrupos(N, { tipo: 'lista', grupos: [{ jid: 'a@g.us', nome: 'A', botAdmin: false }, { jid: 'b@g.us', nome: 'B', botAdmin: false }] })
    orq.eventoGrupos(N, { tipo: 'lista', grupos: [{ jid: 'a@g.us', nome: 'A', botAdmin: false }] })
    expect(grupos.grupos(N).map((g) => g.jid)).toEqual(['a@g.us'])
    orq.eventoGrupos(N, { tipo: 'admin', jid: 'a@g.us', admin: true })
    orq.eventoGrupos(N, { tipo: 'renomeado', jid: 'a@g.us', nome: 'A2' })
    expect(grupos.grupo(N, 'a@g.us')).toMatchObject({ botAdmin: true, nome: 'A2' })
    orq.eventoGrupos(N, { tipo: 'saiu', jid: 'a@g.us' })
    expect(grupos.grupos(N)).toEqual([])
    orq.eventoGrupos(N, { tipo: 'entrou', grupos: [{ jid: 'b@g.us', nome: 'B', botAdmin: true }] })
    expect(grupos.grupo(N, 'b@g.us')).toMatchObject({ ativo: true, botAdmin: true })
  })
})
```

- [ ] **Step 2: Run** `npx vitest run tests/orquestrador-grupos.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** — create `src/grupos/orquestrador.ts`:

```ts
import type { Logger } from 'pino'
import type { RepoGrupos } from '../db/grupos.js'
import type { Repositorio } from '../db/repositorio.js'
import { acharComando, interpretar } from './comandos.js'
import { processarComando } from './motor.js'
import { pessoaDoJid, telefoneCanonico, usuarioDoJid, vinculosDeLid } from './pessoas.js'
import type { AcaoGrupo, ConexaoGrupos, ContextoGrupos, EnvioGrupo, EventoGrupos, MembroGrupo, MensagemGrupo, Pessoa } from './tipos.js'

export interface DependenciasGrupos {
  /** Auditoria e transações. */
  repo: Repositorio
  grupos: RepoGrupos
  /** Conexão do número; null se estiver desativado. */
  conexao: (numeroId: number) => ConexaoGrupos | null
  log: Logger
  relogio?: () => number
  conectadoDesde?: (numeroId: number) => number | null
  /** Avisado quando há algo novo na caixa de saída do número. */
  aoEnfileirar?: (numeroId: number) => void
}

/** Comando mais velho que isso (fila do WhatsApp ao reconectar) não é executado. */
export const JANELA_COMANDO_MS = 10 * 60 * 1000

const FALHA = 'Não consegui concluir esse comando agora. Tente de novo em instantes.'

/**
 * Liga os comandos ao motor. Tudo que depende do WhatsApp (LID → telefone, dados do grupo)
 * acontece antes; depois, dedupe + mudanças + respostas + auditoria vão numa transação só.
 * Se o processo cair antes dela, o comando não aconteceu e o gestor manda de novo.
 */
export class OrquestradorGrupos {
  private filas = new Map<string, Promise<void>>()
  private readonly relogio: () => number

  constructor(private readonly d: DependenciasGrupos) {
    this.relogio = d.relogio ?? Date.now
  }

  /** Comandos do mesmo chat são tratados em ordem; chats diferentes não esperam uns pelos outros. */
  receber(m: MensagemGrupo): void {
    const chave = `${m.numeroId}:${m.chat}`
    const anterior = this.filas.get(chave) ?? Promise.resolve()
    const proxima = anterior
      .then(() => this.tratar(m))
      .catch((err) => this.d.log.error({ err, mensagem: m.id, numero: m.numeroId }, 'falha inesperada no comando'))
      .finally(() => {
        if (this.filas.get(chave) === proxima) this.filas.delete(chave)
      })
    this.filas.set(chave, proxima)
  }

  /** Espera todas as filas esvaziarem (testes e desligamento). */
  async ocioso(): Promise<void> {
    while (this.filas.size > 0) await Promise.all([...this.filas.values()])
  }

  /** Mantém a tabela de grupos igual ao que o WhatsApp informa. */
  eventoGrupos(numeroId: number, e: EventoGrupos): void {
    const g = this.d.grupos
    const agora = this.relogio()
    try {
      this.d.repo.transacao(() => {
        switch (e.tipo) {
          case 'lista':
            for (const x of e.grupos) g.salvarGrupo(numeroId, x.jid, x.nome, x.botAdmin, agora)
            g.desativarAusentes(numeroId, e.grupos.map((x) => x.jid), agora)
            return
          case 'entrou':
            for (const x of e.grupos) g.salvarGrupo(numeroId, x.jid, x.nome, x.botAdmin, agora)
            return
          case 'renomeado':
            return g.renomearGrupo(numeroId, e.jid, e.nome, agora)
          case 'admin':
            return g.definirBotAdmin(numeroId, e.jid, e.admin, agora)
          case 'saiu':
            return g.desativarGrupo(numeroId, e.jid, agora)
        }
      })
    } catch (err) {
      this.d.log.error({ err, numero: numeroId, evento: e.tipo }, 'falha ao atualizar grupos')
    }
  }

  private async tratar(m: MensagemGrupo): Promise<void> {
    if (this.relogio() - m.recebidaEm > JANELA_COMANDO_MS) return
    if (this.d.grupos.comandoVisto(m.numeroId, m.id)) return
    const cmd = interpretar(m.texto, m.mencionados, m.citada)
    if (!cmd) return
    const conexao = this.d.conexao(m.numeroId)
    const def = acharComando(cmd.nome)

    const remetente = await this.completar(conexao, m.remetente)
    const mencionados = await Promise.all(m.mencionados.map((j) => this.completar(conexao, pessoaDoJid(j))))
    const citada = m.citada ? await this.completar(conexao, pessoaDoJid(m.citada)) : null
    const membros = m.ehGrupo ? await this.lerGrupo(conexao, m, !!def?.precisaMembros) : null

    // Daqui em diante é síncrono: o retrato do banco e a gravação não se intercalam com outro comando.
    const agora = this.relogio()
    const g = this.d.grupos
    const funcionarios = g.funcionarios()
    const ctx: ContextoGrupos = {
      agora,
      chat: m.chat,
      ehGrupo: m.ehGrupo,
      remetente,
      mencionados,
      citada,
      funcionarios,
      gestores: new Set(g.gestores()),
      grupo: m.ehGrupo ? g.grupo(m.numeroId, m.chat) : null,
      grupos: g.grupos(m.numeroId),
      membros: def?.precisaMembros ? membros : null,
      auditoria: this.d.repo.auditoriaRecente(30),
      conectadoDesde: this.d.conectadoDesde?.(m.numeroId) ?? null
    }
    const acoes = processarComando(ctx, cmd)
    const vistos = [remetente, ...mencionados, ...(citada ? [citada] : []), ...(membros ?? [])]
    const vinculos = vinculosDeLid(funcionarios, vistos)
    const usuario = `wa:${remetente.telefone ?? remetente.lid ?? usuarioDoJid(remetente.jid)}`
    try {
      this.aplicar(m, acoes, vinculos, usuario, agora)
    } catch (err) {
      this.d.log.error({ err, mensagem: m.id, numero: m.numeroId }, 'erro ao executar comando')
      if (acoes.length > 0) this.aplicar(m, [{ tipo: 'responder', texto: FALHA }], [], usuario, agora)
    }
  }

  /** Descobre o telefone por trás do LID quando o WhatsApp sabe. */
  private async completar(conexao: ConexaoGrupos | null, p: Pessoa): Promise<Pessoa> {
    const telefone = telefoneCanonico(p.telefone)
    if (telefone || !p.lid || !conexao) return { ...p, telefone }
    try {
      return { ...p, telefone: telefoneCanonico(await conexao.telefoneDoLid(p.lid)) }
    } catch {
      return { ...p, telefone: null }
    }
  }

  /**
   * Grupo desconhecido (evento perdido) é lido e gravado uma vez. A lista de participantes
   * só é buscada quando o comando precisa dela.
   */
  private async lerGrupo(conexao: ConexaoGrupos | null, m: MensagemGrupo, precisaMembros: boolean): Promise<MembroGrupo[] | null> {
    const conhecido = this.d.grupos.grupo(m.numeroId, m.chat)
    if (!conexao || (conhecido?.ativo && !precisaMembros)) return null
    try {
      const md = await conexao.metadados(m.chat)
      this.d.grupos.salvarGrupo(m.numeroId, md.jid, md.nome, md.botAdmin, this.relogio())
      return await Promise.all(md.membros.map(async (x) => ({ ...(await this.completar(conexao, x)), admin: x.admin })))
    } catch (err) {
      this.d.log.warn({ err, numero: m.numeroId }, 'não foi possível ler os dados do grupo')
      return null
    }
  }

  private aplicar(m: MensagemGrupo, acoes: AcaoGrupo[], vinculos: { id: number; lid: string }[], usuario: string, agora: number): void {
    const g = this.d.grupos
    let enfileirou = false
    this.d.repo.transacao(() => {
      // Outra entrega da mesma mensagem pode ter passado enquanto esta esperava o WhatsApp.
      if (!g.registrarComando(m.numeroId, m.id, m.chat, m.recebidaEm)) return
      for (const v of vinculos) g.vincularLid(v.id, v.lid, agora)
      for (const a of acoes) {
        switch (a.tipo) {
          case 'responder': {
            const envio: EnvioGrupo = { tipo: 'texto', texto: a.texto, ...(a.mencoes ? { mencoes: a.mencoes } : {}) }
            g.enfileirarSaida(m.numeroId, m.chat, JSON.stringify(envio), agora)
            enfileirou = true
            break
          }
          case 'salvar_funcionario':
            g.salvarFuncionario(a.id, a.dados, agora)
            break
          case 'gestor':
            if (a.ativo) g.adicionarGestor(a.funcionarioId, usuario, agora)
            else g.removerGestor(a.funcionarioId)
            break
          case 'auditar':
            this.d.repo.auditar(usuario, a.acao, a.detalhe, agora)
            break
        }
      }
    })
    if (enfileirou) this.d.aoEnfileirar?.(m.numeroId)
  }
}
```

- [ ] **Step 4: Run** `npx vitest run tests/orquestrador-grupos.test.ts` → PASS; `npm test`; `npm run typecheck` → PASS.

- [ ] **Step 5: Commit** — `git add src/grupos/orquestrador.ts tests/orquestrador-grupos.test.ts && git commit -m "feat: orquestrador do bot de grupos (identidade, transação, eventos)"` (+ attribution).

---

### Task 8: Group sender

**Files:**
- Create: `src/grupos/expedidor.ts`
- Test: `tests/expedidor-grupos.test.ts` (create)

- [ ] **Step 1: Write the failing test** — create `tests/expedidor-grupos.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { abrirBanco } from '../src/db/banco.js'
import { RepoGrupos } from '../src/db/grupos.js'
import { RepoNumeros } from '../src/db/numeros.js'
import { ExpedidorGrupos, duracaoDigitandoGrupo } from '../src/grupos/expedidor.js'
import type { ConexaoGrupos } from '../src/grupos/tipos.js'
import { AGORA, log } from './ajuda.js'

function montar(o: { falhar?: boolean; pronta?: boolean } = {}) {
  let t = AGORA
  const db = abrirBanco(':memory:')
  const numeros = new RepoNumeros(db)
  numeros.criar('Avisos', 'grupos', AGORA)
  numeros.criar('Outro', 'grupos', AGORA)
  const grupos = new RepoGrupos(db)
  const eventos: { em: number; tipo: string; jid: string; texto?: string; mencoes?: string[] }[] = []
  const conexao: ConexaoGrupos = {
    pronta: () => o.pronta ?? true,
    digitando: async (jid) => void eventos.push({ em: t, tipo: 'digitando', jid }),
    enviarTexto: async (jid, texto, mencoes) => {
      if (o.falhar) throw new Error('caiu')
      eventos.push({ em: t, tipo: 'texto', jid, texto, ...(mencoes ? { mencoes } : {}) })
    },
    listarGrupos: async () => [],
    metadados: async () => {
      throw new Error('não usado')
    },
    telefoneDoLid: async () => null
  }
  const exp = new ExpedidorGrupos({ numeroId: 2, grupos, conexao, log, relogio: () => t, esperar: async (ms) => void (t += ms) })
  const fila = (jid: string, texto: string, numeroId = 2, mencoes?: string[]) =>
    grupos.enfileirarSaida(numeroId, jid, JSON.stringify({ tipo: 'texto', texto, ...(mencoes ? { mencoes } : {}) }), t)
  return { exp, grupos, eventos, fila, tempo: () => t }
}

describe('expedidor dos grupos', () => {
  it('digita, envia com menções e espera 3 s ou mais entre mensagens do mesmo grupo', async () => {
    const { exp, eventos, fila } = montar()
    fila('a@g.us', 'um', 2, ['111@lid'])
    fila('a@g.us', 'dois')
    await exp.acordar()
    expect(eventos.map((e) => e.tipo)).toEqual(['digitando', 'texto', 'digitando', 'texto'])
    expect(eventos[1]).toMatchObject({ texto: 'um', mencoes: ['111@lid'] })
    expect(eventos[3]!.em - eventos[1]!.em).toBeGreaterThanOrEqual(3000)
  })

  it('não precisa de janela de resposta: envia em grupo que nunca falou com o bot', async () => {
    const { exp, eventos, fila } = montar()
    fila('novo@g.us', 'oi')
    await exp.acordar()
    expect(eventos.filter((e) => e.tipo === 'texto')).toHaveLength(1)
  })

  it('no máximo 10 envios por minuto por número', async () => {
    const { exp, eventos, fila, tempo } = montar()
    const inicio = tempo()
    for (let i = 0; i < 11; i++) fila(`${i}@g.us`, 'oi')
    await exp.acordar()
    const envios = eventos.filter((e) => e.tipo === 'texto')
    expect(envios).toHaveLength(11)
    expect(envios[10]!.em - inicio).toBeGreaterThanOrEqual(60_000)
  })

  it('só drena a fila do próprio número e nada sai desconectado', async () => {
    const { exp, eventos, fila, grupos } = montar()
    fila('a@g.us', 'de outro número', 3)
    await exp.acordar()
    expect(eventos).toEqual([])
    expect(grupos.proximaSaida(3, 'a@g.us')).not.toBeNull()
    const off = montar({ pronta: false })
    off.fila('a@g.us', 'oi')
    await off.exp.acordar()
    expect(off.eventos).toEqual([])
  })

  it('falha agenda nova tentativa; na quinta falha desiste', async () => {
    const { exp, grupos, fila } = montar({ falhar: true })
    fila('a@g.us', 'oi')
    await exp.acordar()
    expect(grupos.proximaSaida(2, 'a@g.us')).toMatchObject({ tentativas: 1 })
    const item = grupos.proximaSaida(2, 'a@g.us')!
    for (let i = 0; i < 3; i++) grupos.adiarSaida(item.id, 0)
    await exp.acordar()
    expect(grupos.proximaSaida(2, 'a@g.us')).toBeNull()
  })

  it('"digitando" dura entre 1 e 2 s', () => {
    expect(duracaoDigitandoGrupo('oi')).toBe(1000)
    expect(duracaoDigitandoGrupo('x'.repeat(500))).toBe(2000)
  })
})
```

- [ ] **Step 2: Run** `npx vitest run tests/expedidor-grupos.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** — create `src/grupos/expedidor.ts`:

```ts
import type { Logger } from 'pino'
import type { RepoGrupos } from '../db/grupos.js'
import { LimitePorMinuto } from '../whatsapp/limite.js'
import type { ConexaoGrupos, EnvioGrupo } from './tipos.js'

export interface OpcoesExpedidorGrupos {
  numeroId: number
  grupos: RepoGrupos
  conexao: ConexaoGrupos
  log: Logger
  intervaloPorChatMs?: number
  limitePorMinuto?: number
  relogio?: () => number
  esperar?: (ms: number) => Promise<void>
}

const MAX_TENTATIVAS = 5

/** "Digitando..." curto: entre 1 e 2 segundos. */
export function duracaoDigitandoGrupo(texto: string): number {
  return Math.min(2000, Math.max(1000, texto.length * 20))
}

/**
 * Esvazia a caixa de saída de um número de grupos. Sem a regra de janela do recrutamento
 * (o bot de grupos responde a comandos e, depois, publica avisos), mas com ritmo mais lento:
 * 3 s ou mais entre mensagens do mesmo chat e no máximo 10 por minuto no número.
 */
export class ExpedidorGrupos {
  private ativos = new Set<string>()
  private ultimoPorJid = new Map<string, number>()
  private timer: NodeJS.Timeout | null = null
  private readonly relogio: () => number
  private readonly esperar: (ms: number) => Promise<void>
  private readonly intervalo: number
  private readonly limite: LimitePorMinuto

  constructor(private readonly o: OpcoesExpedidorGrupos) {
    this.relogio = o.relogio ?? Date.now
    this.esperar = o.esperar ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.intervalo = o.intervaloPorChatMs ?? 3000
    this.limite = new LimitePorMinuto(o.limitePorMinuto ?? 10, this.relogio, this.esperar)
  }

  iniciar(): void {
    this.timer = setInterval(() => void this.acordar(), 1000)
  }

  parar(): void {
    if (this.timer) clearInterval(this.timer)
  }

  async acordar(): Promise<void> {
    if (!this.o.conexao.pronta()) return
    const novos = this.o.grupos.jidsComSaida(this.o.numeroId, this.relogio()).filter((j) => !this.ativos.has(j))
    await Promise.all(novos.map((jid) => this.drenar(jid)))
  }

  private async drenar(jid: string): Promise<void> {
    this.ativos.add(jid)
    try {
      for (;;) {
        if (!this.o.conexao.pronta()) return
        const item = this.o.grupos.proximaSaida(this.o.numeroId, jid)
        if (!item || item.proximaEm > this.relogio()) return
        const envio = JSON.parse(item.conteudo) as EnvioGrupo
        await this.limite.reservar()
        try {
          await this.o.conexao.digitando(jid)
          await this.esperar(duracaoDigitandoGrupo(envio.texto))
          const falta = (this.ultimoPorJid.get(jid) ?? 0) + this.intervalo - this.relogio()
          if (falta > 0) await this.esperar(falta)
          await this.o.conexao.enviarTexto(jid, envio.texto, envio.mencoes)
          this.ultimoPorJid.set(jid, this.relogio())
          this.o.grupos.removerSaida(item.id)
        } catch (err) {
          if (item.tentativas + 1 >= MAX_TENTATIVAS) {
            this.o.log.error({ err, saida: item.id, numero: this.o.numeroId }, 'envio ao grupo abandonado após várias tentativas')
            this.o.grupos.removerSaida(item.id)
          } else {
            const espera = 5000 * 2 ** item.tentativas
            this.o.log.warn({ err, saida: item.id, numero: this.o.numeroId, espera }, 'falha no envio ao grupo, nova tentativa agendada')
            this.o.grupos.adiarSaida(item.id, this.relogio() + espera)
          }
          return
        }
      }
    } finally {
      this.ativos.delete(jid)
      const corte = this.relogio() - 60_000
      for (const [j, t] of this.ultimoPorJid) if (t < corte) this.ultimoPorJid.delete(j)
    }
  }
}
```

- [ ] **Step 4: Run** `npx vitest run tests/expedidor-grupos.test.ts` → PASS; `npm run typecheck` → PASS.

- [ ] **Step 5: Commit** — `git add src/grupos/expedidor.ts tests/expedidor-grupos.test.ts && git commit -m "feat: expedidor do bot de grupos"` (+ attribution).

---

### Task 9: Baileys adapter — group role

**Files:**
- Modify: `src/whatsapp/normalizar.ts`, `src/whatsapp/baileys.ts`
- Test: `tests/normalizar.test.ts`

- [ ] **Step 1: Write the failing tests** — append to `tests/normalizar.test.ts` (add the imports it needs at the top: `import type { GroupMetadata, WAMessage } from '@whiskeysockets/baileys'` and the new functions from `'../src/whatsapp/normalizar.js'`):

```ts
const msgGrupo = (extra: Record<string, unknown> = {}) =>
  ({
    key: { remoteJid: '120363-1@g.us', participant: '111@lid', participantAlt: '5583999990001@s.whatsapp.net', id: 'X', fromMe: false },
    message: { extendedTextMessage: { text: '/quem @222', contextInfo: { mentionedJid: ['222@lid'] } } },
    ...extra
  }) as unknown as WAMessage

describe('bot de grupos: leitura das mensagens', () => {
  it('no grupo, o remetente é o participante, com telefone e LID', () => {
    expect(origemComando(msgGrupo())).toEqual({
      chat: '120363-1@g.us',
      ehGrupo: true,
      remetente: { jid: '111@lid', telefone: '5583999990001', lid: '111@lid' }
    })
  })

  it('no privado, o remetente é o próprio chat; status e canais são ignorados', () => {
    const privado = { key: { remoteJid: '5583999990001@s.whatsapp.net', id: 'Y' }, message: { conversation: '/menu' } } as unknown as WAMessage
    expect(origemComando(privado)).toEqual({
      chat: '5583999990001@s.whatsapp.net',
      ehGrupo: false,
      remetente: { jid: '5583999990001@s.whatsapp.net', telefone: '5583999990001', lid: null }
    })
    expect(origemComando({ key: { remoteJid: 'status@broadcast', id: 'Z' } } as unknown as WAMessage)).toBeNull()
    expect(jidIgnoradoGrupos('120363-1@g.us')).toBe(false)
    expect(jidIgnoradoGrupos('123@newsletter')).toBe(true)
  })

  it('texto, menções e mensagem citada', () => {
    expect(textoDaMensagem(msgGrupo())).toBe('/quem @222')
    expect(mencoesDaMensagem(msgGrupo())).toEqual({ mencionados: ['222@lid'], citada: null })
    const resposta = msgGrupo({
      message: { extendedTextMessage: { text: '/quem', contextInfo: { participant: '333@lid', quotedMessage: { conversation: 'oi' } } } }
    })
    expect(mencoesDaMensagem(resposta)).toEqual({ mencionados: [], citada: '333@lid' })
  })

  it('dados do grupo: o bot é reconhecido por qualquer um dos seus JIDs e sai da lista de membros', () => {
    const eu = ['5583900000000@s.whatsapp.net', '888@lid']
    const g = {
      id: '120363-1@g.us',
      subject: 'Loja Centro',
      participants: [
        { id: '888@lid', admin: 'admin' },
        { id: '111@lid', phoneNumber: '5583999990001@s.whatsapp.net', admin: null },
        { id: '5583999990002@s.whatsapp.net', admin: 'superadmin' }
      ]
    } as unknown as GroupMetadata
    expect(infoDoGrupo(g, eu)).toEqual({ jid: '120363-1@g.us', nome: 'Loja Centro', botAdmin: true })
    expect(membrosDoGrupo(g, eu)).toEqual([
      { jid: '111@lid', telefone: '5583999990001', lid: '111@lid', admin: false },
      { jid: '5583999990002@s.whatsapp.net', telefone: '5583999990002', lid: null, admin: true }
    ])
    expect(souEu(eu, '5583900000000:7@s.whatsapp.net')).toBe(true)
  })
})
```

- [ ] **Step 2: Run** `npx vitest run tests/normalizar.test.ts` → FAIL (functions not exported).

- [ ] **Step 3: Implement**

`src/whatsapp/normalizar.ts` — add `jidNormalizedUser` and `type GroupMetadata` to the Baileys import, `import type { InfoGrupo, MembroGrupo, Pessoa } from '../grupos/tipos.js'`, and append:

```ts
/** Bot de grupos: aceita grupos e conversas privadas; nunca status, listas de transmissão ou canais. */
export function jidIgnoradoGrupos(jid: string | null | undefined): boolean {
  return !jid || !!isJidBroadcast(jid) || !!isJidStatusBroadcast(jid) || !!isJidNewsletter(jid)
}

/** Só o texto digitado (comandos não vêm em legenda de foto). */
export function textoDaMensagem(msg: WAMessage): string | null {
  const c = normalizeMessageContent(msg.message)
  return c?.conversation || c?.extendedTextMessage?.text || null
}

function lidDe(...jids: (string | null | undefined)[]): string | null {
  for (const j of jids) if (j && isLidUser(j)) return jidNormalizedUser(j)
  return null
}

/** Onde responder e quem mandou. No grupo, o remetente é o participante (LID ou telefone). */
export function origemComando(msg: WAMessage): { chat: string; ehGrupo: boolean; remetente: Pessoa } | null {
  const chat = msg.key.remoteJid
  if (!chat || jidIgnoradoGrupos(chat)) return null
  if (!isJidGroup(chat)) {
    const quem = identidade(msg)
    return quem ? { chat, ehGrupo: false, remetente: quem } : null
  }
  const autor = msg.key.participant ? jidNormalizedUser(msg.key.participant) : null
  if (!autor) return null
  const alt = msg.key.participantAlt ? jidNormalizedUser(msg.key.participantAlt) : null
  return { chat, ehGrupo: true, remetente: { jid: autor, telefone: telefoneDoJid(autor) ?? telefoneDoJid(alt), lid: lidDe(autor, alt) } }
}

export function mencoesDaMensagem(msg: WAMessage): { mencionados: string[]; citada: string | null } {
  const info = normalizeMessageContent(msg.message)?.extendedTextMessage?.contextInfo
  const mencionados = (info?.mentionedJid ?? []).filter((j): j is string => !!j).map((j) => jidNormalizedUser(j))
  const citada = info?.quotedMessage && info.participant ? jidNormalizedUser(info.participant) : null
  return { mencionados, citada }
}

type Participante = string | { id: string; lid?: string | undefined; phoneNumber?: string | undefined }

/** O bot aparece no grupo pelo telefone ou pelo LID, conforme o modo do grupo. */
export function souEu(eu: string[], p: Participante): boolean {
  const ids = typeof p === 'string' ? [p] : [p.id, p.lid, p.phoneNumber]
  return ids.filter((j): j is string => !!j).some((j) => eu.includes(jidNormalizedUser(j)))
}

export function infoDoGrupo(g: GroupMetadata, eu: string[]): InfoGrupo {
  return { jid: g.id, nome: g.subject || 'Grupo sem nome', botAdmin: (g.participants ?? []).some((p) => souEu(eu, p) && !!p.admin) }
}

/** Participantes sem o próprio bot. */
export function membrosDoGrupo(g: GroupMetadata, eu: string[]): MembroGrupo[] {
  return (g.participants ?? [])
    .filter((p) => !souEu(eu, p))
    .map((p) => {
      const id = jidNormalizedUser(p.id)
      const pn = p.phoneNumber ? jidNormalizedUser(p.phoneNumber) : null
      return { jid: id, telefone: telefoneDoJid(id) ?? telefoneDoJid(pn), lid: lidDe(p.id, p.lid), admin: !!p.admin }
    })
}
```

`src/whatsapp/baileys.ts`:
  - imports: add `type GroupParticipant` is not needed; add `import type { Papel } from '../db/numeros.js'`, `import { ehComando } from '../grupos/comandos.js'`, `import type { ConexaoGrupos, EventoGrupos, InfoGrupo, MensagemGrupo, MetadadosGrupo } from '../grupos/tipos.js'`, and extend the `./normalizar.js` import with `infoDoGrupo, jidIgnoradoGrupos, membrosDoGrupo, mencoesDaMensagem, origemComando, souEu, textoDaMensagem`.
  - `OpcoesBaileys` becomes:

```ts
export interface OpcoesBaileys {
  /** Número (tabela numeros) desta conexão. */
  numeroId: number
  /** Recrutamento ignora grupos; grupos só repassa comandos. */
  papel: Papel
  pastaSessao: string
  repo: Repositorio
  log: Logger
  /** Mensagens mais velhas que isso (ao reconectar) são ignoradas. */
  janelaMs: number
  aoReceber: (m: MensagemRecebida) => void
  aoComando?: (m: MensagemGrupo) => void
  aoEventoGrupos?: (e: EventoGrupos) => void
  aoMudarEstado?: (e: EstadoConexao) => void
}
```

  - class header: `export class ConexaoBaileys implements ConexaoEnvio, ConexaoGrupos {`
  - in `iniciar()`:
    - `shouldIgnoreJid: (jid) => (this.o.papel === 'grupos' ? jidIgnoradoGrupos(jid) : jidIgnorado(jid)),`
    - inside `if (u.connection === 'open') { ... }` after the log line add: `if (this.o.papel === 'grupos') void this.sincronizarGrupos()`
    - replace the `messages.upsert` handler body:

```ts
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return
      for (const msg of messages) {
        const tratar = this.o.papel === 'grupos' ? this.tratarComando(msg) : this.tratarRecebida(msg)
        tratar.catch((err) => this.o.log.error({ err }, 'erro ao ler mensagem recebida'))
      }
    })
    if (this.o.papel === 'grupos') this.ouvirGrupos(sock)
```

  - in `tratarRecebida`, replace the LID lookup block (`if (!quem.telefone && quem.lid && this.sock) { try {...} catch {...} }`) with:

```ts
    // sem mapeamento, o motor pergunta o telefone no fim
    if (!quem.telefone && quem.lid) quem.telefone = await this.telefoneDoLid(quem.lid)
```

  - add these methods (after `lerVoto`):

```ts
  /** Bot de grupos: só comandos passam. A conversa comum do grupo é descartada aqui, sem tocar no banco nem no log. */
  private async tratarComando(msg: WAMessage): Promise<void> {
    if (msg.key.fromMe || !msg.key.id || !msg.message) return
    const texto = textoDaMensagem(msg)
    if (!texto || !ehComando(texto)) return
    const origem = origemComando(msg)
    if (!origem) return
    const recebidaEm = (paraNumero(msg.messageTimestamp) ?? Math.floor(Date.now() / 1000)) * 1000
    this.o.aoComando?.({ numeroId: this.o.numeroId, id: msg.key.id, ...origem, texto, ...mencoesDaMensagem(msg), recebidaEm })
  }

  /** JIDs do próprio bot (telefone e LID), sem dispositivo. */
  private eu(): string[] {
    return [this.sock?.user?.id, this.sock?.user?.lid].filter((j): j is string => !!j).map((j) => jidNormalizedUser(j))
  }

  private ouvirGrupos(sock: WASocket): void {
    const emitir = (e: EventoGrupos) => this.o.aoEventoGrupos?.(e)
    sock.ev.on('groups.upsert', (gs) => emitir({ tipo: 'entrou', grupos: gs.map((g) => infoDoGrupo(g, this.eu())) }))
    sock.ev.on('groups.update', (us) => {
      for (const u of us) if (u.id && u.subject) emitir({ tipo: 'renomeado', jid: u.id, nome: u.subject })
    })
    sock.ev.on('group-participants.update', (u) => {
      if (!u.participants.some((p) => souEu(this.eu(), p))) return
      if (u.action === 'remove') emitir({ tipo: 'saiu', jid: u.id })
      else if (u.action === 'promote' || u.action === 'demote') emitir({ tipo: 'admin', jid: u.id, admin: u.action === 'promote' })
      else if (u.action === 'add') {
        this.metadados(u.id)
          .then((md) => emitir({ tipo: 'entrou', grupos: [md] }))
          .catch((err) => this.o.log.warn({ err }, 'não foi possível ler o grupo novo'))
      }
    })
  }

  private async sincronizarGrupos(): Promise<void> {
    try {
      this.o.aoEventoGrupos?.({ tipo: 'lista', grupos: await this.listarGrupos() })
    } catch (err) {
      this.o.log.warn({ err }, 'não foi possível listar os grupos')
    }
  }
```

  - replace `enviarTexto` and add the rest of `ConexaoGrupos` in the "envio" section:

```ts
  async enviarTexto(jid: string, texto: string, mencoes?: string[]): Promise<void> {
    const enviada = await this.exigirSocket().sendMessage(jid, mencoes?.length ? { text: texto, mentions: mencoes } : { text: texto })
    this.guardarEnviada(enviada)
  }

  async listarGrupos(): Promise<InfoGrupo[]> {
    const todos = await this.exigirSocket().groupFetchAllParticipating()
    return Object.values(todos).map((g) => infoDoGrupo(g, this.eu()))
  }

  async metadados(jid: string): Promise<MetadadosGrupo> {
    const g = await this.exigirSocket().groupMetadata(jid)
    return { ...infoDoGrupo(g, this.eu()), membros: membrosDoGrupo(g, this.eu()) }
  }

  async telefoneDoLid(lid: string): Promise<string | null> {
    if (!this.sock) return null
    try {
      const pn = await this.sock.signalRepository.lidMapping.getPNForLID(lid)
      return telefoneDoJid(pn ? jidNormalizedUser(pn) : null)
    } catch {
      return null
    }
  }
```

  - delete `export function pastaSessao(...)` at the end of the file (Task 10 replaces it) **only in Task 10**; leave it now so `main.ts` compiles.

- [ ] **Step 4: Run** `npx vitest run tests/normalizar.test.ts` → PASS; `npm test`; `npm run typecheck` → PASS. In `main.ts`, the single `ConexaoBaileys` gets `papel: 'recrutamento',` so it compiles.

- [ ] **Step 5: Commit** — `git add src/whatsapp src/main.ts tests/normalizar.test.ts && git commit -m "feat: adaptador Baileys com papel de grupos (comandos, menções, eventos de grupo)"` (+ attribution).

---

### Task 10: Connection manager, session folders and backup

**Files:**
- Create: `src/whatsapp/gerenciador.ts`
- Modify: `src/whatsapp/baileys.ts` (remove `pastaSessao`), `src/rotinas/backup.ts`, `scripts/restaurar-backup.ts` (comment), `src/main.ts` (import)
- Test: `tests/gerenciador.test.ts` (create), `tests/rotinas.test.ts`

- [ ] **Step 1: Write the failing tests** — create `tests/gerenciador.test.ts`:

```ts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Numero } from '../src/db/numeros.js'
import type { EstadoConexao } from '../src/whatsapp/baileys.js'
import { GerenciadorConexoes, moverSessaoAntiga, pastaSessaoNumero, type ConexaoGerida } from '../src/whatsapp/gerenciador.js'
import { AGORA, log, pastaTemp } from './ajuda.js'

const numero = (id: number, ativo = true): Numero => ({ id, nome: `N${id}`, papel: 'recrutamento', ativo, criadoEm: AGORA })

function fabrica() {
  const eventos: string[] = []
  const criar = (n: Numero) => {
    let estado: EstadoConexao = { status: 'iniciando', qr: null, desde: AGORA, numero: null, motivo: null }
    const conexao: ConexaoGerida = {
      get estadoAtual() {
        return estado
      },
      iniciar: async () => {
        eventos.push(`iniciar ${n.id}`)
        estado = { ...estado, status: 'conectado' }
      },
      parar: async () => void eventos.push(`parar ${n.id}`),
      novaSessao: async () => void eventos.push(`nova ${n.id}`)
    }
    const expedidor = {
      iniciar: () => void eventos.push(`exp ${n.id}`),
      parar: () => void eventos.push(`exp-parar ${n.id}`),
      acordar: async () => void eventos.push(`acordar ${n.id}`)
    }
    return { conexao, expedidor }
  }
  return { eventos, g: new GerenciadorConexoes(criar, log) }
}

describe('gerenciador de conexões', () => {
  it('inicia só os ativos, uma vez cada; para e esquece', async () => {
    const { eventos, g } = fabrica()
    await g.iniciarTodos([numero(1), numero(2, false), numero(3)])
    await g.adicionar(numero(1))
    expect(eventos).toEqual(['iniciar 1', 'exp 1', 'iniciar 3', 'exp 3'])
    expect([...g.estados().keys()]).toEqual([1, 3])
    expect(g.estado(1)!.status).toBe('conectado')
    g.acordar(3)
    await g.parar(3)
    expect(eventos.slice(-3)).toEqual(['acordar 3', 'exp-parar 3', 'parar 3'])
    expect(g.estado(3)).toBeNull()
    expect(g.conexao(3)).toBeNull()
  })

  it('nova sessão só para número ativo', async () => {
    const { eventos, g } = fabrica()
    await g.iniciarTodos([numero(1)])
    await g.novaSessao(1)
    expect(eventos).toContain('nova 1')
    await expect(g.novaSessao(2)).rejects.toThrow('desativado')
  })

  it('pararTodos fecha tudo', async () => {
    const { eventos, g } = fabrica()
    await g.iniciarTodos([numero(1), numero(2)])
    await g.pararTodos()
    expect(eventos.filter((e) => e.startsWith('parar'))).toEqual(['parar 1', 'parar 2'])
    expect(g.estados().size).toBe(0)
  })
})

describe('pastas de sessão', () => {
  it('a sessão de antes vira a do número 1, sem precisar ler o QR de novo; só uma vez', async () => {
    const dados = pastaTemp()
    mkdirSync(join(dados, 'sessao'))
    writeFileSync(join(dados, 'sessao', 'creds.json'), '{}')
    expect(await moverSessaoAntiga(dados)).toBe(true)
    expect(existsSync(join(pastaSessaoNumero(dados, 1), 'creds.json'))).toBe(true)
    expect(existsSync(join(dados, 'sessao'))).toBe(false)
    expect(await moverSessaoAntiga(dados)).toBe(false)
  })

  it('não mexe se o número 1 já tem sessão', async () => {
    const dados = pastaTemp()
    mkdirSync(join(dados, 'sessao'))
    mkdirSync(pastaSessaoNumero(dados, 1), { recursive: true })
    expect(await moverSessaoAntiga(dados)).toBe(false)
    expect(existsSync(join(dados, 'sessao'))).toBe(true)
  })
})
```

In `tests/rotinas.test.ts`, inside the backup test, before `fazerBackup`, add:

```ts
    mkdirSync(join(dados, 'sessoes', '2'), { recursive: true })
    writeFileSync(join(dados, 'sessoes', '2', 'creds.json'), '{"x":1}')
```

and after the restore, add:

```ts
    expect(readFileSync(join(destino, 'sessoes', '2', 'creds.json'), 'utf8')).toBe('{"x":1}')
```

- [ ] **Step 2: Run** `npx vitest run tests/gerenciador.test.ts tests/rotinas.test.ts` → FAIL.

- [ ] **Step 3: Implement**

Create `src/whatsapp/gerenciador.ts`:

```ts
import { existsSync } from 'node:fs'
import { mkdir, rename } from 'node:fs/promises'
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
  await rename(antiga, nova)
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
    const linha = this.criar(numero)
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
```

`src/whatsapp/baileys.ts`: delete `export function pastaSessao(dados: string): string { ... }` and the now-unused `join` import (keep `cp, mkdir, rm`).

`src/main.ts`: `import { pastaSessaoNumero } from './whatsapp/gerenciador.js'` and use `pastaSessao: pastaSessaoNumero(amb.dados, 1),`; also, right after `const repo = new Repositorio(db)`, add:

```ts
if (await moverSessaoAntiga(amb.dados)) log.info('sessão do WhatsApp movida para sessoes/1')
```

(import `moverSessaoAntiga` from the same module). Task 14 rewrites the rest of `main.ts`.

`src/rotinas/backup.ts` line 32: back up every number's session (and a legacy folder if one is still there):

```ts
    const itens = [`backups/.tmp-${o.agora}/banco.sqlite`, 'curriculos', 'sessoes', 'sessao'].filter((i) => existsSync(join(o.dados, i)))
```

`scripts/restaurar-backup.ts` line 2 comment: `// Extrai banco.sqlite (em backups/.tmp-*/), curriculos/ e sessoes/ na pasta destino.`

- [ ] **Step 4: Run** `npx vitest run tests/gerenciador.test.ts tests/rotinas.test.ts` → PASS; `npm test`; `npm run typecheck` → PASS.

- [ ] **Step 5: Commit** — `git add src scripts tests && git commit -m "feat: gerenciador de conexões, uma pasta de sessão por número"` (+ attribution).

---

### Task 11: Connection alert per number

**Files:**
- Modify: `src/rotinas/alerta.ts`
- Test: `tests/rotinas.test.ts`

- [ ] **Step 1: Write the failing test** — append inside `describe('vigia da conexão', ...)`:

```ts
  it('com vários números, o alerta diz qual caiu', () => {
    const enviados: { assunto: string; texto: string }[] = []
    const alertas = { enviar: async (assunto: string, texto: string) => void enviados.push({ assunto, texto }) } as unknown as Alertas
    const vigia = new VigiaConexao(alertas, () => AGORA, 'Avisos')
    vigia.verificar({ status: 'desconectado', desde: AGORA, motivo: 'sessão encerrada' })
    expect(enviados[0]!.assunto).toBe('Sessão do WhatsApp encerrada (Avisos)')
    expect(enviados[0]!.texto).toContain('Números')
  })
```

- [ ] **Step 2: Run** `npx vitest run tests/rotinas.test.ts` → FAIL.

- [ ] **Step 3: Implement** in `src/rotinas/alerta.ts`, `VigiaConexao`:

```ts
export class VigiaConexao {
  private avisado = false

  constructor(
    private readonly alertas: Alertas,
    private readonly relogio: () => number = Date.now,
    /** Nome do número, quando há mais de um. */
    private readonly nome: string | null = null
  ) {}

  private assunto(a: string): string {
    return this.nome ? `${a} (${this.nome})` : a
  }

  verificar(e: { status: string; desde: number; motivo: string | null }): void {
    if (e.status === 'conectado') {
      if (this.avisado) {
        this.avisado = false
        void this.alertas.enviar(this.assunto('Conexão restabelecida'), 'O bot voltou a se conectar ao WhatsApp.')
      }
      return
    }
    if (this.avisado) return
    if (e.status === 'desconectado' && e.motivo) {
      this.avisado = true
      void this.alertas.enviar(
        this.assunto('Sessão do WhatsApp encerrada'),
        `O bot parou: ${e.motivo}.\nAbra a página Números do painel e leia o QR de novo com o celular deste número.`
      )
      return
    }
    if (this.relogio() - e.desde > LIMITE_QUEDA_MS) {
      this.avisado = true
      const situacao = e.status === 'aguardando_qr' ? 'aguardando leitura do QR' : 'sem conexão'
      void this.alertas.enviar(this.assunto('Bot fora do ar há mais de 10 minutos'), `Situação: ${situacao}. Confira a página /saude do painel.`)
    }
  }
}
```

- [ ] **Step 4: Run** `npx vitest run tests/rotinas.test.ts` → PASS (the old test, with no name, keeps its subjects).

- [ ] **Step 5: Commit** — `git add src/rotinas/alerta.ts tests/rotinas.test.ts && git commit -m "feat: alerta de conexão diz qual número caiu"` (+ attribution).

---

### Task 12: Panel — Números page, `/healthz`, `/saude`, bot list per number

**Files:**
- Create: `src/painel/paginas-numeros.ts`, `src/painel/rotas-numeros.ts`
- Modify: `src/painel/paginas.ts`, `src/painel/servidor.ts`
- Test: `tests/painel.test.ts`

- [ ] **Step 1: Write the failing tests** in `tests/painel.test.ts`:
  - imports: `import type { Numero } from '../src/db/numeros.js'` (plus existing `RepoNumeros`).
  - rewrite `painelComBot` so the fake controls several numbers:

```ts
async function painelComBot(repo: Repositorio, armazem: ArmazemArquivos) {
  const modelo = botModelo('2026-10-06')
  repo.salvarBot(
    'VEND-OUT26',
    JSON.stringify({ ...modelo, codigo: 'VEND-OUT26', vaga: 'Vendedor(a) de loja', status: 'aberto', encerra_em: '2026-10-31' }),
    1,
    'teste',
    AGORA
  )
  const bots = new FonteBots(repo, padrao)
  const estados = new Map<number, EstadoConexao>([[1, { status: 'conectado', qr: null, desde: AGORA, numero: '5583900001111', motivo: null }]])
  const app = await criarPainel({
    repo,
    numeros: new RepoNumeros(repo.db),
    bots,
    relogio: () => AGORA,
    armazem,
    conexoes: {
      estado: (id) => estados.get(id) ?? null,
      novaSessao: async () => {},
      ativar: async (n: Numero) => void estados.set(n.id, { status: 'aguardando_qr', qr: 'QR-TESTE', desde: AGORA, numero: null, motivo: null }),
      desativar: async (id) => void estados.delete(id)
    },
    usuarios: new Map([['rh', hashSenha('senha-bem-longa')]]),
    segredo: 'x'.repeat(40),
    cookieSeguro: false,
    backupAtivo: false,
    alertaAtivo: false
  })
  return { app, bots, estados }
}

async function login(app: FastifyInstance): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/login', payload: 'usuario=rh&senha=senha-bem-longa', headers: form })
  return `sessao=${r.cookies.find((x) => x.name === 'sessao')!.value}`
}
```

  - delete the unused `const estado: EstadoConexao = ...` line inside `describe('painel', ...)`.
  - append:

```ts
describe('números', () => {
  let app: FastifyInstance
  let repo: Repositorio
  let cookie: string

  beforeEach(async () => {
    repo = new Repositorio(abrirBanco(':memory:'))
    ;({ app } = await painelComBot(repo, new ArmazemArquivos(pastaTemp())))
    cookie = await login(app)
  })

  it('adicionar número mostra o QR e é auditado; /healthz só fica ok com todos os ativos conectados', async () => {
    expect((await app.inject('/healthz')).statusCode).toBe(200)
    const r = await app.inject({ method: 'POST', url: '/numeros', headers: { ...form, cookie }, payload: 'nome=Avisos&papel=grupos' })
    expect(r.statusCode).toBe(303)
    expect(r.headers.location).toBe('/numeros/2')
    expect((await app.inject({ url: '/numeros/2', headers: { cookie } })).body).toContain('data:image/png;base64')
    expect(repo.auditoriaRecente(1)[0]).toMatchObject({ usuario: 'rh', acao: 'criar_numero' })
    const h = await app.inject('/healthz')
    expect(h.statusCode).toBe(503)
    expect(h.json()).toEqual({ ok: false })
    expect((await app.inject({ method: 'POST', url: '/numeros/2/desativar', headers: { cookie } })).statusCode).toBe(303)
    expect(new RepoNumeros(repo.db).numero(2)!.ativo).toBe(false)
    expect((await app.inject('/healthz')).statusCode).toBe(200)
    expect(repo.auditoriaRecente(1)[0]).toMatchObject({ acao: 'desativar_numero' })
  })

  it('nome vazio ou uso desconhecido é recusado', async () => {
    const r = await app.inject({ method: 'POST', url: '/numeros', headers: { ...form, cookie }, payload: 'nome=&papel=grupos' })
    expect(r.statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/numeros', headers: { ...form, cookie }, payload: 'nome=X&papel=vendas' })).statusCode).toBe(400)
    expect(new RepoNumeros(repo.db).listar()).toHaveLength(1)
  })

  it('/conexao leva para /numeros; /numeros e /saude mostram cada número', async () => {
    new RepoNumeros(repo.db).criar('Avisos', 'grupos', AGORA)
    expect((await app.inject({ url: '/conexao', headers: { cookie } })).headers.location).toBe('/numeros')
    const lista = await app.inject({ url: '/numeros', headers: { cookie } })
    expect(lista.body).toContain('Principal')
    expect(lista.body).toContain('Avisos')
    const saude = await app.inject({ url: '/saude', headers: { cookie } })
    expect(saude.body).toContain('Principal')
    expect(saude.body).toContain('Avisos')
  })
})
```

- [ ] **Step 2: Run** `npx vitest run tests/painel.test.ts` → FAIL.

- [ ] **Step 3: Implement**

`src/painel/paginas.ts`:
  - `import type { Numero } from '../db/numeros.js'`
  - nav: `<a href="/">Bots</a><a href="/numeros">Números</a><a href="/saude">Saúde</a><a href="/auditoria">Auditoria</a>`
  - export `ROTULO_STATUS` (`export const ROTULO_STATUS`).
  - delete `paginaConexao` (moved to `paginas-numeros.ts`).
  - `paginaProcessos` takes the recruitment numbers instead of one phone:

```ts
/** Número de recrutamento como a lista de bots precisa: nome e telefone conectado. */
export interface NumeroDosBots {
  id: number
  nome: string
  telefone: string | null
}

export function paginaProcessos(
  config: ConfigCarregada,
  resumo: Map<string, { total: number; concluidas: number }>,
  numeros: NumeroDosBots[],
  usuario: string,
  agora: number,
  aviso: string | null = null
): string {
  const linhas = config.processos
    .map((p) => {
      const r = resumo.get(p.codigo) ?? { total: 0, concluidas: 0 }
      const n = numeros.find((x) => x.id === p.numeroId)
      const link = n?.telefone ? linkWaMe(n.telefone, p.codigo) : null
      const cod = encodeURIComponent(p.codigo)
      const qual = numeros.length > 1 && n ? `<br><span class="suave">${esc(n.nome)}</span>` : ''
      return `<tr><td><strong>${esc(p.vaga)}</strong><br><span class="suave">${esc(p.codigo)}</span></td>
        <td>${ROTULO_SITUACAO[situacao(p, agora)]}</td><td>${periodo(p)}</td>
        <td><a href="/processos/${cod}">${r.concluidas} concluídas</a><br><span class="suave">${r.total - r.concluidas} incompletas</span></td>
        <td>${link ? `<code>${esc(link)}</code>` : '<span class="suave">conecte o número para gerar</span>'}${qual}</td>
        <td style="white-space:nowrap"><a class="botao" href="/bots/${cod}">Editar</a> <a class="botao" href="/bots/novo?de=${cod}">Copiar</a></td></tr>`
    })
    .join('')
```

  and replace the `abertos`/`direto` block with one line per connected recruitment number:

```ts
  const direto = numeros
    .filter((n): n is NumeroDosBots & { telefone: string } => !!n.telefone)
    .map((n) => {
      const abertos = config.processos.filter((p) => p.numeroId === n.id && situacao(p, agora) === 'aberto').length
      const destino =
        abertos === 1 ? 'vai para o único bot aberto.' : abertos > 1 ? 'o candidato escolhe a vaga numa enquete.' : 'responde que não há inscrições abertas.'
      return `<p class="suave">Contato direto pelo ${esc(n.nome)} (<code>https://wa.me/${esc(n.telefone)}</code>): ${destino}</p>`
    })
    .join('')
```

  - `paginaSaude` gets one line per number:

```ts
export interface SaudeNumero {
  numero: Numero
  estado: EstadoConexao | null
  ultimaMensagem: number | null
}

export interface DadosSaude {
  numeros: SaudeNumero[]
  filas: { entrada: number; saida: number; erros: number }
  ultimoBackup: string | null
  backupAtivo: boolean
  alertaAtivo: boolean
  config: ConfigCarregada
}

export function paginaSaude(d: DadosSaude, usuario: string): string {
  const fila = d.filas.entrada + d.filas.saida
  const numeros = d.numeros
    .map(({ numero: n, estado: e, ultimaMensagem }) => {
      const cor = !n.ativo ? 'suave' : e?.status === 'conectado' ? 'ok' : 'erro'
      const status = !n.ativo ? 'desativado' : `${esc(ROTULO_STATUS[e?.status ?? 'iniciando'])}${e ? ` desde ${esc(dataBR(e.desde))}` : ''}`
      return `<dt>${esc(n.nome)} <span class="suave">(${n.papel})</span></dt>
        <dd><span class="${cor}">${status}</span> · última mensagem: ${esc(ultimaMensagem ? dataBR(ultimaMensagem) : 'nenhuma')}</dd>`
    })
    .join('')
  const corpo = `<h1>Saúde do bot</h1><div class="cartao"><h2 style="margin-top:0">Números</h2><dl>${numeros}</dl></div>
  <div class="cartao"><dl>
    <dt>Fila</dt><dd class="${fila === 0 ? 'ok' : 'alerta'}">${d.filas.entrada} a processar · ${d.filas.saida} a enviar</dd>
    <dt>Mensagens com erro</dt><dd class="${d.filas.erros ? 'erro' : 'ok'}">${d.filas.erros}</dd>
    <dt>Último backup</dt><dd class="${d.backupAtivo ? '' : 'erro'}">${d.backupAtivo ? esc(d.ultimoBackup ? dataBR(Date.parse(d.ultimoBackup)) : 'ainda não rodou') : 'desativado (defina BACKUP_SENHA)'}</dd>
    <dt>Alerta por e-mail</dt><dd class="${d.alertaAtivo ? 'ok' : 'alerta'}">${d.alertaAtivo ? 'ativo' : 'desativado (defina SMTP_URL e ALERTA_EMAIL_PARA)'}</dd>
    <dt>Configuração</dt><dd>${d.config.processos.length} processos, lida em ${esc(dataBR(d.config.carregadaEm))}${d.config.erros.length ? ` · <span class="erro">${d.config.erros.length} com erro</span>` : ''}</dd>
  </dl></div>`
  return layout('Saúde', corpo, usuario)
}
```

Create `src/painel/paginas-numeros.ts`:

```ts
import type { Numero, Papel } from '../db/numeros.js'
import type { EstadoConexao } from '../whatsapp/baileys.js'
import { dataBR } from './exportar.js'
import { ROTULO_STATUS, esc, layout } from './paginas.js'

const ROTULO_PAPEL: Record<Papel, string> = { recrutamento: 'Recrutamento', grupos: 'Grupos' }

function status(n: Numero, e: EstadoConexao | null): string {
  if (!n.ativo) return '<span class="suave">desativado</span>'
  const cor = e?.status === 'conectado' ? 'ok' : e?.status === 'desconectado' ? 'erro' : 'alerta'
  return `<span class="${cor}">${esc(ROTULO_STATUS[e?.status ?? 'iniciando'])}</span>`
}

export function paginaNumeros(itens: { numero: Numero; estado: EstadoConexao | null }[], usuario: string, erro: string | null = null): string {
  const linhas = itens
    .map(
      ({ numero: n, estado: e }) => `<tr><td><a href="/numeros/${n.id}"><strong>${esc(n.nome)}</strong></a></td>
      <td>${ROTULO_PAPEL[n.papel]}</td><td>${status(n, e)}</td><td>${esc(e?.numero ?? '—')}</td><td>${e ? esc(dataBR(e.desde)) : '—'}</td></tr>`
    )
    .join('')
  return layout(
    'Números',
    `<h1>Números de WhatsApp</h1>${erro ? `<div class="cartao erro">${esc(erro)}</div>` : ''}
    <div class="cartao"><table><thead><tr><th>Nome</th><th>Uso</th><th>Status</th><th>Telefone</th><th>Desde</th></tr></thead><tbody>${linhas}</tbody></table></div>
    <div class="cartao"><h2 style="margin-top:0">+ Número</h2>
      <p class="suave">Cada número tem um uso só. <strong>Recrutamento</strong> responde candidatos; <strong>Grupos</strong> atende comandos nos grupos da empresa. Assim, um bloqueio num número não derruba o outro. O uso não muda depois.</p>
      <form method="post" action="/numeros" style="display:flex;gap:8px;flex-wrap:wrap;align-items:end">
        <label style="flex:1 1 220px">Nome<input name="nome" maxlength="40" required placeholder="Ex.: Avisos da empresa"></label>
        <label style="flex:0 0 180px">Uso<select name="papel"><option value="recrutamento">Recrutamento</option><option value="grupos">Grupos</option></select></label>
        <button class="primario">Adicionar e mostrar o QR</button>
      </form></div>`,
    usuario
  )
}

export function paginaNumero(n: Numero, e: EstadoConexao | null, qrImagem: string | null, usuario: string): string {
  const qr = qrImagem
    ? `<div class="cartao"><p>No celular deste número: WhatsApp → <strong>Aparelhos conectados</strong> → <strong>Conectar aparelho</strong>, e aponte para o código. Ele muda a cada poucos segundos; a página atualiza sozinha.</p>
       <img src="${qrImagem}" alt="QR code de conexão" width="280" height="280" style="background:#fff;padding:8px;border-radius:8px"></div>`
    : ''
  const novoQr =
    n.ativo && e?.status === 'desconectado'
      ? `<form method="post" action="/numeros/${n.id}/nova-sessao" onsubmit="return confirm('Começar uma sessão nova? A sessão atual é copiada antes.')"><button class="primario">Gerar novo QR</button></form>`
      : ''
  const liga = n.ativo
    ? `<form method="post" action="/numeros/${n.id}/desativar" onsubmit="return confirm('Desativar este número? O bot para de usar este WhatsApp até ser ativado de novo.')"><button class="perigo">Desativar</button></form>`
    : `<form method="post" action="/numeros/${n.id}/ativar"><button class="primario">Ativar</button></form>`
  const corpo = `<p><a href="/numeros">← Números</a></p>
    <h1>${esc(n.nome)} <span class="etiqueta">${ROTULO_PAPEL[n.papel]}</span></h1>
    <div class="cartao"><dl>
      <dt>Status</dt><dd>${status(n, e)}</dd>
      ${e ? `<dt>Desde</dt><dd>${esc(dataBR(e.desde))}</dd><dt>Telefone</dt><dd>${esc(e.numero ?? '—')}</dd>` : ''}
      ${e?.motivo ? `<dt>Motivo</dt><dd class="erro">${esc(e.motivo)}</dd>` : ''}
    </dl></div>${qr}
    <div class="cartao" style="display:flex;gap:8px;flex-wrap:wrap">${novoQr}${liga}</div>`
  const refresh = n.ativo && e?.status !== 'conectado' ? '<meta http-equiv="refresh" content="5">' : ''
  return layout(n.nome, corpo, usuario, refresh)
}
```

Create `src/painel/rotas-numeros.ts`:

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import QRCode from 'qrcode'
import { PAPEIS, type Papel } from '../db/numeros.js'
import { paginaNumero, paginaNumeros } from './paginas-numeros.js'
import type { DependenciasPainel } from './servidor.js'

/** Ferramentas que o servidor passa para os arquivos de rotas. */
export interface Ajudantes {
  html: (rep: FastifyReply, corpo: string) => FastifyReply
  usuario: (req: FastifyRequest) => string
  agora: () => number
}

export function rotasNumeros(app: FastifyInstance, d: DependenciasPainel, a: Ajudantes): void {
  const lista = () => d.numeros.listar().map((numero) => ({ numero, estado: numero.ativo ? d.conexoes.estado(numero.id) : null }))
  const achar = (id: string) => (/^\d+$/.test(id) ? d.numeros.numero(Number(id)) : null)

  // Endereço antigo, de quando havia um número só.
  app.get('/conexao', async (_req, rep) => rep.redirect('/numeros', 303))

  app.get('/numeros', async (req, rep) => a.html(rep, paginaNumeros(lista(), a.usuario(req))))

  app.post<{ Body: { nome?: string; papel?: string } }>('/numeros', async (req, rep) => {
    const nome = (req.body?.nome ?? '').trim().replace(/\s+/g, ' ')
    const papel = req.body?.papel as Papel
    if (!nome || nome.length > 40 || !PAPEIS.includes(papel)) {
      return a.html(rep.code(400), paginaNumeros(lista(), a.usuario(req), 'Informe um nome (até 40 caracteres) e o uso do número.'))
    }
    const n = d.repo.transacao(() => {
      const criado = d.numeros.criar(nome, papel, a.agora())
      d.repo.auditar(a.usuario(req), 'criar_numero', `${criado.id} ${nome} (${papel})`, a.agora())
      return criado
    })
    await d.conexoes.ativar(n)
    return rep.redirect(`/numeros/${n.id}`, 303)
  })

  app.get<{ Params: { id: string } }>('/numeros/:id', async (req, rep) => {
    const n = achar(req.params.id)
    if (!n) return rep.code(404).send('Número não encontrado')
    const e = n.ativo ? d.conexoes.estado(n.id) : null
    const qr = e?.qr ? await QRCode.toDataURL(e.qr, { margin: 1, width: 280 }) : null
    return a.html(rep, paginaNumero(n, e, qr, a.usuario(req)))
  })

  app.post<{ Params: { id: string } }>('/numeros/:id/nova-sessao', async (req, rep) => {
    const n = achar(req.params.id)
    if (!n) return rep.code(404).send('Número não encontrado')
    if (!n.ativo) return rep.code(409).send('Ative o número antes de gerar um QR.')
    d.repo.auditar(a.usuario(req), 'nova_sessao', `${n.id} ${n.nome}`, a.agora())
    await d.conexoes.novaSessao(n.id)
    return rep.redirect(`/numeros/${n.id}`, 303)
  })

  app.post<{ Params: { id: string } }>('/numeros/:id/ativar', async (req, rep) => {
    const n = achar(req.params.id)
    if (!n) return rep.code(404).send('Número não encontrado')
    d.repo.transacao(() => {
      d.numeros.definirAtivo(n.id, true)
      d.repo.auditar(a.usuario(req), 'ativar_numero', `${n.id} ${n.nome}`, a.agora())
    })
    await d.conexoes.ativar({ ...n, ativo: true })
    return rep.redirect(`/numeros/${n.id}`, 303)
  })

  app.post<{ Params: { id: string } }>('/numeros/:id/desativar', async (req, rep) => {
    const n = achar(req.params.id)
    if (!n) return rep.code(404).send('Número não encontrado')
    d.repo.transacao(() => {
      d.numeros.definirAtivo(n.id, false)
      d.repo.auditar(a.usuario(req), 'desativar_numero', `${n.id} ${n.nome}`, a.agora())
    })
    await d.conexoes.desativar(n.id)
    return rep.redirect(`/numeros/${n.id}`, 303)
  })
}
```

`src/painel/servidor.ts`:
  - imports: remove `QRCode` and `paginaConexao`; add `import type { Numero } from '../db/numeros.js'` and `import { rotasNumeros } from './rotas-numeros.js'`.
  - add before `DependenciasPainel`:

```ts
/** O que o painel controla nas conexões (o GerenciadorConexoes, em produção). */
export interface ControleConexoes {
  estado(numeroId: number): EstadoConexao | null
  novaSessao(numeroId: number): Promise<void>
  ativar(numero: Numero): Promise<void>
  desativar(numeroId: number): Promise<void>
}
```

  - in `DependenciasPainel` replace `conexao: { estado: ...; novaSessao: ... }` with `conexoes: ControleConexoes`.
  - `/healthz`:

```ts
  /** Para o Uptime Kuma: ok só com todos os números ativos conectados, sem nenhum dado. */
  app.get('/healthz', async (_req, rep) => {
    const ativos = d.numeros.listar().filter((n) => n.ativo)
    const ok = ativos.length > 0 && ativos.every((n) => d.conexoes.estado(n.id)?.status === 'conectado')
    return rep.code(ok ? 200 : 503).send({ ok })
  })
```

  - `/` route:

```ts
    const numeros = numerosRecrutamento().map((n) => ({ id: n.id, nome: n.nome, telefone: d.conexoes.estado(n.id)?.numero ?? null }))
    return html(rep, paginaProcessos(d.bots.get(), d.repo.resumoPorProcesso(), numeros, usuario(req), agora(), aviso))
```

  (move the `numerosRecrutamento` helper above this route.)
  - delete the `/conexao` GET and `/conexao/nova-sessao` POST routes; before `return app` add `rotasNumeros(app, d, { html, usuario, agora })`.
  - `/saude`:

```ts
  app.get('/saude', async (req, rep) => {
    const ultimas = d.repo.ultimaRecebidaPorNumero()
    const numeros = d.numeros.listar().map((numero) => ({
      numero,
      estado: numero.ativo ? d.conexoes.estado(numero.id) : null,
      ultimaMensagem: ultimas.get(numero.id) ?? null
    }))
    return html(
      rep,
      paginaSaude(
        {
          numeros,
          filas: d.repo.filas(),
          ultimoBackup: d.repo.meta('ultimo_backup'),
          backupAtivo: d.backupAtivo,
          alertaAtivo: d.alertaAtivo,
          config: d.bots.get()
        },
        usuario(req)
      )
    )
  })
```

`src/main.ts` (still single-number until Task 14): pass `conexoes: { estado: (id) => (id === 1 ? conexao.estadoAtual : null), novaSessao: () => conexao.novaSessao(), ativar: async () => {}, desativar: async () => {} }` to `criarPainel` (replacing `conexao`) so it compiles.

- [ ] **Step 4: Run** `npx vitest run tests/painel.test.ts` → PASS; `npm test`; `npm run typecheck` → PASS.

- [ ] **Step 5: Commit** — `git add src tests && git commit -m "feat: painel com página Números, saúde por número e /healthz de todos"` (+ attribution).

---

### Task 13: Panel — Grupos and Equipe (with CSV import)

**Files:**
- Create: `src/grupos/equipe.ts`, `src/painel/paginas-equipe.ts`, `src/painel/rotas-equipe.ts`
- Modify: `src/painel/exportar.ts`, `src/painel/paginas.ts` (nav), `src/painel/servidor.ts`, `src/main.ts`
- Test: `tests/equipe.test.ts` (create), `tests/painel.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/equipe.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { ErroEquipe, MAX_LINHAS_CSV, dividirLinhaCsv, lerCsvEquipe, validarFuncionario } from '../src/grupos/equipe.js'

describe('cadastro da equipe', () => {
  it('lê CSV com BOM, cabeçalho e aspas, com um erro por linha', () => {
    const csv = [
      '﻿nome;telefone;setor;loja;cargo;nascimento',
      'Ana Souza;(83) 99999-0001;Vendas;Centro;Gerente;10/05/1990',
      '"Souza; Beto";83999990002;Caixa;Sul;;',
      'X;123;;;;',
      'Caio Lima;83999990001;;;;',
      'Dani Reis;83999990004;;;;31/02/1990',
      ''
    ].join('\r\n')
    const r = lerCsvEquipe(csv)
    expect(r.map((l) => [l.linha, l.erro])).toEqual([
      [2, null],
      [3, null],
      [4, 'nome é obrigatório (até 80 caracteres)'],
      [5, 'telefone repetido (já está na linha 2)'],
      [6, 'nascimento não é uma data válida']
    ])
    expect(r[0]!.dados).toEqual({
      nome: 'Ana Souza', telefone: '5583999990001', lid: null, setor: 'Vendas', loja: 'Centro',
      cargo: 'Gerente', nascimento: '1990-05-10', ativo: true
    })
    expect(r[1]!.dados).toMatchObject({ nome: 'Souza; Beto', cargo: null, nascimento: null })
  })

  it('aspas duplas dentro de campo', () => {
    expect(dividirLinhaCsv('"a ""b""";c')).toEqual(['a "b"', 'c'])
  })

  it('telefone só é obrigatório quando pedido; telefone inválido sempre é erro', () => {
    expect(validarFuncionario({ nome: 'Ana Souza' }, { telefoneObrigatorio: false, lid: '1@lid' })).toMatchObject({ telefone: null, lid: '1@lid' })
    expect(() => validarFuncionario({ nome: 'Ana Souza' }, { telefoneObrigatorio: true, lid: null })).toThrow('telefone é obrigatório')
    expect(() => validarFuncionario({ nome: 'Ana Souza', telefone: '99' }, { telefoneObrigatorio: false, lid: null })).toThrow(ErroEquipe)
  })

  it('arquivo grande demais é recusado inteiro', () => {
    const csv = Array.from({ length: MAX_LINHAS_CSV + 1 }, (_, i) => `P${i} Silva;8399999${String(i).padStart(4, '0')}`).join('\n')
    expect(() => lerCsvEquipe(csv)).toThrow(ErroEquipe)
  })
})
```

In `tests/painel.test.ts`:
  - import `RepoGrupos` from `'../src/db/grupos.js'`; in `painelComBot` add `grupos: new RepoGrupos(repo.db),` to `criarPainel({...})`.
  - append:

```ts
describe('grupos e equipe', () => {
  let app: FastifyInstance
  let repo: Repositorio
  let grupos: RepoGrupos
  let cookie: string
  const post = (url: string, payload: Record<string, string>) =>
    app.inject({ method: 'POST', url, headers: { ...form, cookie }, payload: new URLSearchParams(payload).toString() })

  beforeEach(async () => {
    repo = new Repositorio(abrirBanco(':memory:'))
    ;({ app } = await painelComBot(repo, new ArmazemArquivos(pastaTemp())))
    new RepoNumeros(repo.db).criar('Avisos', 'grupos', AGORA)
    grupos = new RepoGrupos(repo.db)
    grupos.salvarGrupo(2, '120363-1@g.us', 'Loja Centro', false, AGORA)
    cookie = await login(app)
  })

  it('/grupos lista por número e grava setor e loja com auditoria', async () => {
    expect((await app.inject({ url: '/grupos', headers: { cookie } })).body).toContain('Loja Centro')
    const r = await post('/grupos/etiquetar', { numero_id: '2', jid: '120363-1@g.us', setor: 'Vendas', loja: 'Centro' })
    expect(r.statusCode).toBe(303)
    expect(grupos.grupo(2, '120363-1@g.us')).toMatchObject({ setor: 'Vendas', loja: 'Centro' })
    expect(repo.auditoriaRecente(1)[0]).toMatchObject({ usuario: 'rh', acao: 'etiquetar_grupo' })
    expect((await post('/grupos/etiquetar', { numero_id: '2', jid: 'nao@g.us', setor: '', loja: '' })).statusCode).toBe(404)
  })

  it('cadastro pelo painel: telefone normalizado, repetido recusado, gestor e exclusão auditados', async () => {
    expect((await post('/equipe/salvar', { nome: 'Ana Souza', telefone: '(83) 99999-0001', setor: 'Vendas', loja: 'Centro', ativo: '1' })).statusCode).toBe(303)
    const ana = grupos.porTelefone('5583999990001')!
    expect(ana).toMatchObject({ nome: 'Ana Souza', ativo: true })
    const repetido = await post('/equipe/salvar', { nome: 'Outra Pessoa', telefone: '83999990001', ativo: '1' })
    expect(repetido.statusCode).toBe(400)
    expect(repetido.body).toContain('já é de Ana Souza')
    expect((await post(`/equipe/${ana.id}/gestor`, { ativo: '1' })).statusCode).toBe(303)
    expect(grupos.gestores()).toEqual([ana.id])
    expect((await app.inject({ url: '/equipe?q=souza', headers: { cookie } })).body).toContain('👔 gestor')
    expect((await post(`/equipe/${ana.id}/excluir`, {})).statusCode).toBe(303)
    expect(grupos.funcionarios()).toEqual([])
    expect(repo.auditoriaRecente(4).map((l) => l.acao)).toEqual(['excluir_funcionario', 'gestor_adicionado', 'criar_funcionario', 'login'])
  })

  it('importação CSV: prévia com erro por linha, confirma só as válidas e atualiza quem já existe', async () => {
    const id = grupos.salvarFuncionario(
      null,
      { nome: 'Ana', telefone: '5583999990001', lid: '111@lid', setor: null, loja: null, cargo: null, nascimento: null, ativo: true },
      AGORA
    )
    const csv = 'Ana Souza;83999990001;Vendas;Centro;;\nBeto Lima;83999990002;Caixa;Sul;;\nX;1;;;;'
    const previa = await post('/equipe/importar', { csv })
    expect(previa.statusCode).toBe(200)
    expect(previa.body).toContain('atualiza')
    expect(previa.body).toContain('novo')
    expect(previa.body).toContain('nome é obrigatório')
    expect(grupos.funcionarios()).toHaveLength(1)
    const r = await post('/equipe/importar', { csv, confirmar: '1' })
    expect(r.headers.location).toBe('/equipe?importados=2')
    expect(grupos.funcionario(id)).toMatchObject({ nome: 'Ana Souza', setor: 'Vendas', lid: '111@lid' })
    expect(grupos.porTelefone('5583999990002')).toMatchObject({ nome: 'Beto Lima' })
    expect(repo.auditoriaRecente(1)[0]).toMatchObject({ acao: 'importar_equipe', detalhe: '2 pessoas (1 linhas com erro)' })
  })

  it('exportação da equipe vem com BOM e neutraliza fórmulas', async () => {
    grupos.salvarFuncionario(
      null,
      { nome: '=HYPERLINK("x")', telefone: '5583999990001', lid: null, setor: null, loja: null, cargo: null, nascimento: null, ativo: true },
      AGORA
    )
    const r = await app.inject({ url: '/equipe/exportar', headers: { cookie } })
    expect(r.headers['content-type']).toContain('text/csv')
    expect(r.body.startsWith('﻿"nome";"telefone"')).toBe(true)
    expect(r.body).toContain(`"'=HYPERLINK(""x"")"`)
    expect(repo.auditoriaRecente(1)[0]).toMatchObject({ acao: 'exportar_equipe' })
  })
})
```

- [ ] **Step 2: Run** `npx vitest run tests/equipe.test.ts tests/painel.test.ts` → FAIL.

- [ ] **Step 3: Implement**

Create `src/grupos/equipe.ts`:

```ts
import { semAcento } from '../conversa/textos.js'
import type { DadosFuncionario } from '../db/grupos.js'
import { telefoneCanonico } from './pessoas.js'

export class ErroEquipe extends Error {}

/** Campos como chegam do formulário ou da planilha (tudo texto). */
export interface EntradaFuncionario {
  nome?: string | undefined
  telefone?: string | undefined
  setor?: string | undefined
  loja?: string | undefined
  cargo?: string | undefined
  nascimento?: string | undefined
  ativo?: boolean | undefined
}

export const MAX_LINHAS_CSV = 2000

function opcional(v: string | undefined, campo: string): string | null {
  const t = (v ?? '').trim().replace(/\s+/g, ' ')
  if (t.length > 60) throw new ErroEquipe(`${campo} passa de 60 caracteres`)
  return t || null
}

/** Aceita DD/MM/AAAA ou AAAA-MM-DD; devolve AAAA-MM-DD. */
export function dataNascimento(v: string | undefined): string | null {
  const t = (v ?? '').trim()
  if (!t) return null
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t)
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t)
  if (!iso && !br) throw new ErroEquipe('nascimento deve ser DD/MM/AAAA ou AAAA-MM-DD')
  const [ano, mes, dia] = iso ? [iso[1]!, iso[2]!, iso[3]!] : [br![3]!, br![2]!, br![1]!]
  const d = new Date(Date.UTC(Number(ano), Number(mes) - 1, Number(dia)))
  if (d.getUTCMonth() !== Number(mes) - 1 || d.getUTCDate() !== Number(dia) || Number(ano) < 1900) {
    throw new ErroEquipe('nascimento não é uma data válida')
  }
  return `${ano}-${mes}-${dia}`
}

/** Valida o que veio do painel ou da planilha. O LID nunca vem daqui: só o WhatsApp o informa. */
export function validarFuncionario(e: EntradaFuncionario, o: { telefoneObrigatorio: boolean; lid: string | null }): DadosFuncionario {
  const nome = (e.nome ?? '').trim().replace(/\s+/g, ' ')
  if (!/\p{L}{2,}/u.test(nome) || nome.length > 80) throw new ErroEquipe('nome é obrigatório (até 80 caracteres)')
  const bruto = (e.telefone ?? '').trim()
  const telefone = bruto ? telefoneCanonico(bruto) : null
  if (bruto && !telefone) throw new ErroEquipe(`telefone "${bruto}" não parece um número brasileiro com DDD`)
  if (!telefone && o.telefoneObrigatorio) throw new ErroEquipe('telefone é obrigatório')
  return {
    nome,
    telefone,
    lid: o.lid,
    setor: opcional(e.setor, 'setor'),
    loja: opcional(e.loja, 'loja'),
    cargo: opcional(e.cargo, 'cargo'),
    nascimento: dataNascimento(e.nascimento),
    ativo: e.ativo ?? true
  }
}

/** Uma linha de CSV com ";" e aspas opcionais ("a;b" fica inteiro, "" dentro de aspas vira "). */
export function dividirLinhaCsv(linha: string, separador = ';'): string[] {
  const campos: string[] = []
  let atual = ''
  let aspas = false
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i]!
    if (aspas) {
      if (c === '"' && linha[i + 1] === '"') {
        atual += '"'
        i++
      } else if (c === '"') aspas = false
      else atual += c
    } else if (c === '"') aspas = true
    else if (c === separador) {
      campos.push(atual)
      atual = ''
    } else atual += c
  }
  campos.push(atual)
  return campos.map((c) => c.trim())
}

export interface LinhaCsv {
  /** Número da linha no arquivo (1 = primeira). */
  linha: number
  dados: DadosFuncionario | null
  erro: string | null
}

/** Planilha: nome;telefone;setor;loja;cargo;nascimento (cabeçalho opcional; colunas a mais são ignoradas). */
export function lerCsvEquipe(texto: string): LinhaCsv[] {
  const linhas = texto.replace(/^﻿/, '').split(/\r?\n/)
  if (linhas.filter((l) => l.trim()).length > MAX_LINHAS_CSV + 1) {
    throw new ErroEquipe(`a planilha passa de ${MAX_LINHAS_CSV} linhas; divida em partes`)
  }
  const resultado: LinhaCsv[] = []
  const vistos = new Map<string, number>()
  linhas.forEach((bruta, i) => {
    if (!bruta.trim()) return
    const [nome, telefone, setor, loja, cargo, nascimento] = dividirLinhaCsv(bruta)
    if (i === 0 && semAcento(nome ?? '') === 'nome') return
    const n = i + 1
    try {
      const dados = validarFuncionario({ nome, telefone, setor, loja, cargo, nascimento }, { telefoneObrigatorio: true, lid: null })
      const antes = vistos.get(dados.telefone!)
      if (antes) throw new ErroEquipe(`telefone repetido (já está na linha ${antes})`)
      vistos.set(dados.telefone!, n)
      resultado.push({ linha: n, dados, erro: null })
    } catch (e) {
      if (!(e instanceof ErroEquipe)) throw e
      resultado.push({ linha: n, dados: null, erro: e.message })
    }
  })
  return resultado
}
```

`src/painel/exportar.ts` — add (import `type Funcionario` from `'../db/grupos.js'`):

```ts
/** Equipe no mesmo formato que a importação lê, com gestor e situação no fim. */
export function gerarCsvEquipe(funcionarios: Funcionario[], gestores: Set<number>): string {
  const cabecalho = ['nome', 'telefone', 'setor', 'loja', 'cargo', 'nascimento', 'gestor', 'ativo']
  const linhas = funcionarios.map((f) =>
    [f.nome, f.telefone ?? '', f.setor ?? '', f.loja ?? '', f.cargo ?? '', f.nascimento ?? '', gestores.has(f.id) ? 'sim' : 'não', f.ativo ? 'sim' : 'não']
      .map(celula)
      .join(';')
  )
  return '﻿' + [cabecalho.map(celula).join(';'), ...linhas].join('\r\n') + '\r\n'
}
```

Create `src/painel/paginas-equipe.ts`:

```ts
import type { Funcionario, Grupo } from '../db/grupos.js'
import type { Numero } from '../db/numeros.js'
import type { LinhaCsv } from '../grupos/equipe.js'
import { formatarTelefone } from '../grupos/pessoas.js'
import { esc, layout } from './paginas.js'

const aviso = (t: string | null) => (t ? `<div class="cartao ok">${esc(t)}</div>` : '')
const falha = (t: string | null) => (t ? `<div class="cartao erro">${esc(t)}</div>` : '')
const tel = (t: string | null) => (t ? formatarTelefone(t) : '—')

export function paginaGrupos(blocos: { numero: Numero; grupos: Grupo[] }[], usuario: string, msg: string | null): string {
  const corpo =
    blocos.length === 0
      ? '<div class="cartao"><p>Nenhum número de grupos ainda. Adicione um em <a href="/numeros">Números</a> com o uso "Grupos".</p></div>'
      : blocos
          .map(({ numero: n, grupos }) => {
            const linhas = grupos
              .map(
                (g) => `<tr${g.ativo ? '' : ' class="suave"'}><td><strong>${esc(g.nome)}</strong>${g.ativo ? '' : '<br>o bot saiu deste grupo'}</td>
                <td>${g.botAdmin ? '<span class="ok">sim</span>' : '<span class="alerta">não</span>'}</td>
                <td><form method="post" action="/grupos/etiquetar" style="display:flex;gap:6px;flex-wrap:wrap">
                  <input type="hidden" name="numero_id" value="${n.id}"><input type="hidden" name="jid" value="${esc(g.jid)}">
                  <input name="setor" value="${esc(g.setor ?? '')}" placeholder="Setor" maxlength="60" style="flex:1 1 120px">
                  <input name="loja" value="${esc(g.loja ?? '')}" placeholder="Loja" maxlength="60" style="flex:1 1 120px">
                  <button>Salvar</button></form></td></tr>`
              )
              .join('')
            return `<div class="cartao"><h2 style="margin-top:0">${esc(n.nome)}${n.ativo ? '' : ' <span class="suave">(desativado)</span>'}</h2>
              <table><thead><tr><th>Grupo</th><th>Bot é admin?</th><th>Setor e loja</th></tr></thead><tbody>
              ${linhas || '<tr><td colspan="3" class="suave">O bot ainda não está em nenhum grupo. Adicione este número aos grupos pelo celular.</td></tr>'}
              </tbody></table></div>`
          })
          .join('')
  return layout(
    'Grupos',
    `<h1>Grupos</h1>${aviso(msg)}<p class="suave">Setor e loja servirão para mandar avisos por setor. Para apagar mensagens e fixar avisos, o bot precisa ser admin do grupo.</p>${corpo}`,
    usuario
  )
}

export function paginaEquipe(lista: Funcionario[], gestores: Set<number>, q: string, usuario: string, msg: string | null): string {
  const linhas = lista
    .map((f) => {
      const gestor = gestores.has(f.id)
      const botao = gestor
        ? '<button title="Tirar o poder de gestor">👔 gestor</button>'
        : `<button${f.ativo ? '' : ' disabled'}>Tornar gestor</button>`
      return `<tr${f.ativo ? '' : ' class="suave"'}>
        <td><a href="/equipe/${f.id}"><strong>${esc(f.nome)}</strong></a>${f.ativo ? '' : '<br>inativo'}</td>
        <td>${esc(tel(f.telefone))}${f.lid ? '' : '<br><span class="suave">ainda não visto no WhatsApp</span>'}</td>
        <td>${esc(f.setor ?? '')}</td><td>${esc(f.loja ?? '')}</td><td>${esc(f.cargo ?? '')}</td>
        <td><form method="post" action="/equipe/${f.id}/gestor"><input type="hidden" name="ativo" value="${gestor ? '0' : '1'}">${botao}</form></td></tr>`
    })
    .join('')
  return layout(
    'Equipe',
    `<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><h1>Equipe</h1>
      <span><a class="botao primario" href="/equipe/novo">+ Pessoa</a> <a class="botao" href="/equipe/importar">Importar CSV</a> <a class="botao" href="/equipe/exportar">Exportar CSV</a></span></div>
    ${aviso(msg)}
    <form method="get" action="/equipe" class="cartao" style="display:flex;gap:8px"><input name="q" value="${esc(q)}" placeholder="Buscar por nome, telefone, setor ou loja"><button>Buscar</button></form>
    <div class="cartao"><p class="suave">Gestores mandam comandos ao bot de grupos. Ser admin de um grupo no WhatsApp não dá poder no bot.</p>
    <table><thead><tr><th>Nome</th><th>Telefone</th><th>Setor</th><th>Loja</th><th>Cargo</th><th>Gestor</th></tr></thead>
    <tbody>${linhas || '<tr><td colspan="6" class="suave">Ninguém encontrado.</td></tr>'}</tbody></table></div>`,
    usuario
  )
}

export interface FormFuncionario {
  id: number | null
  nome: string
  telefone: string
  setor: string
  loja: string
  cargo: string
  nascimento: string
  ativo: boolean
  lid: string | null
}

export function paginaFuncionario(f: FormFuncionario, usuario: string, erro: string | null): string {
  const campo = (nome: 'nome' | 'telefone' | 'setor' | 'loja' | 'cargo' | 'nascimento', rotulo: string, extra = '') =>
    `<label>${rotulo}<input name="${nome}" value="${esc(f[nome])}" ${extra}></label>`
  const excluir = f.id
    ? `<form method="post" action="/equipe/${f.id}/excluir" onsubmit="return confirm('Excluir esta pessoa do cadastro? Não tem volta.')"><button class="perigo">Excluir do cadastro</button></form>`
    : ''
  return layout(
    f.id ? 'Editar pessoa' : 'Nova pessoa',
    `<p><a href="/equipe">← Equipe</a></p><h1>${f.id ? esc(f.nome) : 'Nova pessoa'}</h1>${falha(erro)}
    <form method="post" action="/equipe/salvar" class="cartao" style="display:grid;gap:12px;max-width:560px">
      <input type="hidden" name="id" value="${f.id ?? ''}">
      ${campo('nome', 'Nome', 'required maxlength="80"')}
      ${campo('telefone', 'Telefone com DDD', 'inputmode="tel" placeholder="(83) 99999-0000"')}
      ${campo('setor', 'Setor', 'maxlength="60"')}
      ${campo('loja', 'Loja', 'maxlength="60"')}
      ${campo('cargo', 'Cargo', 'maxlength="60"')}
      ${campo('nascimento', 'Nascimento', 'placeholder="DD/MM/AAAA"')}
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="ativo" value="1" style="width:auto"${f.ativo ? ' checked' : ''}> Ativo</label>
      ${f.lid ? '<p class="suave">Já identificado no WhatsApp.</p>' : ''}
      <div><button class="primario">Salvar</button></div>
    </form>${excluir}`,
    usuario
  )
}

export type LinhaPrevia = LinhaCsv & { situacao: 'novo' | 'atualiza' | 'erro' }

export function paginaImportar(usuario: string, csv: string, previa: LinhaPrevia[] | null, erro: string | null): string {
  const validas = previa?.filter((l) => l.dados).length ?? 0
  const tabela = previa
    ? `<div class="cartao"><p><strong>${validas}</strong> linha(s) prontas · <strong${previa.length - validas ? ' class="erro"' : ''}>${previa.length - validas}</strong> com erro (ficam de fora).</p>
      <table><thead><tr><th>Linha</th><th>Situação</th><th>Nome</th><th>Telefone</th><th>Setor</th><th>Loja</th><th>Cargo</th><th>Nascimento</th></tr></thead><tbody>
      ${previa
        .map((l) =>
          l.dados
            ? `<tr><td>${l.linha}</td><td>${l.situacao === 'novo' ? '<span class="ok">novo</span>' : 'atualiza'}</td><td>${esc(l.dados.nome)}</td><td>${esc(tel(l.dados.telefone))}</td><td>${esc(l.dados.setor ?? '')}</td><td>${esc(l.dados.loja ?? '')}</td><td>${esc(l.dados.cargo ?? '')}</td><td>${esc(l.dados.nascimento ?? '')}</td></tr>`
            : `<tr><td>${l.linha}</td><td class="erro" colspan="7">${esc(l.erro)}</td></tr>`
        )
        .join('')}</tbody></table>
      ${validas ? `<form method="post" action="/equipe/importar"><textarea name="csv" hidden>${esc(csv)}</textarea><input type="hidden" name="confirmar" value="1"><button class="primario">Importar ${validas} pessoa(s)</button></form>` : ''}</div>`
    : ''
  return layout(
    'Importar equipe',
    `<p><a href="/equipe">← Equipe</a></p><h1>Importar equipe (CSV)</h1>${falha(erro)}
    <div class="cartao"><p>Uma pessoa por linha, separando com ponto e vírgula: <code>nome;telefone;setor;loja;cargo;nascimento</code>. O cabeçalho é opcional; cargo e nascimento podem ficar vazios. Quem já está no cadastro (mesmo telefone) é atualizado.</p>
    <form method="post" action="/equipe/importar" style="display:grid;gap:8px">
      <input type="file" accept=".csv,text/csv,text/plain" id="arquivo">
      <textarea name="csv" id="csv" rows="10" placeholder="Ana Souza;83999990001;Vendas;Centro;Gerente;10/05/1990">${esc(csv)}</textarea>
      <div><button>Conferir</button></div>
    </form></div>${tabela}
    <script>document.getElementById('arquivo').addEventListener('change',function(e){var f=e.target.files[0];if(!f)return;var r=new FileReader();r.onload=function(){document.getElementById('csv').value=r.result;};r.readAsText(f,'utf-8');});</script>`,
    usuario
  )
}
```

Create `src/painel/rotas-equipe.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import { semAcento } from '../conversa/textos.js'
import type { DadosFuncionario } from '../db/grupos.js'
import { ErroEquipe, lerCsvEquipe, validarFuncionario, type LinhaCsv } from '../grupos/equipe.js'
import { gerarCsvEquipe } from './exportar.js'
import { paginaEquipe, paginaFuncionario, paginaGrupos, paginaImportar, type FormFuncionario, type LinhaPrevia } from './paginas-equipe.js'
import type { Ajudantes } from './rotas-numeros.js'
import type { DependenciasPainel } from './servidor.js'

interface CorpoFuncionario {
  id?: string
  nome?: string
  telefone?: string
  setor?: string
  loja?: string
  cargo?: string
  nascimento?: string
  ativo?: string
}

export function rotasEquipe(app: FastifyInstance, d: DependenciasPainel, a: Ajudantes): void {
  const g = d.grupos
  const porId = (id: string) => (/^\d+$/.test(id) ? g.funcionario(Number(id)) : null)

  app.get<{ Querystring: { salvo?: string } }>('/grupos', async (req, rep) => {
    const todos = g.todosGrupos()
    const blocos = d.numeros
      .listar()
      .filter((n) => n.papel === 'grupos')
      .map((numero) => ({ numero, grupos: todos.filter((x) => x.numeroId === numero.id) }))
    return a.html(rep, paginaGrupos(blocos, a.usuario(req), req.query.salvo ? 'Etiquetas salvas.' : null))
  })

  app.post<{ Body: { numero_id?: string; jid?: string; setor?: string; loja?: string } }>('/grupos/etiquetar', async (req, rep) => {
    const numeroId = Number(req.body?.numero_id)
    const jid = req.body?.jid ?? ''
    const limpar = (v?: string) => (v ?? '').trim().replace(/\s+/g, ' ').slice(0, 60) || null
    const setor = limpar(req.body?.setor)
    const loja = limpar(req.body?.loja)
    const ok = d.repo.transacao(() => {
      if (!g.etiquetarGrupo(numeroId, jid, setor, loja, a.agora())) return false
      d.repo.auditar(a.usuario(req), 'etiquetar_grupo', `${g.grupo(numeroId, jid)?.nome ?? jid}: ${setor ?? '—'} · ${loja ?? '—'}`, a.agora())
      return true
    })
    if (!ok) return rep.code(404).send('Grupo não encontrado')
    return rep.redirect('/grupos?salvo=1', 303)
  })

  app.get<{ Querystring: { q?: string; salvo?: string; excluido?: string; importados?: string } }>('/equipe', async (req, rep) => {
    const q = (req.query.q ?? '').trim()
    const termo = semAcento(q)
    const digitos = q.replace(/\D/g, '')
    const lista = g
      .funcionarios()
      .filter(
        (f) =>
          !q ||
          semAcento([f.nome, f.setor, f.loja, f.cargo].filter(Boolean).join(' ')).includes(termo) ||
          (digitos.length >= 4 && (f.telefone ?? '').includes(digitos))
      )
    const msg = req.query.salvo
      ? 'Cadastro salvo.'
      : req.query.excluido
        ? 'Pessoa excluída do cadastro.'
        : req.query.importados
          ? `${Number(req.query.importados)} pessoa(s) importada(s).`
          : null
    return a.html(rep, paginaEquipe(lista, new Set(g.gestores()), q, a.usuario(req), msg))
  })

  const vazio: FormFuncionario = { id: null, nome: '', telefone: '', setor: '', loja: '', cargo: '', nascimento: '', ativo: true, lid: null }

  app.get('/equipe/novo', async (req, rep) => a.html(rep, paginaFuncionario(vazio, a.usuario(req), null)))

  app.get('/equipe/importar', async (req, rep) => a.html(rep, paginaImportar(a.usuario(req), '', null, null)))

  app.get('/equipe/exportar', async (req, rep) => {
    const lista = g.funcionarios()
    d.repo.auditar(a.usuario(req), 'exportar_equipe', `${lista.length} pessoas`, a.agora())
    const dia = new Date(a.agora()).toISOString().slice(0, 10)
    return rep
      .type('text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="equipe-${dia}.csv"`)
      .send(gerarCsvEquipe(lista, new Set(g.gestores())))
  })

  app.get<{ Params: { id: string } }>('/equipe/:id', async (req, rep) => {
    const f = porId(req.params.id)
    if (!f) return rep.code(404).send('Pessoa não encontrada')
    const form: FormFuncionario = {
      id: f.id,
      nome: f.nome,
      telefone: f.telefone ?? '',
      setor: f.setor ?? '',
      loja: f.loja ?? '',
      cargo: f.cargo ?? '',
      nascimento: f.nascimento ?? '',
      ativo: f.ativo,
      lid: f.lid
    }
    return a.html(rep, paginaFuncionario(form, a.usuario(req), null))
  })

  app.post<{ Body: CorpoFuncionario }>('/equipe/salvar', async (req, rep) => {
    const b = req.body ?? {}
    const id = b.id && /^\d+$/.test(b.id) ? Number(b.id) : null
    const atual = id ? g.funcionario(id) : null
    if (id && !atual) return rep.code(404).send('Pessoa não encontrada')
    const form: FormFuncionario = {
      id,
      nome: b.nome ?? '',
      telefone: b.telefone ?? '',
      setor: b.setor ?? '',
      loja: b.loja ?? '',
      cargo: b.cargo ?? '',
      nascimento: b.nascimento ?? '',
      ativo: b.ativo === '1',
      lid: atual?.lid ?? null
    }
    try {
      // Sem telefone só fica quem o WhatsApp já identificou pelo LID.
      const dados = validarFuncionario(
        { nome: form.nome, telefone: form.telefone, setor: form.setor, loja: form.loja, cargo: form.cargo, nascimento: form.nascimento, ativo: form.ativo },
        { telefoneObrigatorio: !atual?.lid, lid: atual?.lid ?? null }
      )
      const dono = dados.telefone ? g.porTelefone(dados.telefone) : null
      if (dono && dono.id !== id) throw new ErroEquipe(`esse telefone já é de ${dono.nome}`)
      d.repo.transacao(() => {
        const salvo = g.salvarFuncionario(id, dados, a.agora())
        d.repo.auditar(a.usuario(req), id ? 'editar_funcionario' : 'criar_funcionario', `${salvo} ${dados.nome}`, a.agora())
      })
      return rep.redirect('/equipe?salvo=1', 303)
    } catch (e) {
      if (!(e instanceof ErroEquipe)) throw e
      return a.html(rep.code(400), paginaFuncionario(form, a.usuario(req), e.message))
    }
  })

  app.post<{ Params: { id: string }; Body: { ativo?: string } }>('/equipe/:id/gestor', async (req, rep) => {
    const f = porId(req.params.id)
    if (!f) return rep.code(404).send('Pessoa não encontrada')
    const ativo = req.body?.ativo === '1'
    if (ativo && !f.ativo) return rep.code(409).send('Cadastro inativo não pode ser gestor.')
    d.repo.transacao(() => {
      if (ativo) g.adicionarGestor(f.id, `painel:${a.usuario(req)}`, a.agora())
      else g.removerGestor(f.id)
      d.repo.auditar(a.usuario(req), ativo ? 'gestor_adicionado' : 'gestor_removido', f.nome, a.agora())
    })
    return rep.redirect('/equipe', 303)
  })

  app.post<{ Params: { id: string } }>('/equipe/:id/excluir', async (req, rep) => {
    const f = porId(req.params.id)
    if (!f) return rep.code(404).send('Pessoa não encontrada')
    d.repo.transacao(() => {
      g.excluirFuncionario(f.id)
      d.repo.auditar(a.usuario(req), 'excluir_funcionario', f.nome, a.agora())
    })
    return rep.redirect('/equipe?excluido=1', 303)
  })

  app.post<{ Body: { csv?: string; confirmar?: string } }>('/equipe/importar', async (req, rep) => {
    const csv = req.body?.csv ?? ''
    let linhas: LinhaCsv[]
    try {
      linhas = lerCsvEquipe(csv)
    } catch (e) {
      if (!(e instanceof ErroEquipe)) throw e
      return a.html(rep.code(400), paginaImportar(a.usuario(req), csv, null, e.message))
    }
    if (req.body?.confirmar !== '1') {
      const previa: LinhaPrevia[] = linhas.map((l) => ({
        ...l,
        situacao: !l.dados ? 'erro' : g.porTelefone(l.dados.telefone!) ? 'atualiza' : 'novo'
      }))
      return a.html(rep, paginaImportar(a.usuario(req), csv, previa, linhas.length ? null : 'Nenhuma linha encontrada.'))
    }
    const validas = linhas.filter((l): l is LinhaCsv & { dados: DadosFuncionario } => !!l.dados)
    d.repo.transacao(() => {
      for (const { dados } of validas) {
        const atual = g.porTelefone(dados.telefone!)
        // LID e situação vêm do que já existe: a planilha não sabe deles.
        g.salvarFuncionario(atual?.id ?? null, { ...dados, lid: atual?.lid ?? null, ativo: atual?.ativo ?? true }, a.agora())
      }
      d.repo.auditar(a.usuario(req), 'importar_equipe', `${validas.length} pessoas (${linhas.length - validas.length} linhas com erro)`, a.agora())
    })
    return rep.redirect(`/equipe?importados=${validas.length}`, 303)
  })
}
```

`src/painel/servidor.ts`: `import type { RepoGrupos } from '../db/grupos.js'`, `import { rotasEquipe } from './rotas-equipe.js'`; add `grupos: RepoGrupos` to `DependenciasPainel` (after `numeros`); before `return app`: `rotasEquipe(app, d, { html, usuario, agora })`.

`src/painel/paginas.ts` nav: `<a href="/">Bots</a><a href="/numeros">Números</a><a href="/grupos">Grupos</a><a href="/equipe">Equipe</a><a href="/saude">Saúde</a><a href="/auditoria">Auditoria</a>`.

`src/main.ts`: pass `grupos: new RepoGrupos(db)` to `criarPainel` (Task 14 replaces the wiring).

- [ ] **Step 4: Run** `npx vitest run tests/equipe.test.ts tests/painel.test.ts` → PASS; `npm test`; `npm run typecheck` → PASS.

- [ ] **Step 5: Commit** — `git add src tests && git commit -m "feat: painel de grupos e equipe, com importação e exportação CSV"` (+ attribution).

---

### Task 14: Wire everything in `main.ts`

**Files:**
- Modify: `src/main.ts` (full replacement)

- [ ] **Step 1: Replace `src/main.ts`** with:

```ts
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import pino from 'pino'
import { lerAmbiente } from './ambiente.js'
import { ArmazemArquivos } from './arquivos.js'
import { FonteBots } from './config/bots.js'
import { lerPadrao, lerYamlProcessos } from './config/carregar.js'
import { Orquestrador } from './conversa/orquestrador.js'
import { abrirBanco } from './db/banco.js'
import { RepoGrupos } from './db/grupos.js'
import { RepoNumeros } from './db/numeros.js'
import { Repositorio } from './db/repositorio.js'
import { ExpedidorGrupos } from './grupos/expedidor.js'
import { OrquestradorGrupos } from './grupos/orquestrador.js'
import { criarPainel } from './painel/servidor.js'
import { Alertas, VigiaConexao } from './rotinas/alerta.js'
import { apagarBackupsAntigos, fazerBackup } from './rotinas/backup.js'
import { aplicarRetencao } from './rotinas/retencao.js'
import { ConexaoBaileys } from './whatsapp/baileys.js'
import { Expedidor } from './whatsapp/expedidor.js'
import { GerenciadorConexoes, moverSessaoAntiga, pastaSessaoNumero } from './whatsapp/gerenciador.js'

const amb = lerAmbiente()
// Logs nunca levam conteúdo de mensagem nem dados de candidato ou funcionário: só IDs.
const log = pino({ level: amb.logNivel, base: undefined })

await mkdir(amb.dados, { recursive: true, mode: 0o700 })
const db = abrirBanco(join(amb.dados, 'banco.sqlite'))
const repo = new Repositorio(db)
const numeros = new RepoNumeros(db)
const grupos = new RepoGrupos(db)
const armazem = new ArmazemArquivos(amb.dados)
// Só depois da migração do banco: a sessão de antes vira a do número 1.
if (await moverSessaoAntiga(amb.dados)) log.info('sessão do WhatsApp movida para sessoes/1')

// Bots ficam no banco e são editados pelo painel. Os YAML antigos só entram na primeira subida.
const config = new FonteBots(repo, lerPadrao(amb.config), amb.empresa)
const importacao = config.importarYaml(lerYamlProcessos(amb.config), Date.now())
if (importacao.importados.length) log.info({ bots: importacao.importados }, 'bots importados dos arquivos YAML')
for (const e of [...importacao.erros, ...config.get().erros]) log.error(`bot com erro: ${e}`)

const alertas = new Alertas({ smtpUrl: amb.smtpUrl, de: amb.alertaDe, para: amb.alertaPara }, log)
const vigias = new Map<number, VigiaConexao>()

function conexaoAtiva(numeroId: number): ConexaoBaileys {
  const c = gerenciador.conexao(numeroId)
  if (!c) throw new Error(`número ${numeroId} desativado`)
  return c
}

const orquestrador = new Orquestrador({
  repo,
  config: () => config.get(),
  baixarMidia: (numeroId, bruto) => conexaoAtiva(numeroId).baixarMidia(bruto),
  armazem,
  log,
  aoEnfileirar: (numeroId) => gerenciador.acordar(numeroId)
})

const orquestradorGrupos = new OrquestradorGrupos({
  repo,
  grupos,
  conexao: (numeroId) => gerenciador.conexao(numeroId),
  log,
  conectadoDesde: (numeroId) => {
    const e = gerenciador.estado(numeroId)
    return e?.status === 'conectado' ? e.desde : null
  },
  aoEnfileirar: (numeroId) => gerenciador.acordar(numeroId)
})

const gerenciador: GerenciadorConexoes<ConexaoBaileys> = new GerenciadorConexoes((n) => {
  const vigia = new VigiaConexao(alertas, Date.now, n.nome)
  vigias.set(n.id, vigia)
  const conexao = new ConexaoBaileys({
    numeroId: n.id,
    papel: n.papel,
    pastaSessao: pastaSessaoNumero(amb.dados, n.id),
    repo,
    log: log.child({ numero: n.id }),
    janelaMs: amb.janelaMs,
    aoReceber: (m) => orquestrador.receber(m),
    aoComando: (m) => orquestradorGrupos.receber(m),
    aoEventoGrupos: (e) => orquestradorGrupos.eventoGrupos(n.id, e),
    aoMudarEstado: (e) => {
      vigia.verificar(e)
      if (e.status === 'conectado') gerenciador.acordar(n.id)
    }
  })
  const expedidor =
    n.papel === 'grupos'
      ? new ExpedidorGrupos({ numeroId: n.id, grupos, conexao, log })
      : new Expedidor({ numeroId: n.id, repo, conexao, log, janelaMs: amb.janelaMs })
  return { conexao, expedidor }
}, log)

orquestrador.retomarPendentes()
await gerenciador.iniciarTodos(numeros.listar())

const timers: NodeJS.Timeout[] = [
  setInterval(() => orquestrador.verificarFinalizacoes(), 5_000),
  setInterval(() => orquestrador.retomarPendentes(), 60_000),
  setInterval(() => {
    for (const [id, estado] of gerenciador.estados()) vigias.get(id)?.verificar(estado)
  }, 60_000),
  setInterval(() => void rotinaDiaria(), 10 * 60_000)
]

/** Uma vez por dia, a partir das 3h (Brasília): retenção, limpeza e backup. */
async function rotinaDiaria(): Promise<void> {
  const agora = Date.now()
  const local = new Date(agora - 3 * 60 * 60 * 1000)
  const hoje = local.toISOString().slice(0, 10)
  if (local.getUTCHours() < 3 || repo.meta('rotina_diaria') === hoje) return
  repo.definirMeta('rotina_diaria', hoje)
  try {
    await aplicarRetencao({ repo, config: config.get(), armazem, log, agora })
  } catch (err) {
    log.error({ err }, 'falha na retenção')
  }
  if (!amb.backupSenha) return
  try {
    const arquivo = await fazerBackup({ db, dados: amb.dados, senha: amb.backupSenha, agora })
    await apagarBackupsAntigos(amb.dados, amb.backupRetencaoDias, agora)
    repo.definirMeta('ultimo_backup', new Date(agora).toISOString())
    log.info({ arquivo }, 'backup concluído')
  } catch (err) {
    log.error({ err }, 'falha no backup')
    void alertas.enviar('Falha no backup diário', String((err as Error).message))
  }
}

const painel = await criarPainel({
  repo,
  numeros,
  grupos,
  bots: config,
  armazem,
  conexoes: {
    estado: (id) => gerenciador.estado(id),
    novaSessao: (id) => gerenciador.novaSessao(id),
    ativar: (n) => gerenciador.adicionar(n),
    desativar: async (id) => {
      await gerenciador.parar(id)
      vigias.delete(id)
    }
  },
  usuarios: amb.painelUsuarios,
  segredo: amb.painelSegredo,
  cookieSeguro: amb.cookieSeguro,
  backupAtivo: !!amb.backupSenha,
  alertaAtivo: alertas.ativo
})
await painel.listen({ host: amb.painelHost, port: amb.painelPorta })
log.info({ host: amb.painelHost, porta: amb.painelPorta }, 'painel no ar')

let desligando = false
async function desligar(sinal: string): Promise<void> {
  if (desligando) return
  desligando = true
  log.info({ sinal }, 'desligando')
  for (const t of timers) clearInterval(t)
  await painel.close()
  await orquestrador.ocioso()
  await orquestradorGrupos.ocioso()
  await gerenciador.pararTodos()
  db.close()
  process.exit(0)
}
process.on('SIGINT', () => void desligar('SIGINT'))
process.on('SIGTERM', () => void desligar('SIGTERM'))
```

Notes for the implementer: the closures reference `gerenciador` before its `const` line, which is fine because they only run after it is initialized (`retomarPendentes` and `iniciarTodos` come after). `ConexaoBaileys` must satisfy `ConexaoGerida` (`estadoAtual` getter, `iniciar`, `parar`, `novaSessao`) — it already does.

- [ ] **Step 2: Verify** `npm run typecheck` → PASS; `npm test` → PASS; `npm run build` → PASS.

- [ ] **Step 3: Smoke run** (no WhatsApp pairing needed): with a `.env` present (see `.env.example`; if none exists, create one in the scratchpad with `PAINEL_SEGREDO` of 40 chars and a `PAINEL_USUARIOS` line from `npm run senha`), point `DADOS_DIR` to a fresh temp folder and run `npx tsx --env-file=<that .env> src/main.ts` for ~10 s in the background; expect the log line `painel no ar` and no exceptions; then `curl -s http://127.0.0.1:3100/healthz` → `{"ok":false}` (not paired). Stop the process. Do not use the real `data/` folder.

- [ ] **Step 4: Commit** — `git add src/main.ts && git commit -m "feat: main liga vários números, bot de grupos e painel"` (+ attribution).

---

### Task 15: Docs, screenshots script, final verification

**Files:**
- Modify: `README.md`, `README.pt-BR.md`, `CHANGELOG.md`, `scripts/gerar-capturas.ts`, `CONTRIBUTING.md`

- [ ] **Step 1: `scripts/gerar-capturas.ts`** — it calls removed/changed functions. Change:
  - import `paginaNumero` from `'../src/painel/paginas-numeros.js'` instead of `paginaConexao`; build the page with
    `paginaNumero({ id: 1, nome: 'Principal', papel: 'recrutamento', ativo: true, criadoEm: agora }, { status: 'aguardando_qr', qr: 'x', desde: agora, numero: null, motivo: null }, qr, 'rh')` and keep the `.replace('<meta http-equiv="refresh" content="5">', '')`.
  - `paginaProcessos(config, resumo, [{ id: 1, nome: 'Principal', telefone: numero }], 'rh', agora, null)`
  - `paginaEditorBot({ dados: vendas, padrao, original: 'VEND-OUT26', candidaturas: 4, erro: null, usuario: 'rh', numeros: [{ id: 1, nome: 'Principal' }] })`; if `vendas` is built without `numero_id`, add `numero_id: 1`.
  - `paginaSaude({ numeros: [{ numero: { id: 1, nome: 'Principal', papel: 'recrutamento', ativo: true, criadoEm: agora }, estado: { status: 'conectado', qr: null, desde: agora - 86400_000, numero, motivo: null }, ultimaMensagem: agora - 600_000 }], filas: ..., ultimoBackup: ..., backupAtivo: true, alertaAtivo: true, config }, 'rh')`
  - run `npx tsx scripts/gerar-capturas.ts` → it must finish printing `páginas em ...` (it only writes HTML; PNGs are optional and not regenerated here).

- [ ] **Step 2: `README.md`** — in `## Features`, add bullets:

```markdown
- **Several WhatsApp numbers in one process.** Each number has one role: *recruitment* (candidates) or *groups* (company groups). A ban on one never touches the other.
- **Group bot core.** Team registry (with CSV import/export), managers, and WhatsApp commands: `/menu`, `/gestores`, `/quem`, `/cadastrar`, `/setores`, `/desconhecidos`, `/grupos`, `/gestor add|remover`, `/status`, `/log`. Only registered managers can run management commands; being a WhatsApp group admin grants nothing. Plain group chat is never stored.
```

  In `## Quick start`, replace "go to **Conexão** and scan the QR code" with "go to **Números**, open *Principal* and scan the QR code"; add after that paragraph:

```markdown
To add the group bot: **Números → + Número** with role *Grupos*, scan the QR with that phone, add the number to your groups, then register people in **Equipe** (or import a CSV) and mark at least one manager. Managers send `/menu` to the bot in private to see what they can do.
```

  In `## Configuration`, add: `Sessions live in data/sessoes/<number id>/. An existing data/sessao/ from 1.0 is moved to data/sessoes/1/ on the first start, no re-pairing needed.`

- [ ] **Step 3: `README.pt-BR.md`** — in `## Operação`, replace the two *Conexão* bullets with:

```markdown
- **Números:** painel → *Números*. Cada número tem um uso só: *Recrutamento* (candidatos) ou *Grupos* (grupos da empresa). Para conectar: abrir o número → no celular dele, *Aparelhos conectados* → *Conectar aparelho* → ler o QR.
- **Se o celular desconectar o aparelho** (logout): o bot para aquele número, avisa por e-mail dizendo qual, e a página do número oferece "Gerar novo QR". A sessão antiga é copiada para `data/sessoes/<id>-antiga-*` antes.
- **Bot de grupos:** cadastre a equipe em *Equipe* (ou importe um CSV `nome;telefone;setor;loja;cargo;nascimento`), marque pelo menos um gestor e adicione o número de grupos aos grupos. Comandos: `/menu`. Só gestores cadastrados mandam comandos de gestão; ser admin do grupo no WhatsApp não dá poder no bot. Conversa comum dos grupos nunca é gravada.
```

  and in `### Atualizar o Baileys` step 1: `Copie data/sessoes/ (a migração para LID não tem volta).`

- [ ] **Step 4: `CHANGELOG.md`** — add above `## 1.0.0`:

```markdown
## Unreleased

- Vários números de WhatsApp no mesmo processo, cada um com um uso (recrutamento ou grupos). Página **Números** substitui **Conexão**; `/healthz` só responde ok com todos os números ativos conectados; `/saude` mostra cada número; alertas dizem qual número caiu.
- Cada bot de recrutamento escolhe o seu número. Conversas, filas e candidaturas ficam separadas por número.
- Bot de grupos (núcleo): cadastro da equipe com importação/exportação CSV, gestores, grupos com setor e loja, e os comandos `/menu`, `/gestores`, `/quem`, `/cadastrar`, `/setores`, `/desconhecidos`, `/grupos`, `/gestor`, `/status`, `/log`. Toda ação de gestão é auditada.
- Atualização: o banco migra sozinho (tudo vai para o número 1) e `data/sessao` vira `data/sessoes/1` sem ler o QR de novo. O backup passa a incluir `data/sessoes/`.
```

- [ ] **Step 5: `CONTRIBUTING.md`** — in *Ground rules*, after the engine rule, add:

```markdown
- **Group bot rules live in `src/grupos/motor.ts` and stay pure** (same contract as the recruitment engine). New commands go in the `COMANDOS` table in `src/grupos/comandos.ts` first; the compiler then forces a rule in the engine. Tests in `tests/motor-grupos.test.ts`, storage in `tests/orquestrador-grupos.test.ts`.
- **Plain group chat never leaves the adapter.** Only messages that start with `/` reach the orchestrator.
```

  and change "Only `src/whatsapp/baileys.ts` imports Baileys" to "Only files in `src/whatsapp/` import Baileys".

- [ ] **Step 6: Final verification** — run and read the output of each:
  - `npm run typecheck` → no errors
  - `npm test` → all green (report the count)
  - `npm run build` → no errors
  - `git status` → only intended files changed

- [ ] **Step 7: Commit** — `git add README.md README.pt-BR.md CHANGELOG.md CONTRIBUTING.md scripts && git commit -m "docs: vários números e bot de grupos"` (+ attribution).

- [ ] **Step 8: Manual check before merging (needs the user; not automatable)** — with two real chips: pair both on a staging copy, run the recruitment flow on number 1, and on number 2 (role *Grupos*) send `/menu` in private as a registered manager, `/cadastrar @someone ...` in a group, `/gestores`, and confirm a plain group message leaves no row in `mensagens_processadas`.

---

## Self-review notes

- Spec coverage: numbers pool + roles (T1, T2, T10, T12), per-number recruitment (T3), session move (T10), `/healthz` and `/saude` (T12), alerts per number (T11), group registry/team/managers/outbox (T4), parser/engine/orchestrator/sender (T5–T8), LID resolution order participantAlt → lidMapping → `funcionarios.lid` (T7 + T9), group events + reconcile on connect (T7, T9), privacy (T9 drops non-commands in the adapter; T7 stores only the dedupe row), panel Grupos/Equipe/CSV (T13), "needs admin" check (T6, `precisaAdmin`), error handling (T7 fallback reply, T8 5 retries), migration test (T1, T4), two-number isolation test (T3), docs (T15).
- Out of scope, as in the spec: notices, scheduling, confirmations, admission/dismissal, moderation, deleting the command message.
