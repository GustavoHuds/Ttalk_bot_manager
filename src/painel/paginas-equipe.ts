import type { BotGrupos } from '../db/bots-grupos.js'
import type { Funcionario } from '../db/grupos.js'
import type { LinhaCsv } from '../grupos/equipe.js'
import { formatarTelefone } from '../grupos/pessoas.js'
import { dataBR } from './exportar.js'
import { cartaoGestor, type LinhaGestor } from './paginas-bot-grupos.js'
import { esc, layout, mensagem, resumo, selo } from './paginas.js'

const falha = (t: string | null) => (t ? `<div class="cartao erro">${esc(t)}</div>` : '')
const tel = (t: string | null) => (t ? formatarTelefone(t) : '—')

/** Situação da pessoa no WhatsApp: provada por código, vista nos grupos ativos, ou nunca vista. */
export type SituacaoWhatsApp = 'confirmado' | 'visto' | 'nunca'

export function situacaoWhatsApp(f: Funcionario, emGrupos: number): SituacaoWhatsApp {
  if (f.confirmadoEm) return 'confirmado'
  return f.lid || emGrupos > 0 ? 'visto' : 'nunca'
}

export function seloWhatsApp(s: SituacaoWhatsApp): string {
  return s === 'confirmado' ? selo('✅ confirmado', 'ok') : s === 'visto' ? selo('👁 visto nos grupos') : selo('⚠ nunca visto', 'alerta')
}

/** Gestor em um bot, como a lista da equipe mostra. */
export interface GestorDaPessoa {
  botId: number
  bot: string
  situacao: 'confirmado' | 'pendente' | 'divergente'
}

export interface LinhaEquipe {
  f: Funcionario
  gestor: GestorDaPessoa[]
  /** Grupos ativos (de qualquer bot) em que a pessoa aparece. */
  grupos: number
}

export const FILTROS_SITUACAO = {
  '': 'Todas as pessoas ativas',
  confirmados: 'WhatsApp confirmado',
  nao_confirmados: 'WhatsApp não confirmado',
  nunca_vistos: 'Nunca vistas no WhatsApp',
  gestores: 'Gestores',
  pendentes: 'Gestores aguardando confirmação',
  inativos: 'Inativas'
} as const

export type FiltroSituacao = keyof typeof FILTROS_SITUACAO

export interface DadosEquipe {
  linhas: LinhaEquipe[]
  q: string
  loja: string
  situacao: FiltroSituacao
  lojas: string[]
  contagem: { ativos: number; confirmados: number; nuncaVistos: number; gestores: number }
}

function seloGestor(g: GestorDaPessoa): string {
  const rotulo = `👔 ${g.bot}`
  return g.situacao === 'confirmado'
    ? selo(`${rotulo} ✅`, 'ok')
    : g.situacao === 'divergente'
      ? selo(`${rotulo} ⚠ conferir`, 'erro')
      : selo(`${rotulo} ⏳`, 'alerta')
}

