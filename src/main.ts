import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import pino from 'pino'
import { lerAmbiente } from './ambiente.js'
import { ArmazemArquivos } from './arquivos.js'
import { FonteBots } from './config/bots.js'
import { lerPadrao, lerYamlProcessos } from './config/carregar.js'
import { Orquestrador } from './conversa/orquestrador.js'
import { abrirBanco } from './db/banco.js'
import { RepoBotsGrupos } from './db/bots-grupos.js'
import { RepoGrupos } from './db/grupos.js'
import { RepoNumeros } from './db/numeros.js'
import { Repositorio } from './db/repositorio.js'
import { ExpedidorGrupos } from './grupos/expedidor.js'
import { OrquestradorGrupos } from './grupos/orquestrador.js'
import { criarPainel } from './painel/servidor.js'
import { Alertas, VigiaConexao } from './rotinas/alerta.js'
import { apagarBackupsAntigos, fazerBackup } from './rotinas/backup.js'
import { aplicarRetencao } from './rotinas/retencao.js'
import { ConexaoBaileys } from './whatsapp/baileys.js'
import { Expedidor } from './whatsapp/expedidor.js'
import { GerenciadorConexoes, moverSessaoAntiga, pastaSessaoNumero } from './whatsapp/gerenciador.js'

const amb = lerAmbiente()
// Logs nunca levam conteúdo de mensagem nem dados de candidato ou funcionário: só IDs.
const log = pino({ level: amb.logNivel, base: undefined })
// Uma promessa esquecida não pode derrubar o bot em silêncio: registra e segue.
// Exceção síncrona não tratada (uncaughtException) continua derrubando o processo.
process.on('unhandledRejection', (err) => log.error({ err }, 'promessa rejeitada sem tratamento'))

await mkdir(amb.dados, { recursive: true, mode: 0o700 })
const db = abrirBanco(join(amb.dados, 'banco.sqlite'))
const repo = new Repositorio(db)
const numeros = new RepoNumeros(db)
const grupos = new RepoGrupos(db)
const botsGrupos = new RepoBotsGrupos(db)
const armazem = new ArmazemArquivos(amb.dados)
// Só depois da migração do banco: a sessão de antes vira a do número 1.
if (await moverSessaoAntiga(amb.dados)) log.info('sessão do WhatsApp movida para sessoes/1')

// Bots ficam no banco e são editados pelo painel. Os YAML antigos só entram na primeira subida.
const config = new FonteBots(repo, lerPadrao(amb.config), amb.empresa)
const importacao = config.importarYaml(lerYamlProcessos(amb.config), Date.now())
if (importacao.importados.length) log.info({ bots: importacao.importados }, 'bots importados dos arquivos YAML')
for (const e of [...importacao.erros, ...config.get().erros]) log.error(`bot com erro: ${e}`)

const alertas = new Alertas({ smtpUrl: amb.smtpUrl, de: amb.alertaDe, para: amb.alertaPara }, log)
const vigias = new Map<number, VigiaConexao>()

function conexaoAtiva(numeroId: number): ConexaoBaileys {
  const c = gerenciador.conexao(numeroId)
  if (!c) throw new Error(`número ${numeroId} desativado`)
  return c
}

const orquestrador = new Orquestrador({
  repo,
  config: () => config.get(),
  baixarMidia: (numeroId, bruto) => conexaoAtiva(numeroId).baixarMidia(bruto),
  armazem,
  log,
  aoEnfileirar: (numeroId) => gerenciador.acordar(numeroId)
})

const orquestradorGrupos = new OrquestradorGrupos({
  repo,
  grupos,
  bots: botsGrupos,
  conexao: (numeroId) => gerenciador.conexao(numeroId),
  telefoneDoNumero: (numeroId) => gerenciador.estado(numeroId)?.numero ?? null,
  log,
  conectadoDesde: (numeroId) => {
    const e = gerenciador.estado(numeroId)
    return e?.status === 'conectado' ? e.desde : null
  },
  aoEnfileirar: (numeroId) => gerenciador.acordar(numeroId)
})

const gerenciador: GerenciadorConexoes<ConexaoBaileys> = new GerenciadorConexoes((n) => {
  const vigia = new VigiaConexao(alertas, Date.now, n.nome)
  vigias.set(n.id, vigia)
  const conexao = new ConexaoBaileys({
    numeroId: n.id,
    papel: n.papel,
    pastaSessao: pastaSessaoNumero(amb.dados, n.id),
    repo,
    log: log.child({ numero: n.id }),
    janelaMs: amb.janelaMs,
    aoReceber: (m) => orquestrador.receber(m),
    aoComando: (m) => orquestradorGrupos.receber(m),
    aoEventoGrupos: (e) => orquestradorGrupos.eventoGrupos(n.id, e),
    aoMudarEstado: (e) => {
      vigia.verificar(e)
      if (e.status === 'conectado') gerenciador.acordar(n.id)
    }
  })
  const expedidor =
    n.papel === 'grupos'
      ? new ExpedidorGrupos({ numeroId: n.id, grupos, conexao, log })
      : new Expedidor({ numeroId: n.id, repo, conexao, log, janelaMs: amb.janelaMs })
  return { conexao, expedidor }
}, log)

orquestrador.retomarPendentes()
await gerenciador.iniciarTodos(numeros.listar())

const timers: NodeJS.Timeout[] = [
  setInterval(() => orquestrador.verificarFinalizacoes(), 5_000),
  setInterval(() => orquestrador.retomarPendentes(), 60_000),
  setInterval(() => {
    for (const [id, estado] of gerenciador.estados()) vigias.get(id)?.verificar(estado)
  }, 60_000),
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
  numeros,
  grupos,
  bots: config,
  armazem,
  log,
  conexoes: {
    estado: (id) => gerenciador.estado(id),
    novaSessao: (id) => gerenciador.novaSessao(id),
    ativar: (n) => gerenciador.adicionar(n),
    desativar: async (id) => {
      await gerenciador.parar(id)
      vigias.delete(id)
    }
  },
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
  // Primeiro para de enviar (nenhum envio novo começa), depois de aceitar pedidos do
  // painel; só então espera os orquestradores e fecha as conexões e o banco.
  for (const t of timers) clearInterval(t)
  gerenciador.pararExpedidores()
  await painel.close()
  await orquestrador.ocioso()
  await orquestradorGrupos.ocioso()
  await gerenciador.pararTodos()
  db.close()
  process.exit(0)
}
process.on('SIGINT', () => void desligar('SIGINT'))
process.on('SIGTERM', () => void desligar('SIGTERM'))
