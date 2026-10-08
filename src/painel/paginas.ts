import { situacao } from '../config/carregar.js'
import type { ConfigCarregada, Processo } from '../config/tipos.js'
import type { CandidatoPainel } from '../db/repositorio.js'
import type { Numero } from '../db/numeros.js'
import type { EstadoConexao } from '../whatsapp/baileys.js'
import { colunasDeResposta, dataBR } from './exportar.js'

export function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

const CSS = `
:root{color-scheme:light;--fundo:#f3f5f7;--sup:#fff;--sup2:#f8fafb;--texto:#17202b;--suave:#5f6b7a;--borda:#e2e7ed;--marca:#0e7a5f;--marca-forte:#0a6650;--marca-fundo:#e5f3ee;
--ok:#15803d;--ok-fundo:#e8f6ed;--alerta:#b45309;--alerta-fundo:#fdf3e5;--erro:#b91c1c;--erro-fundo:#fdeceb;--lateral:#0f1720;--lateral-texto:#a9b4c2;--sombra:0 1px 2px rgba(16,24,40,.05)}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--fundo:#0d1117;--sup:#151b23;--sup2:#1b232d;--texto:#e6edf3;--suave:#9aa6b2;--borda:#27313d;--marca:#34b38a;--marca-forte:#4cc79f;--marca-fundo:#12352b;
--ok:#4ade80;--ok-fundo:#10291b;--alerta:#f5a524;--alerta-fundo:#33240d;--erro:#f87171;--erro-fundo:#3a1616;--lateral:#0a0e14;--lateral-texto:#94a0ae;--sombra:none}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--fundo);color:var(--texto);min-height:100vh}
a{color:var(--marca)}h1,h2,h3{line-height:1.25;margin:0}h1{font-size:1.4rem}h2{font-size:1.05rem}h3{font-size:.95rem}
.app{display:grid;grid-template-columns:232px minmax(0,1fr);min-height:100vh}
.lateral{position:sticky;top:0;height:100vh;background:var(--lateral);color:var(--lateral-texto);display:flex;flex-direction:column;padding:18px 12px;gap:4px}
.marca{display:flex;align-items:center;gap:10px;color:#fff;font-weight:700;font-size:1rem;padding:4px 10px 18px;text-decoration:none}
.marca i{display:grid;place-items:center;width:30px;height:30px;border-radius:8px;background:var(--marca);font-style:normal}
.nav{display:flex;flex-direction:column;gap:2px}
.nav a{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:8px;color:var(--lateral-texto);text-decoration:none;font-weight:500}
.nav a:hover{background:rgba(255,255,255,.06);color:#fff}.nav a.atual{background:rgba(255,255,255,.1);color:#fff}
.nav svg{width:18px;height:18px;flex:none;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.sair{margin-top:auto;padding:12px 10px 0;border-top:1px solid rgba(255,255,255,.08);display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:.85rem}
.sair button{background:transparent;border-color:rgba(255,255,255,.18);color:var(--lateral-texto);min-height:30px;padding:4px 10px}
.barra,.veu{display:none}.corpo{min-width:0}
main{padding:28px 32px 48px;max-width:1240px;width:100%;margin:0 auto;min-width:0}
.cabecalho{display:flex;justify-content:space-between;align-items:flex-start;gap:12px 16px;flex-wrap:wrap;margin-bottom:20px}
.cabecalho .titulo{display:flex;flex-direction:column;gap:6px;min-width:0}.cabecalho .titulo h1{overflow-wrap:anywhere}
.voltar{display:inline-flex;align-items:center;gap:4px;color:var(--suave);text-decoration:none;font-size:.88rem;margin-bottom:10px}.voltar:hover{color:var(--texto)}
.cartao{background:var(--sup);border:1px solid var(--borda);border-radius:12px;padding:18px;margin-bottom:16px;box-shadow:var(--sombra);min-width:0}
.cartao>h2:first-child,.cartao>.topo:first-child{margin-bottom:14px}
.topo{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
.secao{margin:28px 0 12px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
.linha{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.linha form{margin:0}
.grade2{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr));gap:16px;align-items:start}
.suave{color:var(--suave)}.ok{color:var(--ok)}.alerta{color:var(--alerta)}.erro{color:var(--erro)}.pequeno{font-size:.85rem}
button,.botao{font:inherit;font-weight:500;min-height:36px;padding:7px 14px;border-radius:8px;border:1px solid var(--borda);background:var(--sup);color:var(--texto);
cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;line-height:1.2}
button:hover,.botao:hover{border-color:var(--suave)}button:disabled{opacity:.5;cursor:not-allowed}
.primario{background:var(--marca)!important;border-color:var(--marca)!important;color:#fff!important}.primario:hover{background:var(--marca-forte)!important}
.perigo{color:var(--erro)!important}.perigo:hover{border-color:var(--erro)!important}
.mini{min-height:30px;padding:4px 10px;font-size:.85rem}
input,select,textarea{font:inherit;padding:9px 11px;border:1px solid var(--borda);border-radius:8px;width:100%;background:var(--sup);color:var(--texto);min-height:38px}
input:focus,select:focus,textarea:focus,button:focus-visible,.botao:focus-visible{outline:2px solid var(--marca);outline-offset:1px}
input[type=checkbox],input[type=radio]{width:18px;height:18px;min-height:0;accent-color:var(--marca);flex:none;margin:0}
textarea{resize:vertical}label{display:block}
.campos{display:grid;gap:14px;max-width:620px}.campos.largo{max-width:none}
.campo>span{display:block;font-size:.85rem;font-weight:500;margin-bottom:5px}
.marcar{display:flex;align-items:center;gap:8px;cursor:pointer}
.acoes{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
code{font-size:.85em;word-break:break-all;background:var(--sup2);border:1px solid var(--borda);border-radius:5px;padding:1px 5px}
.selo{display:inline-flex;align-items:center;gap:6px;font-size:.78rem;font-weight:600;line-height:1.3;padding:3px 9px;border-radius:99px;background:var(--sup2);color:var(--suave);border:1px solid var(--borda);white-space:nowrap}
.selo::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.8}
.selo.ok{color:var(--ok);background:var(--ok-fundo);border-color:transparent}.selo.alerta{color:var(--alerta);background:var(--alerta-fundo);border-color:transparent}
.selo.erro{color:var(--erro);background:var(--erro-fundo);border-color:transparent}.selo.marca{color:var(--marca);background:var(--marca-fundo);border-color:transparent}
.abas{display:flex;gap:4px;border-bottom:1px solid var(--borda);margin:0 0 20px;overflow-x:auto;scrollbar-width:none}
.abas a{padding:9px 14px;text-decoration:none;color:var(--suave);border-bottom:2px solid transparent;white-space:nowrap;font-weight:500;margin-bottom:-1px}
.abas a:hover{color:var(--texto)}.abas a.atual{color:var(--texto);border-bottom-color:var(--marca)}
.numeros{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}
.numeros .cartao{margin:0;padding:14px 16px}.numeros strong{display:block;font-size:1.55rem;line-height:1.2}.numeros span{color:var(--suave);font-size:.85rem}
.aviso{padding:12px 16px;border-radius:10px;margin-bottom:16px;font-weight:500}
.aviso.ok{background:var(--ok-fundo);color:var(--ok)}.aviso.erro{background:var(--erro-fundo);color:var(--erro)}.aviso.alerta{background:var(--alerta-fundo);color:var(--alerta)}
.vazio{text-align:center;padding:28px 16px;color:var(--suave)}
.tabela{border-collapse:collapse;width:100%}
.tabela th,.tabela td{text-align:left;padding:11px 12px;border-bottom:1px solid var(--borda);vertical-align:middle}
.tabela th{font-size:.75rem;text-transform:uppercase;letter-spacing:.04em;color:var(--suave);font-weight:600}
.tabela tbody tr:last-child td{border-bottom:0}.tabela tr.apagada td{opacity:.6}
.tabela td.fim{text-align:right}.tabela td.fim .acoes{justify-content:flex-end}
.nome{font-weight:600;color:var(--texto);text-decoration:none}a.nome:hover{color:var(--marca)}
.sub{display:block;color:var(--suave);font-size:.84rem;font-weight:400}
.envolve{overflow-x:auto;margin:-4px -18px;padding:0 18px}
.chave{min-width:96px}.chave.ligada{background:var(--ok-fundo);color:var(--ok);border-color:transparent}
.codigo{font:700 1.6rem/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.14em}
.qr{display:grid;place-items:center;gap:12px;padding:8px 0}.qr img{background:#fff;padding:10px;border-radius:12px;width:min(280px,100%);height:auto}
dl.dados{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:10px 18px;margin:0}dl.dados dt{color:var(--suave)}dl.dados dd{margin:0;overflow-wrap:anywhere}
.fichas{display:flex;gap:6px;flex-wrap:wrap}
.zona{border-color:var(--erro-fundo)}
.entrar{min-height:100vh;display:grid;place-items:center;padding:16px}.entrar .cartao{width:min(380px,100%);padding:26px}
.entrar h1{margin-bottom:18px}
@media (max-width:900px){
  .app{grid-template-columns:minmax(0,1fr)}
  .barra{display:flex;align-items:center;gap:12px;position:sticky;top:0;z-index:20;background:var(--lateral);color:#fff;padding:10px 16px;font-weight:700}
  .barra label{display:grid;place-items:center;width:36px;height:36px;border-radius:8px;cursor:pointer;font-size:1.2rem;border:1px solid rgba(255,255,255,.15)}
  .lateral{position:fixed;z-index:40;left:0;top:0;width:260px;transform:translateX(-100%);transition:transform .2s ease}
  #menu:checked~.app .lateral{transform:none}
  .veu{display:none;position:fixed;inset:0;z-index:30;background:rgba(0,0,0,.45)}#menu:checked~.app .veu{display:block}
  main{padding:20px 16px 40px}
}
@media (max-width:720px){
  .tabela thead{display:none}.tabela,.tabela tbody,.tabela tr,.tabela td{display:block;width:100%}
  .tabela tr{border:1px solid var(--borda);border-radius:10px;padding:6px 12px;margin-bottom:10px;background:var(--sup)}
  .tabela td{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px 12px;border:0;padding:7px 0;text-align:right}
  .tabela td>*{max-width:100%}.tabela .fichas{justify-content:flex-end}
  .tabela td::before{content:attr(data-r);color:var(--suave);font-size:.8rem;text-align:left;flex:none}
  .tabela td[data-r=""]{display:block;text-align:left}.tabela td[data-r=""]::before{display:none}
  .tabela td.fim .acoes{justify-content:flex-start}.tabela tbody tr:last-child td{border-bottom:0}
  .tabela td.vazio{display:block;text-align:center}.tabela td.vazio::before{display:none}
  .envolve{margin:0;padding:0;overflow:visible}.cartao{padding:14px}
  .abas{gap:0}.abas a{padding:9px 9px;font-size:.92rem}
  dl.dados{grid-template-columns:minmax(0,1fr)}dl.dados dt{margin-top:6px}
  .cabecalho .acoes{width:100%}
}
`

