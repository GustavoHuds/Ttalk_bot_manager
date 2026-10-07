import { situacao } from '../config/carregar.js'
import type { ConfigCarregada, Processo } from '../config/tipos.js'
import type { CandidatoPainel } from '../db/repositorio.js'
import type { Numero } from '../db/numeros.js'
import type { EstadoConexao } from '../whatsapp/baileys.js'
import { colunasDeResposta, dataBR } from './exportar.js'
import { ROTULO_PAPEL } from './paginas-numeros.js'

export function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

const CSS = `
:root{--fundo:#f6f7f9;--cartao:#fff;--texto:#1d2330;--suave:#5b6474;--borda:#dde1e7;--marca:#0b5cad;--ok:#1a7f37;--alerta:#b54708;--erro:#b42318}
@media (prefers-color-scheme:dark){:root{--fundo:#12151b;--cartao:#1b2029;--texto:#e6e9ef;--suave:#9aa3b2;--borda:#2c3340;--marca:#5aa2f0;--ok:#4ac26b;--alerta:#f0a050;--erro:#f97066}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--fundo);color:var(--texto)}
header{display:flex;flex-wrap:wrap;gap:4px 18px;align-items:center;padding:12px 16px;background:var(--cartao);border-bottom:1px solid var(--borda)}
header strong{margin-right:auto}header a{color:var(--suave);text-decoration:none}header a:hover{color:var(--marca)}
main{max-width:1200px;margin:0 auto;padding:20px 16px}h1{font-size:1.35rem;margin:0 0 16px}h2{font-size:1.05rem;margin:24px 0 8px}
.cartao{background:var(--cartao);border:1px solid var(--borda);border-radius:8px;padding:16px;margin-bottom:16px;overflow-x:auto}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--borda);vertical-align:top}
th{font-size:.8rem;text-transform:uppercase;letter-spacing:.03em;color:var(--suave)}
a{color:var(--marca)}.suave{color:var(--suave)}.ok{color:var(--ok)}.alerta{color:var(--alerta)}.erro{color:var(--erro)}
button,.botao{font:inherit;padding:6px 12px;border-radius:6px;border:1px solid var(--borda);background:var(--cartao);color:var(--texto);cursor:pointer;text-decoration:none;display:inline-block}
button.perigo{color:var(--erro)}button.primario,.botao.primario{background:var(--marca);border-color:var(--marca);color:#fff}
input,select,textarea{font:inherit;padding:8px;border:1px solid var(--borda);border-radius:6px;width:100%;background:var(--fundo);color:var(--texto)}
code{font-size:.85em;word-break:break-all}.etiqueta{font-size:.8rem;padding:2px 8px;border-radius:99px;border:1px solid currentColor}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;margin:0}dt{color:var(--suave)}dd{margin:0}
`

