package store

import (
	"fmt"
	"strings"
)

// RemoveSessions deletes the given sessions and everything that belongs to
// them, in one transaction: their claude_launches and permission_prompts
// rows, the messages addressed TO them (with those messages' Claude delivery
// rows and consumed proof records, by ON DELETE CASCADE), and their events.
// Messages they SENT to sessions that remain are kept; their from_session
// keeps the old id as text. The caller checks that removal is allowed
// (session.Manager.Remove): a set whose sessions are referenced as parents
// by a session outside it fails on the sessions table's foreign key.
//
// Why deleting a recipient's Claude proof rows cannot let one journal record
// prove two messages for a session that remains: a Claude delivery's target
// is always the recipient's own launch, so every claude_deliveries row and
// every claude_consumed_records key of a removed recipient carries that
// recipient's own Claude conversation id and journal file. The ambiguity
// checks (ambiguousClaudeProof, crossFileUncertain) and the retention rule
// (protectClaudeHistory) only ever compare rows of the same conversation id,
// envelopes carry unique wire ids, and messages.id is AUTOINCREMENT, so ids
// are never reused. PurgeOld deletes unprotected Claude rows the same way.
func (s *Store) RemoveSessions(ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	marks := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck // no-op if committed
	for _, q := range []string{
		`DELETE FROM messages WHERE to_session IN (` + marks + `)`,
		`DELETE FROM permission_prompts WHERE session_id IN (` + marks + `)`,
		`DELETE FROM claude_launches WHERE session_id IN (` + marks + `)`,
		`DELETE FROM events WHERE session_id IN (` + marks + `)`,
		`DELETE FROM sessions WHERE id IN (` + marks + `)`,
	} {
		if _, err := tx.Exec(q, args...); err != nil {
			return fmt.Errorf("remove sessions: %w", err)
		}
	}
	return tx.Commit()
}

// CountUnsettledMessagesTo reports how many messages addressed to any of ids
// are still queued, delivering or accepted.
func (s *Store) CountUnsettledMessagesTo(ids []string) (int, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	marks := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	var n int
	err := s.db.QueryRow(`SELECT count(*) FROM messages WHERE status IN ('queued','delivering','accepted') AND to_session IN (`+marks+`)`, args...).Scan(&n)
	return n, err
}
