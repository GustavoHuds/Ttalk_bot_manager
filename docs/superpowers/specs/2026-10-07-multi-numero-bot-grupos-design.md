# Multi-number + group bot core — design

Date: 2026-10-07 · Status: approved in brainstorming, awaiting spec review

## Context

Today Ttalk runs **one** WhatsApp number (`ConexaoBaileys`, session in `data/sessao`) and every "bot" is a
recruitment opening (`processos` row) on that number. Message tables (`conversas`, `saida`,
`mensagens_processadas`, `enquetes`, `enviadas`) are keyed by contact `jid` only. Groups are dropped by
`jidIgnorado()`, and the `Expedidor` refuses to send to anyone who did not write within the window
(reply-only anti-ban rule).

The company wants a second kind of bot — a **group bot** for internal company groups (notices, schedules,
read confirmation, hiring/dismissal across groups, office hours, light moderation). That full feature list
is split into six sub-projects. **This spec covers only sub-project 1**: multiple numbers and the group bot
core. The others get their own spec later and build on this one.

| # | Sub-project | Status |
|---|---|---|
| **1** | **Multiple numbers + group bot core (registry, managers, commands, audit)** | **this spec** |
| 2 | Notices: hidetag, visible @, multi-group, by sector, attachments, pin/edit/delete | later |
| 3 | Scheduler: once/daily/weekly/monthly, event reminders, holidays | later |
| 4 | Confirmation (✅ reaction), follow-ups, polls, attendance lists | later |
| 5 | Admission/dismissal across groups, welcome, blocklist, join approval | later |
| 6 | Office hours, anti-link, warnings, group standardisation, rosters/checklists | later |

## Decisions (from brainstorming)

1. **Numbers are a pool.** The panel has a *Números* page; add a number, scan its QR. Each bot picks a number.
2. **One role per number:** `recrutamento` or `grupos`, never both. Keeps the anti-ban profiles separate and
   a ban on one number does not affect the other.
3. **Managers are an explicit list** kept by the bot. Being a WhatsApp group admin grants no bot power.
4. **Commands work in groups and in private chat.** Local commands inside the group; cross-group commands
   in private chat with the bot. (Deleting the command message in the group arrives in sub-project 2.)
5. **Panel for setup, WhatsApp for daily use.** Panel: numbers/QR, groups, team registry (with CSV import),
   managers, audit. Notices/schedules screens come with their sub-projects.
6. **Architecture A:** one process, N Baileys connections, one SQLite database.

## 1. Numbers and connections

### Data — migration 3

```sql
CREATE TABLE numeros (
  id INTEGER PRIMARY KEY,
  nome TEXT NOT NULL,
  papel TEXT NOT NULL CHECK (papel IN ('recrutamento', 'grupos')),
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em INTEGER NOT NULL
);
INSERT INTO numeros (id, nome, papel, ativo, criado_em) VALUES (1, 'Principal', 'recrutamento', 1, <now>);
```

- `numero_id INTEGER NOT NULL DEFAULT 1 REFERENCES numeros(id)` added to `processos`, `saida`,
  `mensagens_processadas`, `enquetes`, `enviadas`.
- `conversas` is rebuilt with primary key `(numero_id, jid)` (same person may talk to two numbers).
  Existing rows get `numero_id = 1`.
- Session folder: on startup, if `data/sessao` exists and `data/sessoes/1` does not, it is moved to
  `data/sessoes/1`. No re-pairing needed. New numbers use `data/sessoes/<id>`.
- A recruitment bot may only be assigned a number with `papel = 'recrutamento'` (validated in `config/bots.ts`).

### Runtime

- New `src/whatsapp/gerenciador.ts` — `GerenciadorConexoes`: `Map<numeroId, ConexaoBaileys>`.
  `iniciarTodos()`, `adicionar(numero)`, `parar(id)`, `novaSessao(id)`, `estado(id)`, `estados()`.
- `ConexaoBaileys` receives `numeroId` and `papel`. The role controls filtering:
  - `recrutamento`: unchanged (groups, broadcasts, newsletters ignored).
  - `grupos`: accepts `@g.us` messages and private messages; private messages from non-managers are ignored
    silently (decided in the group orchestrator, not the adapter).
