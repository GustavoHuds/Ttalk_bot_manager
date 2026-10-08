# Anti-ban measures

[Português](anti-bloqueio.md)

WhatsApp restricts numbers because of **behaviour patterns**, not one single rule. Tools that have run on top of WhatsApp Web for years (Evolution API, WPPConnect, whatsapp-web.js, the Baileys guides) converge on the same practices. This is what Ttalk does and why, most important first.

| # | Measure | Where | Why it works |
|---|---|---|---|
| 1 | **Never starts a conversation.** Recruitment only replies to people who wrote in the last 24 h; group bots only speak in groups you activated and in private to confirmed managers. | `whatsapp/expedidor.ts`, `grupos/orquestrador.ts` | Spam reports from people who didn't ask for a message are the number one ban reason. |
| 2 | **"Typing…" sized to the text and randomised**: 30–60 ms per character (drawn per message) plus 0.4–1.2 s of "thinking", between 1.2 and 9 s; then "stopped typing"; audio shows "recording". | `whatsapp/limite.ts` (`duracaoDigitando`) | A fixed delay is the easiest robot signature; real clients always send presence first. |
| 3 | **Irregular gaps** between messages in the same chat (recruitment 1.5–3 s, groups 3–7 s); scheduled sends spread up to 45 s after their time. | senders, `grupos/agenda.ts` | Sending on the exact second, or in identical bursts, gives automation away. |
| 4 | **Per-number caps** per minute and per hour: recruitment 20/min and 300/h; groups 12/min and 200/h. | `LimitePorMinuto` | High volume in a short time is the classic restriction trigger. |
| 5 | **Brake on mass mentions**: `/all` and `/todos` at most once a minute per group. | `grupos/motor.ts` | Mentioning hundreds of people repeatedly looks like spam. |
| 6 | **Content variation** in scheduled messages (up to 3 versions, never the last one again). | `grupos/agenda.ts` | Identical text at fixed times forms a fingerprint. |
| 7 | **Group metadata cached** (`cachedGroupMetadata`); a group is fetched again only after it changes. | `whatsapp/baileys.ts` | Fetching group data on every send is traffic no real client produces. |
| 8 | **Not permanently online, no history sync, no link previews** (`markOnlineOnConnect: false`, `syncFullHistory: false`, `generateHighQualityLinkPreview: false`). | `whatsapp/baileys.ts` | Always online and previewing every link are server behaviours. |
| 9 | **Reads before replying**: a command is marked as read before the answer goes out. | `grupos/orquestrador.ts` | Replying to "unread" messages is an automation pattern. |
| 10 | **Stale queue is dropped**: a group reply waiting more than 30 min (or a recruitment reply outside the window) is not sent; a scheduled time missed by more than 10 min is skipped. | senders, scheduler | A burst of late messages on reconnect is an anomalous peak. |
| 11 | **One role per number** and **pause per number**. | `numeros` | A ban on one use doesn't take down the other; you can take a number offline without unlinking it. |
| 12 | **Exponential reconnect backoff** (2 s → 5 min) and a full stop on logout or ban. | `whatsapp/baileys.ts` | Reconnecting nonstop after a block makes things worse. |

## What the operator should do

- **Warm up new numbers**: keep usage light in the first days (few groups, few scheduled messages) and use the phone normally too.
- Use a **dedicated SIM** per number and keep the phone on, with WhatsApp updated.
- Prefer **a few scheduled messages with variations** over many identical ones.
- Make the number an **admin only where it moderates** (remove, close, delete).
