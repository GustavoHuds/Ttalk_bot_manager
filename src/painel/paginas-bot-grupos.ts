import type { BotGrupos, GestorBot, Programada, Silencio } from '../db/bots-grupos.js'
import type { Funcionario, Grupo } from '../db/grupos.js'
import type { Numero } from '../db/numeros.js'
import { COMANDOS } from '../grupos/comandos.js'
import { formatarTelefone } from '../grupos/pessoas.js'
import type { EstadoConexao } from '../whatsapp/baileys.js'
import { dataBR } from './exportar.js'
import { abas, botaoPost, cabecalho, copiar, esc, layout, mensagem, resumo, selo, seloNumero, tabela } from './paginas.js'

/** O que todas as páginas de um bot de grupos mostram no topo. */
export interface CabecalhoBot {
  bot: BotGrupos
  numero: Numero | null
  estado: EstadoConexao | null
}

export type AbaBot = 'geral' | 'grupos' | 'gestores' | 'comandos' | 'programadas'

const ABAS: { aba: AbaBot; caminho: string; rotulo: string }[] = [
  { aba: 'geral', caminho: '', rotulo: 'Geral' },
  { aba: 'grupos', caminho: '/grupos', rotulo: 'Grupos' },
  { aba: 'gestores', caminho: '/gestores', rotulo: 'Gestores' },
  { aba: 'comandos', caminho: '/comandos', rotulo: 'Comandos' },
  { aba: 'programadas', caminho: '/programadas', rotulo: 'Programadas' }
]

/** Moldura de todas as páginas de um bot: cabeçalho, selos e as abas (sempre as mesmas). */
function pagina(c: CabecalhoBot, aba: AbaBot, corpo: string, usuario: string, acoes = '', head = ''): string {
  const base = `/grupos-bot/${c.bot.id}`
  const atual = ABAS.find((x) => x.aba === aba)!
  const selos = `${selo('Grupos', 'marca')}${c.bot.ativo ? '' : selo('desativado', 'erro')}${c.numero ? `${selo(c.numero.nome)}${seloNumero(c.numero, c.estado)}` : selo('sem número', 'erro')}`
  return layout(
    `${atual.rotulo} · ${c.bot.nome}`,
    `${cabecalho(c.bot.nome, { voltar: { href: '/', rotulo: 'Bots' }, selos, acoes })}
    ${abas(
      ABAS.map((x) => ({ href: `${base}${x.caminho}`, rotulo: x.rotulo })),
      `${base}${atual.caminho}`
    )}${corpo}`,
    usuario,
    { secao: 'bots', head }
  )
}

// --- novo / geral -------------------------------------------------------------------

/** Números de grupos que este bot pode usar: livres ou o atual dele. */
export interface OpcaoNumero {
  id: number
  nome: string
  usadoPor: string | null
}

function selectNumero(opcoes: OpcaoNumero[], atual: number | null): string {
  const itens = opcoes
    .map(
      (n) =>
        `<option value="${n.id}"${n.id === atual ? ' selected' : ''}${n.usadoPor ? ' disabled' : ''}>${esc(n.nome)}${n.usadoPor ? ` (${esc(n.usadoPor)})` : ''}</option>`
    )
    .join('')
  return `<select name="numero_id"><option value=""${atual === null ? ' selected' : ''}>Sem número</option>${itens}</select>`
}

export function paginaNovoBotGrupos(opcoes: OpcaoNumero[], usuario: string, erro: string | null, nome = ''): string {
  return layout(
    'Novo bot de grupos',
    `${cabecalho('Novo bot de grupos', { voltar: { href: '/', rotulo: 'Bots' } })}${mensagem(null, erro)}
    <form method="post" action="/grupos-bot" class="cartao campos">
      <label class="campo"><span>Nome</span><input name="nome" required maxlength="40" value="${esc(nome)}" placeholder="Avisos da loja"></label>
      <label class="campo"><span>Número</span>${selectNumero(opcoes, null)}</label>
      <div class="acoes"><button class="primario">Criar bot</button><a class="botao" href="/numeros/novo">+ Número</a></div>
    </form>`,
    usuario,
    { secao: 'bots' }
  )
}

export interface DadosGeral {
  cab: CabecalhoBot
  opcoes: OpcaoNumero[]
  gruposAtivos: number
  gestoresConfirmados: number
  gestoresPendentes: number
  programadas: number
}

