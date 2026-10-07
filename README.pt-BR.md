# Ttalk Bot Manager

[English](README.md)

Gerenciador de bots de WhatsApp, auto-hospedado: cada bot espera o primeiro contato, responde, faz algumas perguntas, recebe o currículo (PDF, Word ou foto) e guarda tudo com segurança no seu servidor. Um número atende vários bots, criados e editados pelo painel.

Node.js 22 + TypeScript, Baileys `7.0.0-rc14` (versão fixada), SQLite, Fastify. Um processo só, sem navegador, Redis ou PostgreSQL.

## Como funciona

```
WhatsApp ─► ConexaoBaileys ─► Orquestrador ─► Motor (regras, sem efeitos)
               ▲   (adaptador)     │  grava estado + respostas na mesma transação
               │                   ▼
           Expedidor ◄──── caixa de saída (SQLite) ──── Painel (Fastify)
     (digitando, 1,5 s/conversa, 20/min por número)
```

- `src/conversa/motor.ts` decide tudo a partir da configuração do bot e devolve ações. Não fala com o WhatsApp nem com o banco, por isso é testado por inteiro sem conexão.
- `src/whatsapp/baileys.ts` é a única parte que conhece o Baileys. Trocar para Evolution API ou para a API oficial é escrever outra classe com os mesmos métodos.
- Quem manda o currículo logo na primeira mensagem (ou antes da hora) não perde nada: o arquivo é guardado e o bot segue com as perguntas, sem pedir o currículo de novo.
- Mensagem recebida é gravada antes de ser processada; ID repetido é descartado; resposta vai para uma caixa de saída gravada na mesma transação. Se o processo cair no meio, nada se perde e nada é respondido duas vezes.

## Criar um bot (uma vaga)

Tudo pelo painel, sem mexer em arquivo na VPS. Um número de WhatsApp atende vários bots.

1. Painel → **+ Novo bot** (ou **Copiar** num bot existente para reaproveitar perguntas e textos).
2. Preencha vaga, código (vai no link; não muda depois), período e por quantos meses guardar os dados.
3. Perguntas: adicione, reordene (↑ ↓), remova; cada uma é **texto livre** (pode conferir nome completo ou telefone) ou **enquete** (2 a 12 opções). O **currículo é sempre o último passo**: escolha os formatos aceitos (PDF, Word, foto) e o tamanho máximo.
4. **Textos do bot** (opcional): em branco usa o padrão, mostrado em cinza. Boas-vindas aceita várias versões, uma por linha, sorteadas.
5. **Salvar rascunho** ou **Abrir inscrições**. Vale na hora, sem reiniciar. Depois, **Encerrar inscrições** no mesmo lugar.
6. Copie o link de divulgação na lista de bots.

Ciclo: rascunho (ignorado) → aberto (recebe entre as datas) → encerrado (avisa que acabou). Depois de N meses do encerramento, a rotina das 3h apaga candidaturas e currículos daquele bot. Bot com candidaturas não pode ser excluído, só encerrado.

**Quem escreve direto pro número, sem link:** se houver um só bot aberto, entra nele; se houver vários, escolhe a vaga numa enquete.

Os textos de fábrica ficam em `config/mensagens-padrao.yaml`. Na primeira subida, os arquivos de `config/processos/*.yaml` são importados para o banco (é assim que o `VEND-OUT26`, aberto de 06/10 a 31/10/2026, chega ao painel); depois disso esses arquivos não são mais lidos.

Variáveis nos textos: `{empresa}` (vem de `EMPRESA_NOME`), `{vaga}`, `{codigo}`, `{retencao_meses}`, `{primeiro_nome}`, `{protocolo}`.

## Rodar localmente

```bash
npm install
cp .env.example .env          # preencha EMPRESA_NOME, PAINEL_SEGREDO e PAINEL_USUARIOS
npm run senha -- gustavo      # gera a linha para PAINEL_USUARIOS
npm run dev                   # painel em http://127.0.0.1:3100 (use PAINEL_COOKIE_SEGURO=false sem HTTPS)
npm test                      # 90 testes
npm run typecheck
```

`PAINEL_SEGREDO`: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

## Implantar na VPS (Docker)

O usuário da VPS não tem sudo, mas está no grupo `docker`; o `restart: unless-stopped` cuida de reinícios.

```bash
git clone https://github.com/GustavoHuds/Ttalk_bot_manager.git && cd Ttalk_bot_manager
cp .env.example .env && nano .env     # EMPRESA_NOME, segredo, usuários, BACKUP_SENHA, SMTP
mkdir -p data && chown 1000:1000 data # o container roda como uid 1000
docker compose up -d --build
docker compose logs -f
```

O painel fica só em `127.0.0.1:3100`. Publique pelo Caddy já existente, num subdomínio próprio:

```
bots.<dominio> {
    reverse_proxy 127.0.0.1:3100
}
```

(se o Caddy roda em container, use o nome do serviço na rede do Docker em vez de `127.0.0.1`). O painel tem login próprio; colocar também atrás do Authelia é opcional.

