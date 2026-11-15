package store

import (
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// Inbox message statuses. An inbox message is written when a message is
// addressed to a mailbox whose session is not live; the session drains it
// itself with `hopp inbox next` once it is up.
const (
	InboxUnread = "unread"
	InboxRead   = "read"
)

// InboxMessage is one message waiting in a mailbox.
type InboxMessage struct {
	ID      int64
	Mailbox string
	// From is the sender's session id; empty for the human/UI.
	From      string
	Body      string
	Status    string // unread|read
	CreatedAt int64
	ReadAt    int64
}

const inboxColumns = `id, mailbox, from_session, body, status, created_at, read_at`

// AddInboxMessage appends a message to a mailbox and returns its id.
// Status defaults to unread.
func (s *Store) AddInboxMessage(m InboxMessage) (int64, error) {
	if m.Status == "" {
		m.Status = InboxUnread
	}
	if m.CreatedAt == 0 {
		m.CreatedAt = time.Now().Unix()
	}

	res, err := s.db.Exec(
		`INSERT INTO mailbox_messages (mailbox, from_session, body, status, created_at, read_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		m.Mailbox, m.From, m.Body, m.Status, m.CreatedAt, nullIfZero(m.ReadAt),
	)
	if err != nil {
		return 0, fmt.Errorf("insert inbox message: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("inbox message id: %w", err)
	}
	return id, nil
}

// ListInboxMessages returns a mailbox's messages oldest-first. An empty status
// returns every message; limit <= 0 means no limit.
func (s *Store) ListInboxMessages(mailbox, status string, limit int) ([]InboxMessage, error) {
	query := `SELECT ` + inboxColumns + ` FROM mailbox_messages WHERE mailbox = ?`
	args := []any{mailbox}
	if status != "" {
		query += ` AND status = ?`
		args = append(args, status)
	}
	query += ` ORDER BY id`
	if limit > 0 {
		query += ` LIMIT ?`
		args = append(args, limit)
	}

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("query inbox messages: %w", err)
	}
	defer rows.Close()

	var out []InboxMessage
	for rows.Next() {
		m, err := scanInboxMessage(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// GetInboxMessage returns one message by id, or ErrNotFound.
func (s *Store) GetInboxMessage(id int64) (InboxMessage, error) {
	row := s.db.QueryRow(`SELECT `+inboxColumns+` FROM mailbox_messages WHERE id = ?`, id)
	return scanInboxMessage(row)
}

// NextUnreadInboxMessage takes a mailbox's oldest unread message and marks it
// read, atomically: two concurrent `hopp inbox next` calls never hand out the
// same message twice. ok is false when the mailbox holds nothing unread.
//
// One UPDATE ... RETURNING takes the write lock at once. Rocket selected the
// row in a deferred transaction and updated it after; with several takers at
// once SQLite cannot upgrade those read locks and the calls fail with
// SQLITE_BUSY instead of waiting.
func (s *Store) NextUnreadInboxMessage(mailbox string) (InboxMessage, bool, error) {
	row := s.db.QueryRow(
		`UPDATE mailbox_messages SET status = ?, read_at = ?
		 WHERE id = (SELECT id FROM mailbox_messages WHERE mailbox = ? AND status = ? ORDER BY id LIMIT 1)
		 RETURNING `+inboxColumns,
		InboxRead, time.Now().Unix(), mailbox, InboxUnread,
	)
	m, err := scanInboxMessage(row)
	if errors.Is(err, ErrNotFound) {
		return InboxMessage{}, false, nil
	}
	if err != nil {
		return InboxMessage{}, false, fmt.Errorf("take inbox message: %w", err)
	}
	return m, true, nil
}

// CountUnreadInbox returns how many unread messages a mailbox holds.
func (s *Store) CountUnreadInbox(mailbox string) (int, error) {
	var n int
	err := s.db.QueryRow(
		`SELECT COUNT(*) FROM mailbox_messages WHERE mailbox = ? AND status = ?`,
		mailbox, InboxUnread,
	).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("count unread inbox: %w", err)
	}
	return n, nil
}

// MaxUnreadInboxID returns the highest id among a mailbox's unread messages, or
// 0 when it has none. The unread notifier uses it to tell "the same unread pile
// I already announced" from "something new arrived since".
func (s *Store) MaxUnreadInboxID(mailbox string) (int64, error) {
	var id sql.NullInt64
	err := s.db.QueryRow(
		`SELECT MAX(id) FROM mailbox_messages WHERE mailbox = ? AND status = ?`,
		mailbox, InboxUnread,
	).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("max unread inbox id: %w", err)
	}
	if !id.Valid {
		return 0, nil
	}
	return id.Int64, nil
}

func scanInboxMessage(row interface{ Scan(...any) error }) (InboxMessage, error) {
	var m InboxMessage
	var from sql.NullString
	var readAt sql.NullInt64

	err := row.Scan(&m.ID, &m.Mailbox, &from, &m.Body, &m.Status, &m.CreatedAt, &readAt)
	if errors.Is(err, sql.ErrNoRows) {
		return InboxMessage{}, ErrNotFound
	}
	if err != nil {
		return InboxMessage{}, fmt.Errorf("scan inbox message: %w", err)
	}

	m.From = from.String
	m.ReadAt = readAt.Int64
	return m, nil
}

// Mailbox is a registered mailbox name with its message counts.
type Mailbox struct {
	Name          string
	CreatedAt     int64
	Unread, Total int
}

// AddMailbox registers name; ErrExists when it is registered already.
func (s *Store) AddMailbox(name string) error {
	_, err := s.db.Exec(`INSERT INTO mailboxes (name, created_at) VALUES (?, ?)`, name, time.Now().Unix())
	if isUniqueViolation(err) {
		return ErrExists
	}
	if err != nil {
		return fmt.Errorf("insert mailbox: %w", err)
	}
	return nil
}

// RemoveMailbox removes a mailbox and its mail; ErrNotFound when there is
// none of that name.
func (s *Store) RemoveMailbox(name string) error {
	res, err := s.db.Exec(`DELETE FROM mailboxes WHERE name = ?`, name)
	if err != nil {
		return fmt.Errorf("delete mailbox: %w", err)
	}
	return checkRowsAffected(res)
}

// HasMailbox reports whether name is a registered mailbox.
func (s *Store) HasMailbox(name string) (bool, error) {
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM mailboxes WHERE name = ?`, name).Scan(&n); err != nil {
		return false, fmt.Errorf("has mailbox: %w", err)
	}
	return n > 0, nil
}

// ListMailboxes returns every mailbox by name, with unread and total counts.
func (s *Store) ListMailboxes() ([]Mailbox, error) {
	rows, err := s.db.Query(`SELECT b.name, b.created_at,
		COALESCE(SUM(CASE WHEN m.status = 'unread' THEN 1 ELSE 0 END), 0), COUNT(m.id)
		FROM mailboxes b LEFT JOIN mailbox_messages m ON m.mailbox = b.name
		GROUP BY b.name ORDER BY b.name`)
	if err != nil {
		return nil, fmt.Errorf("query mailboxes: %w", err)
	}
	defer rows.Close()
	var out []Mailbox
	for rows.Next() {
		var b Mailbox
		if err := rows.Scan(&b.Name, &b.CreatedAt, &b.Unread, &b.Total); err != nil {
			return nil, fmt.Errorf("scan mailbox: %w", err)
		}
		out = append(out, b)
	}
	return out, rows.Err()
}
