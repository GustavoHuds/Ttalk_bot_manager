import type { BotGrupos, GestorBot, Loja } from '../db/bots-grupos.js'
import type { Funcionario } from '../db/grupos.js'
import type { Numero } from '../db/numeros.js'
import { TEXTOS, type ComandosDoBot } from '../grupos/catalogo.js'
import { COMANDOS, type NomeComando } from '../grupos/comandos.js'
import { formatarTelefone } from '../grupos/pessoas.js'
import type { EstadoConexao } from '../whatsapp/baileys.js'
import { dataBR } from './exportar.js'
import { ROTULO_STATUS, abas, esc, layout, mensagem, resumo, selo } from './paginas.js'

/** O que todas as páginas de um bot de grupos mostram no topo. */
export interface CabecalhoBot {
  bot: BotGrupos
  numero: Numero | null
  estado: EstadoConexao | null
}

const ROTULO_QUEM = { todos: 'Todos', gestores: '👔 Gestores' } as const
const ROTULO_ONDE = { grupo: 'No grupo', privado: 'No privado', ambos: 'Grupo e privado' } as const

function statusNumero(c: CabecalhoBot): string {
  if (!c.numero) return selo('sem número', 'erro')
  if (!c.numero.ativo) return selo(`${c.numero.nome}: desativado`, 'erro')
  const st = c.estado?.status ?? 'iniciando'
  return selo(`${c.numero.nome}: ${ROTULO_STATUS[st] ?? st}`, st === 'conectado' ? 'ok' : 'alerta')
}

function pagina(c: CabecalhoBot, aba: string, titulo: string, corpo: string, usuario: string): string {
  const id = c.bot.id
  const nav = abas(
    [
      { href: `/grupos-bot/${id}`, rotulo: 'Geral' },
      { href: `/grupos?bot=${id}`, rotulo: 'Grupos' },
      { href: `/grupos-bot/${id}/lojas`, rotulo: 'Lojas' },
      { href: `/grupos-bot/${id}/gestores`, rotulo: 'Gestores' },
      { href: `/grupos-bot/${id}/comandos`, rotulo: 'Comandos' }
    ],
    aba
  )
  return layout(
    `${titulo} · ${c.bot.nome}`,
    `<p><a href="/">← Bots</a></p>
    <div class="topo"><h1>${esc(c.bot.nome)} <span class="etiqueta">Bot de grupos</span></h1>
      <span class="linha">${c.bot.ativo ? '' : selo('bot desativado', 'erro')}${statusNumero(c)}</span></div>
    ${nav}${corpo}`,
    usuario
  )
}

// --- novo / geral -------------------------------------------------------------------

/** Números de grupos que este bot pode usar: livres ou o atual dele. */
export interface OpcaoNumero {
  id: number
  nome: string
  ativo: boolean
  usadoPor: string | null
}

function selectNumero(opcoes: OpcaoNumero[], atual: number | null): string {
  const itens = opcoes
    .map((n) => {
      const rotulo = `${n.nome}${n.ativo ? '' : ' (desativado)'}${n.usadoPor ? ` — usado por ${n.usadoPor}` : ''}`
      return `<option value="${n.id}"${n.id === atual ? ' selected' : ''}${n.usadoPor ? ' disabled' : ''}>${esc(rotulo)}</option>`
    })
    .join('')
  return `<select name="numero_id" id="numero_id"><option value=""${atual === null ? ' selected' : ''}>Sem número por enquanto</option>${itens}</select>`
}