export type Secao = 'bots' | 'numeros' | 'saude' | 'auditoria'

const ICONES: Record<Secao, string> = {
  bots: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M9 11h.01M15 11h.01"/>',
  numeros: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18h2"/>',
  saude: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
  auditoria: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>'
}

const NAV: { secao: Secao; href: string; rotulo: string }[] = [
  { secao: 'bots', href: '/', rotulo: 'Bots' },
  { secao: 'numeros', href: '/numeros', rotulo: 'Números' },
  { secao: 'saude', href: '/saude', rotulo: 'Saúde' },
  { secao: 'auditoria', href: '/auditoria', rotulo: 'Auditoria' }
]

export interface OpcoesLayout {
  /** Item da barra lateral marcado como atual. */
  secao?: Secao
  /** Conteúdo extra no <head> (estilo próprio da página, refresh). */
  head?: string
}

export function layout(titulo: string, corpo: string, usuario: string | null, o: OpcoesLayout = {}): string {
  const head = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titulo)} · Ttalk Bot Manager</title><meta name="robots" content="noindex"><style>${CSS}</style>${o.head ?? ''}</head>`
  if (!usuario) return `${head}<body><div class="entrar">${corpo}</div></body></html>`
  const nav = NAV.map(
    (n) =>
      `<a href="${n.href}"${n.secao === o.secao ? ' class="atual" aria-current="page"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true">${ICONES[n.secao]}</svg>${n.rotulo}</a>`
  ).join('')
  return `${head}<body><input type="checkbox" id="menu" hidden>
<div class="app"><aside class="lateral"><a class="marca" href="/"><i>T</i>Ttalk Bot Manager</a><nav class="nav" aria-label="Menu">${nav}</nav>
<form class="sair" method="post" action="/sair"><span>${esc(usuario)}</span><button>Sair</button></form></aside>
<label for="menu" class="veu" aria-hidden="true"></label>
<div class="corpo"><div class="barra"><label for="menu" aria-label="Abrir menu">☰</label>Ttalk Bot Manager</div><main>${corpo}</main></div></div></body></html>`
}

