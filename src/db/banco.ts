import Database from 'better-sqlite3'

export type Banco = Database.Database

export const MIGRACOES: string[] = [
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
  `,
  `
  -- Números de WhatsApp. Nunca são apagados (só desativados): por isso as colunas numero_id abaixo
  -- não têm REFERENCES (o SQLite não aceita ADD COLUMN com REFERENCES e DEFAULT 1 com as FKs ligadas).
  CREATE TABLE numeros (
    id INTEGER PRIMARY KEY,
    nome TEXT NOT NULL,
    papel TEXT NOT NULL CHECK (papel IN ('recrutamento', 'grupos')),
    ativo INTEGER NOT NULL DEFAULT 1,
    criado_em INTEGER NOT NULL
  );
  INSERT INTO numeros (id, nome, papel, ativo, criado_em) VALUES (1, 'Principal', 'recrutamento', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000);

  ALTER TABLE processos ADD COLUMN numero_id INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE candidaturas ADD COLUMN numero_id INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE saida ADD COLUMN numero_id INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE enquetes ADD COLUMN numero_id INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE enviadas ADD COLUMN numero_id INTEGER NOT NULL DEFAULT 1;
  CREATE INDEX candidaturas_numero_jid ON candidaturas (numero_id, jid);
  CREATE INDEX saida_numero ON saida (numero_id, proxima_em);

  -- A mesma pessoa pode conversar com dois números.
  CREATE TABLE conversas_nova (
    numero_id INTEGER NOT NULL,
    jid TEXT NOT NULL,
    candidatura_id INTEGER REFERENCES candidaturas (id) ON DELETE SET NULL,
    estado TEXT,
    ultima_recebida INTEGER NOT NULL,
    PRIMARY KEY (numero_id, jid)
  );
  INSERT INTO conversas_nova (numero_id, jid, candidatura_id, estado, ultima_recebida)
    SELECT 1, jid, candidatura_id, estado, ultima_recebida FROM conversas;
  DROP TABLE conversas;
  ALTER TABLE conversas_nova RENAME TO conversas;

  -- O mesmo ID de mensagem chega a dois números quando os dois estão no mesmo grupo.
  CREATE TABLE mensagens_nova (
    numero_id INTEGER NOT NULL,
    id TEXT NOT NULL,
    jid TEXT NOT NULL,
    recebida_em INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pendente', 'processada', 'erro')),
    tentativas INTEGER NOT NULL DEFAULT 0,
    payload TEXT,
    PRIMARY KEY (numero_id, id)
  );
  INSERT INTO mensagens_nova (numero_id, id, jid, recebida_em, status, tentativas, payload)
    SELECT 1, id, jid, recebida_em, status, tentativas, payload FROM mensagens_processadas;
  DROP TABLE mensagens_processadas;
  ALTER TABLE mensagens_nova RENAME TO mensagens_processadas;
  CREATE INDEX mensagens_pendentes ON mensagens_processadas (status) WHERE status = 'pendente';
  `,
  `
  -- Bot de grupos: grupos de cada número, cadastro da equipe, gestores e caixa de saída própria.
  CREATE TABLE grupos (
    numero_id INTEGER NOT NULL REFERENCES numeros (id),
    jid TEXT NOT NULL,
    nome TEXT NOT NULL,
    bot_admin INTEGER NOT NULL DEFAULT 0,
    setor TEXT,
    loja TEXT,
    ativo INTEGER NOT NULL DEFAULT 1,
    atualizado_em INTEGER NOT NULL,
    PRIMARY KEY (numero_id, jid)
  );

  CREATE TABLE funcionarios (
    id INTEGER PRIMARY KEY,
    nome TEXT NOT NULL,
    telefone TEXT UNIQUE,
    lid TEXT UNIQUE,
    setor TEXT,
    loja TEXT,
    cargo TEXT,
    nascimento TEXT,
    ativo INTEGER NOT NULL DEFAULT 1,
    criado_em INTEGER NOT NULL,
    atualizado_em INTEGER NOT NULL
  );

  -- Gestores valem para todos os números de grupos. Ser admin no WhatsApp não dá poder no bot.
  CREATE TABLE gestores (
    funcionario_id INTEGER PRIMARY KEY REFERENCES funcionarios (id) ON DELETE CASCADE,
    adicionado_por TEXT NOT NULL,
    adicionado_em INTEGER NOT NULL
  );

  CREATE TABLE saida_grupos (
    id INTEGER PRIMARY KEY,
    numero_id INTEGER NOT NULL REFERENCES numeros (id),
    jid TEXT NOT NULL,
    conteudo TEXT NOT NULL,
    criada_em INTEGER NOT NULL,
    tentativas INTEGER NOT NULL DEFAULT 0,
    proxima_em INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX saida_grupos_numero ON saida_grupos (numero_id, proxima_em);
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

/** Aplica as migrações que faltam, cada uma na sua transação. `alvo` serve aos testes de migração. */
export function migrar(db: Banco, alvo = MIGRACOES.length): void {
  const versao = db.pragma('user_version', { simple: true }) as number
  for (let v = versao; v < alvo; v++) {
    db.transaction(() => {
      db.exec(MIGRACOES[v]!)
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
}