export function paginaGeralBot(d: DadosGeral, usuario: string, ok: string | null, erro: string | null): string {
  const b = d.cab.bot
  const excluir = botaoPost(`/grupos-bot/${b.id}/excluir`, 'Excluir bot', {
    classe: 'perigo',
    confirma: `Excluir o bot ${b.nome}? Gestores, comandos e programadas dele são apagados.`,
    ...(d.gruposAtivos ? { desabilitado: 'Desative os grupos antes' } : {})
  })
  const corpo = `${mensagem(ok, erro)}
    ${resumo([
      { valor: d.gruposAtivos, rotulo: 'grupos ativos' },
      { valor: d.gestoresConfirmados, rotulo: 'gestores' },
      { valor: d.gestoresPendentes, rotulo: 'gestores pendentes' },
      { valor: d.programadas, rotulo: 'programadas' }
    ])}
    <div class="grade2">
      <form method="post" action="/grupos-bot/${b.id}" class="cartao campos">
        <h2>Configuração</h2>
        <label class="campo"><span>Nome</span><input name="nome" required maxlength="40" value="${esc(b.nome)}"></label>
        <label class="campo"><span>Número</span>${selectNumero(d.opcoes, b.numeroId)}</label>
        <label class="marcar"><input type="checkbox" name="ativo" value="1"${b.ativo ? ' checked' : ''}> Bot ativo</label>
        <div class="acoes"><button class="primario">Salvar</button>${d.cab.numero ? `<a class="botao" href="/numeros/${d.cab.numero.id}">Abrir número</a>` : ''}</div>
      </form>
      <div class="cartao zona"><h2>Excluir</h2><div class="acoes">${excluir}</div></div>
    </div>`
  return pagina(d.cab, 'geral', corpo, usuario)
}

// --- grupos -------------------------------------------------------------------------

export interface LinhaGrupoAtivo {
  jid: string
  /** Da lista geral do número atual; null = o número atual não está no grupo. */
  geral: Grupo | null
  ativadoEm: number
  palavras: number
  silencio: Silencio | null
  repeticoes: number
}

export interface DadosGrupos {
  cab: CabecalhoBot
  ativos: LinhaGrupoAtivo[]
  /** Grupos do número que ainda não estão ativos no bot. */
  disponiveis: Grupo[]
}

export function paginaGruposBot(d: DadosGrupos, usuario: string, ok: string | null, erro: string | null): string {
  const id = d.cab.bot.id
  const ativos = tabela(
    [{ rotulo: 'Grupo' }, { rotulo: 'Admin' }, { rotulo: 'Moderação' }, { rotulo: 'Ativado em' }, { rotulo: '', fim: true }],
    d.ativos.map((a) => {
      const nome = a.geral?.nome ?? 'Grupo'
      const fora = !a.geral?.ativo ? selo('número fora do grupo', 'erro') : ''
      const moderacao = [
        a.palavras ? selo(`${a.palavras} palavra(s) proibida(s)`) : '',
        a.silencio ? selo(a.silencio.inicio ? `fecha ${a.silencio.inicio}–${a.silencio.fim}` : 'fechado', 'alerta') : '',
        a.repeticoes ? selo(`${a.repeticoes} repetição(ões)`, 'marca') : ''
      ].join('')
      return {
        celulas: [
          `<span class="nome">${esc(nome)}</span>${fora ? `<div>${fora}</div>` : ''}`,
          a.geral?.botAdmin ? selo('admin', 'ok') : selo('não é admin', 'alerta'),
          moderacao ? `<div class="fichas">${moderacao}</div>` : '—',
          esc(dataBR(a.ativadoEm)),
          botaoPost(`/grupos-bot/${id}/grupos/desativar`, 'Desativar', {
            classe: 'perigo mini',
            campos: { jid: a.jid },
            confirma: `Desativar ${nome}? O bot para de agir neste grupo e as programadas dele são apagadas.`
          })
        ]
      }
    }),
    'Nenhum grupo ativo.'
  )
  const disponiveis = tabela(
    [{ rotulo: 'Grupo' }, { rotulo: 'Admin' }, { rotulo: '', fim: true }],
    d.disponiveis.map((x) => ({
      atributos: `data-nome="${esc(x.nome.toLowerCase())}"`,
      celulas: [
        `<span class="nome">${esc(x.nome)}</span>`,
        x.botAdmin ? selo('admin', 'ok') : selo('não é admin'),
        botaoPost(`/grupos-bot/${id}/grupos/ativar`, 'Ativar', { classe: 'primario mini', campos: { jid: x.jid } })
      ]
    })),
    d.cab.numero ? 'Nenhum outro grupo neste número.' : 'Escolha um número na aba Geral.'
  )
  const corpo = `${mensagem(ok, erro)}
    <div class="cartao"><div class="topo"><h2>Ativos <span class="suave">(${d.ativos.length})</span></h2></div>${ativos}</div>
    <div class="cartao"><div class="topo"><h2>Outros grupos do número <span class="suave">(${d.disponiveis.length})</span></h2>
      ${d.disponiveis.length > 6 ? '<input type="search" id="busca" placeholder="Buscar grupo" aria-label="Buscar grupo" style="max-width:260px">' : ''}</div>
      <div id="geral">${disponiveis}</div><p id="nenhum" class="vazio" hidden>Nenhum grupo com esse nome.</p></div>
    <script>(function(){var b=document.getElementById('busca');if(!b)return;b.addEventListener('input',function(){
      var t=b.value.trim().toLowerCase(),n=0;document.querySelectorAll('#geral tr[data-nome]').forEach(function(r){
      var v=r.getAttribute('data-nome').indexOf(t)!==-1;r.hidden=!v;if(v)n++;});document.getElementById('nenhum').hidden=n>0||!t;});})();</script>`
  return pagina(d.cab, 'grupos', corpo, usuario)
}

