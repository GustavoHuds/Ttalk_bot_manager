# Changelog

## Unreleased

- Vários números de WhatsApp no mesmo processo, cada um com um uso (recrutamento ou grupos). Página **Números** substitui **Conexão**; `/healthz` só responde ok com todos os números ativos conectados; `/saude` mostra cada número; alertas dizem qual número caiu.
- Cada bot de recrutamento escolhe o seu número. Conversas, filas e candidaturas ficam separadas por número.
- Bot de grupos (núcleo): cadastro da equipe com importação/exportação CSV, gestores, grupos com setor e loja, e os comandos `/menu`, `/gestores`, `/quem`, `/cadastrar`, `/setores`, `/desconhecidos`, `/grupos`, `/gestor`, `/status`, `/log`. Toda ação de gestão é auditada.
- Telefones de outros países: digitados com `+<código do país>` no painel, no CSV e no `/cadastrar` (sem `+` é Brasil). A importação CSV aceita vírgula ou ponto e vírgula e arquivos em UTF-8 ou do Excel (Windows-1252).
- Atualização: o banco migra sozinho (tudo vai para o número 1) e `data/sessao` vira `data/sessoes/1` sem ler o QR de novo. O backup passa a incluir `data/sessoes/`.

## 1.0.0 — 2026-10-06

First public release.

- WhatsApp connection with Baileys 7.0.0-rc14 (pinned), QR pairing, persistent session, exponential reconnect, stop and alert on logout.
- Bots created and edited in the web panel: questions (text with validation, or poll), required file at the end, custom texts, open/close, copy to a new opening.
- Conversation engine: entry by link code or direct message, one question per message, poll votes decrypted in the adapter with a typed-number fallback, file grouping (60 s), early CV accepted, resume after 24 h, CV replacement, hidden-number (`@lid`) handling, erasure on request.
- Reliability: inbox with dedupe, outbox in the same transaction as state, retries, crash recovery.
- Human pacing: typing indicator, per-chat and global rate limits, reply-only window.
- Panel: login with lockout, candidates, downloads, ZIP + CSV export, connection, health, audit log.
- Daily retention, encrypted backup with a restore script, e-mail alerts.
- Docker image and compose file; CI with typecheck, tests and Docker build.
