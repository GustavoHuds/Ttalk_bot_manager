# Changelog

## Unreleased

### Group bots
- New bot type that runs company WhatsApp groups. Each group bot is its own entity, separate from the number it uses, so swapping the SIM keeps its groups, managers, commands and schedules.
- Acts only in the groups you activate; everywhere else it stays silent and stores nothing.
- Managers are added by name and WhatsApp and gain power only after sending a 6-digit code (`/confirmar`, valid 48 h) from that WhatsApp. A correct code from another number shows up in the panel to accept or discard. Wrong codes are rate-limited.
- Commands, usable in the group or in private (the bot asks which group, numbered, and remembers the choice): `/all`, `/todos`, `/mencionar`, `/remove`, `/banword`, `/mutegroup` (now or a daily window), `/unmute`, `/repeat` / `/repeat stop`, `/menu`, `/grupo`. Each can be switched off per bot.
- Scheduled messages: weekdays or a single date, up to four times a day, up to three variations, media (image, video, audio, document) and an optional hidden mention of everyone.
- Messages with banned words are deleted; groups are opened and closed on schedule.

### Numbers
- Several WhatsApp numbers in one process, each with one role (recruitment or groups). The **Numbers** page replaces **Connection**; `/healthz` is ok only when every active number is connected, and alerts name the number that dropped.
- **Pause** (stays connected, the bot stops reading and sending) and **Revoke** (logs the linked WhatsApp out and shows a new QR).
- The QR only runs while the number's page is open; with nobody watching, pairing stops after 30 s.
- Each recruitment bot picks its number. Conversations, queues and applications are kept per number.

### Panel
- New layout: left sidebar, responsive tables that turn into cards on phones, light and dark themes.
- Everything about a group bot lives in its own tabs: General, Groups, Managers, Commands and Scheduled.

### Anti-ban
- "Typing…" sized to the message and randomised every time, followed by "stopped typing".
- Irregular gaps between messages, per-hour caps on top of per-minute caps, scheduled sends spread over 45 s, one mass mention per minute per group, message variations, read before reply, no link previews. See [docs/anti-ban.md](docs/anti-ban.md).

### Upgrading
- The database migrates itself; existing data is kept. `data/sessao` becomes `data/sessoes/1` without re-pairing, and backups now include `data/sessoes/`.
- Numbers that were disabled now show as *no connection*; open the number's page to pair it again.

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
