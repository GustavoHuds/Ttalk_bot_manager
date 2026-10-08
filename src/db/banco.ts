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
  CREATE INDEX saida_grupos_jid ON saida_grupos (numero_id, jid);
  `,
  `
  -- Bot de grupos vira uma entidade própria, separada do número: trocar o chip mantém lojas, comandos,
  -- gestores e grupos ativos (o JID de um grupo não muda com o número). Um número atende um bot só.
  CREATE TABLE bots_grupos (
    id INTEGER PRIMARY KEY,
    nome TEXT NOT NULL,
    numero_id INTEGER UNIQUE REFERENCES numeros (id),
    ativo INTEGER NOT NULL DEFAULT 1,
    criado_em INTEGER NOT NULL
  );
  INSERT INTO bots_grupos (nome, numero_id, ativo, criado_em)
    SELECT nome, id, 1, criado_em FROM numeros WHERE papel = 'grupos' ORDER BY id;

  CREATE TABLE lojas (
    id INTEGER PRIMARY KEY,
    bot_id INTEGER NOT NULL REFERENCES bots_grupos (id) ON DELETE CASCADE,
    nome TEXT NOT NULL COLLATE NOCASE,
    UNIQUE (bot_id, nome)
  );

  -- Só aqui o bot atua. Grupo fora desta tabela: o bot fica em silêncio e nada é guardado.
  CREATE TABLE grupos_ativos (
    bot_id INTEGER NOT NULL REFERENCES bots_grupos (id) ON DELETE CASCADE,
    jid TEXT NOT NULL,
    loja_id INTEGER REFERENCES lojas (id) ON DELETE SET NULL,
    setor TEXT,
    ativado_em INTEGER NOT NULL,
    ativado_por TEXT NOT NULL,
    PRIMARY KEY (bot_id, jid)
  );

  -- Participantes só dos grupos ativos (sem nome, sem mensagem): somem quando o grupo é desativado.
  CREATE TABLE participantes (
    bot_id INTEGER NOT NULL,
    grupo_jid TEXT NOT NULL,
    jid TEXT NOT NULL,
    telefone TEXT,
    lid TEXT,
    admin INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (bot_id, grupo_jid, jid),
    FOREIGN KEY (bot_id, grupo_jid) REFERENCES grupos_ativos (bot_id, jid) ON DELETE CASCADE
  );
  CREATE INDEX participantes_telefone ON participantes (telefone);
  CREATE INDEX participantes_lid ON participantes (lid);

  -- Gestores por bot. Só têm poder depois de confirmar pelo código no privado do bot.
  CREATE TABLE gestores_bot (
    bot_id INTEGER NOT NULL REFERENCES bots_grupos (id) ON DELETE CASCADE,
    funcionario_id INTEGER NOT NULL REFERENCES funcionarios (id) ON DELETE CASCADE,
    codigo TEXT,
    codigo_expira_em INTEGER,
    confirmado_em INTEGER,
    confirmado_jid TEXT,
    divergente_jid TEXT,
    divergente_telefone TEXT,
    divergente_em INTEGER,
    adicionado_por TEXT NOT NULL,
    adicionado_em INTEGER NOT NULL,
    PRIMARY KEY (bot_id, funcionario_id)
  );
  CREATE UNIQUE INDEX gestores_bot_codigo ON gestores_bot (bot_id, codigo) WHERE codigo IS NOT NULL;
  INSERT INTO gestores_bot (bot_id, funcionario_id, adicionado_por, adicionado_em)
    SELECT (SELECT MIN(id) FROM bots_grupos), funcionario_id, adicionado_por, adicionado_em
    FROM gestores WHERE (SELECT MIN(id) FROM bots_grupos) IS NOT NULL;
  DROP TABLE gestores;

  -- Ajustes dos comandos prontos (ligado, textos editados) e comandos personalizados de cada bot.
  CREATE TABLE comandos_bot (
    bot_id INTEGER NOT NULL REFERENCES bots_grupos (id) ON DELETE CASCADE,
    nome TEXT NOT NULL,
    ligado INTEGER NOT NULL DEFAULT 1,
    personalizado INTEGER NOT NULL DEFAULT 0,
    quem TEXT CHECK (quem IN ('todos', 'gestores')),
    onde TEXT CHECK (onde IN ('grupo', 'privado', 'ambos')),
    descricao TEXT,
    resposta TEXT,
    textos TEXT,
    PRIMARY KEY (bot_id, nome)
  );

  ALTER TABLE funcionarios ADD COLUMN confirmado_em INTEGER;
  ALTER TABLE grupos DROP COLUMN setor;
  ALTER TABLE grupos DROP COLUMN loja;
  ALTER TABLE auditoria ADD COLUMN funcionario_id INTEGER;
  CREATE INDEX auditoria_funcionario ON auditoria (funcionario_id) WHERE funcionario_id IS NOT NULL;
  `,
  `
  -- Pausado: o número continua conectado, mas o bot não lê nem envia nada.
  ALTER TABLE numeros ADD COLUMN pausado INTEGER NOT NULL DEFAULT 0;

  -- /banword: mensagem com uma destas palavras é apagada (o bot precisa ser admin).
  CREATE TABLE palavras_proibidas (
    bot_id INTEGER NOT NULL,
    jid TEXT NOT NULL,
    palavra TEXT NOT NULL,
    PRIMARY KEY (bot_id, jid, palavra),
    FOREIGN KEY (bot_id, jid) REFERENCES grupos_ativos (bot_id, jid) ON DELETE CASCADE
  );

  -- /mutegroup: grupo fechado (só admins falam). Sem horário = até o /unmute; com horário = todo dia.
  CREATE TABLE silencios (
    bot_id INTEGER NOT NULL,
    jid TEXT NOT NULL,
    inicio TEXT,
    fim TEXT,
    -- O que o bot aplicou por último no WhatsApp: 1 fechado, 0 aberto, NULL nada ainda.
    fechado INTEGER,
    criado_por TEXT NOT NULL,
    criado_em INTEGER NOT NULL,
    PRIMARY KEY (bot_id, jid),
    FOREIGN KEY (bot_id, jid) REFERENCES grupos_ativos (bot_id, jid) ON DELETE CASCADE
  );

  -- Mensagens programadas (painel) e repetições (/repeat). Horários no fuso de Brasília.
  CREATE TABLE programadas (
    id INTEGER PRIMARY KEY,
    bot_id INTEGER NOT NULL,
    jid TEXT NOT NULL,
    origem TEXT NOT NULL CHECK (origem IN ('painel', 'repeat')),
    horarios TEXT NOT NULL,
    dias TEXT NOT NULL,
    data TEXT,
    variar INTEGER NOT NULL DEFAULT 0,
    mencionar INTEGER NOT NULL DEFAULT 0,
    ativa INTEGER NOT NULL DEFAULT 1,
    ultimo_envio INTEGER,
    ultima_variacao INTEGER,
    criado_por TEXT NOT NULL,
    criado_em INTEGER NOT NULL,
    FOREIGN KEY (bot_id, jid) REFERENCES grupos_ativos (bot_id, jid) ON DELETE CASCADE
  );
  CREATE INDEX programadas_bot ON programadas (bot_id, ativa);
  CREATE TABLE programadas_msgs (
    programada_id INTEGER NOT NULL REFERENCES programadas (id) ON DELETE CASCADE,
    ordem INTEGER NOT NULL,
    texto TEXT,
    midia TEXT,
    midia_tipo TEXT CHECK (midia_tipo IN ('imagem', 'video', 'audio', 'documento')),
    mimetype TEXT,
    nome_arquivo TEXT,
    PRIMARY KEY (programada_id, ordem)
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
