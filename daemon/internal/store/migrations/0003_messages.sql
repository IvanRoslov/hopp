-- Inter-session messages, with the columns rocket's messages table ends up
-- with after its migrations 0001, 0002, 0024 and 0026.
CREATE TABLE messages (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  from_session        TEXT,                       -- NULL = human/system
  to_session          TEXT NOT NULL,
  body                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'queued',  -- queued|delivering|accepted|delivered|failed
  attempts            INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  delivered_at        INTEGER,
  reason              TEXT,
  inject_at           INTEGER NOT NULL DEFAULT 0,
  delivery_transport  TEXT NOT NULL DEFAULT '',
  delivery_proof_at   INTEGER NOT NULL DEFAULT 0,
  delivery_proof_text TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_messages_to ON messages(to_session, status);
