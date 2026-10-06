// Uso: npm run senha -- <usuario>
// Pede a senha no terminal e imprime o trecho para colar em PAINEL_USUARIOS.
import { createInterface } from 'node:readline/promises'
import { hashSenha } from '../src/painel/auth.js'

const usuario = process.argv[2]
if (!usuario || !/^[\w.-]+$/.test(usuario)) {
  console.error('Uso: npm run senha -- <usuario>')
  process.exit(1)
}
const rl = createInterface({ input: process.stdin, output: process.stdout })
const senha = await rl.question('Senha (mínimo 12 caracteres): ')
rl.close()
if (senha.length < 12) {
  console.error('Senha curta demais.')
  process.exit(1)
}
console.log(`\n${usuario}:${hashSenha(senha)}`)
console.log('\nCole a linha acima em PAINEL_USUARIOS no .env (separe usuários com ";").')
