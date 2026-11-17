package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Ask statuses.
const (
	AskOpen      = "open"
	AskAnswered  = "answered"
	AskWithdrawn = "withdrawn"
)

var (
	// ErrAskClosed: the ask is no longer open; nothing was changed.
	ErrAskClosed = errors.New("ask is closed")
	// ErrAskInvalid: the answer does not fit the ask (see AnswerAsk).
	ErrAskInvalid = errors.New("invalid answer")
)

// Ask is a decision request: a question to the human from a session (or
// from a module that is not a session, FromSession empty). Labels are free
// context; the daemon stores and filters them and never interprets them.
type Ask struct {
	ID          int64
	FromSession string
	Labels      map[string]string
	Body        string
	Options     []string
	Attachments []string
	Status      string
	Choice      string
	Answer      string
	Reason      string
	CreatedAt   int64
	ClosedAt    int64
}

const askColumns = `id, from_session, labels, body, options, attachments, status, choice, answer, reason, created_at, closed_at`

// AddAsk stores an open ask and returns its id.
func (s *Store) AddAsk(a Ask) (int64, error) {
	if a.CreatedAt == 0 {
		a.CreatedAt = time.Now().Unix()
	}
	labels, err := json.Marshal(nonNilMap(a.Labels))
	if err != nil {
		return 0, err
	}
	options, err := json.Marshal(nonNilList(a.Options))
	if err != nil {
		return 0, err
	}
	attachments, err := json.Marshal(nonNilList(a.Attachments))
	if err != nil {
		return 0, err
	}
	res, err := s.db.Exec(`INSERT INTO asks (from_session, labels, body, options, attachments, status, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, a.FromSession, string(labels), a.Body, string(options), string(attachments), AskOpen, a.CreatedAt)
	if err != nil {
		return 0, fmt.Errorf("insert ask: %w", err)
	}
	return res.LastInsertId()
}

// GetAsk returns one ask, or ErrNotFound.
func (s *Store) GetAsk(id int64) (Ask, error) {
	return scanAsk(s.db.QueryRow(`SELECT `+askColumns+` FROM asks WHERE id = ?`, id))
}

// AskFilter narrows ListAsks; empty fields do not filter.
type AskFilter struct {
	Status string
	From   string
	Labels map[string]string
}

// ListAsks returns asks oldest-first.
func (s *Store) ListAsks(f AskFilter) ([]Ask, error) {
	query := `SELECT ` + askColumns + ` FROM asks`
	var conds []string
	var args []any
	if f.Status != "" {
		conds = append(conds, `status = ?`)
		args = append(args, f.Status)
	}
	if f.From != "" {
		conds = append(conds, `from_session = ?`)
		args = append(args, f.From)
	}
	if len(conds) > 0 {
		query += ` WHERE ` + strings.Join(conds, ` AND `)
	}
	rows, err := s.db.Query(query+` ORDER BY id`, args...)
	if err != nil {
		return nil, fmt.Errorf("query asks: %w", err)
	}
	defer rows.Close()
	var out []Ask
	for rows.Next() {
		a, err := scanAsk(rows)
		if err != nil {
			return nil, err
		}
		if hasLabels(a.Labels, f.Labels) {
			out = append(out, a)
		}
	}
	return out, rows.Err()
}

// AnswerAsk closes an open ask with an answer. With options, choice must be
// exactly one of them and answer is optional; without options, choice must
// be empty and answer text is required (ErrAskInvalid otherwise). An ask that
// is not open is ErrAskClosed and nothing changes; of two concurrent answers
// exactly one wins.
func (s *Store) AnswerAsk(id int64, choice, answer string, now int64) (Ask, error) {
	a, err := s.GetAsk(id)
	if err != nil {
		return Ask{}, err
	}
	if a.Status != AskOpen {
		return Ask{}, ErrAskClosed
	}
	if len(a.Options) > 0 && choice == "" {
		// None of the options fits: the answer is the text alone.
		if strings.TrimSpace(answer) == "" {
			return Ask{}, fmt.Errorf("%w: choose one of %q, or answer with text", ErrAskInvalid, a.Options)
		}
	} else if len(a.Options) > 0 {
		listed := false
		for _, o := range a.Options {
			if o == choice {
				listed = true
			}
		}
		if !listed {
			return Ask{}, fmt.Errorf("%w: choice must be one of %q", ErrAskInvalid, a.Options)
		}
	} else {
		if choice != "" {
			return Ask{}, fmt.Errorf("%w: this ask has no options; answer with text", ErrAskInvalid)
		}
		if strings.TrimSpace(answer) == "" {
			return Ask{}, fmt.Errorf("%w: an answer text is required", ErrAskInvalid)
		}
	}
	return s.closeAsk(`status = 'answered', choice = ?, answer = ?, closed_at = ?`, id, choice, answer, now)
}

// ReasonDismissed is the reason of an ask the human closed without an
// answer (it stays "withdrawn": closed, no answer).
const ReasonDismissed = "dismissed"

// WithdrawAsk closes an open ask without an answer.
func (s *Store) WithdrawAsk(id int64, reason string, now int64) (Ask, error) {
	return s.closeAsk(`status = 'withdrawn', reason = ?, closed_at = ?`, id, reason, now)
}

// closeAsk applies set to ask id only while it is open: one UPDATE, so two
// concurrent closes cannot both succeed.
func (s *Store) closeAsk(set string, id int64, args ...any) (Ask, error) {
	row := s.db.QueryRow(`UPDATE asks SET `+set+` WHERE id = ? AND status = 'open' RETURNING `+askColumns, append(args, id)...)
	a, err := scanAsk(row)
	if errors.Is(err, ErrNotFound) {
		if _, gerr := s.GetAsk(id); gerr != nil {
			return Ask{}, gerr
		}
		return Ask{}, ErrAskClosed
	}
	return a, err
}

// WithdrawOpenAsksOf withdraws every open ask of a session with reason and
// returns them.
func (s *Store) WithdrawOpenAsksOf(sessionID, reason string, now int64) ([]Ask, error) {
	rows, err := s.db.Query(`UPDATE asks SET status = 'withdrawn', reason = ?, closed_at = ?
		WHERE from_session = ? AND status = 'open' RETURNING `+askColumns, reason, now, sessionID)
	if err != nil {
		return nil, fmt.Errorf("withdraw asks: %w", err)
	}
	defer rows.Close()
	var out []Ask
	for rows.Next() {
		a, err := scanAsk(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func scanAsk(row interface{ Scan(...any) error }) (Ask, error) {
	var a Ask
	var labels, options, attachments string
	var closed sql.NullInt64
	err := row.Scan(&a.ID, &a.FromSession, &labels, &a.Body, &options, &attachments, &a.Status, &a.Choice, &a.Answer, &a.Reason, &a.CreatedAt, &closed)
	if errors.Is(err, sql.ErrNoRows) {
		return Ask{}, ErrNotFound
	}
	if err != nil {
		return Ask{}, fmt.Errorf("scan ask: %w", err)
	}
	a.ClosedAt = closed.Int64
	a.Labels, a.Options, a.Attachments = map[string]string{}, []string{}, []string{}
	for _, f := range []struct {
		raw string
		dst any
	}{{labels, &a.Labels}, {options, &a.Options}, {attachments, &a.Attachments}} {
		if err := json.Unmarshal([]byte(f.raw), f.dst); err != nil {
			return Ask{}, fmt.Errorf("unmarshal ask %d: %w", a.ID, err)
		}
	}
	return a, nil
}

func nonNilMap(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	return m
}

func nonNilList(l []string) []string {
	if l == nil {
		return []string{}
	}
	return l
}
