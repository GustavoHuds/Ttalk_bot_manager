# Group bots + panel redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make group bots first-class (own entity, stores, active groups, per-bot managers confirmed by code, configurable commands) and redesign the Bots, Grupos and Equipe panel pages.

**Architecture:** Same layering as today: SQLite migration → repositories (`src/db`) → pure engine (`src/grupos/motor.ts`) → orchestrator (transaction + outbox) → Baileys adapter. Panel stays server-rendered (Fastify + template strings) with new route/page modules per area.

**Tech Stack:** TypeScript (ESM, Node 22), better-sqlite3, Fastify 5, Baileys 7, Vitest 5.

Spec: `docs/superpowers/specs/2026-10-08-groupbots-painel-design.md`

Commands used throughout:
- Single test file: `npx vitest run tests/<file>.test.ts`
- All tests: `npx vitest run` (baseline: 18 files, 250 tests passing)
- Types: `npx tsc -p tsconfig.json --noEmit`

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/db/banco.ts` | modify | migration 5 |
| `src/db/bots-grupos.ts` | **create** | `RepoBotsGrupos`: bots, lojas, grupos ativos, participantes, gestores por bot, comandos por bot |
| `src/db/grupos.ts` | modify | drop global managers + `etiquetarGrupo`; `Grupo` loses setor/loja; `Funcionario.confirmadoEm`; `confirmarFuncionario` |
| `src/db/repositorio.ts` | modify | `auditar(..., funcionarioId?)`, `auditoriaDaPessoa(id, n)` |
| `src/grupos/catalogo.ts` | **create** | built-in text keys/defaults/placeholders, template fill, custom-command validation, `ComandosDoBot` assembly |
| `src/grupos/comandos.ts` | modify | add `confirmar` built-in; `podeDesligar` flag |
| `src/grupos/tipos.ts` | modify | context/actions/events for bots, codes, participants |
| `src/grupos/motor.ts` | modify | per-bot managers, `/confirmar`, off/custom commands, editable texts |
| `src/grupos/orquestrador.ts` | modify | bot resolution, active-group gate, code generation, private code message, rate limit, participants sync |
| `src/whatsapp/baileys.ts` | modify | forward all participant changes |
| `src/main.ts` | modify | wire `RepoBotsGrupos` |
| `src/painel/servidor.ts` | modify | deps + register new routes, Bots list data |
| `src/painel/paginas.ts` | modify | Bots page second section, shared UI helpers (tabs, badges) |
| `src/painel/rotas-bot-grupos.ts` + `paginas-bot-grupos.ts` | **create** | group bot pages: Geral, Lojas, Gestores, Comandos, Textos |
| `src/painel/rotas-equipe.ts` + `paginas-equipe.ts` | modify | Grupos (active + general lists, activate form), Equipe list filters + person page |
| tests | create/modify | `migracao`, `repo-bots-grupos`, `catalogo`, `motor-grupos`, `orquestrador-grupos`, `painel-grupos` |

---

### Task 1: Migration 5

**Files:** Modify `src/db/banco.ts` (append to `MIGRACOES`); Test `tests/migracao.test.ts`.

- [ ] Write test `migra v4 → v5`: open `:memory:`, `migrar(db, 4)`, insert `numeros` (2,'Avisos','grupos'), a `funcionarios` row, a `gestores` row, a `grupos` row with setor/loja; run `migrar(db)`; expect `user_version = 5`; `bots_grupos` has `{nome:'Avisos', numero_id:2}`; `gestores_bot` has the person pending on that bot (`confirmado_em IS NULL`); `gestores` table gone; `grupos` has no `setor` column (`PRAGMA table_info`); `funcionarios.confirmado_em` and `auditoria.funcionario_id` exist; `grupos_ativos` empty.
- [ ] Write test `sem número de grupos, gestores antigos somem sem erro` (no bot → INSERT…SELECT inserts nothing).
- [ ] Run: FAIL (no migration 5).
- [ ] Append the migration SQL from the spec §1 verbatim to `MIGRACOES`.
- [ ] Run test file: PASS. Commit `Migração 5: bots de grupos, lojas, grupos ativos, participantes, gestores por bot, comandos`.

### Task 2: Repositories

**Files:** Create `src/db/bots-grupos.ts`; modify `src/db/grupos.ts`, `src/db/repositorio.ts`; Test `tests/repo-bots-grupos.test.ts`, update `tests/repo-grupos.test.ts`.

Types (exported from `bots-grupos.ts`):

```ts
export interface BotGrupos { id: number; nome: string; numeroId: number | null; ativo: boolean; criadoEm: number }
export interface Loja { id: number; botId: number; nome: string }
export interface GrupoAtivo { botId: number; jid: string; lojaId: number | null; loja: string | null; setor: string | null; ativadoEm: number; ativadoPor: string }
export interface Participante { jid: string; telefone: string | null; lid: string | null; admin: boolean }
export interface GestorBot {
  botId: number; funcionarioId: number; codigo: string | null; codigoExpiraEm: number | null
  confirmadoEm: number | null; confirmadoJid: string | null
  divergenteJid: string | null; divergenteTelefone: string | null; divergenteEm: number | null
  adicionadoPor: string; adicionadoEm: number
}
export interface ComandoSalvo { nome: string; ligado: boolean; personalizado: boolean; quem: 'todos' | 'gestores' | null
  onde: 'grupo' | 'privado' | 'ambos' | null; descricao: string | null; resposta: string | null; textos: Record<string, string> }
