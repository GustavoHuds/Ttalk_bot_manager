import type { Funcionario, Grupo } from '../db/grupos.js'
import type { Numero } from '../db/numeros.js'
import type { LinhaCsv } from '../grupos/equipe.js'
import { formatarTelefone } from '../grupos/pessoas.js'
import { esc, layout } from './paginas.js'

const aviso = (t: string | null) => (t ? `<div class="cartao ok">${esc(t)}</div>` : '')
const falha = (t: string | null) => (t ? `<div class="cartao erro">${esc(t)}</div>` : '')
const tel = (t: string | null) => (t ? formatarTelefone(t) : '—')

export function paginaGrupos(blocos: { numero: Numero; grupos: Grupo[] }[], usuario: string, msg: string | null): string {
  const corpo =
    blocos.length === 0
      ? '<div class="cartao"><p>Nenhum número de grupos ainda. Adicione um em <a href="/numeros">Números</a> com o uso "Grupos".</p></div>'
      : blocos
          .map(({ numero: n, grupos }) => {
            const linhas = grupos
              .map(
                (g) => `<tr${g.ativo ? '' : ' class="suave"'}><td><strong>${esc(g.nome)}</strong>${g.ativo ? '' : '<br>o bot saiu deste grupo'}</td>
                <td>${g.botAdmin ? '<span class="ok">sim</span>' : '<span class="alerta">não</span>'}</td>
                <td><form method="post" action="/grupos/etiquetar" style="display:flex;gap:6px;flex-wrap:wrap">
                  <input type="hidden" name="numero_id" value="${n.id}"><input type="hidden" name="jid" value="${esc(g.jid)}">
                  <input name="setor" value="${esc(g.setor ?? '')}" placeholder="Setor" maxlength="60" style="flex:1 1 120px">
                  <input name="loja" value="${esc(g.loja ?? '')}" placeholder="Loja" maxlength="60" style="flex:1 1 120px">
                  <button>Salvar</button></form></td></tr>`
              )
              .join('')
            return `<div class="cartao"><h2 style="margin-top:0">${esc(n.nome)}${n.ativo ? '' : ' <span class="suave">(desativado)</span>'}</h2>
              <table><thead><tr><th>Grupo</th><th>Bot é admin?</th><th>Setor e loja</th></tr></thead><tbody>
              ${linhas || '<tr><td colspan="3" class="suave">O bot ainda não está em nenhum grupo. Adicione este número aos grupos pelo celular.</td></tr>'}
              </tbody></table></div>`
          })
          .join('')
  return layout(
    'Grupos',
    `<h1>Grupos</h1>${aviso(msg)}<p class="suave">Setor e loja servirão para mandar avisos por setor. Para apagar mensagens e fixar avisos, o bot precisa ser admin do grupo.</p>${corpo}`,
    usuario
  )
}

export function paginaEquipe(lista: Funcionario[], gestores: Set<number>, q: string, usuario: string, msg: string | null): string {
  const linhas = lista
    .map((f) => {
      const gestor = gestores.has(f.id)
      const botao = gestor
        ? `<button title="Tirar o poder de gestor">👔 gestor${f.ativo ? '' : ' (inativo)'}</button>`
        : `<button${f.ativo ? '' : ' disabled'}>Tornar gestor</button>`
      return `<tr${f.ativo ? '' : ' class="suave"'}>
        <td><a href="/equipe/${f.id}"><strong>${esc(f.nome)}</strong></a>${f.ativo ? '' : '<br>inativo'}</td>
        <td>${esc(tel(f.telefone))}${f.lid ? '' : '<br><span class="suave">ainda não visto no WhatsApp</span>'}</td>
        <td>${esc(f.setor ?? '')}</td><td>${esc(f.loja ?? '')}</td><td>${esc(f.cargo ?? '')}</td>
        <td><form method="post" action="/equipe/${f.id}/gestor"><input type="hidden" name="ativo" value="${gestor ? '0' : '1'}">${botao}</form></td></tr>`
    })
    .join('')
  return layout(
    'Equipe',
    `<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap"><h1>Equipe</h1>
      <span><a class="botao primario" href="/equipe/novo">+ Pessoa</a> <a class="botao" href="/equipe/importar">Importar CSV</a> <a class="botao" href="/equipe/exportar">Exportar CSV</a></span></div>
    ${aviso(msg)}
    <form method="get" action="/equipe" class="cartao" style="display:flex;gap:8px"><input name="q" value="${esc(q)}" placeholder="Buscar por nome, telefone, setor ou loja"><button>Buscar</button></form>
    <div class="cartao"><p class="suave">Gestores mandam comandos ao bot de grupos. Ser admin de um grupo no WhatsApp não dá poder no bot.</p>
    <table><thead><tr><th>Nome</th><th>Telefone</th><th>Setor</th><th>Loja</th><th>Cargo</th><th>Gestor</th></tr></thead>
    <tbody>${linhas || '<tr><td colspan="6" class="suave">Ninguém encontrado.</td></tr>'}</tbody></table></div>`,
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

export function paginaFuncionario(f: FormFuncionario, usuario: string, erro: string | null): string {
  const campo = (nome: 'nome' | 'telefone' | 'setor' | 'loja' | 'cargo' | 'nascimento', rotulo: string, extra = '') =>
    `<label>${rotulo}<input name="${nome}" value="${esc(f[nome])}" ${extra}></label>`
  const excluir = f.id
    ? `<form method="post" action="/equipe/${f.id}/excluir" onsubmit="return confirm('Excluir esta pessoa do cadastro? Não tem volta.')"><button class="perigo">Excluir do cadastro</button></form>`
    : ''
  return layout(
    f.id ? 'Editar pessoa' : 'Nova pessoa',
    `<p><a href="/equipe">← Equipe</a></p><h1>${f.id ? esc(f.nome) : 'Nova pessoa'}</h1>${falha(erro)}
    <form method="post" action="/equipe/salvar" class="cartao" style="display:grid;gap:12px;max-width:560px">
      <input type="hidden" name="id" value="${f.id ?? ''}">
      ${campo('nome', 'Nome', 'required maxlength="80"')}
      ${campo('telefone', 'Telefone com DDD', 'inputmode="tel" placeholder="(83) 99999-0000"')}
      ${campo('setor', 'Setor', 'maxlength="60"')}
      ${campo('loja', 'Loja', 'maxlength="60"')}
      ${campo('cargo', 'Cargo', 'maxlength="60"')}
      ${campo('nascimento', 'Nascimento', 'placeholder="DD/MM/AAAA"')}
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="ativo" value="1" style="width:auto"${f.ativo ? ' checked' : ''}> Ativo</label>
      ${f.lid ? '<p class="suave">Já identificado no WhatsApp.</p>' : ''}
      <div><button class="primario">Salvar</button></div>
    </form>${excluir}`,
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
