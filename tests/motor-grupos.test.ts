import { describe, expect, it } from 'vitest'
import type { Funcionario } from '../src/db/grupos.js'
import { COMANDOS_PADRAO, comandosDoBot } from '../src/grupos/catalogo.js'
import { interpretar } from '../src/grupos/comandos.js'
import { processarComando } from '../src/grupos/motor.js'
import type { AcaoGrupo, ContextoGrupos, GrupoDoBot, MembroGrupo, Pessoa } from '../src/grupos/tipos.js'
import { AGORA } from './ajuda.js'

const ANA: Funcionario = {
  id: 1, nome: 'Ana Souza', telefone: '5583999990001', lid: '111@lid',
  setor: 'Vendas', loja: 'Centro', cargo: 'Gerente', nascimento: null, ativo: true, confirmadoEm: AGORA
}
const BETO: Funcionario = {
  id: 2, nome: 'Beto Lima', telefone: '5583999990002', lid: null,
  setor: 'Caixa', loja: 'Sul', cargo: null, nascimento: null, ativo: true, confirmadoEm: null
}
const GRUPO: GrupoDoBot = { jid: '120363-1@g.us', nome: 'Loja Centro', botAdmin: false, loja: 'Centro', setor: null }
const ANA_LID: Pessoa = { jid: '111@lid', telefone: null, lid: '111@lid' }
const BETO_TEL: Pessoa = { jid: '5583999990002@s.whatsapp.net', telefone: '5583999990002', lid: null }
const ESTRANHO: Pessoa = { jid: '999@lid', telefone: null, lid: '999@lid' }
/** Número dos EUA: o JID já traz o telefone como chave pronta (sem o 55 do Brasil), pessoaDoJid não o canonicaliza. */
const AMERICANO: Pessoa = { jid: '14155550100@s.whatsapp.net', telefone: '14155550100', lid: null }
const membro = (p: Pessoa): MembroGrupo => ({ ...p, admin: false })

function ctx(extra: Partial<ContextoGrupos> = {}): ContextoGrupos {
  return {
    agora: AGORA, bot: { id: 1, nome: 'Avisos' }, comandos: COMANDOS_PADRAO, chat: GRUPO.jid, ehGrupo: true,
    remetente: ANA_LID, mencionados: [], citada: null, funcionarios: [ANA, BETO], gestores: new Set([1]), pendentes: [],
    grupo: GRUPO, grupos: [GRUPO], membros: null,
    auditoria: [], conectadoDesde: AGORA - 3_600_000, ...extra
  }
}
const privado = (extra: Partial<ContextoGrupos> = {}) => ctx({ chat: '111@lid', ehGrupo: false, grupo: null, ...extra })
const rodar = (c: ContextoGrupos, texto: string) => processarComando(c, interpretar(texto, c.mencionados.map((p) => p.jid), c.citada?.jid ?? null)!)
const textos = (acoes: AcaoGrupo[]) => acoes.flatMap((a) => (a.tipo === 'responder' ? [a.texto] : []))

describe('motor do bot de grupos: permissões', () => {
  it('quem não é gestor: comando de gestor e comando desconhecido são ignorados em silêncio', () => {
    const beto = ctx({ remetente: BETO_TEL, mencionados: [ESTRANHO] })
    expect(rodar(beto, '/cadastrar @999 Carla Dias | Estoque | Norte')).toEqual([])
    expect(rodar(beto, '/xyz')).toEqual([])
  })

  it('no privado, só gestores recebem resposta (nem /menu para estranhos)', () => {
    expect(rodar(privado({ remetente: ESTRANHO }), '/menu')).toEqual([])
    expect(rodar(privado({ remetente: BETO_TEL }), '/menu')).toEqual([])
    expect(textos(rodar(privado(), '/menu'))[0]).toContain('/grupos')
  })

  it('gestor ouve que o comando não existe', () => {
    expect(textos(rodar(ctx(), '/xyz'))).toEqual(['Não reconheço esse comando. Veja /menu.'])
  })

  it('/menu mostra só o que a pessoa pode usar ali', () => {
    const beto = textos(rodar(ctx({ remetente: BETO_TEL }), '/menu'))[0]!
    expect(beto).toContain('/quem')
    expect(beto).not.toContain('/cadastrar')
    const ana = textos(rodar(ctx(), '/menu'))[0]!
    expect(ana).toContain('/cadastrar')
    expect(ana).not.toContain('/grupos')
  })

  it('comando de grupo no privado e de privado no grupo explicam onde usar', () => {
    expect(textos(rodar(privado(), '/desconhecidos'))[0]).toContain('dentro de um grupo')
    expect(textos(rodar(ctx(), '/grupos'))[0]).toContain('no privado comigo')
  })

  it('cadastro inativo perde o poder de gestor', () => {
    expect(rodar(ctx({ funcionarios: [{ ...ANA, ativo: false }, BETO] }), '/status')).toEqual([])
  })
})

