import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import pino from 'pino'
import { lerAmbiente } from './ambiente.js'
import { ArmazemArquivos } from './arquivos.js'
import { FonteBots } from './config/bots.js'
import { lerPadrao, lerYamlProcessos } from './config/carregar.js'
import { Orquestrador } from './conversa/orquestrador.js'
import { abrirBanco } from './db/banco.js'
import { RepoNumeros } from './db/numeros.js'
import { Repositorio } from './db/repositorio.js'
import { criarPainel } from './painel/servidor.js'
import { Alertas, VigiaConexao } from './rotinas/alerta.js'
import { apagarBackupsAntigos, fazerBackup } from './rotinas/backup.js'
import { aplicarRetencao } from './rotinas/retencao.js'
import { ConexaoBaileys } from './whatsapp/baileys.js'
import { Expedidor } from './whatsapp/expedidor.js'
import { moverSessaoAntiga, pastaSessaoNumero } from './whatsapp/gerenciador.js'

const amb = lerAmbiente()
// Logs nunca levam conteúdo de mensagem nem dados de candidato: só IDs.
const log = pino({ level: amb.logNivel, base: undefined })

await mkdir(amb.dados, { recursive: true, mode: 0o700 })
const db = abrirBanco(join(amb.dados, 'banco.sqlite'))
const repo = new Repositorio(db)
if (await moverSessaoAntiga(amb.dados)) log.info('sessão do WhatsApp movida para sessoes/1')
const armazem = new ArmazemArquivos(amb.dados)

// Bots ficam no banco e são editados pelo painel. Os YAML antigos só entram na primeira subida.
const config = new FonteBots(repo, lerPadrao(amb.config), amb.empresa)
const importacao = config.importarYaml(lerYamlProcessos(amb.config), Date.now())
if (importacao.importados.length) log.info({ bots: importacao.importados }, 'bots importados dos arquivos YAML')
for (const e of [...importacao.erros, ...config.get().erros]) log.error(`bot com erro: ${e}`)

const alertas = new Alertas({ smtpUrl: amb.smtpUrl, de: amb.alertaDe, para: amb.alertaPara }, log)
const vigia = new VigiaConexao(alertas)

let expedidor: Expedidor | null = null
const conexao: ConexaoBaileys = new ConexaoBaileys({
  numeroId: 1,
  papel: 'recrutamento',
  pastaSessao: pastaSessaoNumero(amb.dados, 1),
  repo,
  log,
  janelaMs: amb.janelaMs,
  aoReceber: (m) => orquestrador.receber(m),
  aoMudarEstado: (e) => {
    vigia.verificar(e)
    if (e.status === 'conectado') void expedidor?.acordar()
  }
})

const orquestrador = new Orquestrador({
  repo,
  config: () => config.get(),
  baixarMidia: (_numeroId, bruto) => conexao.baixarMidia(bruto),
  armazem,
  log,
  aoEnfileirar: () => void expedidor?.acordar()
})

expedidor = new Expedidor({ numeroId: 1, repo, conexao, log, janelaMs: amb.janelaMs })

orquestrador.retomarPendentes()
await conexao.iniciar()
expedidor.iniciar()

const timers: NodeJS.Timeout[] = [
  setInterval(() => orquestrador.verificarFinalizacoes(), 5_000),
  setInterval(() => orquestrador.retomarPendentes(), 60_000),
  setInterval(() => vigia.verificar(conexao.estadoAtual), 60_000),
  setInterval(() => void rotinaDiaria(), 10 * 60_000)
]

/** Uma vez por dia, a partir das 3h (Brasília): retenção, limpeza e backup. */
async function rotinaDiaria(): Promise<void> {
  const agora = Date.now()
  const local = new Date(agora - 3 * 60 * 60 * 1000)
  const hoje = local.toISOString().slice(0, 10)
  if (local.getUTCHours() < 3 || repo.meta('rotina_diaria') === hoje) return
  repo.definirMeta('rotina_diaria', hoje)
  try {
    await aplicarRetencao({ repo, config: config.get(), armazem, log, agora })
  } catch (err) {
    log.error({ err }, 'falha na retenção')
  }
  if (!amb.backupSenha) return
  try {
    const arquivo = await fazerBackup({ db, dados: amb.dados, senha: amb.backupSenha, agora })
    await apagarBackupsAntigos(amb.dados, amb.backupRetencaoDias, agora)
    repo.definirMeta('ultimo_backup', new Date(agora).toISOString())
    log.info({ arquivo }, 'backup concluído')
  } catch (err) {
    log.error({ err }, 'falha no backup')
    void alertas.enviar('Falha no backup diário', String((err as Error).message))
  }
}

const painel = await criarPainel({
  repo,
  bots: config,
  numeros: new RepoNumeros(db),
  armazem,
  conexao: { estado: () => conexao.estadoAtual, novaSessao: () => conexao.novaSessao() },
  usuarios: amb.painelUsuarios,
  segredo: amb.painelSegredo,
  cookieSeguro: amb.cookieSeguro,
  backupAtivo: !!amb.backupSenha,
  alertaAtivo: alertas.ativo
})
await painel.listen({ host: amb.painelHost, port: amb.painelPorta })
log.info({ host: amb.painelHost, porta: amb.painelPorta }, 'painel no ar')

let desligando = false
async function desligar(sinal: string): Promise<void> {
  if (desligando) return
  desligando = true
  log.info({ sinal }, 'desligando')
  for (const t of timers) clearInterval(t)
  expedidor?.parar()
  await painel.close()
  await orquestrador.ocioso()
  await conexao.parar()
  db.close()
  process.exit(0)
}
process.on('SIGINT', () => void desligar('SIGINT'))
process.on('SIGTERM', () => void desligar('SIGTERM'))
