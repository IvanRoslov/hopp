-- Decision requests: one question to the human, from a session or a module.
-- No threads and no reopening: a follow-up is a new ask.
CREATE TABLE asks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_session TEXT NOT NULL DEFAULT '',            -- '' when a module that is not a session asks
  labels       TEXT NOT NULL DEFAULT '{}',          -- JSON object: free key=value context, never interpreted
  body         TEXT NOT NULL,
  options      TEXT NOT NULL DEFAULT '[]',          -- JSON array of strings, may be empty
  attachments  TEXT NOT NULL DEFAULT '[]',          -- JSON array of opaque strings (paths or URLs)
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','withdrawn')),
  choice       TEXT NOT NULL DEFAULT '',
  answer       TEXT NOT NULL DEFAULT '',
  reason       TEXT NOT NULL DEFAULT '',            -- why it was withdrawn
  created_at   INTEGER NOT NULL,
  closed_at    INTEGER
);
CREATE INDEX idx_asks_status ON asks(status, id);
CREATE INDEX idx_asks_from ON asks(from_session, status);