export function layout(titulo: string, corpo: string, usuario: string | null, extraHead = ''): string {
  const nav = usuario
    ? `<a href="/">Bots</a><a href="/numeros">Números</a><a href="/grupos">Grupos</a><a href="/equipe">Equipe</a><a href="/saude">Saúde</a><a href="/auditoria">Auditoria</a>
       <form method="post" action="/sair" style="margin:0"><button>Sair (${esc(usuario)})</button></form>`
    : ''
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titulo)} · Ttalk Bot Manager</title><meta name="robots" content="noindex">${extraHead}<style>${CSS}</style></head>
<body><header><strong>Ttalk Bot Manager</strong>${nav}</header><main>${corpo}</main></body></html>`
}

export function paginaLogin(erro: string | null): string {
  return layout(
    'Entrar',
    `<div class="cartao" style="max-width:360px;margin:40px auto">
      <h1>Entrar no painel</h1>${erro ? `<p class="erro">${esc(erro)}</p>` : ''}
      <form method="post" action="/login">
        <p><label>Usuário<br><input name="usuario" autocomplete="username" required></label></p>
        <p><label>Senha<br><input name="senha" type="password" autocomplete="current-password" required></label></p>
        <button class="primario">Entrar</button>
      </form></div>`,
    null
  )
}

const ROTULO_SITUACAO = { aberto: '<span class="etiqueta ok">aberto</span>', fechado: '<span class="etiqueta suave">encerrado</span>', rascunho: '<span class="etiqueta alerta">rascunho</span>' }

function periodo(p: Processo): string {
  const f = (ms: number) => new Date(ms).toLocaleDateString('pt-BR', { timeZone: 'America/Fortaleza' })
  return `${p.abreEm ? f(p.abreEm) : '—'} a ${f(p.encerraEm)}`
}

export function linkWaMe(numero: string, codigo: string): string {
  return `https://wa.me/${numero}?text=${encodeURIComponent(`Quero me candidatar [${codigo}]`)}`
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
  resumo: Map<string, { total: number; concluidas: number }>,
  numeros: NumeroDosBots[],
  usuario: string,
  agora: number,
  aviso: string | null = null
): string {
  const linhas = config.processos
    .map((p) => {
      const r = resumo.get(p.codigo) ?? { total: 0, concluidas: 0 }
      const n = numeros.find((x) => x.id === p.numeroId)
      const link = n?.telefone ? linkWaMe(n.telefone, p.codigo) : null
      const cod = encodeURIComponent(p.codigo)
      const qual = numeros.length > 1 && n?.ativo ? `<br><span class="suave">${esc(n.nome)}</span>` : ''
      const destino =
        n && !n.ativo
          ? `<span class="erro">número «${esc(n.nome)}» desativado</span>`
          : link
            ? `<code>${esc(link)}</code>`
            : '<span class="suave">conecte o número para gerar</span>'
      return `<tr><td><strong>${esc(p.vaga)}</strong><br><span class="suave">${esc(p.codigo)}</span></td>
        <td>${ROTULO_SITUACAO[situacao(p, agora)]}</td><td>${periodo(p)}</td>
        <td><a href="/processos/${cod}">${r.concluidas} concluídas</a><br><span class="suave">${r.total - r.concluidas} incompletas</span></td>
        <td>${destino}${qual}</td>
        <td style="white-space:nowrap"><a class="botao" href="/bots/${cod}">Editar</a> <a class="botao" href="/bots/novo?de=${cod}">Copiar</a></td></tr>`
    })
    .join('')
  const semBot = [...resumo.keys()].filter((c) => !config.processos.some((p) => p.codigo === c))
  const erros = config.erros.length
    ? `<div class="cartao"><h2 class="erro">Bots com erro (fora do ar até serem corrigidos)</h2><ul>${config.erros.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`
    : ''
  const orfaos = semBot.length
    ? `<div class="cartao"><h2 class="alerta">Candidaturas de bots excluídos</h2><p>A retenção automática não se aplica a elas: ${semBot.map((c) => `<a href="/processos/${encodeURIComponent(c)}">${esc(c)}</a>`).join(', ')}</p></div>`
    : ''
  const direto = numeros
    .filter((n): n is NumeroDosBots & { telefone: string } => !!n.telefone)
    .map((n) => {
      const abertos = config.processos.filter((p) => p.numeroId === n.id && situacao(p, agora) === 'aberto').length
      const destino =
        abertos === 1 ? 'vai para o único bot aberto.' : abertos > 1 ? 'o candidato escolhe a vaga numa enquete.' : 'responde que não há inscrições abertas.'
      return `<p class="suave">Contato direto pelo ${esc(n.nome)} (<code>https://wa.me/${esc(n.telefone)}</code>): ${destino}</p>`
    })
    .join('')
  return layout(
    'Bots',
    `<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><h1>Bots de recrutamento</h1>
      <a class="botao primario" href="/bots/novo">+ Novo bot</a></div>
    ${aviso ? `<div class="cartao ok">${esc(aviso)}</div>` : ''}${erros}
    <div class="cartao"><table><thead><tr><th>Vaga</th><th>Situação</th><th>Período</th><th>Candidaturas</th><th>Link de divulgação</th><th></th></tr></thead>
    <tbody>${linhas || '<tr><td colspan="6" class="suave">Nenhum bot ainda. Clique em "+ Novo bot".</td></tr>'}</tbody></table></div>${direto}${orfaos}`,
    usuario
  )
}