export type Tom = 'ok' | 'alerta' | 'erro' | 'marca' | ''

/** Selo colorido: ok (verde), alerta (laranja), erro (vermelho), marca ou neutro. */
export function selo(texto: string, tom: Tom = ''): string {
  return `<span class="selo${tom ? ` ${tom}` : ''}">${esc(texto)}</span>`
}

/** Abas de uma página com sub-páginas. `atual` é o href da aba aberta. */
export function abas(itens: { href: string; rotulo: string }[], atual: string): string {
  // Em tela estreita as abas rolam de lado: a aba aberta é trazida para a vista.
  return `<nav class="abas">${itens.map((i) => `<a href="${esc(i.href)}"${i.href === atual ? ' class="atual" aria-current="page"' : ''}>${esc(i.rotulo)}</a>`).join('')}</nav>
    <script>(function(){var a=document.querySelector('.abas .atual');if(a&&a.parentNode.scrollWidth>a.parentNode.clientWidth)a.parentNode.scrollLeft=a.offsetLeft-16})()</script>`
}

/** Faixa de números-resumo no topo de uma página. */
export function resumo(itens: { valor: string | number; rotulo: string }[]): string {
  return `<div class="numeros">${itens.map((i) => `<div class="cartao"><strong>${esc(i.valor)}</strong><span>${esc(i.rotulo)}</span></div>`).join('')}</div>`
}

