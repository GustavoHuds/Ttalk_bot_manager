import { describe, expect, it } from 'vitest'
import {
  ESPERA_ARQUIVOS_MS,
  extrairCodigo,
  formatoDoArquivo,
  nomeCompletoValido,
  normalizarTelefone,
  pedeExclusao,
  processar
} from '../src/conversa/motor.js'
import { casarOpcao, renderizar } from '../src/conversa/textos.js'
import { CHAVE_VAGA, type Acao, type CandidaturaVista, type Contexto } from '../src/conversa/tipos.js'
import { AGORA, padrao, processo } from './ajuda.js'

function ctx(parcial: Partial<Contexto> = {}): Contexto {
  return {
    agora: AGORA,
    processos: [processo()],
    padrao,
    estado: null,
    ativaId: null,
    candidaturas: [],
    telefone: '5583999990000',
    aleatorio: () => 0,
    empresa: 'Loja Exemplo',
    ...parcial
  }
}

function cand(parcial: Partial<CandidaturaVista> = {}): CandidaturaVista {
  return {
    id: 1,
    processo: 'VEND-OUT26',
    protocolo: 'VEND-OUT26-0001',
    passo: 'nome',
    status: 'em_andamento',
    telefone: '5583999990000',
    respostas: {},
    arquivosNoLote: 0,
    ultimaInteracao: AGORA - 60_000,
    ...parcial
  }
}

const textos = (acoes: Acao[]) => acoes.filter((a) => a.tipo === 'enviar').map((a) => (a as { texto: string }).texto)
const tipos = (acoes: Acao[]) => acoes.map((a) => a.tipo)

describe('utilitários', () => {
  it('lê o código entre colchetes do link', () => {
    expect(extrairCodigo('Quero me candidatar [vend-out26]')).toBe('VEND-OUT26')
    expect(extrairCodigo('oi')).toBeNull()
  })

  it('reconhece pedido de exclusão com ou sem acento', () => {
    expect(pedeExclusao('Quero EXCLUIR meus dados')).toBe(true)
    expect(pedeExclusao('apagar os meus dados por favor')).toBe(true)
    expect(pedeExclusao('meus dados estão certos')).toBe(false)
  })

  it('valida nome completo', () => {
    expect(nomeCompletoValido('Maria da Silva')).toBe(true)
    expect(nomeCompletoValido('Maria')).toBe(false)
    expect(nomeCompletoValido('Maria 123')).toBe(false)
  })

  it('normaliza telefone brasileiro', () => {
    expect(normalizarTelefone('(83) 99999-0000')).toBe('5583999990000')
    expect(normalizarTelefone('+55 83 3333-4444')).toBe('558333334444')
    expect(normalizarTelefone('123')).toBeNull()
  })

  it('identifica formato por mimetype ou extensão', () => {
    expect(formatoDoArquivo('application/pdf', null)).toBe('pdf')
    expect(formatoDoArquivo('application/octet-stream', 'CV.DOCX')).toBe('docx')
    expect(formatoDoArquivo('image/jpeg', null)).toBe('jpg')
    expect(formatoDoArquivo('application/zip', 'cv.zip')).toBeNull()
  })

  it('casa opção por número ou texto sem acento', () => {
    const op = ['Manhã', 'Tarde']
    expect(casarOpcao('1', op)).toBe('Manhã')
    expect(casarOpcao('manha', op)).toBe('Manhã')
    expect(casarOpcao('opção 2.', op)).toBe('Tarde')
    expect(casarOpcao('3', op)).toBeNull()
  })

  it('renderiza variáveis e limpa vírgula de nome vazio', () => {
    expect(renderizar({ x: 'Obrigado, {primeiro_nome}!' }, 'x', { primeiro_nome: '' }, () => 0)).toBe('Obrigado!')
    expect(renderizar({ x: ['a {vaga}', 'b {vaga}'] }, 'x', { vaga: 'V' }, () => 0.9)).toBe('b V')
  })
})