export function paginaProcesso(codigo: string, p: Processo | undefined, candidatos: CandidatoPainel[], usuario: string): string {
  const colunas = colunasDeResposta(p, candidatos)
  const linhas = candidatos
    .map(
      (c) => `<tr><td>${esc(c.protocolo)}</td>
      <td>${c.status === 'concluida' ? '<span class="ok">concluída</span>' : `<span class="alerta">incompleta</span><br><span class="suave">parou em: ${esc(c.passo)}</span>`}</td>
      ${colunas.map((k) => `<td>${esc(c.respostas[k] ?? '')}</td>`).join('')}
      <td>${esc(c.telefone ?? '')}</td><td>${esc(dataBR(c.concluidaEm ?? c.criadaEm))}</td>
      <td>${c.arquivos.map((a, i) => `<a href="/arquivos/${a.id}">arquivo ${i + 1} (${esc(a.ext)})</a>`).join('<br>') || '<span class="suave">—</span>'}</td>
      <td><form method="post" action="/candidaturas/${c.id}/excluir" onsubmit="return confirm('Excluir ${esc(c.protocolo)} e seus arquivos? Não tem volta.')"><button class="perigo">Excluir</button></form></td></tr>`
    )
    .join('')
  return layout(
    codigo,
    `<h1>${esc(codigo)}${p ? ` · ${esc(p.vaga)}` : ''}</h1>
    <p><a class="botao primario" href="/processos/${encodeURIComponent(codigo)}/exportar">Exportar ZIP (currículos + CSV)</a></p>
    <div class="cartao"><table><thead><tr><th>Protocolo</th><th>Status</th>${colunas.map((k) => `<th>${esc(k)}</th>`).join('')}<th>Telefone</th><th>Data</th><th>Currículo</th><th></th></tr></thead>
    <tbody>${linhas || `<tr><td colspan="${colunas.length + 6}" class="suave">Nenhuma candidatura ainda.</td></tr>`}</tbody></table></div>`,
    usuario
  )
}

export const ROTULO_STATUS: Record<string, string> = {
  iniciando: 'iniciando',
  aguardando_qr: 'aguardando leitura do QR',
  conectado: 'conectado',
  reconectando: 'reconectando',
  desconectado: 'desconectado'
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
  const numeros = d.numeros
    .map(({ numero: n, estado: e, ultimaMensagem }) => {
      const cor = !n.ativo ? 'suave' : e?.status === 'conectado' ? 'ok' : 'erro'
      const status = !n.ativo ? 'desativado' : `${esc(ROTULO_STATUS[e?.status ?? 'iniciando'])}${e ? ` desde ${esc(dataBR(e.desde))}` : ''}`
      return `<dt>${esc(n.nome)} <span class="suave">(${ROTULO_PAPEL[n.papel]})</span></dt>
        <dd><span class="${cor}">${status}</span> · última mensagem: ${esc(ultimaMensagem ? dataBR(ultimaMensagem) : 'nenhuma')}</dd>`
    })
    .join('')
  const corpo = `<h1>Saúde do bot</h1><div class="cartao"><h2 style="margin-top:0">Números</h2><dl>${numeros}</dl></div>
  <div class="cartao"><dl>
    <dt>Fila</dt><dd class="${fila === 0 ? 'ok' : 'alerta'}">${d.filas.entrada} a processar · ${d.filas.saida} a enviar</dd>
    <dt>Mensagens com erro</dt><dd class="${d.filas.erros ? 'erro' : 'ok'}">${d.filas.erros}</dd>
    <dt>Último backup</dt><dd class="${d.backupAtivo ? '' : 'erro'}">${d.backupAtivo ? esc(d.ultimoBackup ? dataBR(Date.parse(d.ultimoBackup)) : 'ainda não rodou') : 'desativado (defina BACKUP_SENHA)'}</dd>
    <dt>Alerta por e-mail</dt><dd class="${d.alertaAtivo ? 'ok' : 'alerta'}">${d.alertaAtivo ? 'ativo' : 'desativado (defina SMTP_URL e ALERTA_EMAIL_PARA)'}</dd>
    <dt>Configuração</dt><dd>${d.config.processos.length} processos, lida em ${esc(dataBR(d.config.carregadaEm))}${d.config.erros.length ? ` · <span class="erro">${d.config.erros.length} com erro</span>` : ''}</dd>
  </dl></div>`
  return layout('Saúde', corpo, usuario)
}

export function paginaAuditoria(linhas: { em: number; usuario: string; acao: string; detalhe: string | null }[], usuario: string): string {
  return layout(
    'Auditoria',
    `<h1>Auditoria</h1><div class="cartao"><table><thead><tr><th>Quando</th><th>Quem</th><th>Ação</th><th>Detalhe</th></tr></thead><tbody>
    ${linhas.map((l) => `<tr><td>${esc(dataBR(l.em))}</td><td>${esc(l.usuario)}</td><td>${esc(l.acao)}</td><td>${esc(l.detalhe ?? '')}</td></tr>`).join('') || '<tr><td colspan="4" class="suave">Nada registrado.</td></tr>'}
    </tbody></table></div>`,
    usuario
  )
}