export function paginaEquipe(d: DadosEquipe, usuario: string, msg: string | null): string {
  const linhas = d.linhas
    .map(({ f, gestor, grupos }) => {
      const onde = [f.loja, f.setor].filter(Boolean).join(' · ')
      return `<tr${f.ativo ? '' : ' class="suave"'}>
        <td><a href="/equipe/${f.id}"><strong>${esc(f.nome)}</strong></a>${f.cargo ? `<div class="ajuda">${esc(f.cargo)}</div>` : ''}${f.ativo ? '' : `<div>${selo('inativo')}</div>`}</td>
        <td>${esc(tel(f.telefone))}</td>
        <td class="esconde-celular">${onde ? esc(onde) : '<span class="suave">—</span>'}</td>
        <td>${seloWhatsApp(situacaoWhatsApp(f, grupos))}${grupos ? `<div class="ajuda">em ${grupos} grupo(s) ativo(s)</div>` : ''}</td>
        <td class="linha">${gestor.map(seloGestor).join('') || '<span class="suave">—</span>'}</td></tr>`
    })
    .join('')
  const opcoesLoja = d.lojas.map((l) => `<option${l === d.loja ? ' selected' : ''}>${esc(l)}</option>`).join('')
  const opcoesSituacao = (Object.keys(FILTROS_SITUACAO) as FiltroSituacao[])
    .map((k) => `<option value="${k}"${k === d.situacao ? ' selected' : ''}>${esc(FILTROS_SITUACAO[k])}</option>`)
    .join('')
  const filtrando = !!(d.q || d.loja || d.situacao)
  return layout(
    'Equipe',
    `<div class="topo"><h1>Equipe</h1>
      <span class="linha"><a class="botao primario" href="/equipe/novo">+ Pessoa</a> <a class="botao" href="/equipe/importar">Importar CSV</a> <a class="botao" href="/equipe/exportar">Exportar CSV</a></span></div>
    ${mensagem(msg)}
    ${resumo([
      { valor: d.contagem.ativos, rotulo: 'pessoas ativas' },
      { valor: d.contagem.confirmados, rotulo: 'WhatsApp confirmado' },
      { valor: d.contagem.nuncaVistos, rotulo: 'nunca vistas no WhatsApp' },
      { valor: d.contagem.gestores, rotulo: 'gestores confirmados' }
    ])}
    <form method="get" action="/equipe" class="cartao linha">
      <input name="q" value="${esc(d.q)}" placeholder="Nome, telefone, setor ou cargo" aria-label="Buscar" style="flex:2 1 220px">
      <select name="loja" aria-label="Loja" style="flex:1 1 160px"><option value="">Todas as lojas</option>${opcoesLoja}</select>
      <select name="situacao" aria-label="Situação" style="flex:1 1 220px">${opcoesSituacao}</select>
      <button>Filtrar</button>${filtrando ? ' <a class="botao" href="/equipe">Limpar</a>' : ''}
    </form>
    <div class="cartao"><p class="ajuda" style="margin-top:0"><strong>✅ confirmado</strong>: a pessoa provou, mandando um código, que este WhatsApp é dela. <strong>👁 visto</strong>: o bot já a viu num grupo ativo (pelo telefone ou pelo contato). <strong>⚠ nunca visto</strong>: confira o telefone. Gestores são escolhidos em cada bot de grupos.</p>
    <table><thead><tr><th>Nome</th><th>Telefone</th><th class="esconde-celular">Loja · setor</th><th>WhatsApp</th><th>Gestor</th></tr></thead>
    <tbody>${linhas || `<tr><td colspan="5" class="vazio">${filtrando ? 'Ninguém com esses filtros.' : 'Ninguém cadastrado ainda. Use "+ Pessoa" ou "Importar CSV".'}</td></tr>`}</tbody></table>
    <p class="ajuda">${d.linhas.length} pessoa(s) na lista.</p></div>`,
    usuario
  )
}

export interface FormFuncionario {
  id: number | null
  nome: string
  telefone: string
  setor: string
  loja: string
  cargo: string
  nascimento: string
  ativo: boolean
  lid: string | null
}

/** Gestor da pessoa num bot (ou não), para o cartão "Gestor" da página dela. */
export interface GestorNoBot {
  bot: BotGrupos
  linha: LinhaGestor | null
  telefoneBot: string | null
}

/** O que a página da pessoa mostra além do formulário (só para quem já existe). */
export interface PerfilPessoa {
  pessoa: Funcionario
  /** Grupos ativos onde a pessoa aparece. */
  grupos: { bot: string; nome: string; loja: string | null }[]
  gestores: GestorNoBot[]
  historico: { em: number; usuario: string; acao: string; detalhe: string | null }[]
  agora: number
}

function cartaoWhatsApp(p: PerfilPessoa): string {
  const f = p.pessoa
  const situacao = situacaoWhatsApp(f, p.grupos.length)
  const explica =
    situacao === 'confirmado'
      ? `Confirmado em ${esc(dataBR(f.confirmadoEm!))}: a pessoa mandou o código pelo próprio WhatsApp. O telefone abaixo está certo.`
      : situacao === 'visto'
        ? 'O bot já viu esta pessoa num grupo ativo, mas ela ainda não confirmou por código.'
        : 'O bot nunca viu este telefone em nenhum grupo ativo. Se a pessoa está num grupo ativo, o telefone pode estar errado.'
  const grupos = p.grupos.length
    ? `<ul style="margin:4px 0 0;padding-left:20px">${p.grupos.map((x) => `<li>${esc(x.nome)}${x.loja ? ` <span class="suave">· ${esc(x.loja)}</span>` : ''} <span class="suave">(${esc(x.bot)})</span></li>`).join('')}</ul>`
    : '<span class="suave">nenhum grupo ativo</span>'
  return `<div class="cartao"><div class="topo" style="margin-bottom:8px"><h2 style="margin:0">WhatsApp</h2>${seloWhatsApp(situacao)}</div>
    <p class="ajuda" style="margin-top:0">${explica}</p>
    <dl><dt>Telefone do cadastro</dt><dd>${esc(tel(f.telefone))}</dd>
      <dt>Contato no WhatsApp</dt><dd>${f.lid ? 'ligado ao cadastro' : '<span class="suave">ainda não</span>'}</dd>
      <dt>Está em</dt><dd>${grupos}</dd></dl></div>`
}

