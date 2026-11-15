-- Named mailboxes: a registered name that holds mail while no live session
-- has that id. mailbox_messages is rocket's agent_inbox (migration 0008) with
-- agent_id renamed to mailbox and from_id to from_session.

CREATE TABLE mailboxes (
  name       TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE mailbox_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  mailbox      TEXT NOT NULL REFERENCES mailboxes(name) ON DELETE CASCADE,
  from_session TEXT NOT NULL DEFAULT '',   -- the sender's session id; '' for a human or the daemon
  body         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread','read')),
  created_at   INTEGER NOT NULL,
  read_at      INTEGER
);

CREATE INDEX idx_mailbox_messages ON mailbox_messages(mailbox, status, id);
