# Contributing

Thanks for helping. Issues and pull requests are welcome in English or Portuguese.

## Setup

```bash
npm install
npm test           # must stay green
npm run typecheck  # strict TypeScript, no errors
npm run dev        # local panel on http://127.0.0.1:3100 (needs a .env, see .env.example)
```

## Ground rules

- **Conversation rules live in `src/conversa/motor.ts` and stay pure.** The engine returns actions; it never touches WhatsApp, the database or the clock directly. Every new behaviour gets a test in `tests/motor.test.ts`, and an end-to-end case in `tests/fluxo.test.ts` when it involves storage.
- **Group bot rules live in `src/grupos/motor.ts` and stay pure** (same contract as the recruitment engine). New commands go in the `COMANDOS` table in `src/grupos/comandos.ts` first; the compiler then forces a rule in the engine. Tests in `tests/motor-grupos.test.ts`, storage in `tests/orquestrador-grupos.test.ts`, schedules in `tests/agenda.test.ts`.
- **Plain group chat is never stored or logged.** The orchestrator drops anything that isn't from an active group and isn't a command, an awaited reply or a banned word, before touching the database.
- **Every outgoing message goes through a sender** (`src/whatsapp/expedidor.ts`, `src/grupos/expedidor.ts`) so it gets the human pacing and rate limits. Don't call the connection to send from anywhere else.
- **Only files in `src/whatsapp/` import Baileys.** Keep it that way so the connection can be swapped.
- **State changes and replies go in one transaction** (state + outbox). Never send a message directly from the orchestrator.
- **Never log message content or personal data.** Log IDs.
- **Baileys is pinned to an exact version.** Upgrades need a manual run of the full flow on a test number; say so in the PR.
- Code identifiers and user-facing texts are in Portuguese (the product's first users are Brazilian). Follow the style of the file you are editing.

## Pull requests

1. Open an issue first for anything bigger than a bug fix.
2. Write the failing test, then the fix.
3. Keep the PR focused; describe what you tested by hand (e.g. "ran the flow on Android with a PDF and two photos").

## Reporting bugs

Use the bug template. Include the Baileys version, what the candidate sent (type, not content), and the relevant log lines; they contain IDs only.
