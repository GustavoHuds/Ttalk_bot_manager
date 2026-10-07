import { TEXTOS_EDITAVEIS, type DadosBot } from '../config/bots.js'
import type { Mensagens } from '../config/tipos.js'
import { esc, layout } from './paginas.js'

export interface OpcoesEditor {
  dados: DadosBot
  padrao: Mensagens
  /** Código original quando editando; null para bot novo. */
  original: string | null
  candidaturas: number
  erro: string | null
  usuario: string
  /** Números de recrutamento que o bot pode usar. */
  numeros: { id: number; nome: string }[]
}

/** JSON dentro de <script> sem permitir fechar a tag. */
function jsonSeguro(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c')
}

const FORMATOS: { valor: string; rotulo: string }[] = [
  { valor: 'pdf', rotulo: 'PDF' },
  { valor: 'docx', rotulo: 'Word (.docx)' },
  { valor: 'doc', rotulo: 'Word antigo (.doc)' },
  { valor: 'jpg', rotulo: 'Foto JPG' },
  { valor: 'png', rotulo: 'Foto PNG' }
]

export function paginaEditorBot(o: OpcoesEditor): string {
  const d = o.dados
  const editando = o.original !== null
  const curriculo = d.perguntas.find((p) => p.tipo === 'arquivo') ?? {
    tipo: 'arquivo' as const,
    texto: 'Agora envie seu currículo em PDF, Word ou foto.',
    formatos: ['pdf', 'docx', 'jpg', 'png'] as const,
    tamanho_max_mb: 10
  }
  const perguntas = d.perguntas.filter((p) => p.tipo !== 'arquivo')

  const textos = TEXTOS_EDITAVEIS.map(({ chave, rotulo, lista }) => {
    const padrao = o.padrao[chave]
    const atual = d.mensagens[chave]
    const valor = atual === undefined ? '' : Array.isArray(atual) ? atual.join('\n') : atual
    const dica = Array.isArray(padrao) ? padrao.join('\n') : (padrao ?? '')
    return `<p><label>${esc(rotulo)}<br><textarea data-msg="${esc(chave)}" rows="${lista ? 3 : 2}" placeholder="${esc(dica)}">${esc(valor)}</textarea></label></p>`
  }).join('')

  const botoes =
    d.status === 'aberto' && editando
      ? `<button name="acao" value="aberto" class="primario">Salvar</button>
         <button name="acao" value="encerrado">Encerrar inscrições</button>
         <button name="acao" value="rascunho">Voltar para rascunho</button>`
      : `<button name="acao" value="rascunho">Salvar rascunho</button>
         <button name="acao" value="aberto" class="primario">Abrir inscrições</button>
         ${d.status === 'encerrado' ? '<button name="acao" value="encerrado">Salvar (continua encerrado)</button>' : ''}`

  const aviso =
    editando && o.candidaturas > 0
      ? `<p class="alerta">Este bot já tem ${o.candidaturas} candidatura(s). Mudanças valem para as próximas mensagens; quem está no meio continua do passo em que parou. Remover uma pergunta não apaga respostas já dadas.</p>`
      : ''

  const corpo = `<h1>${editando ? `Editar bot · ${esc(d.vaga)}` : 'Novo bot'}</h1>
  ${o.erro ? `<div class="cartao erro"><strong>Não foi possível salvar:</strong> ${esc(o.erro)}</div>` : ''}${aviso}
  <form id="f" method="post" action="/bots/salvar">
    <input type="hidden" name="dados" id="dados"><input type="hidden" name="original" value="${esc(o.original ?? '')}">
    <div class="cartao">
      <div class="grade">
        <label>Nome da vaga<input id="vaga" value="${esc(d.vaga)}" required placeholder="Vendedor(a) de loja"></label>
        <label>Código (vai no link)<input id="codigo" value="${esc(d.codigo)}" ${editando ? 'readonly' : ''} required pattern="[A-Za-z0-9][A-Za-z0-9\\-]{1,30}" placeholder="VEND-OUT26"></label>
        <label>Número do WhatsApp<select id="numero_id">${o.numeros
          .map((n) => `<option value="${n.id}"${n.id === d.numero_id ? ' selected' : ''}>${esc(n.nome)}</option>`)
          .join('')}</select></label>
        <label>Abre em<input id="abre_em" type="date" value="${esc(d.abre_em ?? '')}"></label>
        <label>Encerra em<input id="encerra_em" type="date" value="${esc(d.encerra_em)}" required></label>
        <label>Guardar dados por (meses)<input id="retencao_meses" type="number" min="1" max="60" value="${esc(d.retencao_meses)}" required></label>
      </div>
      ${editando ? '' : '<p class="suave">O código não muda depois de criado: ele identifica a vaga no link e nas candidaturas.</p>'}
    </div>

    <div class="cartao">
      <div style="display:flex;justify-content:space-between;align-items:center"><h2 style="margin:0">Perguntas</h2>
      <button type="button" id="adicionar">+ Adicionar pergunta</button></div>
      <p class="suave">Uma pergunta por mensagem, nesta ordem. "Enquete" mostra as opções para tocar (o candidato também pode responder com o número).</p>
      <ol id="perguntas" class="perguntas"></ol>
      <div class="pergunta fixa">
        <strong>Currículo (sempre por último)</strong>
        <label>Mensagem pedindo o currículo<input id="cv_texto" value="${esc(curriculo.texto)}"></label>
        <div>Aceitar: ${FORMATOS.map((f) => `<label class="check"><input type="checkbox" class="cv_formato" value="${f.valor}" ${curriculo.formatos?.includes(f.valor as never) ? 'checked' : ''}> ${f.rotulo}</label>`).join(' ')}</div>
        <label style="max-width:220px">Tamanho máximo (MB)<input id="cv_tamanho" type="number" min="1" max="100" value="${esc(curriculo.tamanho_max_mb ?? 10)}"></label>
        <input type="hidden" id="cv_chave" value="${esc(curriculo.chave ?? 'curriculo')}">
      </div>
    </div>

    <details class="cartao"><summary><strong>Textos do bot</strong> <span class="suave">(em branco = texto padrão, mostrado em cinza)</span></summary>
      <p class="suave">Variáveis: {empresa} {vaga} {primeiro_nome} {protocolo} {retencao_meses}</p>${textos}
    </details>

    <div class="cartao acoes">${botoes} <a class="botao" href="/">Cancelar</a></div>
  </form>
  ${
    editando
      ? `<form method="post" action="/bots/${encodeURIComponent(o.original!)}/excluir" onsubmit="return confirm('Excluir este bot? Só é possível se não houver candidaturas.')">
          <button class="perigo" ${o.candidaturas > 0 ? 'disabled title="Há candidaturas: encerre em vez de excluir"' : ''}>Excluir bot</button></form>`
      : ''
  }
  <script type="application/json" id="inicial">${jsonSeguro(perguntas)}</script>
  <script>${SCRIPT}</script>`

  return layout(editando ? 'Editar bot' : 'Novo bot', corpo, o.usuario, `<style>${CSS_EDITOR}</style>`)
}