export const VALIDADE_CODIGO_MS = 48 * 60 * 60 * 1000
```

`RepoBotsGrupos` methods: `bots()`, `bot(id)`, `botDoNumero(numeroId)` (active only), `criarBot(nome, numeroId|null, agora)`, `editarBot(id, {nome, numeroId, ativo})`, `excluirBot(id)`; `lojas(botId)`, `criarLoja(botId, nome)`, `renomearLoja(id, nome)` (also `UPDATE funcionarios SET loja = novo WHERE loja = antigo COLLATE NOCASE`), `excluirLoja(id)`, `nomesDeLojas()` (distinct from `lojas` ∪ `funcionarios.loja`); `gruposAtivos(botId)`, `grupoAtivo(botId, jid)`, `ativarGrupo(botId, jid, lojaId, setor, por, agora)`, `editarGrupoAtivo(botId, jid, lojaId, setor)`, `desativarGrupo(botId, jid)`; `participantes(botId, jid)`, `substituirParticipantes(botId, jid, lista)`, `adicionarParticipantes`, `removerParticipantes(botId, jid, jids)`, `definirAdminParticipante`, `gruposDaPessoa(telefone, lid)` → `{botId, jid}[]`, `contagemParticipantes(botId)` → `Map<jid,{total, semCadastro}>`; `gestores(botId)`, `gestoresDaPessoa(funcionarioId)`, `gestorPorCodigo(botId, codigo, agora)`, `indicarGestor(botId, funcionarioId, por, agora)` → code, `novoCodigo(botId, funcionarioId, agora)` → code, `confirmarGestor(botId, funcionarioId, jid, agora)`, `registrarDivergencia(botId, funcionarioId, jid, telefone, agora)`, `descartarDivergencia`, `removerGestor`, `gestoresConfirmados(botId)` → ids; `comandos(botId)` → `Map<nome, ComandoSalvo>`, `ligarComando(botId, nome, ligado)`, `salvarTextos(botId, nome, textos)`, `salvarPersonalizado(botId, dados)`, `excluirPersonalizado(botId, nome)`.

Code generation: `String(randomInt(0, 1_000_000)).padStart(6, '0')`, retry while `(bot_id, codigo)` exists, max 10 tries then throw.

`RepoGrupos` changes: remove `gestores/adicionarGestor/removerGestor/etiquetarGrupo`; `Grupo` without setor/loja; `Funcionario.confirmadoEm: number | null` (select column; `salvarFuncionario` keeps it); add `confirmarFuncionario(id, agora)`, `definirTelefone(id, telefone, agora)`, `definirLid(id, lid, agora)`.

`Repositorio`: `auditar(usuario, acao, detalhe, agora, funcionarioId: number | null = null)`; `auditoriaDaPessoa(funcionarioId, limite)`.

- [ ] Tests (`repo-bots-grupos.test.ts`): stores unique per bot (case-insensitive), rename propagates to `funcionarios.loja`; activate/edit/deactivate group, deactivate cascades participants; `substituirParticipantes` + `contagemParticipantes` with one registered person; `indicarGestor` gives 6 digits, `gestorPorCodigo` respects expiry and bot; `confirmarGestor` clears code; divergence stored then discarded; `gestoresConfirmados` ignores pending; command toggle, texts JSON round-trip, custom save/delete; `botDoNumero` ignores inactive bot; number unique across bots throws.
- [ ] Update `repo-grupos.test.ts` for removed APIs; fix compile errors in callers in later tasks (motor/orquestrador/painel) — keep `npx tsc` errors only in files touched by Tasks 3–7.
- [ ] Run, implement, PASS, commit `Repositórios de bots de grupos`.

### Task 3: Command catalog

**Files:** Create `src/grupos/catalogo.ts`; modify `src/grupos/comandos.ts`; Test `tests/catalogo.test.ts`.

```ts
// comandos.ts
export type NomeComando = 'menu' | 'gestores' | 'quem' | 'cadastrar' | 'setores' | 'desconhecidos' | 'grupos' | 'gestor' | 'status' | 'log' | 'confirmar'
// DefComando gains: fixo?: true   (menu, confirmar: cannot be turned off); exemplo: string
// COMANDOS gains: { nome: 'confirmar', gestor: false, onde: 'privado', uso: '/confirmar 123456', descricao: 'confirma você como gestor(a) com o código recebido', fixo: true }
// confirmar is hidden from /menu (it is not for daily use).