export function paginaNovoBotGrupos(opcoes: OpcaoNumero[], usuario: string, erro: string | null, nome = ''): string {
  const semNumero = opcoes.every((n) => n.usadoPor)
  return layout(
    'Novo bot de grupos',
    `<p><a href="/">← Bots</a></p><h1>Novo bot de grupos</h1>${mensagem(null, erro)}
    <form method="post" action="/grupos-bot" class="cartao formgrade">
      <label>Nome do bot<input name="nome" required maxlength="40" value="${esc(nome)}" placeholder="Ex.: Avisos Belmont"></label>
      <label>Número de WhatsApp${selectNumero(opcoes, null)}</label>
      <p class="ajuda">${semNumero ? 'Nenhum número de grupos livre. ' : ''}Adicione números em <a href="/numeros">Números</a> com o uso "Grupos". Você pode trocar o número depois sem perder lojas, gestores, comandos e grupos ativos.</p>
      <div><button class="primario">Criar bot</button></div>
    </form>`,
    usuario
  )
}

export interface DadosGeral {
  cab: CabecalhoBot
  opcoes: OpcaoNumero[]
  gruposAtivos: number
  lojas: number
  gestoresConfirmados: number
  gestoresPendentes: number
  comandosLigados: number
  personalizados: number
  /** Grupos ativos em que o número atual não está. */
  foraDoNumero: number
}

