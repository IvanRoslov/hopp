CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES sessions(id),
  dir TEXT NOT NULL,
  tmux_name TEXT NOT NULL,
  labels TEXT NOT NULL DEFAULT '{}',
  agent TEXT NOT NULL,
  profile TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  effort TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  activity TEXT NOT NULL DEFAULT '',
  activity_ts INTEGER NOT NULL DEFAULT 0,
  prompt TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  permission_mode TEXT NOT NULL DEFAULT '',
  env TEXT NOT NULL DEFAULT '{}',
  pending_quiz TEXT,
  delivery_transport TEXT NOT NULL DEFAULT '',
  delivery_instance TEXT NOT NULL DEFAULT '',
  delivery_endpoint TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX sessions_parent ON sessions(parent_id);
CREATE INDEX sessions_state ON sessions(state);

CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  type       TEXT NOT NULL,
  session_id TEXT,
  data       TEXT NOT NULL DEFAULT '{}'    -- JSON
);
CREATE INDEX idx_events_session ON events(session_id, id);