// catalogo.ts
export interface TextoPadrao { chave: string; rotulo: string; padrao: string; campos: string[] }
export const TEXTOS: Record<NomeComando, TextoPadrao[]>   // table from spec §3
export function preencher(modelo: string, valores: Record<string, string | number>): string   // {campo} → valor; unknown stays literal
export function validarTexto(cmd: NomeComando, chave: string, texto: string): string | null  // error message or null
export interface Personalizado { nome: string; descricao: string; quem: 'todos' | 'gestores'; onde: 'grupo' | 'privado' | 'ambos'; resposta: string }
export function validarPersonalizado(p: Partial<Personalizado>): { ok: Personalizado } | { erro: string }
export interface ComandosDoBot { desligados: Set<NomeComando>; textos: Map<NomeComando, Record<string, string>>; personalizados: Personalizado[] }
export function comandosDoBot(salvos: Map<string, ComandoSalvo>): ComandosDoBot
export function texto(c: ComandosDoBot, cmd: NomeComando, chave: string, valores?: Record<string, string | number>): string
export const COMANDOS_PADRAO: ComandosDoBot  // nothing off, no texts, no custom
```

- [ ] Tests: `preencher` replaces known fields, keeps text otherwise; `validarTexto` rejects `{xyz}`, accepts allowed fields, rejects > 1000 chars; `validarPersonalizado` normalizes `/Horário` → `horario`, rejects built-in names and aliases, rejects empty reply, length limits; `comandosDoBot` ignores off flags on `menu`/`confirmar`; `texto()` falls back to default when edited text missing.
- [ ] Implement, PASS, commit `Catálogo de comandos: textos editáveis e personalizados`.

### Task 4: Engine

**Files:** Modify `src/grupos/tipos.ts`, `src/grupos/motor.ts`; Test `tests/motor-grupos.test.ts`.

Context changes (`ContextoGrupos`): add `bot: { id: number; nome: string; telefone: string | null }`, `comandos: ComandosDoBot`, `pendentes: { funcionarioId: number; codigo: string | null; expiraEm: number | null }[]`; `gestores` = confirmed for this bot; `grupos: GrupoDoBot[]` where `GrupoDoBot = { jid; nome; botAdmin; loja: string | null; setor: string | null }`; `grupo: GrupoDoBot | null`.

Actions: replace `{tipo:'gestor'}` with
```ts
| { tipo: 'indicar_gestor'; funcionarioId: number; avisar: Pessoa }      // orchestrator makes the code and DMs `avisar`
| { tipo: 'remover_gestor'; funcionarioId: number }
| { tipo: 'confirmar_gestor'; funcionarioId: number; pessoa: Pessoa }
| { tipo: 'divergencia'; funcionarioId: number; pessoa: Pessoa }
| { tipo: 'codigo_errado' }
```
`auditar` gains optional `funcionarioId`.

Rules (in order): unknown/off/custom resolution → `/confirmar` (anyone, private) → existing permission checks using per-bot managers.
- `/confirmar 123456`: find pending with this code (not expired) → if sender matches person's phone or LID → `confirmar_gestor` + audit + reply `texto('confirmar','confirmado',{nome, bot})`; else `divergencia` + reply divergence text. Not found → `codigo_errado` + reply `invalido`. In a group → reply `Use /confirmar no privado comigo.` and **no** code check (never leak).
- Off built-in: manager → `Este comando está desligado neste bot.`; others silence.
- Custom: respects `quem`/`onde` like built-ins; reply is the stored text.
- `/gestor add` → `indicar_gestor` (unless already confirmed: `já é gestor(a)`; already pending: `já está pendente; peça para mandar /confirmar no meu privado.`).
- `/menu` lists allowed built-ins (not `confirmar`, not off) + allowed custom.
- All texts in the spec table go through `texto()`.

- [ ] Update `ctx()` helper for new fields; adapt existing tests (`gestor` actions → `indicar_gestor`/`remover_gestor`).
- [ ] New tests: confirm match by LID; confirm match by phone; mismatch → divergence; expired → invalid; `/confirmar` in group says private and leaks nothing; stranger in private can use `/confirmar` but gets silence for `/menu`; off command (manager hears "desligado", others silence); `/menu` hides off and shows custom; custom `quem:'gestores'` silent for others; edited `status` text with placeholders; `/gestor add` already pending.
- [ ] Implement, PASS, commit `Motor: gestores por bot, /confirmar, comandos desligados, personalizados e textos`.

### Task 5: Orchestrator + adapter

**Files:** Modify `src/grupos/orquestrador.ts`, `src/grupos/tipos.ts` (event), `src/whatsapp/baileys.ts`, `src/main.ts`; Test `tests/orquestrador-grupos.test.ts`.

- `DependenciasGrupos` gains `bots: RepoBotsGrupos` and `telefoneDoNumero?: (numeroId) => string | null` (for the wa.me link).
- `receber(m)`: `bot = bots.botDoNumero(m.numeroId)`; none → return. Group chat not in `grupoAtivo(bot.id, chat)` → return (before throttle and queue).
- `/confirmar` wrong-code limiter: `Map` per `${bot}:${sender}` and per `${bot}` with 1-hour windows; over limit → return before engine, `warn` log.
- `aplicar`: `indicar_gestor` → `bots.indicarGestor` and enqueue a private message to `avisar.jid`: `🔐 Código de {nome}: {codigo}\nPeça para {nome} mandar /confirmar {codigo} no meu privado` + `https://wa.me/<telefone>?text=%2Fconfirmar%20<codigo>` when known (valid 48 h); `confirmar_gestor` → `bots.confirmarGestor` + `grupos.confirmarFuncionario` + fill missing phone/LID; `divergencia` → `bots.registrarDivergencia`; `codigo_errado` → limiter counts.
- `eventoGrupos(numeroId, e)`: also handle `{ tipo: 'participantes'; jid; acao: 'add'|'remove'|'promote'|'demote'; membros: MembroGrupo[] }` only for active groups of the bot; `lista` triggers `sincronizarParticipantes(numeroId)` (async, sequential `metadados` for each active group, replace rows).
- `sincronizarGrupo(botId, jid)` public, used by the panel after activation.
- Adapter: `group-participants.update` emits `participantes` for every change (keeps existing `saiu/admin/entrou` for the bot itself). Participant objects → `MembroGrupo` via `membrosDoGrupo`-like mapping.