- `MensagemRecebida` gains `numeroId`. The recruitment `Orquestrador` scopes every repo call by `numeroId`;
  its per-contact queue key becomes `${numeroId}:${jid}`.
- One `Expedidor` per recruitment number (rate limit and pacing are per number). Behaviour unchanged.
- `VigiaConexao` alerts per number (alert text names the number).

### Panel

- **Números** page replaces **Conexão**: list (name, role, status, phone, since), "+ Número" (name + role),
  QR view per number, "Nova sessão", activate/deactivate. All actions audited.
- Bot editor: "Número" dropdown (only `recrutamento` numbers).
- `/saude`: one block per number. `/healthz` stays data-free, `ok` only if every active number is connected.

## 2. Group bot core

New folder `src/grupos/`, same layering as `conversa/`: pure engine → orchestrator (transaction + outbox)
→ sender.

| Unit | Responsibility | Depends on |
|---|---|---|
| `grupos/comandos.ts` | Pure parser: text → `{ nome, args, mencionados, citada }`. Case/accent-insensitive, `/` prefix, `\|` separates fields. | nothing |
| `grupos/motor.ts` | Pure: `(contexto, comando) → Acao[]`. Contexto = sender identity, chat (group or private), is-manager, registry snapshot, groups snapshot, now. | `comandos.ts` types |
| `grupos/orquestrador.ts` | Dedupe inbox, resolve identity (LID→phone), build contexto, run engine, apply actions + enqueue replies in one transaction. | repo, motor |
| `grupos/expedidor.ts` | Drains the group outbox. No reply-window rule. ≥ 3 s between messages per chat, ≤ 10/min per number, "typing…" 1–2 s. Retries with backoff (same as `Expedidor`). | `ConexaoGrupos` |
| adapter | `ConexaoBaileys` implements `ConexaoGrupos`: `listarGrupos()` (`groupFetchAllParticipating`), `metadados(jid)`, `enviarTexto(jid, texto, mencoes?)`; emits `groups.upsert`, `groups.update`, `group-participants.update` to the orchestrator. | Baileys |

### Data — migration 4

```sql
CREATE TABLE grupos (
  numero_id INTEGER NOT NULL REFERENCES numeros(id),
  jid TEXT NOT NULL,
  nome TEXT NOT NULL,
  bot_admin INTEGER NOT NULL DEFAULT 0,
  setor TEXT, loja TEXT,
  ativo INTEGER NOT NULL DEFAULT 1,     -- 0 when the bot left / was removed
  atualizado_em INTEGER NOT NULL,
  PRIMARY KEY (numero_id, jid)
);
CREATE TABLE funcionarios (
  id INTEGER PRIMARY KEY,
  nome TEXT NOT NULL,
  telefone TEXT UNIQUE,                 -- 55 + DDD + number
  lid TEXT UNIQUE,
  setor TEXT, loja TEXT, cargo TEXT,
  nascimento TEXT,                      -- YYYY-MM-DD, optional
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em INTEGER NOT NULL, atualizado_em INTEGER NOT NULL
);
CREATE TABLE gestores (
  funcionario_id INTEGER PRIMARY KEY REFERENCES funcionarios(id) ON DELETE CASCADE,
  adicionado_por TEXT NOT NULL, adicionado_em INTEGER NOT NULL
);
CREATE TABLE saida_grupos (
  id INTEGER PRIMARY KEY,
  numero_id INTEGER NOT NULL REFERENCES numeros(id),
  jid TEXT NOT NULL,
  conteudo TEXT NOT NULL,               -- JSON: { tipo: 'texto', texto, mencoes? }
  criada_em INTEGER NOT NULL,
  tentativas INTEGER NOT NULL DEFAULT 0,
  proxima_em INTEGER NOT NULL DEFAULT 0
);
```

Group commands use the existing `mensagens_processadas` table (with `numero_id`) for dedupe. Audit entries
reuse `auditoria` with `usuario = 'wa:<telefone>'` (or `'wa:<lid>'` when unknown).

