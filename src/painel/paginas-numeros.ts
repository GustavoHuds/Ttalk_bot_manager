import type { Numero, Papel } from '../db/numeros.js'
import { formatarTelefone } from '../grupos/pessoas.js'
import type { EstadoConexao } from '../whatsapp/baileys.js'
import { dataBR } from './exportar.js'
import { botaoPost, cabecalho, esc, layout, mensagem, selo, seloNumero, tabela } from './paginas.js'

export const ROTULO_PAPEL: Record<Papel, string> = { recrutamento: 'Recrutamento', grupos: 'Grupos' }

/** Bot que usa um número (de grupos ou de recrutamento), com o link da página dele. */
export interface BotDoNumero {
  nome: string
  href: string
}

export interface LinhaNumero {
  numero: Numero
  estado: EstadoConexao | null
  bots: BotDoNumero[]
}

const telefone = (e: EstadoConexao | null) => (e?.numero ? formatarTelefone(e.numero) : null)

function fichasBots(bots: BotDoNumero[]): string {
  return bots.length ? `<div class="fichas">${bots.map((b) => `<a class="selo marca" href="${esc(b.href)}">${esc(b.nome)}</a>`).join('')}</div>` : '<span class="suave">—</span>'
}

export function paginaNumeros(itens: LinhaNumero[], usuario: string, ok: string | null = null): string {
  const t = tabela(
    [{ rotulo: 'Número' }, { rotulo: 'Bots' }, { rotulo: 'Situação' }, { rotulo: 'Desde' }],
    itens.map(({ numero: n, estado: e, bots }) => ({
      celulas: [
        `<a class="nome" href="/numeros/${n.id}">${esc(n.nome)}</a><span class="sub">${esc(telefone(e) ?? ROTULO_PAPEL[n.papel])}</span>`,
        fichasBots(bots),
        seloNumero(n, e),
        e?.status === 'conectado' ? esc(dataBR(e.desde)) : '—'
      ]
    })),
    'Nenhum número.'
  )
  return layout(
    'Números',
    `${cabecalho('Números', { acoes: '<a class="botao primario" href="/numeros/novo">+ Número</a>' })}${mensagem(ok)}<div class="cartao">${t}</div>`,
    usuario,
    { secao: 'numeros' }
  )
}

export function paginaNovoNumero(usuario: string, erro: string | null, nome = '', papel: Papel = 'grupos'): string {
  const opcao = (p: Papel) => `<option value="${p}"${p === papel ? ' selected' : ''}>${ROTULO_PAPEL[p]}</option>`
  return layout(
    'Novo número',
    `${cabecalho('Novo número', { voltar: { href: '/numeros', rotulo: 'Números' } })}${mensagem(null, erro)}
    <form method="post" action="/numeros" class="cartao campos">
      <label class="campo"><span>Nome</span><input name="nome" maxlength="40" required value="${esc(nome)}" placeholder="Avisos da loja"></label>
      <label class="campo"><span>Uso</span><select name="papel">${opcao('grupos')}${opcao('recrutamento')}</select></label>
      <div class="acoes"><button class="primario">Adicionar e conectar</button></div>
    </form>`,
    usuario,
    { secao: 'numeros' }
  )
}

/** Situação em texto para a tela do número (e para o JSON que ela consulta). */
export function rotuloSituacao(n: Numero, e: EstadoConexao | null): string {
  if (!n.ativo) return 'Sem conexão'
  if (e?.status === 'conectado') return n.pausado ? 'Pausado' : 'Conectado'
  if (e?.status === 'aguardando_qr') return 'Aguardando leitura do QR'
  if (e?.status === 'desconectado') return 'Desconectado'
  return 'Conectando…'
}

export function paginaNumero(n: Numero, e: EstadoConexao | null, bots: BotDoNumero[], usuario: string, ok: string | null, erro: string | null): string {
  const conectado = n.ativo && e?.status === 'conectado'
  const acoes = conectado
    ? `${botaoPost(`/numeros/${n.id}/${n.pausado ? 'retomar' : 'pausar'}`, n.pausado ? 'Retomar' : 'Pausar', n.pausado ? { classe: 'primario' } : { confirma: `Pausar ${n.nome}? O número continua conectado, mas o bot para de ler e de enviar.` })}
       ${botaoPost(`/numeros/${n.id}/revogar`, 'Revogar', { classe: 'perigo', confirma: `Revogar ${n.nome}? O WhatsApp conectado é desligado deste painel e um QR novo aparece para conectar outro.` })}`
    : ''
  const qr = conectado
    ? ''
    : `<div class="cartao"><h2>Conectar</h2><div class="qr" id="qr" aria-live="polite"><img id="qr-img" alt="QR code de conexão" width="280" height="280" hidden>
        <span id="qr-texto" class="suave">Gerando QR…</span><span class="pequeno suave">WhatsApp › Aparelhos conectados › Conectar aparelho</span></div></div>`
  const dados = `<div class="cartao"><h2>Conexão</h2><dl class="dados">
      <dt>Telefone</dt><dd>${esc(telefone(e) ?? '—')}</dd>
      <dt>Situação</dt><dd id="situacao">${esc(rotuloSituacao(n, e))}</dd>
      <dt>Desde</dt><dd>${conectado ? esc(dataBR(e!.desde)) : '—'}</dd>
      <dt>Uso</dt><dd>${ROTULO_PAPEL[n.papel]}</dd>
      <dt>Bots</dt><dd>${fichasBots(bots)}</dd>
      ${e?.motivo && !conectado ? `<dt>Último motivo</dt><dd class="erro">${esc(e.motivo)}</dd>` : ''}
    </dl></div>`
  const nome = `<form method="post" action="/numeros/${n.id}/renomear" class="cartao"><h2>Nome</h2><div class="linha" style="flex-wrap:nowrap">
      <input name="nome" maxlength="40" required value="${esc(n.nome)}" aria-label="Nome do número"><button>Salvar</button></div></form>`
  // Enquanto a tela está aberta e o número não está conectado, ela pede o QR de tempos em tempos.
  // Fechar a tela para essas consultas: o painel encerra o QR sozinho pouco depois.
  const script = conectado
    ? ''
    : `<script>(function(){var img=document.getElementById('qr-img'),txt=document.getElementById('qr-texto'),sit=document.getElementById('situacao');
      function vez(){fetch('/numeros/${n.id}/estado',{headers:{accept:'application/json'},cache:'no-store'}).then(function(r){return r.json()}).then(function(d){
        if(d.status==='conectado'){location.reload();return}
        sit.textContent=d.situacao;
        if(d.qr){img.src=d.qr;img.hidden=false;txt.hidden=true}else{img.hidden=true;txt.hidden=false;txt.textContent=d.situacao}
      }).catch(function(){}).finally(function(){setTimeout(vez,3000)})}vez();})();</script>`
  return layout(
    n.nome,
    `${cabecalho(n.nome, { voltar: { href: '/numeros', rotulo: 'Números' }, selos: `${selo(ROTULO_PAPEL[n.papel], 'marca')}${seloNumero(n, e)}`, acoes })}
    ${mensagem(ok, erro)}<div class="grade2"><div>${qr}${dados}</div><div>${nome}</div></div>${script}`,
    usuario,
    { secao: 'numeros' }
  )
}
