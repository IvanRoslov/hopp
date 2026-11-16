-- The folders a session may launch sessions in, as a JSON list of absolute
-- paths; an empty list means no limit. New in hopp, not ported from rocket.

ALTER TABLE sessions ADD COLUMN spawn_dirs TEXT NOT NULL DEFAULT '[]';