function cartaoGestores(p: PerfilPessoa): string {
  const voltar = `/equipe/${p.pessoa.id}`
  if (p.gestores.length === 0) {
    return `<div class="cartao"><h2 style="margin-top:0">Gestor</h2><p class="ajuda">Nenhum bot de grupos ainda. <a href="/grupos-bot/novo">Criar bot de grupos</a></p></div>`
  }
  const linhas = p.gestores
    .map(({ bot, linha, telefoneBot }) => {
      if (linha) return `<h3 style="margin:16px 0 8px">${esc(bot.nome)}</h3>${cartaoGestor(bot.id, bot.nome, linha, telefoneBot, p.agora, voltar)}`
      return `<h3 style="margin:16px 0 8px">${esc(bot.nome)}</h3><div class="linha"><span class="suave">Não é gestor(a) deste bot.</span>
        <form method="post" action="/grupos-bot/${bot.id}/gestores"><input type="hidden" name="funcionario_id" value="${p.pessoa.id}"><input type="hidden" name="voltar" value="${voltar}">
        <button${p.pessoa.ativo ? '' : ' disabled title="Cadastro inativo"'}>Indicar como gestor</button></form></div>`
    })
    .join('')
  return `<div class="cartao"><h2 style="margin-top:0">Gestor</h2><p class="ajuda" style="margin-top:0">Cada bot de grupos tem os seus gestores. Indicada, a pessoa só ganha poder depois de confirmar com o código.</p>${linhas}</div>`
}

function cartaoHistorico(p: PerfilPessoa): string {
  const linhas = p.historico
    .map((h) => `<tr><td style="white-space:nowrap">${esc(dataBR(h.em))}</td><td>${esc(h.usuario)}</td><td>${esc(h.acao)}</td><td>${esc(h.detalhe ?? '')}</td></tr>`)
    .join('')
  return `<div class="cartao"><h2 style="margin-top:0">Histórico</h2>
    <table><thead><tr><th>Quando</th><th>Quem</th><th>Ação</th><th>Detalhe</th></tr></thead>
    <tbody>${linhas || '<tr><td colspan="4" class="vazio">Nada registrado para esta pessoa ainda.</td></tr>'}</tbody></table></div>`
}

export function paginaFuncionario(
  f: FormFuncionario,
  usuario: string,
  erro: string | null,
  lojas: string[] = [],
  perfil: PerfilPessoa | null = null,
  ok: string | null = null
): string {
  const campo = (nome: 'nome' | 'telefone' | 'setor' | 'loja' | 'cargo' | 'nascimento', rotulo: string, extra = '') =>
    `<label>${rotulo}<input name="${nome}" value="${esc(f[nome])}" ${extra}></label>`
  const excluir = f.id
    ? `<div class="cartao"><form method="post" action="/equipe/${f.id}/excluir" data-confirma="Excluir esta pessoa do cadastro? Ela deixa de ser gestora em todos os bots. Não tem volta." onsubmit="return confirm(this.dataset.confirma)"><button class="perigo">Excluir do cadastro</button></form></div>`
    : ''
  const formulario = `<form method="post" action="/equipe/salvar" class="cartao formgrade">
      <h2 style="margin:0">Cadastro</h2>
      <input type="hidden" name="id" value="${f.id ?? ''}">
      ${campo('nome', 'Nome', 'required maxlength="80"')}
      ${campo('telefone', 'Telefone com DDD', 'inputmode="tel" placeholder="(83) 99999-0000"')}
      ${perfil?.pessoa.confirmadoEm ? '<p class="ajuda" style="margin-top:-6px">Telefone confirmado pela própria pessoa. Se você mudar o telefone, a marca de confirmado sai até ela confirmar de novo.</p>' : ''}
      ${campo('loja', 'Loja', 'maxlength="60" list="lojas"')}
      <datalist id="lojas">${lojas.map((l) => `<option value="${esc(l)}">`).join('')}</datalist>
      ${campo('setor', 'Setor', 'maxlength="60"')}
      ${campo('cargo', 'Cargo', 'maxlength="60"')}
      ${campo('nascimento', 'Nascimento', 'placeholder="DD/MM/AAAA"')}
      <label class="linha"><input type="checkbox" name="ativo" value="1" style="width:auto"${f.ativo ? ' checked' : ''}> Ativo (inativo perde o poder de gestor)</label>
      <div><button class="primario">Salvar</button></div>
    </form>`
  const corpo = perfil
    ? `<div style="display:grid;gap:0 16px;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));align-items:start">
        <div>${formulario}${cartaoWhatsApp(perfil)}</div><div>${cartaoGestores(perfil)}</div></div>${cartaoHistorico(perfil)}${excluir}`
    : formulario
  return layout(
    f.id ? f.nome || 'Editar pessoa' : 'Nova pessoa',
    `<p><a href="/equipe">← Equipe</a></p><h1>${f.id ? esc(f.nome) : 'Nova pessoa'}</h1>${mensagem(ok, null)}${falha(erro)}${corpo}`,
    usuario
  )
}

