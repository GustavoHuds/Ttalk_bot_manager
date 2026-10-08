import type { BotGrupos, GrupoAtivo, Loja } from '../db/bots-grupos.js'
import type { Grupo } from '../db/grupos.js'
import type { Numero } from '../db/numeros.js'
import type { EstadoConexao } from '../whatsapp/baileys.js'
import { dataBR } from './exportar.js'
import { ROTULO_STATUS, abas, esc, layout, mensagem, resumo, selo } from './paginas.js'

/** Grupo ativo com o que a lista mostra. */
export interface LinhaAtivo {
  ativo: GrupoAtivo
  /** Da lista geral do número atual; null = o número atual não está (ou nunca esteve) no grupo. */
  geral: Grupo | null
  participantes: { total: number; semCadastro: number } | null
}

export interface DadosGrupos {
  bots: BotGrupos[]
  bot: BotGrupos
  numero: Numero | null
  estado: EstadoConexao | null
  ativos: LinhaAtivo[]
  /** Grupos do número que ainda não estão ativos no bot. */
  disponiveis: Grupo[]
}

function seletorBots(bots: BotGrupos[], atual: number): string {
  if (bots.length < 2) return ''
  return abas(
    bots.map((b) => ({ href: `/grupos?bot=${b.id}`, rotulo: b.nome })),
    `/grupos?bot=${atual}`
  )
}

export function paginaSemBotGrupos(usuario: string): string {
  return layout(
    'Grupos',
    `<h1>Grupos</h1><div class="cartao vazio"><p>Ainda não há nenhum bot de grupos.</p>
      <p>Crie um em <a class="botao primario" href="/grupos-bot/novo">+ Bot de grupos</a> e escolha o número que ele usa.</p></div>`,
    usuario
  )
}

export function paginaGrupos(d: DadosGrupos, usuario: string, ok: string | null, erro: string | null): string {
  const b = d.bot
  const conectado = d.estado?.status === 'conectado'
  const numero = !d.numero
    ? selo('sem número', 'erro')
    : selo(`${d.numero.nome}: ${d.numero.ativo ? (ROTULO_STATUS[d.estado?.status ?? 'iniciando'] ?? '') : 'desativado'}`, conectado ? 'ok' : 'alerta')
  const linhasAtivos = d.ativos
    .map(({ ativo: a, geral, participantes: p }) => {
      const nome = geral?.nome ?? a.jid
      const aviso = !d.numero
        ? ''
        : !geral || !geral.ativo
          ? `<div>${selo(`${d.numero.nome} não está neste grupo`, 'erro')}</div>`
          : ''
      const pessoas = p
        ? `${p.total}${p.semCadastro ? ` · <span class="alerta">${p.semCadastro} sem cadastro</span>` : ' · todos cadastrados'}`
        : '<span class="suave">ainda não lidos</span>'
      const jid = encodeURIComponent(a.jid)
      return `<tr><td><strong>${esc(nome)}</strong>${aviso}<div class="ajuda">ativado em ${esc(dataBR(a.ativadoEm))}</div></td>
        <td>${a.loja ? esc(a.loja) : '<span class="suave">sem loja</span>'}${a.setor ? `<div class="ajuda">${esc(a.setor)}</div>` : ''}</td>
        <td>${pessoas}</td>
        <td class="esconde-celular">${geral?.botAdmin ? selo('admin', 'ok') : selo('não é admin')}</td>
        <td class="linha"><a class="botao" href="/grupos/editar?bot=${b.id}&amp;jid=${jid}">Editar</a>
          <form method="post" action="/grupos/desativar" data-confirma="Desativar ${esc(nome)}? O bot para de responder neste grupo e os participantes guardados são apagados." onsubmit="return confirm(this.dataset.confirma)">
            <input type="hidden" name="bot" value="${b.id}"><input type="hidden" name="jid" value="${esc(a.jid)}"><button class="perigo">Desativar</button></form></td></tr>`
    })
    .join('')
  const linhasGeral = d.disponiveis
    .map(
      (x) => `<tr data-nome="${esc(x.nome.toLowerCase())}"><td><strong>${esc(x.nome)}</strong></td>
        <td class="esconde-celular">${x.botAdmin ? selo('admin', 'ok') : selo('não é admin')}</td>
        <td><a class="botao primario" href="/grupos/ativar?bot=${b.id}&amp;jid=${encodeURIComponent(x.jid)}">Ativar</a></td></tr>`
    )
    .join('')
  const geral = !d.numero
    ? `<div class="cartao vazio">Este bot está sem número. Escolha um em <a href="/grupos-bot/${b.id}">Geral</a> para ver os grupos dele.</div>`
    : `<div class="cartao"><div class="topo" style="margin-bottom:8px"><h2 style="margin:0">Todos os grupos do ${esc(d.numero.nome)} <span class="suave">(${d.disponiveis.length})</span></h2>
        <input type="search" id="busca" placeholder="Buscar grupo" aria-label="Buscar grupo" style="max-width:280px"></div>
      <p class="ajuda" style="margin-top:0">Grupos em que o número está. O bot não lê nem guarda nada destes grupos enquanto não forem ativados.</p>
      <table id="geral"><thead><tr><th>Grupo</th><th class="esconde-celular">Número é admin?</th><th></th></tr></thead><tbody>
      ${linhasGeral || `<tr><td colspan="3" class="vazio">${d.ativos.length ? 'Todos os grupos do número já estão ativos.' : 'O número ainda não está em nenhum grupo (ou ainda não conectou). Adicione-o aos grupos pelo celular.'}</td></tr>`}
      </tbody></table><p id="nenhum" class="vazio" hidden>Nenhum grupo com esse nome.</p></div>
      <script>(function(){var b=document.getElementById('busca');if(!b)return;b.addEventListener('input',function(){
        var t=b.value.trim().toLowerCase(),n=0;document.querySelectorAll('#geral tbody tr[data-nome]').forEach(function(r){
        var v=r.getAttribute('data-nome').indexOf(t)!==-1;r.hidden=!v;if(v)n++;});document.getElementById('nenhum').hidden=n>0||!t;});})();</script>`
  const semCadastro = d.ativos.reduce((s, x) => s + (x.participantes?.semCadastro ?? 0), 0)
  const corpo = `${seletorBots(d.bots, b.id)}
    <div class="topo"><h1>Grupos · ${esc(b.nome)}</h1><span class="linha">${numero}<a class="botao" href="/grupos-bot/${b.id}/lojas">Lojas</a></span></div>
    ${mensagem(ok, erro)}
    ${resumo([
      { valor: d.ativos.length, rotulo: 'grupos ativos' },
      { valor: d.disponiveis.length, rotulo: 'outros grupos do número' },
      { valor: semCadastro, rotulo: 'participantes sem cadastro' }
    ])}
    <div class="cartao destaque"><h2 style="margin-top:0">Grupos ativos</h2>
      <p class="ajuda" style="margin-top:0">O bot só responde comandos nestes grupos. Em todos os outros, fica em silêncio.</p>
      <table><thead><tr><th>Grupo</th><th>Loja</th><th>Participantes</th><th class="esconde-celular">Admin</th><th></th></tr></thead>
      <tbody>${linhasAtivos || '<tr><td colspan="5" class="vazio">Nenhum grupo ativo. Escolha abaixo os grupos em que o bot deve atuar.</td></tr>'}</tbody></table></div>
    ${geral}`
  return layout(`Grupos · ${b.nome}`, corpo, usuario)
}