describe('entrada no processo', () => {
  it('link com código inicia a candidatura: boas-vindas, aviso LGPD e primeira pergunta', () => {
    const a = processar(ctx(), { tipo: 'texto', texto: 'Quero me candidatar [VEND-OUT26]' })
    expect(tipos(a)).toEqual(['criar_candidatura', 'passo', 'enviar', 'enviar', 'enviar'])
    const t = textos(a)
    expect(t[0]).toContain('Vendedor(a) de loja')
    expect(t[0]).toContain('RH da Loja Exemplo')
    expect(t[1]).toContain('12 meses')
    expect(t[1]).toContain('LGPD')
    expect(t[2]).toBe('Para começar, qual é o seu nome completo?')
  })

  it('"oi" sem código com um só processo aberto usa esse processo', () => {
    const a = processar(ctx(), { tipo: 'texto', texto: 'oi' })
    expect(a[0]).toEqual({ tipo: 'criar_candidatura', processo: 'VEND-OUT26' })
  })

  it('com mais de um processo aberto pergunta a vaga por enquete', () => {
    const outro = processo({ codigo: 'CAIXA-OUT26', vaga: 'Caixa' })
    const a = processar(ctx({ processos: [processo(), outro] }), { tipo: 'texto', texto: 'oi' })
    expect(a).toContainEqual({ tipo: 'estado', estado: { tipo: 'escolher_vaga', codigos: ['VEND-OUT26', 'CAIXA-OUT26'] } })
    const enquete = a.find((x) => x.tipo === 'enquete') as Extract<Acao, { tipo: 'enquete' }>
    expect(enquete.chave).toBe(CHAVE_VAGA)
    expect(enquete.opcoes).toEqual(['Vendedor(a) de loja', 'Caixa'])
  })

  it('escolha da vaga por voto ou número', () => {
    const outro = processo({ codigo: 'CAIXA-OUT26', vaga: 'Caixa' })
    const base = ctx({ processos: [processo(), outro], estado: { tipo: 'escolher_vaga', codigos: ['VEND-OUT26', 'CAIXA-OUT26'] } })
    expect(processar(base, { tipo: 'voto', chave: CHAVE_VAGA, opcoes: ['Caixa'] })).toContainEqual({
      tipo: 'criar_candidatura',
      processo: 'CAIXA-OUT26'
    })
    expect(processar(base, { tipo: 'texto', texto: '1' })).toContainEqual({ tipo: 'criar_candidatura', processo: 'VEND-OUT26' })
    expect(textos(processar(base, { tipo: 'texto', texto: 'sei lá' }))[0]).toContain('1. Vendedor(a) de loja')
  })

  it('processo em rascunho é ignorado; encerrado avisa', () => {
    const rascunho = processo({ status: 'rascunho' })
    expect(textos(processar(ctx({ processos: [rascunho] }), { tipo: 'texto', texto: '[VEND-OUT26]' }))[0]).toContain(
      'não temos inscrições abertas'
    )
    const encerrado = processo({ status: 'encerrado' })
    expect(textos(processar(ctx({ processos: [encerrado] }), { tipo: 'texto', texto: '[VEND-OUT26]' }))[0]).toContain(
      'não estão abertas'
    )
  })

  it('processo aberto mas fora do período conta como fechado', () => {
    const depois = ctx({ agora: Date.UTC(2026, 10, 1, 4) })
    expect(textos(processar(depois, { tipo: 'texto', texto: '[VEND-OUT26]' }))[0]).toContain('não estão abertas')
  })
})

describe('perguntas', () => {
  it('nome inválido pede de novo; válido salva e pergunta a cidade', () => {
    const c = ctx({ candidaturas: [cand()], ativaId: 1 })
    expect(textos(processar(c, { tipo: 'texto', texto: 'Maria' }))).toEqual([
      'Por favor, envie seu nome completo (nome e sobrenome).'
    ])
    const a = processar(c, { tipo: 'texto', texto: '  maria   da silva ' })
    expect(a).toContainEqual({ tipo: 'resposta', chave: 'nome', valor: 'maria da silva' })
    expect(a).toContainEqual({ tipo: 'passo', passo: 'cidade' })
    expect(textos(a)).toEqual(['Em qual cidade e bairro você mora?'])
  })

  it('depois da cidade envia a enquete de disponibilidade', () => {
    const c = ctx({ candidaturas: [cand({ passo: 'cidade', respostas: { nome: 'Maria Silva' } })], ativaId: 1 })
    const a = processar(c, { tipo: 'texto', texto: 'João Pessoa, Mangabeira' })
    expect(a).toContainEqual({
      tipo: 'enquete',
      chave: 'disponibilidade',
      pergunta: 'Qual horário você tem disponível?',
      opcoes: ['Manhã', 'Tarde', 'Integral', 'Escala 6x1']
    })
  })

  it('enquete aceita voto, número digitado e ignora voto de outra enquete', () => {
    const c = ctx({ candidaturas: [cand({ passo: 'disponibilidade' })], ativaId: 1 })
    expect(processar(c, { tipo: 'voto', chave: 'disponibilidade', opcoes: ['Tarde'] })).toContainEqual({
      tipo: 'resposta',
      chave: 'disponibilidade',
      valor: 'Tarde'
    })
    expect(processar(c, { tipo: 'texto', texto: '3' })).toContainEqual({ tipo: 'resposta', chave: 'disponibilidade', valor: 'Integral' })
    expect(processar(c, { tipo: 'voto', chave: '_vaga', opcoes: ['x'] })).toEqual([])
    expect(textos(processar(c, { tipo: 'texto', texto: 'qualquer' }))[0]).toContain('4. Escala 6x1')
  })

  it('áudio, figurinha e afins recebem a explicação', () => {
    const c = ctx({ candidaturas: [cand({ passo: 'cidade' })], ativaId: 1 })
    expect(textos(processar(c, { tipo: 'nao_suportado' }))[0]).toContain('só mensagens de texto')
  })

  it('volta depois de 24 h: retoma de onde parou sem tratar o "oi" como resposta', () => {
    const c = ctx({ candidaturas: [cand({ passo: 'cidade', ultimaInteracao: AGORA - 25 * 3600_000 })], ativaId: 1 })
    const a = processar(c, { tipo: 'texto', texto: 'oi' })
    expect(a.some((x) => x.tipo === 'resposta')).toBe(false)
    expect(textos(a)).toEqual(['Que bom que você voltou! Vamos continuar de onde paramos.', 'Em qual cidade e bairro você mora?'])
  })
})

