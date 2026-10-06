// Uso: BACKUP_SENHA=... npm run restaurar-backup -- <arquivo.tar.gz.enc> <pasta-destino>
// Extrai banco.sqlite (em backups/.tmp-*/), curriculos/ e sessao/ na pasta destino.
// Restaure numa pasta separada e só depois troque a pasta data/ com o bot parado.
import { restaurarBackup } from '../src/rotinas/backup.js'

const [arquivo, destino] = process.argv.slice(2)
const senha = process.env.BACKUP_SENHA
if (!arquivo || !destino || !senha) {
  console.error('Uso: BACKUP_SENHA=... npm run restaurar-backup -- <arquivo> <pasta-destino>')
  process.exit(1)
}
await restaurarBackup(arquivo, senha, destino)
console.log(`Backup extraído em ${destino}`)