export function paginaGeralBot(d: DadosGeral, usuario: string, ok: string | null, erro: string | null): string {
  const b = d.cab.bot
  const avisos = [
    !d.cab.numero ? 'Este bot está sem número: escolha um abaixo para ele voltar a atender.' : null,
    d.cab.numero && d.gruposAtivos === 0 ? 'Nenhum grupo ativo: o bot fica em silêncio em todos os grupos até você ativar algum na aba Grupos.' : null,
    d.gestoresConfirmados === 0 ? 'Nenhum gestor confirmado ainda: indique alguém na aba Gestores.' : null,
    d.foraDoNumero ? `${d.foraDoNumero} grupo(s) ativo(s) sem o número atual dentro: adicione o número a eles pelo celular.` : null
  ].filter((x): x is string => !!x)
  const excluir =
    d.gruposAtivos === 0
      ? `<form method="post" action="/grupos-bot/${b.id}/excluir" data-confirma="Excluir o bot ${esc(b.nome)}? Lojas, gestores e comandos dele são apagados. Não tem volta." onsubmit="return confirm(this.dataset.confirma)"><button class="perigo">Excluir bot</button></form>`
      : `<p class="ajuda">Para excluir o bot, desative antes os grupos ativos dele.</p>`
  const corpo = `${mensagem(ok, erro)}
    ${resumo([
      { valor: d.gruposAtivos, rotulo: 'grupos ativos' },
      { valor: d.lojas, rotulo: 'lojas' },
      { valor: `${d.gestoresConfirmados}${d.gestoresPendentes ? ` + ${d.gestoresPendentes}` : ''}`, rotulo: d.gestoresPendentes ? 'gestores (+ pendentes)' : 'gestores' },
      { valor: d.comandosLigados, rotulo: `comandos ligados${d.personalizados ? ` (${d.personalizados} seus)` : ''}` }
    ])}
    ${avisos.length ? `<div class="cartao aviso"><ul style="margin:0;padding-left:20px">${avisos.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></div>` : ''}
    <form method="post" action="/grupos-bot/${b.id}" class="cartao formgrade">
      <h2 style="margin:0">Configuração</h2>
      <label>Nome do bot<input name="nome" required maxlength="40" value="${esc(b.nome)}"></label>
      <label>Número de WhatsApp${selectNumero(d.opcoes, b.numeroId)}</label>
      <p class="ajuda">Trocar o número mantém lojas, gestores, comandos e grupos ativos. O número novo precisa estar nos mesmos grupos.</p>
      <label class="linha"><input type="checkbox" name="ativo" value="1" style="width:auto"${b.ativo ? ' checked' : ''}> Bot ativo (desativado, não responde a nada)</label>
      <div><button class="primario">Salvar</button></div>
    </form>
    <div class="cartao"><h2 style="margin-top:0">Como funciona</h2><ol class="passos">
      <li>Na aba <a href="/grupos?bot=${b.id}">Grupos</a>, ative os grupos em que o bot deve atuar e diga a loja de cada um.</li>
      <li>Na aba <a href="/grupos-bot/${b.id}/gestores">Gestores</a>, indique quem manda no bot. A pessoa confirma mandando um código no privado do número.</li>
      <li>Na aba <a href="/grupos-bot/${b.id}/comandos">Comandos</a>, ligue, desligue e ajuste as respostas, ou crie comandos seus.</li>
    </ol></div>
    <div class="cartao">${excluir}</div>`
  return pagina(d.cab, `/grupos-bot/${b.id}`, 'Geral', corpo, usuario)
}

// --- lojas --------------------------------------------------------------------------

export function paginaLojas(cab: CabecalhoBot, lojas: (Loja & { grupos: number })[], usuario: string, ok: string | null, erro: string | null): string {
  const id = cab.bot.id
  const linhas = lojas
    .map(
      (l) => `<tr><td><form method="post" action="/grupos-bot/${id}/lojas/${l.id}/renomear" class="linha">
          <input name="nome" value="${esc(l.nome)}" required maxlength="60" style="flex:1 1 200px" aria-label="Nome da loja"><button>Renomear</button></form></td>
        <td>${l.grupos ? `${l.grupos} grupo(s)` : '<span class="suave">nenhum grupo</span>'}</td>
        <td><form method="post" action="/grupos-bot/${id}/lojas/${l.id}/excluir" data-confirma="Excluir a loja ${esc(l.nome)}?${l.grupos ? ' Os grupos dela continuam ativos, só ficam sem loja.' : ''}" onsubmit="return confirm(this.dataset.confirma)"><button class="perigo">Excluir</button></form></td></tr>`
    )
    .join('')
  const corpo = `${mensagem(ok, erro)}
    <div class="cartao"><p class="ajuda" style="margin-top:0">As lojas deste bot aparecem ao ativar um grupo e servem de sugestão no cadastro da equipe. Renomear uma loja também atualiza quem, na equipe, tinha exatamente o nome antigo.</p>
    <table><thead><tr><th>Loja</th><th>Grupos ativos</th><th></th></tr></thead><tbody>
    ${linhas || '<tr><td colspan="3" class="vazio">Nenhuma loja ainda. Adicione abaixo.</td></tr>'}</tbody></table></div>
    <form method="post" action="/grupos-bot/${id}/lojas" class="cartao linha">
      <label style="flex:1 1 260px">Nova loja<input name="nome" required maxlength="60" placeholder="Ex.: Loja Centro"></label>
      <button class="primario" style="align-self:end">Adicionar loja</button>
    </form>`
  return pagina(cab, `/grupos-bot/${id}/lojas`, 'Lojas', corpo, usuario)
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

/** Cartão de um gestor (confirmado, pendente ou com divergência), com as ações. `voltar` volta para a página certa. */
export function cartaoGestor(botId: number, nomeBot: string, l: LinhaGestor, telefoneBot: string | null, agora: number, voltar: string): string {
  const { gestor: g, pessoa: p } = l
  const acao = (caminho: string, rotulo: string, classe = '', confirma = '') =>
    `<form method="post" action="/grupos-bot/${botId}/gestores/${p.id}/${caminho}"${confirma ? ` data-confirma="${esc(confirma)}" onsubmit="return confirm(this.dataset.confirma)"` : ''}>
      <input type="hidden" name="voltar" value="${esc(voltar)}"><button${classe ? ` class="${classe}"` : ''}>${esc(rotulo)}</button></form>`
  const remover = acao('remover', g.confirmadoEm ? 'Tirar de gestor' : 'Cancelar indicação', 'perigo', `Tirar ${p.nome} dos gestores do ${nomeBot}?`)
  const quem = `<a href="/equipe/${p.id}"><strong>${esc(p.nome)}</strong></a>${p.ativo ? '' : ` ${selo('cadastro inativo', 'erro')}`}
    <div class="ajuda">${esc([p.cargo, p.loja, p.setor].filter(Boolean).join(' · ') || 'sem loja/setor')} · cadastro: ${esc(telefone(p.telefone))}</div>`

  if (g.confirmadoEm) {
    return `<div class="cartao"><div class="topo" style="margin:0"><div>${quem}</div>${selo('✅ confirmado', 'ok')}</div>
      <p class="ajuda">Confirmado em ${esc(dataBR(g.confirmadoEm))} pelo WhatsApp ${esc(g.confirmadoJid ? jidLegivel(g.confirmadoJid) : '—')}.</p>
      <div class="linha">${remover}</div></div>`
  }
  const divergencia = g.divergenteEm
    ? `<div class="cartao aviso" style="margin:12px 0 0"><strong>⚠ O código certo chegou de outro WhatsApp</strong>
        <p style="margin:6px 0">Em ${esc(dataBR(g.divergenteEm))} veio de <strong>${esc(g.divergenteTelefone ? formatarTelefone(g.divergenteTelefone) : jidLegivel(g.divergenteJid ?? ''))}</strong>,
        mas o cadastro de ${esc(p.nome)} diz <strong>${esc(telefone(p.telefone))}</strong>. Se for mesmo a pessoa (número trocado ou digitado errado), corrija e confirme.</p>
        <div class="linha">${acao('aceitar-divergencia', 'Usar este WhatsApp e confirmar', 'primario', `Corrigir o cadastro de ${p.nome} para este WhatsApp e confirmar como gestor?`)}${acao('descartar-divergencia', 'Não é a pessoa: descartar')}</div></div>`
    : ''
  const vencido = !g.codigo || (g.codigoExpiraEm ?? 0) <= agora
  const codigo = vencido
    ? `<p>${selo('código vencido', 'erro')} Gere um novo código para a pessoa confirmar.</p>`
    : `<p style="margin:8px 0">Código: <span class="codigo">${esc(g.codigo)}</span> <span class="ajuda">vale até ${esc(dataBR(g.codigoExpiraEm!))}</span></p>
      <p class="ajuda">${esc(p.nome)} manda <code>/confirmar ${esc(g.codigo)}</code> no privado do número do bot, pelo WhatsApp ${esc(telefone(p.telefone))}.</p>
      ${
        telefoneBot
          ? `<div class="linha"><input readonly value="${esc(linkConfirmar(telefoneBot, g.codigo!))}" aria-label="Link de confirmação" style="flex:1 1 280px" onclick="this.select()">
             <button type="button" onclick="var i=this.previousElementSibling;i.select();navigator.clipboard&&navigator.clipboard.writeText(i.value);this.textContent='Copiado ✓'">Copiar link</button></div>
             <p class="ajuda">Mande este link para ${esc(p.nome)}: ao tocar, o WhatsApp abre a conversa com o bot já com o código escrito.</p>`
          : '<p class="ajuda">Conecte o número do bot para gerar o link de confirmação.</p>'
      }`
  return `<div class="cartao destaque"><div class="topo" style="margin:0"><div>${quem}</div>${selo('⏳ aguardando confirmação', 'alerta')}</div>
    ${codigo}${divergencia}
    <div class="linha" style="margin-top:12px">${acao('codigo', 'Gerar novo código')}${remover}</div></div>`
}

/** JID legível: telefone formatado, ou "contato oculto" para LID. */
function jidLegivel(jid: string): string {
  const usuario = jid.split('@')[0]!.split(':')[0]!
  return jid.endsWith('@s.whatsapp.net') ? formatarTelefone(usuario) : `contato oculto (${usuario})`
}

export interface DadosGestores {
  cab: CabecalhoBot
  linhas: LinhaGestor[]
  telefoneBot: string | null
  agora: number
  busca: string
  /** Resultado da busca na equipe (só quem ainda não é gestor deste bot). */
  candidatos: Funcionario[] | null
}

export function paginaGestores(d: DadosGestores, usuario: string, ok: string | null, erro: string | null): string {
  const id = d.cab.bot.id
  const voltar = `/grupos-bot/${id}/gestores`
  const confirmados = d.linhas.filter((l) => l.gestor.confirmadoEm)
  const pendentes = d.linhas.filter((l) => !l.gestor.confirmadoEm)
  const candidatos =
    d.candidatos === null
      ? ''
      : d.candidatos.length === 0
        ? `<p class="vazio">Ninguém encontrado na equipe com "${esc(d.busca)}". <a href="/equipe/novo">Cadastrar pessoa</a></p>`
        : `<table><thead><tr><th>Pessoa</th><th>Telefone</th><th>WhatsApp</th><th></th></tr></thead><tbody>${d.candidatos
            .map(
              (f) => `<tr><td><strong>${esc(f.nome)}</strong><div class="ajuda">${esc([f.cargo, f.loja, f.setor].filter(Boolean).join(' · '))}</div></td>
              <td>${esc(telefone(f.telefone))}</td><td>${f.confirmadoEm ? selo('✅ confirmado', 'ok') : f.lid ? selo('👁 visto') : selo('nunca visto', 'alerta')}</td>
              <td><form method="post" action="/grupos-bot/${id}/gestores"><input type="hidden" name="funcionario_id" value="${f.id}"><button class="primario"${f.ativo ? '' : ' disabled title="Cadastro inativo"'}>Indicar como gestor</button></form></td></tr>`
            )
            .join('')}</tbody></table>`
  const corpo = `${mensagem(ok, erro)}
    <div class="cartao"><h2 style="margin-top:0">Como alguém vira gestor</h2><ol class="passos">
      <li>Indique a pessoa da equipe abaixo. Ela fica <strong>pendente</strong>, sem poder nenhum.</li>
      <li>Mande o código (ou o link) para ela. A pessoa envia <code>/confirmar código</code> no privado do número do bot.</li>
      <li>O bot confere se a mensagem veio do WhatsApp do cadastro. Se veio, ela vira gestora ✅. Se veio de outro número, aparece aqui para você conferir.</li>
    </ol></div>
    <div class="cartao"><h2 style="margin-top:0">Indicar gestor</h2>
      <form method="get" action="${voltar}" class="linha"><input name="q" value="${esc(d.busca)}" placeholder="Nome ou telefone de alguém da equipe" style="flex:1 1 260px" aria-label="Buscar na equipe"><button>Buscar</button></form>
      ${candidatos}</div>
    <h2>Aguardando confirmação (${pendentes.length})</h2>
    ${pendentes.map((l) => cartaoGestor(id, d.cab.bot.nome, l, d.telefoneBot, d.agora, voltar)).join('') || '<p class="ajuda">Ninguém pendente.</p>'}
    <h2>Gestores confirmados (${confirmados.length})</h2>
    ${confirmados.map((l) => cartaoGestor(id, d.cab.bot.nome, l, d.telefoneBot, d.agora, voltar)).join('') || '<div class="cartao vazio">Nenhum gestor confirmado ainda.</div>'}`
  return pagina(d.cab, voltar, 'Gestores', corpo, usuario)
}

// --- comandos -----------------------------------------------------------------------

export function paginaComandos(cab: CabecalhoBot, c: ComandosDoBot, usuario: string, ok: string | null, erro: string | null): string {
  const id = cab.bot.id
  const prontos = COMANDOS.map((d) => {
    const desligado = c.desligados.has(d.nome)
    const editados = Object.keys(c.textos.get(d.nome) ?? {}).length
    const chave = d.fixo
      ? selo('sempre ligado', 'ok')
      : `<form method="post" action="/grupos-bot/${id}/comandos/${d.nome}/ligar"><input type="hidden" name="ligado" value="${desligado ? '1' : '0'}">
          <button${desligado ? '' : ' class="primario"'} aria-pressed="${!desligado}" title="${desligado ? 'Ligar' : 'Desligar'} /${d.nome}">${desligado ? '○ Desligado' : '● Ligado'}</button></form>`
    return `<tr${desligado ? ' class="suave"' : ''}><td><strong>/${d.nome}</strong><div class="ajuda">${esc(d.descricao)}</div></td>
      <td>${d.gestor ? ROTULO_QUEM.gestores : d.nome === 'confirmar' ? 'Gestor indicado' : ROTULO_QUEM.todos}</td><td class="esconde-celular">${ROTULO_ONDE[d.onde]}</td>
      <td class="esconde-celular"><code>${esc(d.exemplo)}</code></td><td>${chave}</td>
      <td><a class="botao" href="/grupos-bot/${id}/comandos/${d.nome}/textos">Respostas${editados ? ` (${editados} editada${editados > 1 ? 's' : ''})` : ''}</a></td></tr>`
  }).join('')
  const proprios = c.personalizados
    .map(
      (p) => `<tr><td><strong>/${esc(p.nome)}</strong><div class="ajuda">${esc(p.descricao)}</div></td><td>${ROTULO_QUEM[p.quem]}</td><td class="esconde-celular">${ROTULO_ONDE[p.onde]}</td>
      <td style="max-width:360px;white-space:pre-wrap">${esc(p.resposta.length > 140 ? `${p.resposta.slice(0, 140)}…` : p.resposta)}</td>
      <td class="linha"><a class="botao" href="/grupos-bot/${id}/comandos/personalizado/${encodeURIComponent(p.nome)}">Editar</a>
        <form method="post" action="/grupos-bot/${id}/comandos/personalizado/${encodeURIComponent(p.nome)}/excluir" data-confirma="Excluir /${esc(p.nome)}?" onsubmit="return confirm(this.dataset.confirma)"><button class="perigo">Excluir</button></form></td></tr>`
    )
    .join('')
  const corpo = `${mensagem(ok, erro)}
    <div class="cartao"><h2 style="margin-top:0">Comandos prontos</h2>
    <p class="ajuda" style="margin-top:0">Desligado, o comando some do /menu: um gestor que o usar ouve "este comando está desligado"; as outras pessoas não recebem nada.</p>
    <table><thead><tr><th>Comando</th><th>Quem usa</th><th class="esconde-celular">Onde</th><th class="esconde-celular">Exemplo</th><th>Situação</th><th></th></tr></thead><tbody>${prontos}</tbody></table></div>
    <div class="cartao"><div class="topo" style="margin-bottom:8px"><h2 style="margin:0">Comandos personalizados</h2>
      <a class="botao primario" href="/grupos-bot/${id}/comandos/personalizado/novo">+ Novo comando</a></div>
    <p class="ajuda" style="margin-top:0">Respostas fixas que você escreve, como horário das lojas, chave Pix ou regras do grupo. Aparecem no /menu.</p>
    <table><thead><tr><th>Comando</th><th>Quem usa</th><th class="esconde-celular">Onde</th><th>Resposta</th><th></th></tr></thead>
    <tbody>${proprios || '<tr><td colspan="5" class="vazio">Nenhum comando personalizado ainda.</td></tr>'}</tbody></table></div>`
  return pagina(cab, `/grupos-bot/${id}/comandos`, 'Comandos', corpo, usuario)
}

export function paginaTextos(cab: CabecalhoBot, cmd: NomeComando, editados: Record<string, string>, usuario: string, erro: string | null, enviado: Record<string, string> | null = null): string {
  const id = cab.bot.id
  const def = COMANDOS.find((d) => d.nome === cmd)!
  const campos = TEXTOS[cmd]
    .map((t) => {
      const valor = enviado?.[t.chave] ?? editados[t.chave] ?? t.padrao
      const lista = t.campos.length ? `Campos: ${t.campos.map((x) => `<code>{${x}}</code>`).join(' ')}` : 'Sem campos.'
      return `<label>${esc(t.rotulo)}${editados[t.chave] ? ` ${selo('editado', 'alerta')}` : ''}
        <textarea name="t_${esc(t.chave)}" rows="${valor.length > 90 ? 3 : 2}" maxlength="1000">${esc(valor)}</textarea></label>
        <p class="ajuda" style="margin-top:-6px">${lista} · Original: <em>${esc(t.padrao)}</em></p>`
    })
    .join('')
  const corpo = `<p><a href="/grupos-bot/${id}/comandos">← Comandos</a></p>
    <h2>Respostas do /${def.nome}</h2>${mensagem(null, erro)}
    <form method="post" action="/grupos-bot/${id}/comandos/${cmd}/textos" class="cartao formgrade" style="max-width:720px">
      ${campos}
      <p class="ajuda">Os campos entre chaves são trocados pelo valor na hora da resposta. Texto apagado (vazio) volta ao original. Mensagens de uso e de permissão não mudam.</p>
      <div class="linha"><button class="primario">Salvar respostas</button><button name="original" value="1" onclick="return confirm('Voltar todas as respostas do /${def.nome} ao original?')">Voltar tudo ao original</button></div>
    </form>`
  return pagina(cab, `/grupos-bot/${id}/comandos`, `/${cmd}`, corpo, usuario)
}

export interface FormPersonalizado {
  nome: string
  descricao: string
  quem: string
  onde: string
  resposta: string
}

export function paginaPersonalizado(cab: CabecalhoBot, f: FormPersonalizado, editando: string | null, usuario: string, erro: string | null): string {
  const id = cab.bot.id
  const opcao = (nome: string, valor: string, rotulo: string, atual: string) =>
    `<label class="linha" style="font-weight:normal"><input type="radio" name="${nome}" value="${valor}" style="width:auto"${atual === valor ? ' checked' : ''} required> ${esc(rotulo)}</label>`
  const corpo = `<p><a href="/grupos-bot/${id}/comandos">← Comandos</a></p>
    <h2>${editando ? `Editar /${esc(editando)}` : 'Novo comando personalizado'}</h2>${mensagem(null, erro)}
    <form method="post" action="/grupos-bot/${id}/comandos/personalizado" class="cartao formgrade" style="max-width:720px">
      <input type="hidden" name="original" value="${esc(editando ?? '')}">
      <label>Nome do comando<input name="nome" required maxlength="21" value="${esc(f.nome)}" placeholder="horario" pattern="/?[A-Za-zÀ-ÿ0-9_]{2,20}"${editando ? ' readonly' : ''}></label>
      <p class="ajuda" style="margin-top:-6px">Sem espaços. As pessoas vão digitar <code>/${esc(f.nome || 'nome')}</code>. Acentos e maiúsculas são ignorados.</p>
      <label>Descrição no /menu<input name="descricao" required maxlength="80" value="${esc(f.descricao)}" placeholder="horário de funcionamento das lojas"></label>
      <fieldset style="border:0;padding:0;margin:0"><legend style="margin-bottom:4px">Quem pode usar</legend><div class="linha">
        ${opcao('quem', 'todos', 'Todos', f.quem)}${opcao('quem', 'gestores', 'Só gestores', f.quem)}</div></fieldset>
      <fieldset style="border:0;padding:0;margin:0"><legend style="margin-bottom:4px">Onde vale</legend><div class="linha">
        ${opcao('onde', 'grupo', 'No grupo', f.onde)}${opcao('onde', 'privado', 'No privado com o bot', f.onde)}${opcao('onde', 'ambos', 'Nos dois', f.onde)}</div></fieldset>
      <label>Resposta<textarea name="resposta" required rows="6" maxlength="1000" placeholder="Segunda a sábado, das 8h às 18h.">${esc(f.resposta)}</textarea></label>
      <p class="ajuda" style="margin-top:-6px">No privado, só gestores são atendidos (mesmo com "Todos").</p>
      <div><button class="primario">${editando ? 'Salvar' : 'Criar comando'}</button></div>
    </form>`
  return pagina(cab, `/grupos-bot/${id}/comandos`, editando ? `/${editando}` : 'Novo comando', corpo, usuario)
}
