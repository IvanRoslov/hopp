-- Artifact versions: a named file the daemon keeps in immutable versions,
-- in a scope (the root session of the publisher, or one given). The file
-- lives at path, under $HOPP_HOME/artifacts. No foreign key on from_session
-- or scope: an artifact outlives its sessions.
CREATE TABLE artifact_versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  scope        TEXT NOT NULL,
  name         TEXT NOT NULL,
  version      INTEGER NOT NULL,
  filename     TEXT NOT NULL,
  mime         TEXT NOT NULL DEFAULT '',
  size         INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  path         TEXT NOT NULL,
  from_session TEXT NOT NULL DEFAULT '',
  labels       TEXT NOT NULL DEFAULT '{}',          -- JSON object, the publisher's labels when published
  created_at   INTEGER NOT NULL,
  UNIQUE (scope, name, version)
);