describe('motor do bot de grupos: comandos', () => {
  it('/cadastrar @pessoa cria com o LID, audita e confirma', () => {
    const carla: Pessoa = { jid: '777@lid', telefone: null, lid: '777@lid' }
    const acoes = rodar(ctx({ mencionados: [carla] }), '/cadastrar @777 Carla Dias | Estoque | Norte')
    expect(acoes).toEqual([
      {
        tipo: 'salvar_funcionario', id: null,
        dados: { nome: 'Carla Dias', telefone: null, lid: '777@lid', setor: 'Estoque', loja: 'Norte', cargo: null, nascimento: null, ativo: true }
      },
      { tipo: 'auditar', acao: 'cadastrar_funcionario', detalhe: 'Carla Dias (Estoque · Norte)' },
      { tipo: 'responder', texto: '✅ Carla Dias cadastrado(a): Estoque · Norte.' }
    ])
  })

  it('/cadastrar no privado aceita o telefone e atualiza quem já existe', () => {
    const acoes = rodar(privado(), '/cadastrar 83999990002 Beto Lima | Caixa | Sul | Operador')
    expect(acoes[0]).toMatchObject({ tipo: 'salvar_funcionario', id: 2, dados: { telefone: '5583999990002', cargo: 'Operador' } })
    expect(textos(acoes)).toEqual(['✅ Beto Lima atualizado(a): Caixa · Sul · Operador.'])
  })

  it('/cadastrar incompleto mostra o uso', () => {
    const carla: Pessoa = { jid: '777@lid', telefone: null, lid: '777@lid' }
    expect(textos(rodar(ctx({ mencionados: [carla] }), '/cadastrar @777 Carla'))[0]).toMatch(/^Uso: \/cadastrar/)
    expect(textos(rodar(ctx(), '/cadastrar Carla | Estoque | Norte'))[0]).toMatch(/^Uso:/)
  })

  it('/cadastrar recusa telefone e LID que são de cadastros diferentes', () => {
    const misturado: Pessoa = { jid: '111@lid', telefone: '5583999990002', lid: '111@lid' }
    expect(textos(rodar(ctx({ mencionados: [misturado] }), '/cadastrar @111 X Y | A | B'))[0]).toContain('cadastros diferentes')
  })

  it('/gestor add indica (pendente) e manda o código para quem pediu; remover; o último gestor não sai', () => {
    const add = rodar(ctx({ mencionados: [BETO_TEL] }), '/gestor add @5583999990002')
    expect(add).toEqual([
      { tipo: 'indicar_gestor', funcionarioId: 2, avisar: ANA_LID },
      { tipo: 'auditar', acao: 'gestor_indicado', detalhe: 'Beto Lima no Avisos', funcionarioId: 2 },
      {
        tipo: 'responder',
        texto: '⏳ Beto Lima foi indicado(a) como gestor(a). Para ativar, Beto Lima deve mandar /confirmar no meu privado.'
      }
    ])
    // pendente de novo: troca o código
    const pend = { funcionarioId: 2, codigo: '123456', expiraEm: AGORA + 1 }
    expect(rodar(ctx({ mencionados: [BETO_TEL], pendentes: [pend] }), '/gestor add @5583999990002')[0]).toMatchObject({ tipo: 'indicar_gestor' })
    expect(textos(rodar(ctx({ mencionados: [ANA_LID] }), '/gestor add @111'))).toEqual(['Ana Souza já é gestor(a).'])
    expect(textos(rodar(ctx({ mencionados: [ANA_LID] }), '/gestor remover @111'))[0]).toContain('último gestor')
    const rem = rodar(ctx({ mencionados: [BETO_TEL], gestores: new Set([1, 2]) }), '/gestor remover @5583999990002')
    expect(rem[0]).toEqual({ tipo: 'remover_gestor', funcionarioId: 2 })
    expect(textos(rem)).toEqual(['Beto Lima não é mais gestor(a).'])
    // pendente também pode ser removido, e não conta como "último gestor"
    expect(rodar(ctx({ mencionados: [BETO_TEL], pendentes: [pend] }), '/gestor remover @5583999990002')[0]).toEqual({
      tipo: 'remover_gestor',
      funcionarioId: 2
    })
    expect(textos(rodar(ctx({ mencionados: [BETO_TEL] }), '/gestor remover @5583999990002'))).toEqual(['Beto Lima não é gestor(a).'])
    expect(textos(rodar(ctx({ mencionados: [ESTRANHO] }), '/gestor add @999'))[0]).toContain('não está no cadastro')
    expect(textos(rodar(privado(), '/gestor add 83999990002'))[0]).toContain('indicado(a) como gestor(a)')
  })

  it('/quem responde pela menção ou pela mensagem citada', () => {
    expect(textos(rodar(ctx({ remetente: BETO_TEL, mencionados: [ANA_LID] }), '/quem @111'))).toEqual([
      '🪪 Ana Souza — Vendas · Centro · Gerente · 👔 gestor(a)'
    ])
    expect(textos(rodar(ctx({ citada: BETO_TEL }), '/quem'))).toEqual(['🪪 Beto Lima — Caixa · Sul'])
    expect(textos(rodar(ctx({ mencionados: [ESTRANHO] }), '/quem @999'))).toEqual(['Não encontrei essa pessoa no cadastro.'])
  })

  it('/gestores menciona os gestores presentes no grupo', () => {
    const acoes = rodar(ctx({ membros: [membro(ANA_LID), membro(BETO_TEL)] }), '/gestores')
    expect(acoes).toEqual([{ tipo: 'responder', texto: '👔 Gestores deste grupo: @111', mencoes: ['111@lid'] }])
    expect(textos(rodar(ctx({ membros: [membro(BETO_TEL)] }), '/gestores'))[0]).toContain('Nenhum gestor')
    expect(textos(rodar(ctx(), '/gestores'))[0]).toContain('Não consegui ler os participantes')
  })

  it('/desconhecidos lista quem não está no cadastro', () => {
    const t = textos(rodar(ctx({ membros: [membro(ANA_LID), membro(BETO_TEL), membro(ESTRANHO)] }), '/desconhecidos'))[0]!
    expect(t).toContain('1 sem cadastro')
    expect(t).toContain('contato oculto')
    expect(textos(rodar(ctx({ membros: [membro(ANA_LID)] }), '/desconhecidos'))[0]).toContain('Todos os participantes')
  })

  it('/desconhecidos nunca mostra o telefone de quem participa pelo LID (WhatsApp esconde o número)', () => {
    const lidComTelefone: Pessoa = { jid: '888@lid', telefone: '5583999990088', lid: '888@lid' }
    const t = textos(rodar(ctx({ membros: [membro(lidComTelefone), membro(AMERICANO)] }), '/desconhecidos'))[0]!
    expect(t).toContain('contato oculto (888)')
    expect(t).not.toContain('99999-0088')
    expect(t).not.toContain('5583999990088')
    expect(t).toContain('+14155550100')
  })

  it('/setores conta por setor e loja', () => {
    const extra: Funcionario = { ...BETO, id: 3, nome: 'Caio', telefone: '5583999990003', loja: 'Centro' }
    const t = textos(rodar(ctx({ funcionarios: [ANA, BETO, extra] }), '/setores'))[0]!
    expect(t).toContain('3 pessoas')
    expect(t).toContain('• Caixa: 2 (Centro 1, Sul 1)')
    expect(t).toContain('• Vendas: 1 (Centro 1)')
  })

  it('/grupos, /status e /log', () => {
    expect(textos(rodar(privado(), '/grupos'))[0]).toContain('Loja Centro — sem admin ❌ — Centro')
    expect(textos(rodar(ctx(), '/status'))[0]).toContain('1 grupos ativos · 2 pessoas cadastradas (1 gestores)')
    expect(textos(rodar(privado({ grupos: [] }), '/grupos'))).toEqual(['Nenhum grupo ativo neste bot.'])
    const auditoria = Array.from({ length: 40 }, (_, i) => ({ em: AGORA - i, usuario: 'rh', acao: `a${i}`, detalhe: null }))
    expect(textos(rodar(privado({ auditoria }), '/log 99'))[0]!.split('\n')).toHaveLength(31)
    expect(textos(rodar(privado({ auditoria }), '/log'))[0]!.split('\n')).toHaveLength(11)
  })
})