describe('currículo', () => {
  const noCurriculo = (extra: Partial<CandidaturaVista> = {}) =>
    ctx({ candidaturas: [cand({ passo: 'curriculo', respostas: { nome: 'Maria Silva' }, ...extra })], ativaId: 1 })

  it('primeiro arquivo: guarda, agenda fechamento em 60 s e avisa que pode mandar mais páginas', () => {
    const a = processar(noCurriculo(), { tipo: 'arquivo', mimetype: 'application/pdf', nomeArquivo: 'cv.pdf', tamanho: 1000 })
    expect(a).toContainEqual({ tipo: 'guardar_arquivo', ext: 'pdf' })
    expect(a).toContainEqual({ tipo: 'agendar_finalizacao', em: AGORA + ESPERA_ARQUIVOS_MS })
    expect(textos(a)[0]).toContain('mais páginas')
  })

  it('segunda foto só reagenda, sem nova mensagem', () => {
    const a = processar(noCurriculo({ arquivosNoLote: 1 }), { tipo: 'arquivo', mimetype: 'image/jpeg', nomeArquivo: null, tamanho: 10 })
    expect(tipos(a)).toEqual(['interacao', 'guardar_arquivo', 'agendar_finalizacao'])
  })

  it('texto sem arquivo repete o pedido; texto depois do arquivo espera o fechamento', () => {
    expect(textos(processar(noCurriculo(), { tipo: 'texto', texto: 'já mando' }))[0]).toContain('Ainda falta o currículo')
    expect(textos(processar(noCurriculo({ arquivosNoLote: 1 }), { tipo: 'texto', texto: 'pronto' }))).toEqual([])
  })

  it('formato desconhecido e arquivo grande são recusados', () => {
    expect(textos(processar(noCurriculo(), { tipo: 'arquivo', mimetype: 'application/zip', nomeArquivo: 'cv.zip', tamanho: 10 }))[0]).toContain(
      'Não consigo abrir'
    )
    expect(
      textos(processar(noCurriculo(), { tipo: 'arquivo', mimetype: 'application/pdf', nomeArquivo: 'cv.pdf', tamanho: 11 * 1024 * 1024 }))[0]
    ).toContain('limite de tamanho')
  })

  it('fechamento do lote conclui com a confirmação e o protocolo', () => {
    const a = processar(noCurriculo({ arquivosNoLote: 2 }), { tipo: 'finalizar_arquivos' })
    expect(a).toContainEqual({ tipo: 'concluir' })
    expect(textos(a)[0]).toBe(
      'Obrigado, Maria! Recebemos seu currículo (protocolo VEND-OUT26-0001). Ele será analisado pela nossa equipe e, se seu perfil avançar, entraremos em contato por este número.'
    )
  })

  it('sem telefone (só LID) pergunta o telefone antes de concluir', () => {
    const c = ctx({
      telefone: null,
      candidaturas: [cand({ passo: 'curriculo', telefone: null, arquivosNoLote: 1, respostas: { nome: 'Maria Silva' } })],
      ativaId: 1
    })
    const a = processar(c, { tipo: 'finalizar_arquivos' })
    expect(a).toContainEqual({ tipo: 'passo', passo: 'telefone' })
    expect(a.some((x) => x.tipo === 'concluir')).toBe(false)

    const noTel = ctx({ telefone: null, candidaturas: [cand({ passo: 'telefone', telefone: null })], ativaId: 1 })
    expect(textos(processar(noTel, { tipo: 'texto', texto: 'não sei' }))[0]).toContain('Não reconheci')
    const ok = processar(noTel, { tipo: 'texto', texto: '83 98888-7777' })
    expect(ok).toContainEqual({ tipo: 'telefone', telefone: '5583988887777' })
    expect(ok).toContainEqual({ tipo: 'concluir' })
  })
})

