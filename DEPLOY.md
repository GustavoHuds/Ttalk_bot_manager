# Deploy: Ttalk Bot Manager (srv1183825)

Projeto: `/opt/ttalk-bot-manager` · Mudança local: troca de senha no painel (`src/painel/servidor.ts`, `paginas.ts`, teste em `tests/painel.test.ts`) · Commit do upstream: `a1fd294d1e185c0d9e26cdfd46231e136978808c`
Container: `ttalk-bot-manager` · Imagem: `ttalk-bot-manager:1.0.0` (também `deploy-a1fd294`)
URL: https://ttalk.lojasbelmont.com.br (Traefik do Coolify, certificado Let's Encrypt automático)
Porta publicada: `127.0.0.1:3100` (só local). O Traefik chega no container pela rede `coolify`; rota em `/data/coolify/proxy/dynamic/ttalk.yaml` (HTTP→HTTPS, HSTS, nosniff, frame deny).

## Arquivos importantes

| Caminho | O que é | Permissão |
| --- | --- | --- |
| `.env` | segredos e configuração (PAINEL_SEGREDO, PAINEL_USUARIOS, BACKUP_SENHA) | 600, fora do git |
| `data/` | banco SQLite, sessões do WhatsApp, currículos e backups (bind mount) | dono uid 1000, 700 |
| `deploy/config/` | textos padrão (sem bots de exemplo) montados em `/app/config` somente leitura | 644 |
| `docker-compose.yml` | serviço, limites, healthcheck, log rotation | |

Os segredos nunca vão para o git. O `.env` tem `$` escapados como `$$` (o hash do usuário precisa disso no compose).

## Operação

Rodar sempre dentro de `/opt/ttalk-bot-manager`:

```bash
docker compose up -d          # iniciar
docker compose stop           # parar
docker compose restart        # reiniciar
docker compose logs -f --tail 100
docker stats --no-stream ttalk-bot-manager
```

Verificação rápida:

```bash
curl -s http://127.0.0.1:3100/healthz   # {"ok":false} é normal até um número ser pareado e conectado
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/login   # 200
docker inspect -f '{{.State.Health.Status}}' ttalk-bot-manager          # healthy
```

## Primeiro uso (pendente)

1. ~~Trocar `EMPRESA_NOME`~~ feito: `Belmont Móveis e Colchões`.
2. Entrar no painel (https://ttalk.lojasbelmont.com.br, usuário `admin`) e parear os números em **Números** (QR).
3. Opcional: preencher `SMTP_URL`, `ALERTA_EMAIL_DE`, `ALERTA_EMAIL_PARA` para alertas por e-mail.
4. ~~Apagar `credenciais.txt`~~ feito em 2026-10-10. A senha do backup só existe agora no `.env` (e fora do servidor, com o dono).

## Atualizar

```bash
cd /opt/ttalk-bot-manager
git fetch origin && git log --oneline HEAD..origin/main   # ver o que muda
git stash                       # guarda Dockerfile/compose locais
git checkout <tag-ou-sha-novo> && git stash pop            # resolver conflitos se houver
nice -n 19 ionice -c3 docker compose build
docker tag ttalk-bot-manager:1.0.0 ttalk-bot-manager:deploy-<sha-curto>   # marca o que vai rodar
docker compose up -d
```

Antes de atualizar, faça backup do `data/` (`cp -a data data.bak-$(date +%F)` ou use o backup diário cifrado). O banco se migra sozinho na subida.

## Rollback

A imagem anterior fica marcada como `ttalk-bot-manager:rollback-a1fd294`. Antes da tela de troca de senha: `ttalk-bot-manager:rollback-antes-senha`.

```bash
cd /opt/ttalk-bot-manager
docker tag ttalk-bot-manager:rollback-a1fd294 ttalk-bot-manager:1.0.0
docker compose up -d --no-build
```

Se a versão nova já migrou o banco, o rollback do código pode não funcionar: restaure o `data/` salvo antes da atualização.

## Usuários do painel

Não há tela de usuários: eles ficam em `PAINEL_USUARIOS` no `.env`. Use o script (pede a senha sem mostrar, reinicia o container):

```bash
cd /opt/ttalk-bot-manager
./deploy/usuario.sh admin               # trocar a senha do admin
./deploy/usuario.sh maria               # criar usuário (ou trocar a senha dele)
./deploy/usuario.sh --remover maria     # remover (derruba as sessões dele)
```

Cada usuário também pode trocar a própria senha no painel: clicar no nome, no canto inferior esquerdo (`/senha`). Essa troca fica no banco (tabela `meta`, chave `senha:<usuario>`) e só vale enquanto o hash do `.env` for o mesmo; rodar `usuario.sh` para esse usuário redefine a senha e anula a troca feita pelo painel (é o caminho para quem esqueceu a senha).

O script faz cópia do `.env` antes de mexer e apaga a cópia se tudo deu certo.

## Notas

- Build: a imagem usa `node:22.23.3-bookworm-slim` fixado por digest. Ao atualizar o Node, troque a tag e o digest nos dois `FROM` do Dockerfile.
- Limites: `mem_limit 512m`, `cpus 1.0`, `pids_limit 256`. Logs: json-file, 10 MB × 3.
- `init: true` e `stop_grace_period: 30s`: o desligamento espera os envios em andamento.
- Healthcheck: sobrescrito para checar `/login`, porque `/healthz` responde 503 sem números conectados.
- Backup diário cifrado ativo (`BACKUP_SENHA`); retenção de 365 dias.
- Painel publicado em https://ttalk.lojasbelmont.com.br. Não existe Caddy na borda: as portas 80/443 são do `coolify-proxy` (Traefik), que lê `/data/coolify/proxy/dynamic/*.yaml` sozinho (watch). Se o container trocar de nome, ajustar o `url` do service no `ttalk.yaml`.