// --- gestores -----------------------------------------------------------------------

export interface LinhaGestor {
  gestor: GestorBot
  pessoa: Funcionario
}

/** Link que abre o WhatsApp da pessoa já com "/confirmar <código>" para o número do bot. */
export function linkConfirmar(telefoneBot: string, codigo: string): string {
  return `https://wa.me/${telefoneBot}?text=${encodeURIComponent(`/confirmar ${codigo}`)}`
}

const telefone = (t: string | null) => (t ? formatarTelefone(t) : '—')

/** JID legível: telefone formatado, ou "contato oculto" para LID. */
function jidLegivel(jid: string): string {
  const usuario = jid.split('@')[0]!.split(':')[0]!
  return jid.endsWith('@s.whatsapp.net') ? formatarTelefone(usuario) : `contato oculto (${usuario})`
}

function cartaoGestor(botId: number, nomeBot: string, l: LinhaGestor, telefoneBot: string | null, agora: number): string {
  const { gestor: g, pessoa: p } = l
  const base = `/grupos-bot/${botId}/gestores/${p.id}`
  const remover = botaoPost(`${base}/remover`, g.confirmadoEm ? 'Remover' : 'Cancelar', {
    classe: 'perigo mini',
    confirma: `Tirar ${p.nome} dos gestores do ${nomeBot}?`
  })
  const quem = `<div><span class="nome">${esc(p.nome)}</span><span class="sub">${esc(telefone(p.telefone))}</span></div>`
  if (g.confirmadoEm) {
    return `<div class="cartao"><div class="topo">${quem}<div class="linha">${selo('confirmado', 'ok')}${remover}</div></div>
      <p class="pequeno suave" style="margin:10px 0 0">Desde ${esc(dataBR(g.confirmadoEm))}${g.confirmadoJid ? ` · ${esc(jidLegivel(g.confirmadoJid))}` : ''}</p></div>`
  }
  const divergencia = g.divergenteEm
    ? `<div class="aviso alerta" style="margin:14px 0 0">Código recebido de ${esc(g.divergenteTelefone ? formatarTelefone(g.divergenteTelefone) : jidLegivel(g.divergenteJid ?? ''))} em ${esc(dataBR(g.divergenteEm))}.
        <div class="acoes" style="margin-top:10px">${botaoPost(`${base}/aceitar-divergencia`, 'Usar este WhatsApp', { classe: 'primario mini', confirma: `Trocar o WhatsApp de ${p.nome} por este e confirmar?` })}${botaoPost(`${base}/descartar-divergencia`, 'Descartar', { classe: 'mini' })}</div></div>`
    : ''
  const vencido = !g.codigo || (g.codigoExpiraEm ?? 0) <= agora
  const codigo = vencido
    ? `<p style="margin:12px 0 0">${selo('código vencido', 'erro')}</p>`
    : `<div style="margin:14px 0 0;display:grid;gap:10px"><div class="linha"><span class="codigo">${esc(g.codigo)}</span><span class="pequeno suave">até ${esc(dataBR(g.codigoExpiraEm!))}</span></div>
        ${telefoneBot ? copiar(linkConfirmar(telefoneBot, g.codigo!), 'Copiar link') : ''}</div>`
  return `<div class="cartao"><div class="topo">${quem}<div class="linha">${selo('pendente', 'alerta')}${botaoPost(`${base}/codigo`, 'Novo código', { classe: 'mini' })}${remover}</div></div>
    ${codigo}${divergencia}</div>`
}