describe('currículo enviado antes da hora', () => {
  const pdf = { tipo: 'arquivo' as const, mimetype: 'application/pdf', nomeArquivo: 'cv.pdf', tamanho: 100 }

  it('primeira mensagem já é o currículo: guarda e segue com as perguntas', () => {
    const a = processar(ctx(), pdf)
    expect(tipos(a)).toEqual(['criar_candidatura', 'passo', 'enviar', 'enviar', 'guardar_arquivo', 'enviar', 'enviar'])
    expect(textos(a)[2]).toContain('Recebi seu currículo')
    expect(textos(a)[3]).toBe('Para começar, qual é o seu nome completo?')
  })

  it('arquivo no meio das perguntas é guardado e a pergunta atual é repetida', () => {
    const c = ctx({ candidaturas: [cand({ passo: 'cidade' })], ativaId: 1 })
    const a = processar(c, pdf)
    expect(a).toContainEqual({ tipo: 'guardar_arquivo', ext: 'pdf' })
    expect(a.some((x) => x.tipo === 'agendar_finalizacao')).toBe(false)
    expect(textos(a).at(-1)).toBe('Em qual cidade e bairro você mora?')
  })

  it('com o currículo já guardado, pula o pedido e conclui', () => {
    const c = ctx({
      candidaturas: [cand({ passo: 'pretensao', arquivosNoLote: 1, respostas: { nome: 'Maria Silva', cidade: 'x', disponibilidade: 'Tarde' } })],
      ativaId: 1
    })
    const a = processar(c, { tipo: 'texto', texto: 'a combinar' })
    expect(a).toContainEqual({ tipo: 'concluir' })
    expect(textos(a)[0]).toContain('Obrigado, Maria!')
  })

  it('formato inválido antecipado avisa e repete a pergunta', () => {
    const c = ctx({ candidaturas: [cand({ passo: 'cidade' })], ativaId: 1 })
    const a = processar(c, { tipo: 'arquivo', mimetype: 'application/zip', nomeArquivo: 'a.zip', tamanho: 1 })
    expect(a.some((x) => x.tipo === 'guardar_arquivo')).toBe(false)
    expect(textos(a)).toEqual(['Não consigo abrir esse formato. Envie o currículo em PDF, Word ou foto.', 'Em qual cidade e bairro você mora?'])
  })
})

describe('depois de concluir', () => {
  const concluida = (extra: Partial<CandidaturaVista> = {}) =>
    ctx({ candidaturas: [cand({ status: 'concluida', passo: 'fim', respostas: { nome: 'Maria Silva' }, ...extra })], ativaId: 1 })

  it('nova mensagem repete a confirmação e oferece trocar o currículo', () => {
    expect(textos(processar(concluida(), { tipo: 'texto', texto: 'oi' }))[0]).toContain('trocar o currículo')
  })

  it('novo arquivo abre lote de substituição; ao fechar descarta o antigo', () => {
    const a = processar(concluida(), { tipo: 'arquivo', mimetype: 'application/pdf', nomeArquivo: 'novo.pdf', tamanho: 5 })
    expect(tipos(a)).toEqual(['interacao', 'novo_lote', 'passo', 'guardar_arquivo', 'agendar_finalizacao', 'enviar'])
    const fim = processar(concluida({ passo: 'substituindo', arquivosNoLote: 1 }), { tipo: 'finalizar_arquivos' })
    expect(fim).toContainEqual({ tipo: 'descartar_lotes_antigos' })
    expect(textos(fim)[0]).toContain('atualizado')
  })
})

describe('exclusão de dados', () => {
  it('pede confirmação e só apaga com SIM', () => {
    const c = ctx({ candidaturas: [cand()], ativaId: 1 })
    const pedido = processar(c, { tipo: 'texto', texto: 'quero excluir meus dados' })
    expect(pedido).toContainEqual({ tipo: 'estado', estado: { tipo: 'confirmar_exclusao' } })

    const confirmando = { ...c, estado: { tipo: 'confirmar_exclusao' as const } }
    expect(processar(confirmando, { tipo: 'texto', texto: 'Sim' })).toContainEqual({ tipo: 'excluir_dados' })
    const cancelado = processar(confirmando, { tipo: 'texto', texto: 'não' })
    expect(cancelado.some((x) => x.tipo === 'excluir_dados')).toBe(false)
    expect(textos(cancelado)).toEqual(['Tudo bem, nada foi excluído.', 'Para começar, qual é o seu nome completo?'])
  })

  it('sem dados guardados avisa que não há nada', () => {
    expect(textos(processar(ctx(), { tipo: 'texto', texto: 'excluir meus dados' }))[0]).toContain('Não encontramos')
  })
})