Managers are global (not per number): a manager can command any group number. The first manager is added
in the panel (no bootstrap via WhatsApp, so a stranger can't claim it).

### Commands in this delivery

| Command | Who | Where | Does |
|---|---|---|---|
| `/menu` | everyone | group, private | Lists the commands the sender may use |
| `/gestores` | everyone | group | Mentions the managers present in this group |
| `/quem @x` | everyone | group | Name, sector, store, role of a registered person |
| `/cadastrar @x Nome \| Setor \| Loja [\| Cargo]` | 👔 | group, private (`/cadastrar 5583999999999 ...`) | Creates/updates employee, links LID |
| `/setores` | 👔 | group, private | Sectors and stores with employee counts |
| `/desconhecidos` | 👔 | group | Members of this group not in the registry |
| `/grupos` | 👔 | private | Groups on this number, admin yes/no, sector/store |
| `/gestor add @x` · `/gestor remover @x` | 👔 | group, private | Manage the manager list (person must be registered) |
| `/status` | 👔 | group, private | Connected since, groups count, registry size |
| `/log [n]` | 👔 | private | Last n (default 10, max 30) audit entries |

Replies: errors and usage hints go to the same chat. An unknown command gets "não reconheço, veja /menu"
**only if the sender is a manager**; anyone else is ignored. A non-manager using a 👔 command is ignored
(no reply, nothing stored beyond the dedupe row), to avoid the bot being used to spam groups.

### Identity (LID)

In groups WhatsApp usually identifies participants by **LID**. Resolution order: phone from the message key
(`participantAlt`) → `lidMapping.getPNForLID` → `funcionarios.lid`. When a registered phone is matched to a
LID, the LID is saved on the employee. People who can't be resolved appear in `/desconhecidos` and are
linked with `/cadastrar @pessoa ...` (mention carries the LID).

### Group events

- `groups.upsert` / bot added to group → upsert `grupos`, refresh `bot_admin`.
- `groups.update`, `group-participants.update` (promote/demote of the bot, bot removed) → update
  `bot_admin` / `ativo`. Member join/leave handling (welcome, exit alerts, blocklist) is sub-project 5.
- On connect, `listarGrupos()` reconciles the table (groups no longer present → `ativo = 0`).

### Privacy

- Plain group chat is **never** stored or logged. Non-command messages are discarded in the adapter before
  reaching the database (no dedupe row either).
- Only commands (text), their result, and audit lines are stored. Logs carry IDs only, as today.
- Employee data falls under the existing backup and is exportable/deletable from the panel.

### Panel (setup)

- **Grupos**: per number, list groups with admin badge; edit sector/store tags.
- **Equipe**: list/search/edit employees; CSV import (`nome;telefone;setor;loja;cargo;nascimento`) with a
  preview and per-row errors; mark/unmark manager.
- All changes audited with the panel user.

## Error handling

- Group number disconnected: group outbox items stay queued; retried when connected, dropped after 5 failed
  attempts (same as recruitment), logged with IDs.
- Command sent while the bot is not admin and the command needs admin: reply "preciso ser admin deste grupo".
  (No such command exists in this delivery; the check is built in the engine for sub-projects 2+.)
- Message from a group not in `grupos` (e.g. event missed): fetch metadata once, upsert, continue.
- Migration failure: the existing migration runner is transactional; the session-folder move happens only
  after the DB migration commits, and is skipped if the target already exists.

## Testing

- `comandos.test.ts`: parsing (accents, case, `|`, mentions, quoted message, garbage).
- `motor-grupos.test.ts`: permissions per command, replies, unknown-command rule, private vs group.
- `orquestrador-grupos.test.ts`: fake `ConexaoGrupos`; dedupe, LID resolution, transaction + outbox,
  plain chat not stored.
- `expedidor-grupos.test.ts`: per-chat spacing, per-number limit, retries (fake clock, like `expedidor.test.ts`).
- `migracao.test.ts`: a v2 database with data upgrades to v4 with everything on `numero_id = 1`.
- Existing recruitment tests pass with `numeroId = 1`; one new test proves two recruitment numbers don't
  share conversation state.
- Panel tests for Números, Grupos, Equipe (CSV import errors), as in `painel.test.ts`.
- Manual check with two real chips before merging: pair both, recruitment flow on #1, commands on #2.

## Out of scope (later sub-projects)

Notices of any kind, scheduling, confirmations/polls, admission/dismissal/welcome/blocklist, office hours,
moderation, rosters, birthdays, deleting the command message in groups.