describe('motor do bot de grupos: correções de revisão', () => {
  it('/cadastrar não reativa quem está inativo (perderia e recuperaria poder de gestor em silêncio)', () => {
    const inativo: Funcionario = { ...BETO, ativo: false }
    const acoes = rodar(ctx({ funcionarios: [ANA, inativo], mencionados: [BETO_TEL] }), '/cadastrar @5583999990002 Beto Lima | Caixa | Sul')
    expect(textos(acoes)).toEqual(['Beto Lima está com o cadastro inativo. Reative pelo painel.'])
    expect(acoes.some((a) => a.tipo === 'salvar_funcionario')).toBe(false)
  })

  it('/gestor remover: a proteção do último gestor só vale se o alvo estiver ativo', () => {
    const betoInativo: Funcionario = { ...BETO, ativo: false }
    // Ana (ativa, gestora) remove Beto, que é gestor mas está inativo: ele não conta como "o último gestor ativo".
    const acoes = rodar(
      ctx({ funcionarios: [ANA, betoInativo], gestores: new Set([1, 2]), mencionados: [BETO_TEL] }),
      '/gestor remover @5583999990002'
    )
    expect(acoes[0]).toEqual({ tipo: 'remover_gestor', funcionarioId: 2 })
  })

  it('/cadastrar recusa nome com dígitos (telefone digitado não pode virar nome quando o alvo é a mensagem citada)', () => {
    const t = textos(rodar(ctx({ citada: BETO_TEL }), '/cadastrar 83999990002 Nome | Estoque | Norte'))[0]
    expect(t).toMatch(/^Uso:/)
  })

  it('/log 0 vira 1 (só cai para 10 quando não vem número); cada linha é cortada em 200 caracteres', () => {
    const longa = 'x'.repeat(300)
    const auditoria = [
      { em: AGORA, usuario: 'rh', acao: longa, detalhe: null },
      { em: AGORA - 1, usuario: 'rh', acao: 'a2', detalhe: null }
    ]
    const comZero = textos(rodar(privado({ auditoria }), '/log 0'))[0]!.split('\n')
    expect(comZero).toHaveLength(2)
    expect(comZero[1]!.length).toBeLessThanOrEqual(200)
  })

  it('/grupos: quem não é gestor não recebe nada, mesmo dentro do grupo', () => {
    expect(rodar(ctx({ remetente: BETO_TEL }), '/grupos')).toEqual([])
  })

  it('/desconhecidos corta a lista em 40 e diz quantos faltaram', () => {
    const estranhos = Array.from({ length: 45 }, (_, i) => membro({ jid: `${i}@lid`, telefone: null, lid: `${i}@lid` }))
    const t = textos(rodar(ctx({ membros: [membro(ANA_LID), ...estranhos] }), '/desconhecidos'))[0]!
    expect(t).toContain('45 sem cadastro')
    expect(t).toContain('… e mais 5')
  })

  it('/cadastrar e /quem usam a mesma chave para telefone estrangeiro (Pessoa.telefone já é a chave; não canonicaliza de novo como brasileiro)', () => {
    const cadastro = rodar(ctx({ mencionados: [AMERICANO] }), '/cadastrar @14155550100 Carlos Externo | TI | Remoto')
    const salvar = cadastro.find((a) => a.tipo === 'salvar_funcionario')
    if (salvar?.tipo !== 'salvar_funcionario') throw new Error('esperava salvar_funcionario')
    expect(salvar.dados.telefone).toBe('14155550100')

    const carlos: Funcionario = {
      id: 9, nome: 'Carlos Externo', telefone: salvar.dados.telefone, lid: null,
      setor: 'TI', loja: 'Remoto', cargo: null, nascimento: null, ativo: true, confirmadoEm: null
    }
    const quem = textos(rodar(ctx({ funcionarios: [ANA, BETO, carlos], mencionados: [AMERICANO] }), '/quem @14155550100'))
    expect(quem[0]).toContain('Carlos Externo')
  })

  it('/cadastrar no privado: telefone estrangeiro digitado com "+" (não +55) mantém os dígitos crus', () => {
    const acoes = rodar(privado(), '/cadastrar +14155550100 Carlos Externo | TI | Remoto')
    expect(acoes[0]).toMatchObject({ tipo: 'salvar_funcionario', dados: { telefone: '14155550100' } })
  })

  it('/cadastrar no privado: telefone brasileiro digitado com "+55" ainda canonicaliza', () => {
    const acoes = rodar(privado(), '/cadastrar +5583999990009 Diana Reis | Caixa | Sul')
    expect(acoes[0]).toMatchObject({ tipo: 'salvar_funcionario', dados: { telefone: '5583999990009' } })
  })
})