export type LinhaPrevia = LinhaCsv & { situacao: 'novo' | 'atualiza' | 'erro' }

export function paginaImportar(usuario: string, csv: string, previa: LinhaPrevia[] | null, erro: string | null): string {
  const validas = previa?.filter((l) => l.dados).length ?? 0
  const tabela = previa
    ? `<div class="cartao"><p><strong>${validas}</strong> linha(s) prontas · <strong${previa.length - validas ? ' class="erro"' : ''}>${previa.length - validas}</strong> com erro (ficam de fora).</p>
      <table><thead><tr><th>Linha</th><th>Situação</th><th>Nome</th><th>Telefone</th><th>Setor</th><th>Loja</th><th>Cargo</th><th>Nascimento</th></tr></thead><tbody>
      ${previa
        .map((l) =>
          l.dados
            ? `<tr><td>${l.linha}</td><td>${l.situacao === 'novo' ? '<span class="ok">novo</span>' : 'atualiza'}</td><td>${esc(l.dados.nome)}</td><td>${esc(tel(l.dados.telefone))}</td><td>${esc(l.dados.setor ?? '')}</td><td>${esc(l.dados.loja ?? '')}</td><td>${esc(l.dados.cargo ?? '')}</td><td>${esc(l.dados.nascimento ?? '')}</td></tr>`
            : `<tr><td>${l.linha}</td><td class="erro" colspan="7">${esc(l.erro)}</td></tr>`
        )
        .join('')}</tbody></table>
      ${validas ? `<form method="post" action="/equipe/importar"><textarea name="csv" hidden>${esc(csv)}</textarea><input type="hidden" name="confirmar" value="1"><button class="primario">Importar ${validas} pessoa(s)</button></form>` : ''}</div>`
    : ''
  return layout(
    'Importar equipe',
    `<p><a href="/equipe">← Equipe</a></p><h1>Importar equipe (CSV)</h1>${falha(erro)}
    <div class="cartao"><p>Uma pessoa por linha, separando com ponto e vírgula ou vírgula: <code>nome;telefone;setor;loja;cargo;nascimento</code>. O cabeçalho é opcional; cargo e nascimento podem ficar vazios (e, para quem já está no cadastro, mantêm o valor atual). Quem já está no cadastro (mesmo telefone) é atualizado. Telefone sem <code>+</code> é do Brasil (com DDD); número de outro país vai com <code>+&lt;código do país&gt;</code>, ex.: <code>+1 415 555 0123</code>. Arquivo em UTF-8 ou salvo pelo Excel.</p>
    <form method="post" action="/equipe/importar" style="display:grid;gap:8px">
      <input type="file" accept=".csv,text/csv,text/plain" id="arquivo">
      <textarea name="csv" id="csv" rows="10" placeholder="Ana Souza;83999990001;Vendas;Centro;Gerente;10/05/1990">${esc(csv)}</textarea>
      <div><button>Conferir</button></div>
    </form></div>${tabela}
    <script>document.getElementById('arquivo').addEventListener('change',function(e){
      var f=e.target.files[0];if(!f)return;
      var ler=function(cod){
        var r=new FileReader();
        r.onload=function(){
          if(cod==='utf-8'&&r.result.indexOf('�')!==-1){ler('windows-1252');return;}
          document.getElementById('csv').value=r.result;
        };
        r.readAsText(f,cod);
      };
      ler('utf-8');
    });</script>`,
    usuario
  )
}
