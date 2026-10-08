// Gera as páginas do painel com dados de demonstração (fictícios) em docs/img/*.html.
// As imagens do README são tiradas delas com um navegador headless:
//   npx tsx scripts/gerar-capturas.ts && (ver docs/img/README para o comando do navegador)
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import QRCode from 'qrcode'
import { botModelo } from '../src/config/bots.js'
import { lerPadrao, montarConfig } from '../src/config/carregar.js'
import type { CandidatoPainel } from '../src/db/repositorio.js'
import { paginaEditorBot } from '../src/painel/editor.js'
import { paginaProcesso, paginaProcessos, paginaSaude } from '../src/painel/paginas.js'
import { paginaNumero } from '../src/painel/paginas-numeros.js'

const saida = join(import.meta.dirname, '..', 'docs', 'img')
mkdirSync(saida, { recursive: true })
const padrao = lerPadrao(join(import.meta.dirname, '..', 'config'))
const agora = Date.UTC(2026, 9, 12, 14)

const vendas = { ...botModelo('2026-10-06'), codigo: 'VEND-OUT26', vaga: 'Vendedor(a) de loja', status: 'aberto' as const, encerra_em: '2026-10-31' }
const caixa = {
  ...botModelo('2026-10-10'),
  codigo: 'CAIXA-NOV26',
  vaga: 'Operador(a) de caixa',
  status: 'rascunho' as const,
  encerra_em: '2026-11-30'
}
const config = montarConfig(padrao, [{ origem: 'a', dados: vendas }, { origem: 'b', dados: caixa }], agora, 'Loja Exemplo')
const numero = '5583900000000'

const arquivo = (id: number, ext: string) => ({ id, candidatura_id: id, lote: 1, caminho: '', ext, mimetype: '', tamanho: 1, hash: '', recebido_em: agora })
const candidatos: CandidatoPainel[] = [
  ['Ana Souza', 'João Pessoa, Mangabeira', 'Tarde', 'A combinar', 'pdf'],
  ['Bruno Lima', 'Cabedelo, Centro', 'Integral', 'R$ 1.900', 'jpg'],
  ['Carla Mendes', 'João Pessoa, Bancários', 'Manhã', 'R$ 1.700', 'docx'],
  ['Diego Alves', 'Bayeux, Centro', '', '', '']
].map(([nome, cidade, disp, pret, ext], i) => ({
  id: i + 1,
  protocolo: `VEND-OUT26-000${i + 1}`,
  processo: 'VEND-OUT26',
  telefone: `55839999900${i}${i}`,
  status: ext ? ('concluida' as const) : ('em_andamento' as const),
  passo: ext ? 'fim' : 'disponibilidade',
  criadaEm: agora - (4 - i) * 3600_000,
  concluidaEm: ext ? agora - (4 - i) * 3500_000 : null,
  respostas: Object.fromEntries(
    Object.entries({ nome, cidade, disponibilidade: disp, pretensao: pret }).filter(([, v]) => v)
  ) as Record<string, string>,
  arquivos: ext ? [arquivo(i + 1, ext!)] : []
}))

const resumo = new Map([['VEND-OUT26', { total: 4, concluidas: 3 }]])
const qr = await QRCode.toDataURL('demonstracao-ttalk-bot-manager', { margin: 1, width: 280 })

const numeros = [{ id: 1, nome: 'Principal', ativo: true, telefone: numero }]

const paginas: Record<string, string> = {
  bots: paginaProcessos(config, resumo, numeros, 'rh', agora, null),
  editor: paginaEditorBot({
    dados: vendas,
    padrao,
    original: 'VEND-OUT26',
    candidaturas: 4,
    erro: null,
    usuario: 'rh',
    numeros: [{ id: 1, nome: 'Principal' }]
  }),
  candidatos: paginaProcesso('VEND-OUT26', config.processos[0], candidatos, 'rh'),
  // O QR chega por JavaScript na tela real; aqui vai direto na imagem.
  conexao: paginaNumero(
    { id: 1, nome: 'Principal', papel: 'recrutamento', ativo: true, pausado: false, criadoEm: agora },
    { status: 'aguardando_qr', qr: 'x', desde: agora, numero: null, motivo: null },
    [{ nome: 'Vendedor(a) de loja', href: '/bots/VEND-OUT26' }],
    'rh',
    null,
    null
  )
    .replace(/<img id="qr-img"([^>]*) hidden>/, `<img id="qr-img" src="${qr}"$1>`)
    .replace('<span id="qr-texto" class="suave">', '<span id="qr-texto" class="suave" hidden>'),
  saude: paginaSaude(
    {
      numeros: [
        {
          numero: { id: 1, nome: 'Principal', papel: 'recrutamento', ativo: true, pausado: false, criadoEm: agora },
          estado: { status: 'conectado', qr: null, desde: agora - 86400_000, numero, motivo: null },
          ultimaMensagem: agora - 600_000
        }
      ],
      filas: { entrada: 0, saida: 0, erros: 0 },
      ultimoBackup: new Date(agora - 8 * 3600_000).toISOString(),
      backupAtivo: true,
      alertaAtivo: true,
      config
    },
    'rh'
  )
}
for (const [nome, html] of Object.entries(paginas)) writeFileSync(join(saida, `${nome}.html`), html)
console.log(`páginas em ${saida}`)
