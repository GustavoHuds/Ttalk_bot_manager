# Security policy

Ttalk stores personal data (names, phone numbers, CVs). Security reports are taken seriously.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private reporting: *Security → Report a vulnerability* on this repository. Include steps to reproduce and the impact. You will get an answer within 7 days.

## Supported versions

Only the latest release on `main` receives fixes.

## Hardening checklist for deployers

- Serve the panel **only over HTTPS** behind a reverse proxy; keep `PAINEL_COOKIE_SEGURO=true` and bind to `127.0.0.1`.
- Use long, unique panel passwords (`npm run senha`), and a random `PAINEL_SEGREDO` of 32 or more characters.
- Set `BACKUP_SENHA` and copy `data/backups/` off the server regularly; store the password elsewhere.
- Keep `data/` readable only by the service user (the Docker image runs as uid 1000).
- Pin and upgrade Baileys deliberately. Versions below 6.7.22 and 7.0.0-rc12 are affected by a message-spoofing vulnerability.