export interface DadosGestores {
  cab: CabecalhoBot
  linhas: LinhaGestor[]
  telefoneBot: string | null
  agora: number
  form: { nome: string; telefone: string }
}

export function paginaGestores(d: DadosGestores, usuario: string, ok: string | null, erro: string | null): string {
  const id = d.cab.bot.id
  const pendentes = d.linhas.filter((l) => !l.gestor.confirmadoEm)
  const confirmados = d.linhas.filter((l) => l.gestor.confirmadoEm)
  const cartoes = (ls: LinhaGestor[]) => ls.map((l) => cartaoGestor(id, d.cab.bot.nome, l, d.telefoneBot, d.agora)).join('')
  const corpo = `${mensagem(ok, erro)}
    <form method="post" action="/grupos-bot/${id}/gestores" class="cartao"><h2>Novo gestor</h2>
      <div class="linha" style="align-items:flex-end">
        <label class="campo" style="flex:2 1 220px"><span>Nome</span><input name="nome" required maxlength="80" value="${esc(d.form.nome)}"></label>
        <label class="campo" style="flex:1 1 180px"><span>WhatsApp</span><input name="telefone" required inputmode="tel" value="${esc(d.form.telefone)}" placeholder="(83) 99999-0000"></label>
        <button class="primario">Adicionar</button>
      </div></form>
    ${pendentes.length ? `<div class="secao"><h2>Pendentes <span class="suave">(${pendentes.length})</span></h2></div>${cartoes(pendentes)}` : ''}
    <div class="secao"><h2>Confirmados <span class="suave">(${confirmados.length})</span></h2></div>
    ${cartoes(confirmados) || '<div class="cartao vazio">Nenhum gestor confirmado.</div>'}`
  return pagina(d.cab, 'gestores', corpo, usuario)
}

// --- comandos -----------------------------------------------------------------------

export function paginaComandos(cab: CabecalhoBot, desligados: Set<string>, usuario: string, ok: string | null): string {
  const id = cab.bot.id
  const t = tabela(
    [{ rotulo: 'Comando' }, { rotulo: 'Uso' }, { rotulo: 'Onde' }, { rotulo: '', fim: true }],
    COMANDOS.filter((c) => !c.oculto).map((c) => {
      const desligado = !c.fixo && desligados.has(c.nome)
      const chave = c.fixo
        ? selo('sempre ligado', 'ok')
        : `<form method="post" action="/grupos-bot/${id}/comandos/${c.nome}"><input type="hidden" name="ligado" value="${desligado ? '1' : '0'}">
            <button class="chave mini${desligado ? '' : ' ligada'}" aria-pressed="${!desligado}">${desligado ? 'Desligado' : 'Ligado'}</button></form>`
      return {
        classe: desligado ? 'apagada' : '',
        celulas: [`<span class="nome">/${c.nome}</span><span class="sub">${esc(c.descricao)}</span>`, `<code>${esc(c.uso)}</code>`, c.soPrivado ? 'Privado' : 'Grupo e privado', chave]
      }
    }),
    ''
  )
  return pagina(cab, 'comandos', `${mensagem(ok)}<div class="cartao">${t}</div>`, usuario)
}

// --- programadas --------------------------------------------------------------------

export const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']

export function quando(p: Pick<Programada, 'horarios' | 'dias' | 'data'>): string {
  const hs = p.horarios.join(', ')
  if (p.data) return `${p.data.split('-').reverse().join('/')} às ${hs}`
  const dias = p.dias.length === 7 ? 'Todo dia' : p.dias.map((d) => DIAS[d]).join(', ')
  return `${dias} às ${hs}`
}

const ICONE_MIDIA = { imagem: '🖼', video: '🎬', audio: '🎵', documento: '📄' } as const

