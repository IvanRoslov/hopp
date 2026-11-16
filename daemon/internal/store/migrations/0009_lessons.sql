-- Lessons: a note from an agent (or the human) about what would make the
-- harness better. The daemon stores and lists them and never interprets
-- them. No foreign key on from_session: a lesson outlives its session.
CREATE TABLE lessons (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_session TEXT NOT NULL DEFAULT '',
  labels       TEXT NOT NULL DEFAULT '{}',          -- JSON object, the writer's labels when written
  body         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','closed')),
  created_at   INTEGER NOT NULL,
  closed_at    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_lessons_status ON lessons(status, id);