const CSS_EDITOR = `
.grade{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
label{display:block}.grade label,.pergunta label{font-size:.9rem;color:var(--suave)}
.perguntas{padding-left:0;list-style:none;margin:12px 0}
.pergunta{border:1px solid var(--borda);border-radius:8px;padding:12px;margin-bottom:10px;display:grid;gap:8px}
.pergunta.fixa{background:var(--fundo)}
.linha{display:flex;gap:8px;flex-wrap:wrap;align-items:end}.linha>label{flex:1 1 200px}
.check{display:inline-flex;gap:4px;align-items:center;margin-right:12px;color:var(--texto)}.check input{width:auto}
.acoes{display:flex;gap:8px;flex-wrap:wrap;position:sticky;bottom:0}
textarea{resize:vertical}summary{cursor:pointer}
[hidden]{display:none!important}
`

/** Editor das perguntas: monta as linhas a partir do JSON e serializa tudo no envio. */
const SCRIPT = `
(function(){
  var lista = document.getElementById('perguntas');
  var inicial = JSON.parse(document.getElementById('inicial').textContent);
  function el(html){var t=document.createElement('template');t.innerHTML=html.trim();return t.content.firstChild;}
  function escH(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function linha(p){
    var li = el('<li class="pergunta">'
      + '<div class="linha"><label>Pergunta<input class="q_texto" value="'+escH(p.texto)+'" placeholder="Ex.: Em qual cidade e bairro você mora?"></label>'
      + '<label style="flex:0 0 140px">Tipo<select class="q_tipo"><option value="texto">Texto livre</option><option value="enquete">Enquete</option></select></label>'
      + '<span><button type="button" class="q_cima" title="Subir">↑</button> <button type="button" class="q_baixo" title="Descer">↓</button> <button type="button" class="q_remover perigo" title="Remover">Remover</button></span></div>'
      + '<label class="q_val">Conferir resposta<select class="q_validacao"><option value="">Não conferir</option><option value="nome_completo">Nome completo (nome e sobrenome)</option><option value="telefone">Telefone com DDD</option></select></label>'
      + '<label class="q_ops">Opções da enquete (uma por linha, de 2 a 12)<textarea class="q_opcoes" rows="4">'+escH((p.opcoes||[]).join('\\n'))+'</textarea></label>'
      + '<input type="hidden" class="q_chave" value="'+escH(p.chave||'')+'"></li>');
    li.querySelector('.q_tipo').value = p.tipo === 'enquete' ? 'enquete' : 'texto';
    li.querySelector('.q_validacao').value = p.validacao || '';
    function ajustar(){var e=li.querySelector('.q_tipo').value==='enquete';li.querySelector('.q_ops').hidden=!e;li.querySelector('.q_val').hidden=e;}
    li.querySelector('.q_tipo').addEventListener('change', ajustar); ajustar();
    li.querySelector('.q_cima').onclick=function(){if(li.previousElementSibling)lista.insertBefore(li,li.previousElementSibling);};
    li.querySelector('.q_baixo').onclick=function(){if(li.nextElementSibling)lista.insertBefore(li.nextElementSibling,li);};
    li.querySelector('.q_remover').onclick=function(){if(confirm('Remover esta pergunta?'))li.remove();};
    return li;
  }
  inicial.forEach(function(p){lista.appendChild(linha(p));});
  document.getElementById('adicionar').onclick=function(){var li=linha({tipo:'texto',texto:''});lista.appendChild(li);li.querySelector('.q_texto').focus();};
  document.getElementById('f').addEventListener('submit', function(){
    var v=function(id){return document.getElementById(id).value;};
    var perguntas=[].map.call(lista.children,function(li){
      var tipo=li.querySelector('.q_tipo').value, p={chave:li.querySelector('.q_chave').value,tipo:tipo,texto:li.querySelector('.q_texto').value};
      if(tipo==='enquete')p.opcoes=li.querySelector('.q_opcoes').value.split('\\n');else if(li.querySelector('.q_validacao').value)p.validacao=li.querySelector('.q_validacao').value;
      return p;
    });
    perguntas.push({chave:v('cv_chave'),tipo:'arquivo',texto:v('cv_texto'),
      formatos:[].filter.call(document.querySelectorAll('.cv_formato'),function(c){return c.checked;}).map(function(c){return c.value;}),
      tamanho_max_mb:Number(v('cv_tamanho'))});
    var mensagens={};
    [].forEach.call(document.querySelectorAll('[data-msg]'),function(t){if(t.value.trim())mensagens[t.dataset.msg]=t.value;});
    document.getElementById('dados').value=JSON.stringify({codigo:v('codigo'),numero_id:Number(v('numero_id')),vaga:v('vaga'),abre_em:v('abre_em')||null,
      encerra_em:v('encerra_em'),retencao_meses:Number(v('retencao_meses')),perguntas:perguntas,mensagens:mensagens});
  });
})();
`
