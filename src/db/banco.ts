import Database from 'better-sqlite3'

export type Banco = Database.Database

const MIGRACOES: string[] = [
  `
  CREATE TABLE candidaturas (
    id INTEGER PRIMARY KEY,
    processo TEXT NOT NULL,
    protocolo TEXT NOT NULL UNIQUE,
    jid TEXT NOT NULL,
    telefone TEXT,
    lid TEXT,
    passo TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('em_andamento', 'concluida')),
    lote INTEGER NOT NULL DEFAULT 1,
    finalizar_em INTEGER,
    criada_em INTEGER NOT NULL,
    atualizada_em INTEGER NOT NULL,
    ultima_interacao INTEGER NOT NULL,
    concluida_em INTEGER,
    UNIQUE (processo, jid)
  );
  CREATE INDEX candidaturas_jid ON candidaturas (jid);
  CREATE INDEX candidaturas_finalizar ON candidaturas (finalizar_em) WHERE finalizar_em IS NOT NULL;

  CREATE TABLE respostas (
    candidatura_id INTEGER NOT NULL REFERENCES candidaturas (id) ON DELETE CASCADE,
    chave TEXT NOT NULL,
    valor TEXT NOT NULL,
    respondida_em INTEGER NOT NULL,
    PRIMARY KEY (candidatura_id, chave)
  );

  CREATE TABLE arquivos (
    id INTEGER PRIMARY KEY,
    candidatura_id INTEGER NOT NULL REFERENCES candidaturas (id) ON DELETE CASCADE,
    lote INTEGER NOT NULL,
    caminho TEXT NOT NULL,
    ext TEXT NOT NULL,
    mimetype TEXT NOT NULL,
    tamanho INTEGER NOT NULL,
    hash TEXT NOT NULL,
    recebido_em INTEGER NOT NULL
  );
  CREATE INDEX arquivos_candidatura ON arquivos (candidatura_id, lote);

  -- Estado por contato, antes ou ao lado de uma candidatura.
  CREATE TABLE conversas (
    jid TEXT PRIMARY KEY,
    candidatura_id INTEGER REFERENCES candidaturas (id) ON DELETE SET NULL,
    estado TEXT,
    ultima_recebida INTEGER NOT NULL
  );

  -- Caixa de entrada: a mensagem é gravada antes de ser processada.
  CREATE TABLE mensagens_processadas (
    id TEXT PRIMARY KEY,
    jid TEXT NOT NULL,
    recebida_em INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pendente', 'processada', 'erro')),
    tentativas INTEGER NOT NULL DEFAULT 0,
    payload TEXT
  );
  CREATE INDEX mensagens_pendentes ON mensagens_processadas (status) WHERE status = 'pendente';

  -- Caixa de saída: respostas gravadas na mesma transação que muda o estado.
  CREATE TABLE saida (
    id INTEGER PRIMARY KEY,
    jid TEXT NOT NULL,
    conteudo TEXT NOT NULL,
    criada_em INTEGER NOT NULL,
    tentativas INTEGER NOT NULL DEFAULT 0,
    proxima_em INTEGER NOT NULL DEFAULT 0
  );

  -- Enquetes enviadas, para decifrar os votos.
  CREATE TABLE enquetes (
    id TEXT PRIMARY KEY,
    jid TEXT NOT NULL,
    chave TEXT NOT NULL,
    opcoes TEXT NOT NULL,
    segredo BLOB NOT NULL,
    criada_em INTEGER NOT NULL
  );

  -- Conteúdo das mensagens enviadas, para o WhatsApp pedir reenvio (getMessage).
  CREATE TABLE enviadas (
    id TEXT PRIMARY KEY,
    conteudo TEXT NOT NULL,
    criada_em INTEGER NOT NULL
  );

  CREATE TABLE contadores (
    processo TEXT PRIMARY KEY,
    ultimo INTEGER NOT NULL
  );

  CREATE TABLE auditoria (
    id INTEGER PRIMARY KEY,
    em INTEGER NOT NULL,
    usuario TEXT NOT NULL,
    acao TEXT NOT NULL,
    detalhe TEXT
  );

  CREATE TABLE meta (
    chave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
  );
  `,
  `
  -- Bots (um por vaga), criados e editados pelo painel. "dados" tem o mesmo formato do antigo YAML.
  CREATE TABLE processos (
    codigo TEXT PRIMARY KEY,
    dados TEXT NOT NULL,
    criado_em INTEGER NOT NULL,
    atualizado_em INTEGER NOT NULL,
    atualizado_por TEXT NOT NULL
  );
  `
]

export function abrirBanco(caminho: string): Banco {
  const db = new Database(caminho)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  migrar(db)
  return db
}

function migrar(db: Banco): void {
  const versao = db.pragma('user_version', { simple: true }) as number
  for (let v = versao; v < MIGRACOES.length; v++) {
    db.transaction(() => {
      db.exec(MIGRACOES[v]!)
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
}