- [ ] Tests: inactive group: no dedupe row, no reply; number without bot ignored; activated group answers; stranger private `/confirmar <code>` confirms and outbox gets the confirmation; mismatch stores divergence; 6th wrong code within an hour is ignored (no reply); `/gestor add @x` in group enqueues group reply **and** private code message to the requester; `participantes` event updates rows only for active groups; `lista` event re-reads participants of active groups.
- [ ] Implement, wire `main.ts`, PASS, commit `Orquestrador: grupos ativos, confirmação por código e participantes`.

### Task 6: Panel — Bots list + group bot pages

**Files:** Create `src/painel/rotas-bot-grupos.ts`, `src/painel/paginas-bot-grupos.ts`; modify `src/painel/servidor.ts` (`DependenciasPainel` gains `botsGrupos: RepoBotsGrupos` and `sincronizarGrupo?: (botId, jid) => Promise<void>`), `src/painel/paginas.ts` (Bots second section, `abas()` helper, `.selo` badges CSS); Test `tests/painel-grupos.test.ts`.

Routes:
- `GET /` — adds "Bots de grupos" table + `+ Bot de grupos` (`POST /grupos-bot` with nome + numero).
- `GET|POST /grupos-bot/:id` — Geral (nome, número select, ativo), summary cards; `POST /grupos-bot/:id/excluir` (only with zero active groups).
- `GET /grupos-bot/:id/lojas`, `POST …/lojas`, `POST …/lojas/:loja/renomear`, `POST …/lojas/:loja/excluir`.
- `GET /grupos-bot/:id/gestores` (+ `?q=` team search), `POST …/gestores` (funcionario_id), `POST …/gestores/:f/codigo`, `POST …/gestores/:f/remover`, `POST …/gestores/:f/aceitar-divergencia`, `POST …/gestores/:f/descartar-divergencia`.
- `GET /grupos-bot/:id/comandos`, `POST …/comandos/:nome/ligar` (ligado=0|1), `GET|POST …/comandos/:nome/textos`, `POST …/comandos/personalizado` (create/edit), `POST …/comandos/personalizado/:nome/excluir`.
All POSTs audited and redirect with `?ok=<msg-key>`.