Para o Uptime Kuma: monitor HTTP em `/healthz` (público, responde `{"ok":true}` com 200 quando todos os números ativos estão conectados e 503 quando não, sem nenhum dado).

## Operação

- **Números:** painel → *Números*. Cada número tem um uso só: *Recrutamento* (candidatos) ou *Grupos* (grupos da empresa). Para conectar: abrir o número → no celular dele, *Aparelhos conectados* → *Conectar aparelho* → ler o QR.
- **Se o celular desconectar o aparelho** (logout): o bot para aquele número, avisa por e-mail dizendo qual, e a página do número oferece "Gerar novo QR". A sessão antiga é copiada para `data/sessoes-antigas/<id>-<data-hora>` antes.
- **Bot de grupos:** cadastre a equipe em *Equipe* (ou importe um CSV `nome;telefone;setor;loja;cargo;nascimento` — separado por ponto e vírgula ou vírgula, em UTF-8 ou no formato do Excel (Windows-1252); telefone sem `+` é do Brasil, número de outro país vai com `+<código do país>`, ex.: `+1 415 555 0123`), marque pelo menos um gestor e adicione o número de grupos aos grupos. Comandos: `/menu`. Só gestores cadastrados mandam comandos de gestão; ser admin do grupo no WhatsApp não dá poder no bot. Conversa comum dos grupos nunca é gravada.
- **Ao ativar um número novo:** o `/healthz` fica em 503 (e o monitor dispara) até todos os números ativos estarem conectados — ou seja, até o QR do novo ser lido.
- **Toda semana:** página *Saúde* — conexão, fila zerada, último backup.
- **Depois do processo:** *Encerrar inscrições* no editor do bot e *Exportar ZIP* (CSV + currículos) para a triagem com IA.
- **Excluir candidato:** botão na lista do processo, ou o próprio candidato escreve "excluir meus dados" e confirma com SIM.
- **Auditoria:** logins, visualizações, downloads, exportações e exclusões ficam na página *Auditoria*.

### Backup

Com `BACKUP_SENHA` definido, todo dia às 3h é gerado `data/backups/backup-AAAA-MM-DD.tar.gz.enc` (banco, currículos e sessões, cifrado com AES-256-GCM). Ele fica no mesmo disco: **copie a pasta `data/backups/` para fora da VPS** periodicamente. Sem a senha, o backup não abre — guarde-a fora da VPS também.

Restaurar (numa pasta separada, com o bot parado):

```bash
BACKUP_SENHA=... npm run restaurar-backup -- data/backups/backup-2026-10-20.tar.gz.enc /tmp/restauro
```

O banco restaurado fica em `/tmp/restauro/backups/.tmp-*/banco.sqlite`; mova-o para `data/banco.sqlite`.

### Alertas

Com `SMTP_URL` e `ALERTA_EMAIL_PARA`, o bot manda e-mail quando a conexão fica fora por mais de 10 min, quando a sessão é encerrada, quando volta e quando o backup falha. Sem isso, os avisos ficam só no log.

### Atualizar o Baileys

1. Copie `data/sessoes/` (a migração para LID não tem volta).
2. Troque a versão exata no `package.json` (sem `^`), `npm install`, `npm test`.
3. Rode o fluxo completo com um chip de teste antes de subir em produção.

## Comportamento anti-banimento já implementado

Nunca inicia conversa (resposta só para quem escreveu nas últimas `JANELA_RESPOSTA_HORAS`, padrão 24 h), marca como lida, "digitando..." de 1 a 4 s, 1,5 s entre mensagens da conversa e 20 por minuto por número, três versões da boas-vindas, `markOnlineOnConnect: false`, `syncFullHistory: false`, reconexão com espera crescente (2 s → 5 min) e parada no logout em vez de insistir.

No bot de grupos: no máximo 10 mensagens por minuto por número, 3 s ou mais entre mensagens do mesmo chat, "digitando..." de 1 a 2 s, e os comandos comuns têm freio — o mesmo comando repetido pela mesma pessoa em menos de 60 s, ou por qualquer pessoa no mesmo grupo em menos de 15 s, é ignorado. Resposta que ficou mais de 30 minutos na fila é descartada.

## Antes de colocar em produção

- [ ] Chip dedicado ao bot, aquecido (1 a 2 semanas de uso normal) e com perfil do WhatsApp Business completo.
- [ ] Textos e opções de cada vaga revisados no painel (em Editar).
- [ ] `ALERTA_EMAIL_PARA` definido (quem recebe o aviso de queda) e `BACKUP_SENHA` definido.
- [ ] Piloto com 5 a 10 pessoas, Android e iPhone: nenhum currículo perdido, nenhum fluxo travado. Votos em enquete dependem de decifrar o voto (o Baileys 7 não faz isso sozinho); se algum aparelho falhar, o candidato ainda pode responder com o número da opção.

## Licença

[MIT](LICENSE). Não é afiliado ao WhatsApp nem à Meta; usa uma conexão não oficial, e o cumprimento dos termos do WhatsApp e da LGPD é responsabilidade de quem implanta.