describe('motor do bot de grupos: confirmação por código', () => {
  const PEND = { funcionarioId: 2, codigo: '482193', expiraEm: AGORA + 60_000 }
  const comBetoPendente = (extra: Partial<ContextoGrupos> = {}) => privado({ remetente: BETO_TEL, pendentes: [PEND], ...extra })

  it('código certo vindo do telefone do cadastro confirma e audita', () => {
    expect(rodar(comBetoPendente(), '/confirmar 482193')).toEqual([
      { tipo: 'confirmar_gestor', funcionarioId: 2, pessoa: BETO_TEL },
      { tipo: 'auditar', acao: 'gestor_confirmado', detalhe: 'Beto Lima no Avisos', funcionarioId: 2 },
      { tipo: 'responder', texto: '✅ Pronto, Beto Lima! Você agora é gestor(a) do Avisos.' }
    ])
  })

  it('o LID do cadastro também vale; espaços e traços no código são ignorados', () => {
    const betoComLid: Funcionario = { ...BETO, lid: '222@lid' }
    const pelaLid: Pessoa = { jid: '222@lid', telefone: null, lid: '222@lid' }
    const acoes = rodar(comBetoPendente({ funcionarios: [ANA, betoComLid], remetente: pelaLid }), '/confirmar 482-193')
    expect(acoes[0]).toEqual({ tipo: 'confirmar_gestor', funcionarioId: 2, pessoa: pelaLid })
  })

  it('código certo de outro WhatsApp vira divergência, sem poder', () => {
    const outro: Pessoa = { jid: '5583988887777@s.whatsapp.net', telefone: '5583988887777', lid: null }
    const acoes = rodar(comBetoPendente({ remetente: outro }), '/confirmar 482193')
    expect(acoes[0]).toEqual({ tipo: 'divergencia', funcionarioId: 2, pessoa: outro })
    expect(acoes[1]).toEqual({
      tipo: 'auditar', acao: 'gestor_divergente', detalhe: 'Beto Lima no Avisos: veio de +55 83 98888-7777', funcionarioId: 2
    })
    expect(textos(acoes)[0]).toContain('diferente do cadastro de Beto Lima')
  })

  it('código errado, vencido ou ausente: inválido e conta como tentativa errada', () => {
    const invalido = 'Código inválido ou vencido. Peça um novo código a quem cadastrou você.'
    for (const t of ['/confirmar 000000', '/confirmar', '/confirmar 48219']) {
      expect(rodar(comBetoPendente(), t)).toEqual([{ tipo: 'codigo_errado' }, { tipo: 'responder', texto: invalido }])
    }
    expect(rodar(comBetoPendente({ agora: PEND.expiraEm }), '/confirmar 482193')[0]).toEqual({ tipo: 'codigo_errado' })
    // estranho, fora do cadastro, também pode tentar (e erra)
    expect(rodar(privado({ remetente: ESTRANHO, pendentes: [PEND] }), '/confirmar 111111')[0]).toEqual({ tipo: 'codigo_errado' })
  })

  it('no grupo, /confirmar só manda usar no privado e nunca olha o código', () => {
    expect(rodar(ctx({ remetente: BETO_TEL, pendentes: [PEND] }), '/confirmar 482193')).toEqual([
      { tipo: 'responder', texto: 'Use /confirmar no privado comigo.' }
    ])
  })

  it('gestor pendente não tem poder; /confirmar não aparece no /menu', () => {
    expect(rodar(comBetoPendente(), '/status')).toEqual([])
    expect(textos(rodar(privado(), '/menu'))[0]).not.toContain('/confirmar')
  })
})