export interface FormGrupo {
  bot: BotGrupos
  jid: string
  nome: string
  lojas: Loja[]
  lojaId: number | null
  setor: string
  /** Sugestões de setor (os já usados). */
  setores: string[]
  editando: boolean
}

export function paginaFormGrupo(f: FormGrupo, usuario: string, erro: string | null): string {
  const opcoes = f.lojas.map((l) => `<option value="${l.id}"${l.id === f.lojaId ? ' selected' : ''}>${esc(l.nome)}</option>`).join('')
  const acao = f.editando ? '/grupos/editar' : '/grupos/ativar'
  return layout(
    f.editando ? 'Editar grupo' : 'Ativar grupo',
    `<p><a href="/grupos?bot=${f.bot.id}">← Grupos</a></p>
    <h1>${f.editando ? 'Editar' : 'Ativar'}: ${esc(f.nome)}</h1>${mensagem(null, erro)}
    <form method="post" action="${acao}" class="cartao formgrade">
      <input type="hidden" name="bot" value="${f.bot.id}"><input type="hidden" name="jid" value="${esc(f.jid)}">
      <label>Loja<select name="loja_id"><option value="">Sem loja</option>${opcoes}</select></label>
      <label>Ou uma loja nova<input name="loja_nova" maxlength="60" placeholder="Ex.: Loja Centro"></label>
      <p class="ajuda" style="margin-top:-6px">Uma loja nova entra na lista do ${esc(f.bot.nome)} (<a href="/grupos-bot/${f.bot.id}/lojas">gerenciar lojas</a>).</p>
      <label>Setor (opcional)<input name="setor" maxlength="60" value="${esc(f.setor)}" list="setores" placeholder="Ex.: Vendas"></label>
      <datalist id="setores">${f.setores.map((s) => `<option value="${esc(s)}">`).join('')}</datalist>
      ${f.editando ? '' : '<p class="ajuda">Ao ativar, o bot passa a responder comandos neste grupo e guarda a lista de participantes (só identificação, sem mensagens).</p>'}
      <div><button class="primario">${f.editando ? 'Salvar' : 'Ativar neste grupo'}</button></div>
    </form>`,
    usuario
  )
}
