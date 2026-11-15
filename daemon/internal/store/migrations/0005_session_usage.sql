-- Token usage per session and model, and the collection state per session:
-- rocket's migration 0023 without its task and subtask columns (and their
-- index), the sessions table's task columns and the model_prices table.

CREATE TABLE session_usage (
  session_id  TEXT NOT NULL,
  model       TEXT NOT NULL,
  input       INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  cache_read  INTEGER NOT NULL DEFAULT 0,
  output      INTEGER NOT NULL DEFAULT 0,
  reasoning   INTEGER NOT NULL DEFAULT 0,
  messages    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, model)
);

CREATE TABLE session_stats (
  session_id   TEXT PRIMARY KEY,
  status       TEXT NOT NULL,
  final        INTEGER NOT NULL,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  collected_at INTEGER NOT NULL,
  error        TEXT NOT NULL DEFAULT '',
  attempts     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX session_stats_ended ON session_stats(ended_at);
CREATE INDEX session_stats_collected ON session_stats(collected_at);