/** Aviso de sucesso (verde) ou erro (vermelho) no topo de uma página. */
export function mensagem(ok: string | null, erro: string | null = null): string {
  return `${ok ? `<div class="aviso ok" role="status">${esc(ok)}</div>` : ''}${erro ? `<div class="aviso erro" role="alert">${esc(erro)}</div>` : ''}`
}

/** Título da página com, opcionalmente, um link de volta, selos ao lado e ações à direita. */
export function cabecalho(titulo: string, o: { voltar?: { href: string; rotulo: string }; selos?: string; acoes?: string } = {}): string {
  return `${o.voltar ? `<a class="voltar" href="${esc(o.voltar.href)}">← ${esc(o.voltar.rotulo)}</a>` : ''}
    <div class="cabecalho"><div class="titulo"><h1>${esc(titulo)}</h1>${o.selos ? `<div class="fichas">${o.selos}</div>` : ''}</div>${o.acoes ? `<div class="acoes">${o.acoes}</div>` : ''}</div>`
}

export interface Coluna {
  rotulo: string
  /** Célula de ações: alinhada à direita. */
  fim?: boolean
}

/**
 * Tabela padrão. No celular cada linha vira um cartão e cada célula mostra o rótulo da coluna ao lado
 * (a primeira coluna, sem rótulo, vira o título do cartão).
 */
export function tabela(colunas: Coluna[], linhas: { celulas: string[]; classe?: string; atributos?: string }[], vazio: string): string {
  const corpo = linhas.length
    ? linhas
        .map(
          (l) =>
            `<tr${l.classe ? ` class="${l.classe}"` : ''}${l.atributos ? ` ${l.atributos}` : ''}>${l.celulas
              .map((c, i) => `<td data-r="${i === 0 ? '' : esc(colunas[i]?.rotulo ?? '')}"${colunas[i]?.fim ? ' class="fim"' : ''}>${c}</td>`)
              .join('')}</tr>`
        )
        .join('')
    : `<tr><td colspan="${colunas.length}" class="vazio">${vazio}</td></tr>`
  return `<div class="envolve"><table class="tabela"><thead><tr>${colunas.map((c) => `<th${c.fim ? ' class="fim"' : ''}>${esc(c.rotulo)}</th>`).join('')}</tr></thead><tbody>${corpo}</tbody></table></div>`
}

