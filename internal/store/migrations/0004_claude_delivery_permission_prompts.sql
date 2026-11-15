-- Claude Code socket delivery, exactly as rocket's migration 0027 creates it
-- (claude_launches is in 0002), and the permission prompt journal as rocket's
-- migration 0017 creates it.
CREATE TABLE claude_deliveries (
 message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
 transport TEXT NOT NULL CHECK(transport='claude-socket-v1'),
 wire_id TEXT NOT NULL UNIQUE,
 snapshot_json TEXT NOT NULL,
 claude_uuid TEXT NOT NULL,
 journal_device INTEGER NOT NULL,
 journal_inode INTEGER NOT NULL,
 journal_path TEXT NOT NULL,
 boundary_offset INTEGER NOT NULL,
 envelope_hash TEXT NOT NULL,
 phase TEXT NOT NULL,
 deadline_ns INTEGER NOT NULL,
 proof_record TEXT,
 proof_offset INTEGER,
 proof_end INTEGER
);
CREATE INDEX claude_history_domain ON claude_deliveries(claude_uuid,journal_device,journal_inode,envelope_hash,boundary_offset);
CREATE INDEX claude_history_cross_file ON claude_deliveries(claude_uuid,envelope_hash,phase);
CREATE TABLE claude_consumed_records (
 target_key TEXT NOT NULL,
 device INTEGER NOT NULL,
 inode INTEGER NOT NULL,
 record_id TEXT NOT NULL,
 message_id INTEGER NOT NULL UNIQUE REFERENCES claude_deliveries(message_id) ON DELETE CASCADE,
 PRIMARY KEY(target_key,device,inode,record_id)
);

-- One-time upgrade provenance. Never recapture at launch/restore/follow.
CREATE TABLE claude_legacy_cutoff (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 through_id INTEGER NOT NULL CHECK(through_id>=0)
);
INSERT INTO claude_legacy_cutoff VALUES(1,(SELECT COALESCE(MAX(id),0) FROM messages));

-- Claude Code permission dialogs the monitor found on a session pane. An open
-- row (resolved_at IS NULL) is a dialog showing now.
CREATE TABLE permission_prompts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL,
    title        TEXT NOT NULL,
    context      TEXT NOT NULL DEFAULT '',
    options_json TEXT NOT NULL DEFAULT '[]',
    asked_at     INTEGER NOT NULL,
    resolved_at  INTEGER,
    answer_label TEXT NOT NULL DEFAULT '',
    answered_via TEXT NOT NULL DEFAULT '',
    sent_at      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX permission_prompts_session ON permission_prompts(session_id, id);
