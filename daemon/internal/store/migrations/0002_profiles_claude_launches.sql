-- The model profile registry: name, agent, model, effort and what the profile
-- is good for. '' in model/effort means the agent's default, and no flag is
-- passed. enabled is the global permission.
CREATE TABLE model_profiles (
  name        TEXT PRIMARY KEY,
  agent       TEXT NOT NULL,
  model       TEXT NOT NULL DEFAULT '',
  effort      TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE claude_launches (
 session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
 generation TEXT NOT NULL UNIQUE,
 launch_json TEXT NOT NULL,
 identity_json TEXT,
 last_event_at INTEGER NOT NULL DEFAULT 0
);