/** Botão que envia um POST (com confirmação, se `confirma`). Campos extras vão escondidos. */
export function botaoPost(
  acao: string,
  rotulo: string,
  o: { classe?: string; confirma?: string; campos?: Record<string, string | number>; desabilitado?: string } = {}
): string {
  const campos = Object.entries(o.campos ?? {})
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('')
  const confirma = o.confirma ? ` data-confirma="${esc(o.confirma)}" onsubmit="return confirm(this.dataset.confirma)"` : ''
  const desab = o.desabilitado ? ` disabled title="${esc(o.desabilitado)}"` : ''
  return `<form method="post" action="${esc(acao)}"${confirma}>${campos}<button${o.classe ? ` class="${o.classe}"` : ''}${desab}>${esc(rotulo)}</button></form>`
}

export function paginaLogin(erro: string | null): string {
  return layout(
    'Entrar',
    `<div class="cartao"><a class="marca" style="color:var(--texto);padding:0 0 18px"><i style="color:#fff">T</i>Ttalk Bot Manager</a>
      ${erro ? `<div class="aviso erro" role="alert">${esc(erro)}</div>` : ''}
      <form method="post" action="/login" class="campos">
        <label class="campo"><span>Usuário</span><input name="usuario" autocomplete="username" required autofocus></label>
        <label class="campo"><span>Senha</span><input name="senha" type="password" autocomplete="current-password" required></label>
        <button class="primario">Entrar</button>
      </form></div>`,
    null
  )
}

const SITUACAO_BOT = { aberto: selo('aberto', 'ok'), fechado: selo('encerrado'), rascunho: selo('rascunho', 'alerta') }

function periodo(p: Processo): string {
  const f = (ms: number) => new Date(ms).toLocaleDateString('pt-BR', { timeZone: 'America/Fortaleza' })
  return `${p.abreEm ? f(p.abreEm) : '—'} a ${f(p.encerraEm)}`
}

export function linkWaMe(numero: string, codigo: string): string {
  return `https://wa.me/${numero}?text=${encodeURIComponent(`Quero me candidatar [${codigo}]`)}`
}

/** Campo só de leitura com botão de copiar. */
export function copiar(valor: string, rotulo = 'Copiar'): string {
  return `<div class="linha" style="flex-wrap:nowrap"><input readonly value="${esc(valor)}" aria-label="${esc(rotulo)}" onclick="this.select()" style="min-width:0">
    <button type="button" class="mini" onclick="var i=this.previousElementSibling;i.select();navigator.clipboard&&navigator.clipboard.writeText(i.value);this.textContent='Copiado'">${esc(rotulo)}</button></div>`
}

export const ROTULO_STATUS: Record<string, string> = {
  iniciando: 'iniciando',
  aguardando_qr: 'aguardando QR',
  conectado: 'conectado',
  reconectando: 'reconectando',
  desconectado: 'desconectado'
}

/** Situação de um número em uma palavra, com a cor. */
export function seloNumero(n: { ativo: boolean; pausado: boolean } | null, e: EstadoConexao | null): string {
  if (!n) return selo('sem número', 'erro')
  if (!n.ativo) return selo('sem conexão', 'erro')
  const st = e?.status ?? 'iniciando'
  if (st === 'conectado') return n.pausado ? selo('pausado', 'alerta') : selo('conectado', 'ok')
  return selo(ROTULO_STATUS[st] ?? st, st === 'desconectado' ? 'erro' : 'alerta')
}

/** Bot de grupos como a lista de bots mostra. */
export interface ResumoBotGrupos {
  id: number
  nome: string
  ativo: boolean
  /** Número que o bot usa agora, com o status da conexão; null = sem número. */
  numero: { nome: string; ativo: boolean; pausado: boolean; estado: EstadoConexao | null } | null
  gruposAtivos: number
  gestoresConfirmados: number
  gestoresPendentes: number
  programadas: number
}

/** Número de recrutamento como a lista de bots precisa: nome, se está ativo e telefone conectado. */
export interface NumeroDosBots {
  id: number
  nome: string
  ativo: boolean
  telefone: string | null
}