export function paginaProgramadas(cab: CabecalhoBot, itens: Programada[], nomes: Map<string, string>, usuario: string, ok: string | null): string {
  const id = cab.bot.id
  const t = tabela(
    [{ rotulo: 'Mensagem' }, { rotulo: 'Grupo' }, { rotulo: 'Quando' }, { rotulo: 'Situação' }, { rotulo: '', fim: true }],
    itens.map((p) => {
      const v = p.variacoes[0]
      const previa = (v?.texto ?? '').replace(/\s+/g, ' ').slice(0, 80) || (v?.midia ? (v.midia.nome ?? 'mídia') : '—')
      const extra = [
        p.origem === 'repeat' ? selo('/repeat', 'marca') : '',
        p.variar && p.variacoes.length > 1 ? selo(`${p.variacoes.length} variações`) : '',
        p.mencionar ? selo('menciona todos') : '',
        ...p.variacoes.flatMap((x) => (x.midia ? [selo(`${ICONE_MIDIA[x.midia.tipo]} ${x.midia.tipo}`)] : []))
      ].join('')
      const situacao = p.ativa ? selo('ativa', 'ok') : selo(p.data && p.ultimoEnvio ? 'enviada' : 'pausada')
      return {
        classe: p.ativa ? '' : 'apagada',
        celulas: [
          `<a class="nome" href="/grupos-bot/${id}/programadas/${p.id}">${esc(previa)}</a>${extra ? `<div class="fichas" style="margin-top:4px">${extra}</div>` : ''}`,
          esc(nomes.get(p.jid) ?? 'Grupo'),
          esc(quando(p)),
          situacao,
          `<div class="acoes">${botaoPost(`/grupos-bot/${id}/programadas/${p.id}/${p.ativa ? 'pausar' : 'ativar'}`, p.ativa ? 'Pausar' : 'Ativar', { classe: 'mini' })}
            ${botaoPost(`/grupos-bot/${id}/programadas/${p.id}/excluir`, 'Excluir', { classe: 'perigo mini', confirma: 'Excluir esta mensagem programada?' })}</div>`
        ]
      }
    }),
    'Nenhuma mensagem programada.'
  )
  return pagina(cab, 'programadas', `${mensagem(ok)}<div class="cartao">${t}</div>`, usuario, `<a class="botao primario" href="/grupos-bot/${id}/programadas/nova">+ Mensagem</a>`)
}

/** Formulário de uma programada como o painel mostra e recebe. */
export interface FormProgramada {
  jid: string
  tipo: 'semanal' | 'unica'
  dias: number[]
  data: string
  horarios: string[]
  variar: boolean
  mencionar: boolean
  /** Três abas de mensagem: texto e mídia já salva (nome para mostrar). */
  msgs: { texto: string; midia: { nome: string; tipo: string } | null }[]
}

export const MAX_MIDIA_BYTES = 15 * 1024 * 1024

