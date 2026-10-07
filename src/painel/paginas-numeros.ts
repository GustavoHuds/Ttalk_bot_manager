import type { Numero, Papel } from '../db/numeros.js'
import type { EstadoConexao } from '../whatsapp/baileys.js'
import { dataBR } from './exportar.js'
import { ROTULO_STATUS, esc, layout } from './paginas.js'

export const ROTULO_PAPEL: Record<Papel, string> = { recrutamento: 'Recrutamento', grupos: 'Grupos' }

function status(n: Numero, e: EstadoConexao | null): string {
  if (!n.ativo) return '<span class="suave">desativado</span>'
  const cor = e?.status === 'conectado' ? 'ok' : e?.status === 'desconectado' ? 'erro' : 'alerta'
  return `<span class="${cor}">${esc(ROTULO_STATUS[e?.status ?? 'iniciando'])}</span>`
}

export function paginaNumeros(itens: { numero: Numero; estado: EstadoConexao | null }[], usuario: string, erro: string | null = null): string {
  const linhas = itens
    .map(
      ({ numero: n, estado: e }) => `<tr><td><a href="/numeros/${n.id}"><strong>${esc(n.nome)}</strong></a></td>
      <td>${ROTULO_PAPEL[n.papel]}</td><td>${status(n, e)}</td><td>${esc(e?.numero ?? '—')}</td><td>${e ? esc(dataBR(e.desde)) : '—'}</td></tr>`
    )
    .join('')
  return layout(
    'Números',
    `<h1>Números de WhatsApp</h1>${erro ? `<div class="cartao erro">${esc(erro)}</div>` : ''}
    <div class="cartao"><table><thead><tr><th>Nome</th><th>Uso</th><th>Status</th><th>Telefone</th><th>Desde</th></tr></thead><tbody>${linhas}</tbody></table></div>
    <div class="cartao"><h2 style="margin-top:0">+ Número</h2>
      <p class="suave">Cada número tem um uso só. <strong>Recrutamento</strong> responde candidatos; <strong>Grupos</strong> atende comandos nos grupos da empresa. Assim, um bloqueio num número não derruba o outro. O uso não muda depois.</p>
      <form method="post" action="/numeros" style="display:flex;gap:8px;flex-wrap:wrap;align-items:end">
        <label style="flex:1 1 220px">Nome<input name="nome" maxlength="40" required placeholder="Ex.: Avisos da empresa"></label>
        <label style="flex:0 0 180px">Uso<select name="papel"><option value="recrutamento">Recrutamento</option><option value="grupos">Grupos</option></select></label>
        <button class="primario">Adicionar e mostrar o QR</button>
      </form></div>`,
    usuario
  )
}

export function paginaNumero(n: Numero, e: EstadoConexao | null, qrImagem: string | null, usuario: string, erro = false): string {
  const avisoErro = erro
    ? `<div class="cartao erro">Não foi possível falar com o WhatsApp agora — veja o log; o painel tentará de novo ao reiniciar.</div>`
    : ''
  const qr = qrImagem
    ? `<div class="cartao"><p>No celular deste número: WhatsApp → <strong>Aparelhos conectados</strong> → <strong>Conectar aparelho</strong>, e aponte para o código. Ele muda a cada poucos segundos; a página atualiza sozinha.</p>
       <img src="${qrImagem}" alt="QR code de conexão" width="280" height="280" style="background:#fff;padding:8px;border-radius:8px"></div>`
    : ''
  const novoQr =
    n.ativo && e?.status === 'desconectado'
      ? `<form method="post" action="/numeros/${n.id}/nova-sessao" onsubmit="return confirm('Começar uma sessão nova? A sessão atual é copiada antes.')"><button class="primario">Gerar novo QR</button></form>`
      : ''
  const liga = n.ativo
    ? `<form method="post" action="/numeros/${n.id}/desativar" onsubmit="return confirm('Desativar este número? O bot para de usar este WhatsApp até ser ativado de novo.')"><button class="perigo">Desativar</button></form>`
    : `<form method="post" action="/numeros/${n.id}/ativar"><button class="primario">Ativar</button></form>`
  const corpo = `<p><a href="/numeros">← Números</a></p>
    <h1>${esc(n.nome)} <span class="etiqueta">${ROTULO_PAPEL[n.papel]}</span></h1>
    ${avisoErro}
    <div class="cartao"><dl>
      <dt>Status</dt><dd>${status(n, e)}</dd>
      ${e ? `<dt>Desde</dt><dd>${esc(dataBR(e.desde))}</dd><dt>Telefone</dt><dd>${esc(e.numero ?? '—')}</dd>` : ''}
      ${e?.motivo ? `<dt>Motivo</dt><dd class="erro">${esc(e.motivo)}</dd>` : ''}
    </dl></div>${qr}
    <div class="cartao" style="display:flex;gap:8px;flex-wrap:wrap">${novoQr}${liga}</div>`
  const refresh = n.ativo && e?.status !== 'conectado' ? '<meta http-equiv="refresh" content="5">' : ''
  return layout(n.nome, corpo, usuario, refresh)
}
