import { describe, expect, it } from 'vitest'
import type { Funcionario, Grupo } from '../src/db/grupos.js'
import { interpretar } from '../src/grupos/comandos.js'
import { processarComando } from '../src/grupos/motor.js'
import type { AcaoGrupo, ContextoGrupos, MembroGrupo, Pessoa } from '../src/grupos/tipos.js'
import { AGORA } from './ajuda.js'

const ANA: Funcionario = {
  id: 1, nome: 'Ana Souza', telefone: '5583999990001', lid: '111@lid',
  setor: 'Vendas', loja: 'Centro', cargo: 'Gerente', nascimento: null, ativo: true
}
const BETO: Funcionario = {
  id: 2, nome: 'Beto Lima', telefone: '5583999990002', lid: null,
  setor: 'Caixa', loja: 'Sul', cargo: null, nascimento: null, ativo: true
}
const GRUPO: Grupo = {
  numeroId: 2, jid: '120363-1@g.us', nome: 'Loja Centro', botAdmin: false,
  setor: null, loja: 'Centro', ativo: true, atualizadoEm: AGORA
}
const ANA_LID: Pessoa = { jid: '111@lid', telefone: null, lid: '111@lid' }
const BETO_TEL: Pessoa = { jid: '5583999990002@s.whatsapp.net', telefone: '5583999990002', lid: null }
const ESTRANHO: Pessoa = { jid: '999@lid', telefone: null, lid: '999@lid' }
const membro = (p: Pessoa): MembroGrupo => ({ ...p, admin: false })

function ctx(extra: Partial<ContextoGrupos> = {}): ContextoGrupos {
  return {
    agora: AGORA, chat: GRUPO.jid, ehGrupo: true, remetente: ANA_LID, mencionados: [], citada: null,
    funcionarios: [ANA, BETO], gestores: new Set([1]), grupo: GRUPO, grupos: [GRUPO], membros: null,
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

  it('/gestor add e remover; o último gestor não sai', () => {
    const add = rodar(ctx({ mencionados: [BETO_TEL] }), '/gestor add @5583999990002')
    expect(add.slice(0, 2)).toEqual([
      { tipo: 'gestor', funcionarioId: 2, ativo: true },
      { tipo: 'auditar', acao: 'gestor_adicionado', detalhe: 'Beto Lima' }
    ])
    expect(textos(rodar(ctx({ mencionados: [ANA_LID] }), '/gestor remover @111'))[0]).toContain('último gestor')
    const rem = rodar(ctx({ mencionados: [BETO_TEL], gestores: new Set([1, 2]) }), '/gestor remover @5583999990002')
    expect(rem[0]).toEqual({ tipo: 'gestor', funcionarioId: 2, ativo: false })
    expect(textos(rodar(ctx({ mencionados: [ESTRANHO] }), '/gestor add @999'))[0]).toContain('não está no cadastro')
    expect(textos(rodar(privado(), '/gestor add 83999990002'))[0]).toContain('agora é gestor')
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

  it('/setores conta por setor e loja', () => {
    const extra: Funcionario = { ...BETO, id: 3, nome: 'Caio', telefone: '5583999990003', loja: 'Centro' }
    const t = textos(rodar(ctx({ funcionarios: [ANA, BETO, extra] }), '/setores'))[0]!
    expect(t).toContain('3 pessoas')
    expect(t).toContain('• Caixa: 2 (Centro 1, Sul 1)')
    expect(t).toContain('• Vendas: 1 (Centro 1)')
  })

  it('/grupos, /status e /log', () => {
    expect(textos(rodar(privado(), '/grupos'))[0]).toContain('Loja Centro — sem admin ❌ — Centro')
    expect(textos(rodar(ctx(), '/status'))[0]).toContain('1 grupos · 2 pessoas cadastradas (1 gestores)')
    const auditoria = Array.from({ length: 40 }, (_, i) => ({ em: AGORA - i, usuario: 'rh', acao: `a${i}`, detalhe: null }))
    expect(textos(rodar(privado({ auditoria }), '/log 99'))[0]!.split('\n')).toHaveLength(31)
    expect(textos(rodar(privado({ auditoria }), '/log'))[0]!.split('\n')).toHaveLength(11)
  })
})
