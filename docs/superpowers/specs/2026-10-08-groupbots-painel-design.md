# Group bots as first-class bots + panel redesign (Grupos, Equipe, Bots) — design

Date: 2026-10-08 · Status: approved in brainstorming (user asked to proceed straight to implementation)

## Context

Sub-project 1 (`2026-10-07-multi-numero-bot-grupos-design.md`) shipped multiple numbers and the group bot
core. Running it for real exposed four problems:

1. **The bot answers in every group the number is in.** The pilot number is in 54 groups, most of them
   unrelated to the company. There is no way to say "act only in these groups".
2. **Managers can't be verified.** A manager is a registry row with a typed phone. In groups WhatsApp hides
   numbers (LID), so a wrong phone is never noticed, and the panel only says "ainda não visto no WhatsApp".
3. **Managers are global.** A second group bot would share the same managers.
4. **Group bots are invisible in "Bots".** A group bot is just a number with role `grupos`; its settings are
   scattered (Grupos page, Equipe page) and its commands are hard-coded.

## Decisions (from brainstorming)

| # | Decision |
|---|---|
| 1 | Manager confirmation by **code**: the panel issues a 6-digit code; the person sends `/confirmar <code>` to the bot in private. Only then do they get power. |
| 2 | **Managers are per group bot**, not global. |
| 3 | **Stores (lojas) are per group bot**: add/rename/remove on the bot page. An active group picks its store from that list. |
| 4 | **Team (Equipe) stays one registry.** A person's store is free text with suggestions from every bot's stores. |
| 5 | Commands screen per bot: **toggle built-ins, custom fixed-reply commands, and edit built-in reply texts**. |
| 6 | **A group bot is its own entity, separate from the number** (like recruitment bots). Changing the number keeps stores, commands, managers and active groups (group JIDs don't change with the number). One number serves at most one group bot. |
| 7 | Participants are **stored only for active groups**, kept in sync by WhatsApp events. Inactive groups store nothing. |
| 8 | Panel stays server-rendered HTML (Fastify + template strings), plain forms, small inline JS. No new dependency. |
| 9 | After the upgrade **no group is active**: the bot is silent until the admin activates groups. |
| 10 | Pending code expires in **48 h**. A pending manager has **no** power. |

## 1. Data — migration 5

```sql
CREATE TABLE bots_grupos (
  id INTEGER PRIMARY KEY,
  nome TEXT NOT NULL,
  numero_id INTEGER UNIQUE REFERENCES numeros (id),   -- NULL = no number yet
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em INTEGER NOT NULL
);
-- One bot per existing 'grupos' number, named after the number.
INSERT INTO bots_grupos (nome, numero_id, ativo, criado_em)
  SELECT nome, id, 1, criado_em FROM numeros WHERE papel = 'grupos';

CREATE TABLE lojas (
  id INTEGER PRIMARY KEY,
  bot_id INTEGER NOT NULL REFERENCES bots_grupos (id) ON DELETE CASCADE,
  nome TEXT NOT NULL COLLATE NOCASE,
  UNIQUE (bot_id, nome)
);

CREATE TABLE grupos_ativos (
  bot_id INTEGER NOT NULL REFERENCES bots_grupos (id) ON DELETE CASCADE,
  jid TEXT NOT NULL,
  loja_id INTEGER REFERENCES lojas (id) ON DELETE SET NULL,
  setor TEXT,
  ativado_em INTEGER NOT NULL,
  ativado_por TEXT NOT NULL,
  PRIMARY KEY (bot_id, jid)
);

CREATE TABLE participantes (
  bot_id INTEGER NOT NULL,
  grupo_jid TEXT NOT NULL,
  jid TEXT NOT NULL,
  telefone TEXT,
  lid TEXT,
  admin INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bot_id, grupo_jid, jid),
  FOREIGN KEY (bot_id, grupo_jid) REFERENCES grupos_ativos (bot_id, jid) ON DELETE CASCADE
);
CREATE INDEX participantes_telefone ON participantes (telefone);
CREATE INDEX participantes_lid ON participantes (lid);

-- Managers per bot, with confirmation.
CREATE TABLE gestores_bot (
  bot_id INTEGER NOT NULL REFERENCES bots_grupos (id) ON DELETE CASCADE,
  funcionario_id INTEGER NOT NULL REFERENCES funcionarios (id) ON DELETE CASCADE,
  codigo TEXT,                  -- 6 digits while pending; NULL once confirmed
  codigo_expira_em INTEGER,
  confirmado_em INTEGER,        -- NULL = pending, no power
  confirmado_jid TEXT,          -- which WhatsApp confirmed
  divergente_jid TEXT,          -- right code, but sent from a different WhatsApp than the registry
  divergente_telefone TEXT,
  divergente_em INTEGER,
  adicionado_por TEXT NOT NULL,
  adicionado_em INTEGER NOT NULL,
  PRIMARY KEY (bot_id, funcionario_id)
);
CREATE UNIQUE INDEX gestores_bot_codigo ON gestores_bot (bot_id, codigo) WHERE codigo IS NOT NULL;
-- Old global managers become pending on the first group bot (if any).
INSERT INTO gestores_bot (bot_id, funcionario_id, adicionado_por, adicionado_em)
  SELECT (SELECT MIN(id) FROM bots_grupos), funcionario_id, adicionado_por, adicionado_em
  FROM gestores WHERE (SELECT MIN(id) FROM bots_grupos) IS NOT NULL;
DROP TABLE gestores;

CREATE TABLE comandos_bot (
  bot_id INTEGER NOT NULL REFERENCES bots_grupos (id) ON DELETE CASCADE,
  nome TEXT NOT NULL,            -- built-in name or custom name, lower case, no accents
  ligado INTEGER NOT NULL DEFAULT 1,
  personalizado INTEGER NOT NULL DEFAULT 0,
  quem TEXT CHECK (quem IN ('todos', 'gestores')),          -- custom only
  onde TEXT CHECK (onde IN ('grupo', 'privado', 'ambos')),  -- custom only
  descricao TEXT,                -- custom only, shown in /menu
  resposta TEXT,                 -- custom only
  textos TEXT,                   -- built-in only: JSON {chave: texto} of edited replies
  PRIMARY KEY (bot_id, nome)
);

ALTER TABLE funcionarios ADD COLUMN confirmado_em INTEGER;   -- WhatsApp identity proven by a code
ALTER TABLE grupos DROP COLUMN setor;                         -- tags moved to grupos_ativos
ALTER TABLE grupos DROP COLUMN loja;
ALTER TABLE auditoria ADD COLUMN funcionario_id INTEGER;      -- person history on the Equipe page
CREATE INDEX auditoria_funcionario ON auditoria (funcionario_id) WHERE funcionario_id IS NOT NULL;
```

- `grupos` (per number) stays the **general list**: every group the number is in, kept by WhatsApp events.
- Built-in commands absent from `comandos_bot` are on, with original texts.
- Migration is transactional (existing runner). `migracao.test.ts` covers v4 → v5 with data.

## 2. Repositories

- `src/db/bots-grupos.ts` — `RepoBotsGrupos`: bots (list, get, by number, create, rename, set number,
  activate), stores (list, create, rename, delete, all store names for suggestions), active groups
  (list, get, activate, edit tags, deactivate), participants (replace for a group, add, remove, set admin,
  per person), managers (list with status, add pending with code, new code, confirm, record divergence,
  accept divergence, remove, confirmed ids), commands (list overrides, toggle, save texts, create/edit/delete
  custom).
- `src/db/grupos.ts` keeps general groups, team, inbox dedupe and outbox. Global manager methods are
  removed. `etiquetarGrupo` is removed. `funcionarios` gains `confirmado_em` in the `Funcionario` type.
- Codes: `crypto.randomInt(0, 1_000_000)` padded to 6 digits, unique among the bot's pending codes.

## 3. Runtime (WhatsApp side)

### Which bot handles a message

`OrquestradorGrupos` resolves `numeroId → bot` (`bots_grupos` where `numero_id = ? AND ativo = 1`).

- No bot for the number, or bot inactive → everything is ignored (no dedupe row).
- Group message from a group **not active** for that bot → ignored before any work (no dedupe row, nothing
  stored, no reply). This is checked in `receber()` before queuing.
- Private message → only confirmed managers of this bot are served, plus `/confirmar` from anyone.

### `/confirmar <código>` (new built-in, private, anyone, cannot be turned off)

1. Rate limit (in memory): per bot+sender 5 wrong codes/hour, per bot 30 wrong codes/hour. Over the limit →
   silence + `warn` log with IDs only.
2. Look up the pending, unexpired code in this bot. Not found → "Código inválido ou vencido. Peça um novo
   código a quem cadastrou você." (counts as wrong).
3. Found → compare the sender with the person's registry: match if sender phone == registry phone, or
   sender LID == registry LID. A registry with neither field set is impossible (phone required unless LID).
   - **Match** → confirm (`confirmado_em`, `confirmado_jid`, clear code), set `funcionarios.confirmado_em`,
     link LID/phone that were missing, audit `gestor_confirmado` with `funcionario_id`. Reply with the
     editable "confirmado" text.
   - **Mismatch** → store `divergente_*`, keep pending, audit `gestor_divergente`, reply "Recebido. Este
     WhatsApp é diferente do cadastro de {nome}; quem administra o painel precisa conferir." The panel shows
     the divergence with "Usar este número e confirmar" / "Descartar".

### Manager commands now per bot

- Context `gestores` = confirmed managers of this bot. `/gestor add @x` creates a **pending** manager with a
  code. In a group the reply says the person is pending and must send `/confirmar` in private; the code itself
  is sent **in private to the manager who asked** (one extra outbox item to their chat) with a `wa.me` link to
  forward. Never published in the group.
- `/gestor remover` removes confirmed or pending; "last manager" rule counts confirmed managers of this bot.
- `/grupos` lists the bot's **active** groups with store and admin badge. `/status` counts active groups.
- `/desconhecidos` and `/gestores` read the **stored participants** of the active group (no live fetch); if the
  group has no stored participants yet, fetch once, store, continue.

### Commands per bot

- Engine receives `comandos: ComandosDoBot` (built-in on/off, edited texts, custom commands).
- Off built-in → behaves like unknown (managers: "Este comando está desligado neste bot."; others: silence).
  `/menu` and `/confirmar` cannot be turned off.
- Custom commands: name 2–20 chars `[a-z0-9_]` after lower-case/accent removal, must not collide with built-in
  names or aliases (`ajuda`, `help`, `comandos`). Reply text 1–1000 chars. `quem` and `onde` like built-ins.
  Listed in `/menu`. Non-manager custom commands share the existing repeat throttle.
- Editable texts: each built-in declares its keys, default text and allowed placeholders (table below).
  Saving rejects unknown placeholders and empty texts mean "back to default".

| Command | Key → default (placeholders) |
|---|---|
| menu | `titulo` → `📖 Comandos` |
| gestores | `lista` → `👔 Gestores deste grupo: {lista}` · `vazio` → `Nenhum gestor cadastrado está neste grupo.` |
| quem | `nao_encontrado` → `Não encontrei essa pessoa no cadastro.` |
| cadastrar | `sucesso` → `✅ {nome} {acao}: {resumo}.` |
| setores | `titulo` → `📋 Setores e lojas — {total} pessoas` · `vazio` → `Ninguém cadastrado ainda.` |
| desconhecidos | `todos` → `✅ Todos os participantes deste grupo estão cadastrados.` · `titulo` → `❓ {total} sem cadastro:` · `rodape` → `Cadastre com /cadastrar @pessoa Nome \| Setor \| Loja` |
| grupos | `titulo` → `👥 Grupos ativos ({total})` · `vazio` → `Nenhum grupo ativo neste bot.` |
| gestor | `pendente` → `⏳ {nome} foi indicado(a) como gestor(a). Para ativar, {nome} deve mandar /confirmar no meu privado.` · `removido` → `{nome} não é mais gestor(a).` |
| status | `resumo` → `🤖 {conexao} · {grupos} grupos ativos · {pessoas} pessoas cadastradas ({gestores} gestores)` |
| log | `titulo` → `📜 Últimas ações` |
| confirmar | `confirmado` → `✅ Pronto, {nome}! Você agora é gestor(a) do {bot}.` · `invalido` → `Código inválido ou vencido. Peça um novo código a quem cadastrou você.` |

### Participants sync (active groups only)

- On activation (panel) and on connect (`lista` event) for each active group of the bot's number: fetch
  metadata (sequential, one at a time), replace stored participants.
- `group-participants.update` on an active group: add/remove/promote/demote rows. Today the adapter only
  forwards events that involve the bot itself; it now forwards every participant change as
  `{ tipo: 'participantes', jid, acao, membros }`, and the orchestrator drops it unless the group is active.
- LID → phone is resolved like commands do (`completar`). Phones stored only when WhatsApp gives them.
- Deactivating a group deletes its participants (FK cascade). Participant rows hold no names or messages.

## 4. Panel

Navigation stays: **Bots · Números · Grupos · Equipe · Saúde · Auditoria**. Números is unchanged.

### Bots (`/`)

Two sections:

1. **Bots de recrutamento** — unchanged table.
2. **Bots de grupos** — table: name, number (name + status badge, or "sem número"), active groups, managers
   (`2 ✅ · 1 ⏳`), commands (`9 ligados · 2 personalizados`), `Abrir`. Button `+ Bot de grupos`.

### Group bot page (`/grupos-bot/:id`, tabs as sub-pages)

- **Geral** (`/grupos-bot/:id`): name, number (select of `grupos` numbers not used by another bot, plus
  "sem número"), active on/off, connection status of the number, summary cards (active groups, stores,
  managers, commands). Changing the number warns that active groups the new number is not in will show a
  warning on Grupos. Delete bot (confirm; only when it has no active groups).
- **Lojas** (`/grupos-bot/:id/lojas`): list with the count of active groups per store; add, rename (rename
  also updates `funcionarios.loja` rows with the exact old name, in the same transaction), remove (groups
  keep working with no store).
- **Gestores** (`/grupos-bot/:id/gestores`): confirmed and pending managers. Add: search the team (name or
  phone) and pick a person → pending with code. Pending row shows the code, expiry, a `wa.me/<bot number>?
  text=/confirmar%20<code>` link with a copy button, "Gerar novo código", "Remover". Divergence row shows the
  phone it came from with "Usar este número e confirmar" (updates the registry phone/LID and confirms) and
  "Descartar".
- **Comandos** (`/grupos-bot/:id/comandos`): built-ins table (name, who, where, usage, example, on/off
  toggle, "Editar textos" when it has texts). Edit texts page per command: each key with default shown,
  allowed placeholders listed, "voltar ao original". Custom commands: list + form (name, description, who,
  where, reply) + edit/delete.

### Grupos (`/grupos`)

Per group bot (selector when there is more than one; `?bot=<id>`):

1. **Grupos ativos** — name, store, sector, bot admin badge, participants (`12 · 3 sem cadastro`), warnings
   ("o número saiu deste grupo" / "o número atual não está neste grupo"), `Editar` (store select + sector),
   `Desativar` (confirm).
2. **Todos os grupos do número** — the general list with a search box (client-side filter), sorted by name,
   showing name, admin badge, `Ativar`. `Ativar` opens `/grupos/ativar?bot=&jid=` with store select (from the
   bot's stores, link to manage stores) and sector, then redirects back with the group now in the active list.
   Active groups are not repeated in the general list.

When the bot has no number: message pointing to the bot page. When there is no group bot: link to create one.

### Equipe (`/equipe`)

- **List**: name (+ cargo), phone, store · sector, WhatsApp badge (`✅ confirmado` / `👁 visto nos grupos` /
  `⚠ nunca visto`), managers (`👔 Groupbot ✅`, `⏳ pendente`), active groups count. Filters: text, store
  (select of used stores), situation (`todos`, `confirmados`, `não confirmados`, `nunca vistos`, `gestores`,
  `gestores pendentes`, `inativos`). Counters on top (total, confirmed, never seen, managers). The global
  "Tornar gestor" button is removed (managers are per bot).
- **Person page** (`/equipe/:id`): registry form (store input with `<datalist>` of all stores) plus cards:
  - *WhatsApp*: registry phone, LID linked yes/no, confirmed at + from which number, "visto em" list of active
    groups (via participants matched by phone or LID).
  - *Gestor*: one row per group bot: status (confirmed / pending with code+link / divergence / not a manager)
    and actions (make manager, new code, remove, accept/discard divergence).
  - *Histórico*: last 30 audit lines with this `funcionario_id`.
- New and edited audit entries for people carry `funcionario_id`.

## 5. Error handling

- Number disconnected while activating a group: the group is activated, participants fetch is skipped and
  retried on next connect; the page says "participantes serão lidos quando o número conectar".
- Code collisions: retry generation up to 10 times, then error page.
- Deleting a store used by active groups: groups keep working with no store (FK `SET NULL`).
- Deleting a person who is a manager: cascade removes the manager rows (existing behaviour); audit keeps the id.
- Changing a bot's number to one already used: rejected by `UNIQUE`, shown as a form error.

## 6. Testing

- `migracao.test.ts`: v4 → v5 with a `grupos` number, old managers, tagged groups.
- `repo-bots-grupos.test.ts`: stores CRUD + rename propagation, activation, participants replace/cascade,
  manager lifecycle (code, expiry, confirm, divergence, accept), commands overrides/custom.
- `motor-grupos.test.ts`: `/confirmar` (match, mismatch, expired, wrong), per-bot managers, off commands,
  custom commands (who/where), edited texts with placeholders, `/menu` with custom commands.
- `orquestrador-grupos.test.ts`: inactive group ignored with no dedupe row, unknown bot ignored, private
  `/confirmar` from a stranger, rate limit, participants sync on events, `/gestor add` sends the code privately.
- `painel.test.ts` (or `painel-grupos.test.ts`): Bots lists group bots; bot pages (geral, lojas, gestores,
  comandos, textos); Grupos activate/edit/deactivate; Equipe filters and person page cards.
- Manual: run locally, activate one group, confirm a manager by code from a real phone, run `/menu`.

## Out of scope

Notices, scheduling, confirmations/polls, admission/dismissal, moderation (sub-projects 2–6). Recruitment
bots and the Números page are unchanged.