export function paginaFormProgramada(
  cab: CabecalhoBot,
  grupos: { jid: string; nome: string }[],
  f: FormProgramada,
  editando: number | null,
  usuario: string,
  erro: string | null
): string {
  const id = cab.bot.id
  const opcoes = grupos.map((g) => `<option value="${esc(g.jid)}"${g.jid === f.jid ? ' selected' : ''}>${esc(g.nome)}</option>`).join('')
  const horarios = [0, 1, 2, 3]
    .map((i) => `<input type="time" name="horario${i}" value="${esc(f.horarios[i] ?? '')}" aria-label="Horário ${i + 1}" style="flex:1 1 120px"${i === 0 ? ' required' : ''}>`)
    .join('')
  const dias = DIAS.map(
    (d, i) => `<label class="marcar" style="flex:0 0 auto"><input type="checkbox" name="dia${i}" value="1"${f.dias.includes(i) ? ' checked' : ''}> ${d}</label>`
  ).join('')
  const radios = f.msgs.map((_, i) => `<input type="radio" name="aba" id="aba${i}" class="aba-r"${i === 0 ? ' checked' : ''}>`).join('')
  const paineis = f.msgs
    .map(
      (m, i) => `<div class="painel painel${i}">
        <label class="campo"><span>Texto</span><textarea name="texto${i}" rows="6" maxlength="4000">${esc(m.texto)}</textarea></label>
        <div class="linha" style="margin-top:10px">
          <label class="botao mini" style="cursor:pointer">Anexar mídia<input type="file" data-midia="${i}" accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx" hidden></label>
          <span class="pequeno" id="nome${i}">${m.midia ? `${esc(m.midia.nome)} ${selo(m.midia.tipo)}` : '<span class="suave">sem mídia</span>'}</span>
          ${m.midia ? `<label class="marcar pequeno"><input type="checkbox" name="tirar${i}" value="1"> remover mídia</label>` : ''}
        </div>
        <input type="hidden" name="arquivo${i}" id="arquivo${i}"><input type="hidden" name="arquivo_nome${i}" id="arquivo_nome${i}"><input type="hidden" name="arquivo_tipo${i}" id="arquivo_tipo${i}">
      </div>`
    )
    .join('')
  const estilo = `<style>
    .msgs{position:relative;border:1px solid var(--borda);border-radius:10px;overflow:hidden}
    .msgs .aba-r{position:absolute;opacity:0;pointer-events:none}
    .msgs .rotulos{display:flex;border-bottom:1px solid var(--borda);background:var(--sup2);overflow-x:auto}
    .msgs .aba-l{padding:10px 16px;cursor:pointer;font-weight:500;color:var(--suave);border-bottom:2px solid transparent;white-space:nowrap}
    .msgs .painel{display:none;padding:14px}
    #aba0:checked~.rotulos .aba-l0,#aba1:checked~.rotulos .aba-l1,#aba2:checked~.rotulos .aba-l2{color:var(--texto);border-bottom-color:var(--marca)}
    #aba0:checked~.painel0,#aba1:checked~.painel1,#aba2:checked~.painel2{display:block}
    form:not(.variando) .aba-l1,form:not(.variando) .aba-l2{display:none}
    form.unica .so-semanal,form:not(.unica) .so-unica{display:none}
  </style>`
  const script = `<script>(function(){
    var f=document.getElementById('form-prog');
    function ajustar(){f.classList.toggle('variando',f.variar.checked);f.classList.toggle('unica',f.tipo.value==='unica');
      if(!f.variar.checked)document.getElementById('aba0').checked=true;}
    f.variar.addEventListener('change',ajustar);[].forEach.call(f.tipo,function(r){r.addEventListener('change',ajustar)});ajustar();
    [].forEach.call(document.querySelectorAll('[data-midia]'),function(inp){inp.addEventListener('change',function(){
      var i=inp.dataset.midia,a=inp.files[0];if(!a)return;
      if(a.size>${MAX_MIDIA_BYTES}){alert('Arquivo maior que 15 MB.');inp.value='';return}
      var r=new FileReader();r.onload=function(){document.getElementById('arquivo'+i).value=String(r.result).split(',')[1]||'';
        document.getElementById('arquivo_nome'+i).value=a.name;document.getElementById('arquivo_tipo'+i).value=a.type||'application/octet-stream';
        document.getElementById('nome'+i).textContent=a.name;};r.readAsDataURL(a);});});
  })();</script>`
  const corpo = `${mensagem(null, erro)}
    <form method="post" action="/grupos-bot/${id}/programadas" id="form-prog" class="cartao campos largo${f.variar ? ' variando' : ''}${f.tipo === 'unica' ? ' unica' : ''}">
      <input type="hidden" name="id" value="${editando ?? ''}">
      <h2>${editando ? 'Editar mensagem' : 'Nova mensagem'}</h2>
      <div class="grade2">
        <label class="campo"><span>Grupo</span><select name="jid" required>${opcoes}</select></label>
        <div class="campo"><span>Repetição</span><div class="linha" style="min-height:38px">
          <label class="marcar"><input type="radio" name="tipo" value="semanal"${f.tipo === 'semanal' ? ' checked' : ''}> Dias da semana</label>
          <label class="marcar"><input type="radio" name="tipo" value="unica"${f.tipo === 'unica' ? ' checked' : ''}> Uma vez</label></div></div>
      </div>
      <div class="campo so-semanal"><span>Dias</span><div class="linha">${dias}</div></div>
      <label class="campo so-unica" style="max-width:240px"><span>Data</span><input type="date" name="data" value="${esc(f.data)}"></label>
      <div class="campo"><span>Horários</span><div class="linha">${horarios}</div></div>
      <div class="linha" style="gap:18px">
        <label class="marcar"><input type="checkbox" name="variar" value="1"${f.variar ? ' checked' : ''}> Variar mensagens</label>
        <label class="marcar"><input type="checkbox" name="mencionar" value="1"${f.mencionar ? ' checked' : ''}> Mencionar todos (sem mostrar)</label>
      </div>
      <div class="msgs">${radios}
        <div class="rotulos">${f.msgs.map((_, i) => `<label for="aba${i}" class="aba-l aba-l${i}">Mensagem ${i + 1}</label>`).join('')}</div>${paineis}</div>
      <div class="acoes"><button class="primario">${editando ? 'Salvar' : 'Programar'}</button><a class="botao" href="/grupos-bot/${id}/programadas">Cancelar</a></div>
    </form>${script}`
  return pagina(cab, 'programadas', corpo, usuario, '', estilo)
}