export function paginaProcessos(
  config: ConfigCarregada,
  resumoProcessos: Map<string, { total: number; concluidas: number }>,
  numeros: NumeroDosBots[],
  usuario: string,
  agora: number,
  aviso: string | null = null,
  botsGrupos: ResumoBotGrupos[] = []
): string {
  const grupos = tabela(
    [{ rotulo: 'Bot' }, { rotulo: 'Número' }, { rotulo: 'Grupos ativos' }, { rotulo: 'Gestores' }, { rotulo: 'Programadas' }],
    botsGrupos.map((b) => ({
      classe: b.ativo ? '' : 'apagada',
      celulas: [
        `<a class="nome" href="/grupos-bot/${b.id}">${esc(b.nome)}</a>${b.ativo ? '' : '<span class="sub">desativado</span>'}`,
        b.numero ? `<span class="linha">${esc(b.numero.nome)} ${seloNumero(b.numero, b.numero.estado)}</span>` : selo('sem número', 'erro'),
        `<a href="/grupos-bot/${b.id}/grupos">${b.gruposAtivos}</a>`,
        `<a href="/grupos-bot/${b.id}/gestores">${b.gestoresConfirmados}</a>${b.gestoresPendentes ? ` ${selo(`${b.gestoresPendentes} pendente(s)`, 'alerta')}` : ''}`,
        `<a href="/grupos-bot/${b.id}/programadas">${b.programadas}</a>`
      ]
    })),
    'Nenhum bot de grupos.'
  )
  const recrutamento = tabela(
    [{ rotulo: 'Vaga' }, { rotulo: 'Situação' }, { rotulo: 'Período' }, { rotulo: 'Candidaturas' }, { rotulo: 'Link' }, { rotulo: '', fim: true }],
    config.processos.map((p) => {
      const r = resumoProcessos.get(p.codigo) ?? { total: 0, concluidas: 0 }
      const n = numeros.find((x) => x.id === p.numeroId)
      const cod = encodeURIComponent(p.codigo)
      const link = n && !n.ativo ? selo(`${n.nome} sem conexão`, 'erro') : n?.telefone ? copiar(linkWaMe(n.telefone, p.codigo), 'Copiar link') : selo('número sem conexão', 'alerta')
      return {
        celulas: [
          `<a class="nome" href="/bots/${cod}">${esc(p.vaga)}</a><span class="sub">${esc(p.codigo)}</span>`,
          SITUACAO_BOT[situacao(p, agora)],
          esc(periodo(p)),
          `<a href="/processos/${cod}">${r.concluidas} concluída(s)</a>${r.total - r.concluidas ? `<span class="sub">${r.total - r.concluidas} incompleta(s)</span>` : ''}`,
          link,
          `<div class="acoes"><a class="botao mini" href="/bots/${cod}">Editar</a><a class="botao mini" href="/bots/novo?de=${cod}">Copiar</a></div>`
        ]
      }
    }),
    'Nenhum bot de recrutamento.'
  )
  const semBot = [...resumoProcessos.keys()].filter((c) => !config.processos.some((p) => p.codigo === c))
  const erros = config.erros.length
    ? `<div class="aviso erro" role="alert">Bots com erro, fora do ar: ${config.erros.map((e) => esc(e)).join(' · ')}</div>`
    : ''
  const orfaos = semBot.length
    ? `<div class="cartao"><h2>Candidaturas de bots excluídos</h2><div class="fichas">${semBot.map((c) => `<a class="botao mini" href="/processos/${encodeURIComponent(c)}">${esc(c)}</a>`).join('')}</div></div>`
    : ''
  return layout(
    'Bots',
    `${cabecalho('Bots')}${mensagem(aviso)}${erros}
    <div class="secao"><h2>Grupos</h2><a class="botao primario" href="/grupos-bot/novo">+ Bot de grupos</a></div>
    <div class="cartao">${grupos}</div>
    <div class="secao"><h2>Recrutamento</h2><a class="botao primario" href="/bots/novo">+ Bot de recrutamento</a></div>
    <div class="cartao">${recrutamento}</div>${orfaos}`,
    usuario,
    { secao: 'bots' }
  )
}

