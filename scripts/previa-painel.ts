// Sobe o painel com dados de demonstração (fictícios) e conexões de mentira, sem tocar no WhatsApp.
// Uso: npx tsx scripts/previa-painel.ts  → http://127.0.0.1:3199 (usuário "demo", senha "demonstracao")
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { ArmazemArquivos } from '../src/arquivos.js'
import { FonteBots, botModelo } from '../src/config/bots.js'
import { lerPadrao } from '../src/config/carregar.js'
import { abrirBanco } from '../src/db/banco.js'
import { RepoBotsGrupos } from '../src/db/bots-grupos.js'
import { RepoGrupos } from '../src/db/grupos.js'
import { RepoNumeros } from '../src/db/numeros.js'
import { Repositorio } from '../src/db/repositorio.js'
import { hashSenha } from '../src/painel/auth.js'
import { criarPainel } from '../src/painel/servidor.js'
import type { EstadoConexao } from '../src/whatsapp/baileys.js'

const pasta = mkdtempSync(join(tmpdir(), 'previa-painel-'))
const db = abrirBanco(join(pasta, 'banco.sqlite'))
const repo = new Repositorio(db)
const numeros = new RepoNumeros(db)
const grupos = new RepoGrupos(db)
const botsGrupos = new RepoBotsGrupos(db)
const agora = Date.now()

repo.salvarBot(
  'VEND-OUT26',
  JSON.stringify({ ...botModelo('2026-10-06'), codigo: 'VEND-OUT26', vaga: 'Vendedor(a) de loja', status: 'aberto', encerra_em: '2026-12-31' }),
  1,
  'demo',
  agora
)
const g = numeros.criar('Avisos da Loja', 'grupos', agora)
numeros.criar('Reserva', 'grupos', agora)
const bot = botsGrupos.criarBot('Equipe Loja Exemplo', g.id, agora)
const nomes = ['Loja Centro', 'Loja Mangabeira', 'Gerentes', 'Estoque', 'Vendas Online', 'Marketing', 'Financeiro', 'RH Avisos']
nomes.forEach((n, i) => grupos.salvarGrupo(g.id, `1203630${i}@g.us`, n, i % 3 !== 2, agora))
for (const i of [0, 1, 2]) botsGrupos.ativarGrupo(bot, `1203630${i}@g.us`, 'demo', agora - i * 86_400_000)
botsGrupos.adicionarPalavras(bot, '12036300@g.us', ['golpe', 'pix gratis'])
botsGrupos.definirSilencio(bot, '12036301@g.us', '22:00', '06:00', 'demo', agora)
const ana = grupos.salvarFuncionario(null, { nome: 'Ana Souza', telefone: '5583999990001', lid: null, ativo: true }, agora)
const bia = grupos.salvarFuncionario(null, { nome: 'Beatriz Lima', telefone: '5583999990002', lid: null, ativo: true }, agora)
botsGrupos.indicarGestor(bot, ana, 'demo', agora)
botsGrupos.confirmarGestor(bot, ana, '5583999990001@s.whatsapp.net', agora)
botsGrupos.indicarGestor(bot, bia, 'demo', agora)
botsGrupos.salvarProgramada(
  null,
  bot,
  {
    jid: '12036300@g.us',
    origem: 'painel',
    horarios: ['08:00', '18:30'],
    dias: [1, 2, 3, 4, 5, 6],
    data: null,
    variar: true,
    mencionar: true,
    variacoes: [{ texto: 'Bom dia, equipe! Lembrem de conferir o estoque.', midia: null }, { texto: 'Bom dia! Estoque conferido?', midia: null }]
  },
  'demo',
  agora
)
botsGrupos.salvarProgramada(
  null,
  bot,
  { jid: '12036301@g.us', origem: 'repeat', horarios: ['12:00'], dias: [0, 1, 2, 3, 4, 5, 6], data: null, variar: false, mencionar: false, variacoes: [{ texto: 'Horário de almoço: 12h às 13h.', midia: null }] },
  'wa:5583999990001',
  agora
)

const estados = new Map<number, EstadoConexao>([
  [1, { status: 'conectado', qr: null, desde: agora - 3_600_000, numero: '5583900001111', motivo: null }],
  [g.id, { status: 'conectado', qr: null, desde: agora - 86_400_000, numero: '5583900002222', motivo: null }]
])
const app = await criarPainel({
  repo,
  numeros,
  grupos,
  botsGrupos,
  bots: new FonteBots(repo, lerPadrao(join(import.meta.dirname, '..', 'config'))),
  armazem: new ArmazemArquivos(pasta),
  log: pino({ level: 'silent' }),
  conexoes: {
    estado: (id) => estados.get(id) ?? null,
    novaSessao: async (id) => void estados.set(id, { status: 'aguardando_qr', qr: 'QR-DEMONSTRACAO', desde: Date.now(), numero: null, motivo: null }),
    revogar: async (id) => void estados.set(id, { status: 'aguardando_qr', qr: 'QR-DEMONSTRACAO', desde: Date.now(), numero: null, motivo: null }),
    ativar: async (n) => void estados.set(n.id, { status: 'aguardando_qr', qr: 'QR-DEMONSTRACAO', desde: Date.now(), numero: null, motivo: null }),
    desativar: async (id) => void estados.delete(id)
  },
  usuarios: new Map([['demo', hashSenha('demonstracao')]]),
  segredo: 'p'.repeat(40),
  cookieSeguro: false,
  backupAtivo: false,
  alertaAtivo: false
})
await app.listen({ host: '127.0.0.1', port: 3199 })
console.log('prévia em http://127.0.0.1:3199 (demo / demonstracao)')
