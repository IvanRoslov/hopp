-- Posts: a note that waits for no answer, from a session to the human or,
-- with an empty from_session, the human's own note. The daemon stores and
-- lists them and never interprets them. No foreign key on from_session: a
-- post outlives its session.
CREATE TABLE posts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_session TEXT NOT NULL DEFAULT '',
  labels       TEXT NOT NULL DEFAULT '{}',          -- JSON object, the writer's labels when written
  body         TEXT NOT NULL,
  attachments  TEXT NOT NULL DEFAULT '[]',          -- JSON list of strings, stored as given
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_posts_from ON posts(from_session, id);