export function paginaProcesso(codigo: string, p: Processo | undefined, candidatos: CandidatoPainel[], usuario: string): string {
  const colunas = colunasDeResposta(p, candidatos)
  const t = tabela(
    [{ rotulo: 'Protocolo' }, { rotulo: 'Situação' }, ...colunas.map((k) => ({ rotulo: k })), { rotulo: 'Telefone' }, { rotulo: 'Data' }, { rotulo: 'Currículo' }, { rotulo: '', fim: true }],
    candidatos.map((c) => ({
      celulas: [
        `<span class="nome">${esc(c.protocolo)}</span>`,
        c.status === 'concluida' ? selo('concluída', 'ok') : `${selo('incompleta', 'alerta')}<span class="sub">parou em: ${esc(c.passo)}</span>`,
        ...colunas.map((k) => esc(c.respostas[k] ?? '')),
        esc(c.telefone ?? ''),
        esc(dataBR(c.concluidaEm ?? c.criadaEm)),
        c.arquivos.map((a, i) => `<a href="/arquivos/${a.id}">arquivo ${i + 1} (${esc(a.ext)})</a>`).join('<br>') || '—',
        botaoPost(`/candidaturas/${c.id}/excluir`, 'Excluir', { classe: 'perigo mini', confirma: `Excluir ${c.protocolo} e seus arquivos? Não tem volta.` })
      ]
    })),
    'Nenhuma candidatura.'
  )
  return layout(
    codigo,
    `${cabecalho(p ? p.vaga : codigo, {
      voltar: { href: '/', rotulo: 'Bots' },
      selos: selo(codigo, 'marca'),
      acoes: `<a class="botao primario" href="/processos/${encodeURIComponent(codigo)}/exportar">Exportar ZIP</a>`
    })}
    <div class="cartao">${t}</div>`,
    usuario,
    { secao: 'bots' }
  )
}

export interface SaudeNumero {
  numero: Numero
  estado: EstadoConexao | null
  ultimaMensagem: number | null
}

export interface DadosSaude {
  numeros: SaudeNumero[]
  filas: { entrada: number; saida: number; erros: number }
  ultimoBackup: string | null
  backupAtivo: boolean
  alertaAtivo: boolean
  config: ConfigCarregada
}

export function paginaSaude(d: DadosSaude, usuario: string): string {
  const fila = d.filas.entrada + d.filas.saida
  const numeros = tabela(
    [{ rotulo: 'Número' }, { rotulo: 'Situação' }, { rotulo: 'Desde' }, { rotulo: 'Última mensagem' }],
    d.numeros.map(({ numero: n, estado: e, ultimaMensagem }) => ({
      celulas: [
        `<a class="nome" href="/numeros/${n.id}">${esc(n.nome)}</a><span class="sub">${n.papel === 'grupos' ? 'Grupos' : 'Recrutamento'}</span>`,
        seloNumero(n, e),
        e ? esc(dataBR(e.desde)) : '—',
        esc(ultimaMensagem ? dataBR(ultimaMensagem) : '—')
      ]
    })),
    'Nenhum número.'
  )
  const corpo = `${cabecalho('Saúde')}
  ${resumo([
    { valor: d.filas.entrada, rotulo: 'a processar' },
    { valor: d.filas.saida, rotulo: 'a enviar' },
    { valor: d.filas.erros, rotulo: 'com erro' }
  ])}
  <div class="cartao"><h2>Números</h2>${numeros}</div>
  <div class="cartao"><h2>Sistema</h2><dl class="dados">
    <dt>Fila</dt><dd>${fila === 0 ? selo('vazia', 'ok') : selo(`${fila} item(ns)`, 'alerta')}</dd>
    <dt>Último backup</dt><dd>${d.backupAtivo ? esc(d.ultimoBackup ? dataBR(Date.parse(d.ultimoBackup)) : 'ainda não rodou') : selo('desativado', 'erro')}</dd>
    <dt>Alerta por e-mail</dt><dd>${d.alertaAtivo ? selo('ativo', 'ok') : selo('desativado', 'alerta')}</dd>
    <dt>Bots de recrutamento</dt><dd>${d.config.processos.length}${d.config.erros.length ? ` ${selo(`${d.config.erros.length} com erro`, 'erro')}` : ''}</dd>
  </dl></div>`
  return layout('Saúde', corpo, usuario, { secao: 'saude' })
}

export function paginaAuditoria(linhas: { em: number; usuario: string; acao: string; detalhe: string | null }[], usuario: string): string {
  const t = tabela(
    [{ rotulo: 'Quando' }, { rotulo: 'Quem' }, { rotulo: 'Ação' }, { rotulo: 'Detalhe' }],
    linhas.map((l) => ({ celulas: [esc(dataBR(l.em)), esc(l.usuario), `<code>${esc(l.acao)}</code>`, esc(l.detalhe ?? '')] })),
    'Nada registrado.'
  )
  return layout('Auditoria', `${cabecalho('Auditoria')}<div class="cartao">${t}</div>`, usuario, { secao: 'auditoria' })
}
