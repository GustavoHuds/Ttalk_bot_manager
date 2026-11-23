#!/usr/bin/env bash
# Cria um usuário do painel ou troca a senha dele. Remove com --remover.
# Uso: ./deploy/usuario.sh <usuario>            (pede a senha sem mostrar)
#      ./deploy/usuario.sh --remover <usuario>
# Os usuários ficam em PAINEL_USUARIOS no .env (hash scrypt, com $ escapado como $$ por causa do compose).
set -euo pipefail
cd "$(dirname "$0")/.."

remover=0
if [[ "${1:-}" == "--remover" ]]; then remover=1; shift; fi
usuario="${1:-}"
if [[ ! "$usuario" =~ ^[A-Za-z0-9_.-]+$ ]]; then
  echo "Uso: $0 [--remover] <usuario>   (letras, números, _ . -)" >&2; exit 1
fi

atual=$(grep '^PAINEL_USUARIOS=' .env | cut -d= -f2-)
# Mantém os outros usuários, tira o que vai ser trocado/removido
outros=$(tr ';' '\n' <<<"$atual" | grep -v "^${usuario}:" | grep -v '^$' || true)

if (( remover )); then
  [[ -n "$outros" ]] || { echo "Não dá para remover o último usuário." >&2; exit 1; }
  novo="$outros"
else
  read -rsp "Nova senha para $usuario (mínimo 12 caracteres): " s1; echo
  read -rsp "Repita a senha: " s2; echo
  [[ "$s1" == "$s2" ]] || { echo "As senhas não conferem." >&2; exit 1; }
  (( ${#s1} >= 12 )) || { echo "Senha curta demais." >&2; exit 1; }
  hash=$(printf '%s' "$s1" | docker exec -i ttalk-bot-manager node -e '
    import("/app/dist/painel/auth.js").then(async (m) => {
      let s = ""; for await (const c of process.stdin) s += c
      process.stdout.write(m.hashSenha(s))
    })')
  unset s1 s2
  [[ "$hash" == scrypt\$* ]] || { echo "Falha ao gerar o hash." >&2; exit 1; }
  novo=$(printf '%s\n%s:%s' "$outros" "$usuario" "${hash//\$/\$\$}" | grep -v '^$')
fi

linha="PAINEL_USUARIOS=$(paste -sd';' <<<"$novo")"
bak=".env.bak-$(date +%F-%H%M%S)"   # tem segredos: só fica se algo der errado
cp -a .env "$bak"
tmp=$(mktemp .env.XXXX); chmod 600 "$tmp"
awk -v l="$linha" 'BEGIN{FS=OFS="="} /^PAINEL_USUARIOS=/{print l; next} {print}' .env > "$tmp"
mv "$tmp" .env

if ! docker compose up -d --no-build >/dev/null 2>&1; then
  echo "Falha ao reiniciar. O .env anterior está em $bak (apague depois de resolver)." >&2; exit 1
fi
rm -f "$bak"
echo "Pronto. Usuários: $(paste -sd' ' <<<"$(cut -d: -f1 <<<"$novo")")."
(( remover )) || echo "Quem já estava logado com a senha antiga continua logado até a sessão expirar (12h)."