describe('motor do bot de grupos: comandos do bot', () => {
  const salvo = (nome: string, extra: object) => ({
    nome, ligado: true, personalizado: false, quem: null, onde: null, descricao: null, resposta: null, textos: {}, ...extra
  })
  const comandos = comandosDoBot(
    new Map([
      ['quem', salvo('quem', { ligado: false })],
      ['status', salvo('status', { textos: { resumo: 'Bot ok: {grupos} grupo(s), {gestores} gestor(es)' } })],
      ['menu', salvo('menu', { textos: { titulo: '🤖 O que eu faço' } })],
      ['horario', salvo('horario', { personalizado: true, quem: 'todos', onde: 'grupo', descricao: 'horário das lojas', resposta: 'Seg a sáb, 8h às 18h' })],
      ['metas', salvo('metas', { personalizado: true, quem: 'gestores', onde: 'ambos', descricao: 'metas do mês', resposta: 'Meta: 100 vendas' })]
    ])
  )

  it('comando desligado: gestor ouve que está desligado; os outros, silêncio', () => {
    expect(textos(rodar(ctx({ comandos, mencionados: [BETO_TEL] }), '/quem @5583999990002'))).toEqual(['Este comando está desligado neste bot.'])
    expect(rodar(ctx({ comandos, remetente: BETO_TEL, mencionados: [ANA_LID] }), '/quem @111')).toEqual([])
  })

  it('/menu usa o título editado, esconde o desligado e mostra os personalizados que a pessoa pode usar', () => {
    const beto = textos(rodar(ctx({ comandos, remetente: BETO_TEL }), '/menu'))[0]!
    expect(beto.split('\n')[0]).toBe('🤖 O que eu faço')
    expect(beto).not.toContain('/quem')
    expect(beto).toContain('/horario — horário das lojas')
    expect(beto).not.toContain('/metas')
    const ana = textos(rodar(ctx({ comandos }), '/menu'))[0]!
    expect(ana).toContain('/metas — metas do mês')
    expect(textos(rodar(privado({ comandos }), '/menu'))[0]).not.toContain('/horario')
  })

  it('personalizado responde o texto fixo e respeita quem e onde', () => {
    expect(textos(rodar(ctx({ comandos, remetente: BETO_TEL }), '/horario'))).toEqual(['Seg a sáb, 8h às 18h'])
    expect(textos(rodar(privado({ comandos }), '/horario'))).toEqual(['O /horario funciona dentro de um grupo.'])
    expect(rodar(ctx({ comandos, remetente: BETO_TEL }), '/metas')).toEqual([])
    expect(textos(rodar(privado({ comandos }), '/metas'))).toEqual(['Meta: 100 vendas'])
    expect(rodar(privado({ comandos, remetente: BETO_TEL }), '/horario')).toEqual([])
  })

  it('texto editado do /status preenche os campos', () => {
    expect(textos(rodar(ctx({ comandos }), '/status'))).toEqual(['Bot ok: 1 grupo(s), 1 gestor(es)'])
  })
})