- [ ] Tests: `/` lists group bot with counts; create bot; number select excludes numbers used by another bot; stores add/rename/delete; gestores: add from team → code visible + wa.me link, accept divergence updates phone and confirms; comandos: toggle off is audited and engine-visible (`comandos()`), `menu` can't be turned off (409), edit texts rejects unknown placeholder (400 with message), custom command create/delete; HTML escaping of bot/store names.
- [ ] Implement, PASS, commit `Painel: bots de grupos (geral, lojas, gestores, comandos)`.

### Task 7: Panel — Grupos

**Files:** modify `src/painel/rotas-equipe.ts`, `src/painel/paginas-equipe.ts`; Test `tests/painel-grupos.test.ts`.

- `GET /grupos?bot=` — selector, active list (store, sector, admin, participants `n · m sem cadastro`, warnings), general list (not active, with search box + inline filter script).
- `GET /grupos/ativar?bot=&jid=` form; `POST /grupos/ativar` → `ativarGrupo` + audit + `sincronizarGrupo` (errors swallowed and logged) → redirect `/grupos?bot=&ok=ativado`.
- `GET /grupos/editar?bot=&jid=`, `POST /grupos/editar`; `POST /grupos/desativar`.
- Remove `/grupos/etiquetar`.

- [ ] Tests: general list shows all non-active groups; activation moves group to active with store name; group of another number rejected (404); deactivate removes it and its participants; warning when the bot's number left the group.
- [ ] Implement, PASS, commit `Painel: grupos ativos e lista geral`.

### Task 8: Panel — Equipe

**Files:** modify `src/painel/rotas-equipe.ts`, `src/painel/paginas-equipe.ts`; Test `tests/painel-grupos.test.ts`, update `tests/painel.test.ts` (old gestor button test).

- List: counters, filters `q`, `loja`, `situacao`; columns per spec; remove `/equipe/:id/gestor`.
- Person page: form with `<datalist id="lojas">` from `nomesDeLojas()`; cards WhatsApp / Gestor (per bot with actions posting to the bot routes with `voltar=/equipe/:id`) / Histórico (`auditoriaDaPessoa`).
- Audit lines for create/edit/delete person carry `funcionarioId`.

- [ ] Tests: filters (`confirmados`, `nunca vistos`, `gestores pendentes`, `loja`); person page shows "visto em" group name from participants, pending code, history line.
- [ ] Implement, PASS, commit `Painel: equipe com confirmação, gestores por bot e histórico`.

### Task 9: Verification

- [ ] `npx vitest run` all green; `npx tsc -p tsconfig.json --noEmit` clean.
- [ ] Restart `npm run dev`, log in, screenshot Bots, Groupbot (each tab), Grupos (activate a test group), Equipe (list + person). Check no console errors, phone width layout.
- [ ] Update `README.pt-BR.md`/`README.md` commands section and CHANGELOG.
- [ ] Commit.
