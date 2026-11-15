package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Session is one tmux session running one agent in one folder.
// WorktreePath is the folder; its column and JSON key are `dir`.
type Session struct {
	ID                string
	ParentID          string
	WorktreePath      string
	TmuxName          string
	Labels            map[string]string
	Agent             string
	Profile           string
	Model             string
	Effort            string
	State             string
	Activity          string
	ActivityTS        int64
	Prompt            string
	SystemPrompt      string
	PermissionMode    string
	Env               map[string]string
	PendingQuiz       string
	DeliveryTransport string
	DeliveryInstance  string
	DeliveryEndpoint  string
	CreatedAt         int64
	UpdatedAt         int64
}

// SessionFilter narrows ListSessions. All == false returns only spawning and
// running sessions; every non-empty field narrows further. A session matches
// Labels when it carries every given pair.
type SessionFilter struct {
	Parent string
	Labels map[string]string
	State  string
	All    bool
}

const sessionColumns = `id, parent_id, dir, tmux_name, labels, agent, profile, model, effort,
	state, activity, activity_ts, prompt, system_prompt, permission_mode, env, pending_quiz,
	delivery_transport, delivery_instance, delivery_endpoint, created_at, updated_at`

// AddSession inserts a new session. Returns ErrExists if the id is already taken.
func (s *Store) AddSession(sess Session) error {
	now := time.Now().Unix()
	if sess.CreatedAt == 0 {
		sess.CreatedAt = now
	}
	if sess.UpdatedAt == 0 {
		sess.UpdatedAt = sess.CreatedAt
	}
	labels, env, err := marshalSessionMaps(sess)
	if err != nil {
		return err
	}

	_, err = s.db.Exec(
		`INSERT INTO sessions (`+sessionColumns+`)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		sess.ID, nullIfEmpty(sess.ParentID), sess.WorktreePath, sess.TmuxName, labels,
		sess.Agent, sess.Profile, sess.Model, sess.Effort,
		sess.State, sess.Activity, sess.ActivityTS, sess.Prompt, sess.SystemPrompt,
		sess.PermissionMode, env, nullIfEmpty(sess.PendingQuiz),
		sess.DeliveryTransport, sess.DeliveryInstance, sess.DeliveryEndpoint,
		sess.CreatedAt, sess.UpdatedAt,
	)
	if isUniqueViolation(err) {
		return ErrExists
	}
	if err != nil {
		return fmt.Errorf("insert session: %w", err)
	}
	return nil
}

// GetSession returns the session with the given id, or ErrNotFound.
func (s *Store) GetSession(id string) (Session, error) {
	row := s.db.QueryRow(`SELECT `+sessionColumns+` FROM sessions WHERE id = ?`, id)
	return scanSession(row)
}

// ListSessions returns sessions matching the filter, ordered by created_at, id.
// Label filtering is done in Go after the query.
func (s *Store) ListSessions(f SessionFilter) ([]Session, error) {
	query := `SELECT ` + sessionColumns + ` FROM sessions`

	var conds []string
	var args []any

	if !f.All {
		conds = append(conds, `state IN ('spawning', 'running')`)
	}
	if f.Parent != "" {
		conds = append(conds, `parent_id = ?`)
		args = append(args, f.Parent)
	}
	if f.State != "" {
		conds = append(conds, `state = ?`)
		args = append(args, f.State)
	}

	if len(conds) > 0 {
		query += " WHERE " + strings.Join(conds, " AND ")
	}
	query += " ORDER BY created_at, id"

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("query sessions: %w", err)
	}
	defer rows.Close()

	var out []Session
	for rows.Next() {
		sess, err := scanSession(rows)
		if err != nil {
			return nil, err
		}
		if !hasLabels(sess.Labels, f.Labels) {
			continue
		}
		out = append(out, sess)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func hasLabels(have, want map[string]string) bool {
	for k, v := range want {
		if got, ok := have[k]; !ok || got != v {
			return false
		}
	}
	return true
}

// UpdateSessionState updates a session's state and refreshes updated_at.
// Returns ErrNotFound if the session doesn't exist.
func (s *Store) UpdateSessionState(id, state string) error {
	res, err := s.db.Exec(
		`UPDATE sessions SET state = ?, updated_at = ? WHERE id = ?`,
		state, time.Now().Unix(), id,
	)
	if err != nil {
		return fmt.Errorf("update session state: %w", err)
	}
	return checkRowsAffected(res)
}

// UpdateSession updates the full mutable session row and refreshes updated_at.
// Returns ErrNotFound if the session doesn't exist.
func (s *Store) UpdateSession(sess Session) error {
	labels, env, err := marshalSessionMaps(sess)
	if err != nil {
		return err
	}
	res, err := s.db.Exec(
		`UPDATE sessions SET
			parent_id = ?, dir = ?, tmux_name = ?, labels = ?, agent = ?,
			profile = ?, model = ?, effort = ?, state = ?, activity = ?, activity_ts = ?,
			prompt = ?, system_prompt = ?, permission_mode = ?, env = ?, pending_quiz = ?,
			delivery_transport = ?, delivery_instance = ?, delivery_endpoint = ?,
			updated_at = ?
		 WHERE id = ?`,
		nullIfEmpty(sess.ParentID), sess.WorktreePath, sess.TmuxName, labels, sess.Agent,
		sess.Profile, sess.Model, sess.Effort, sess.State, sess.Activity, sess.ActivityTS,
		sess.Prompt, sess.SystemPrompt, sess.PermissionMode, env, nullIfEmpty(sess.PendingQuiz),
		sess.DeliveryTransport, sess.DeliveryInstance, sess.DeliveryEndpoint,
		time.Now().Unix(), sess.ID,
	)
	if err != nil {
		return fmt.Errorf("update session: %w", err)
	}
	return checkRowsAffected(res)
}

func (s *Store) UpdateSessionDelivery(id, transport, instance, endpoint string) error {
	res, err := s.db.Exec(
		`UPDATE sessions SET delivery_transport = ?, delivery_instance = ?, delivery_endpoint = ?, updated_at = ? WHERE id = ?`,
		transport, instance, endpoint, time.Now().Unix(), id,
	)
	if err != nil {
		return fmt.Errorf("update session delivery: %w", err)
	}
	return checkRowsAffected(res)
}

// UpdateSessionActivity updates a session's activity, activity_ts, and refreshes updated_at.
// Returns ErrNotFound if the session doesn't exist.
func (s *Store) UpdateSessionActivity(id, state string, ts int64) error {
	// The columns are NOT NULL here, so "no activity" is stored as '' and 0
	// instead of rocket's NULL; GetSession reads both the same way.
	res, err := s.db.Exec(
		`UPDATE sessions SET activity = ?, activity_ts = ?, updated_at = ? WHERE id = ?`,
		state, ts, time.Now().Unix(), id,
	)
	if err != nil {
		return fmt.Errorf("update session activity: %w", err)
	}
	return checkRowsAffected(res)
}

// SetPendingQuiz stores the JSON-encoded pending AskUserQuestion quiz for a
// session and refreshes updated_at. Returns ErrNotFound if the session
// doesn't exist.
func (s *Store) SetPendingQuiz(id string, quizJSON string) error {
	res, err := s.db.Exec(
		`UPDATE sessions SET pending_quiz = ?, updated_at = ? WHERE id = ?`,
		nullIfEmpty(quizJSON), time.Now().Unix(), id,
	)
	if err != nil {
		return fmt.Errorf("set pending quiz: %w", err)
	}
	return checkRowsAffected(res)
}

// ClearPendingQuiz removes any pending quiz for a session and refreshes
// updated_at. Returns ErrNotFound if the session doesn't exist. Clearing a
// session that has no pending quiz is a no-op (idempotent).
func (s *Store) ClearPendingQuiz(id string) error {
	res, err := s.db.Exec(
		`UPDATE sessions SET pending_quiz = NULL, updated_at = ? WHERE id = ?`,
		time.Now().Unix(), id,
	)
	if err != nil {
		return fmt.Errorf("clear pending quiz: %w", err)
	}
	return checkRowsAffected(res)
}

// CompareAndSwapPendingQuiz sets a session's pending quiz to newJSON only if
// it currently equals oldJSON ("" meaning none, on either side), refreshing
// updated_at. It reports whether the swap happened; a mismatch is not an
// error. The monitor writes permission quizzes this way so it never
// overwrites a hook quiz that landed between its read and its write.
func (s *Store) CompareAndSwapPendingQuiz(id, oldJSON, newJSON string) (bool, error) {
	res, err := s.db.Exec(
		`UPDATE sessions SET pending_quiz = ?, updated_at = ? WHERE id = ? AND IFNULL(pending_quiz, '') = ?`,
		nullIfEmpty(newJSON), time.Now().Unix(), id, oldJSON,
	)
	if err != nil {
		return false, fmt.Errorf("swap pending quiz: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("swap pending quiz: rows affected: %w", err)
	}
	return n == 1, nil
}

func marshalSessionMaps(sess Session) (labels, env string, err error) {
	if labels, err = marshalStringMap(sess.Labels); err != nil {
		return "", "", fmt.Errorf("marshal labels: %w", err)
	}
	if env, err = marshalStringMap(sess.Env); err != nil {
		return "", "", fmt.Errorf("marshal env: %w", err)
	}
	return labels, env, nil
}

func marshalStringMap(m map[string]string) (string, error) {
	if len(m) == 0 {
		return "{}", nil
	}
	b, err := json.Marshal(m)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func scanSession(row interface{ Scan(...any) error }) (Session, error) {
	var sess Session
	var parentID, pendingQuiz sql.NullString
	var labels, env string

	err := row.Scan(
		&sess.ID, &parentID, &sess.WorktreePath, &sess.TmuxName, &labels,
		&sess.Agent, &sess.Profile, &sess.Model, &sess.Effort,
		&sess.State, &sess.Activity, &sess.ActivityTS, &sess.Prompt, &sess.SystemPrompt,
		&sess.PermissionMode, &env, &pendingQuiz,
		&sess.DeliveryTransport, &sess.DeliveryInstance, &sess.DeliveryEndpoint,
		&sess.CreatedAt, &sess.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return Session{}, ErrNotFound
	}
	if err != nil {
		return Session{}, fmt.Errorf("scan session: %w", err)
	}

	sess.ParentID = parentID.String
	sess.PendingQuiz = pendingQuiz.String
	sess.Labels = map[string]string{}
	if err := json.Unmarshal([]byte(labels), &sess.Labels); err != nil {
		return Session{}, fmt.Errorf("unmarshal labels of %s: %w", sess.ID, err)
	}
	sess.Env = map[string]string{}
	if err := json.Unmarshal([]byte(env), &sess.Env); err != nil {
		return Session{}, fmt.Errorf("unmarshal env of %s: %w", sess.ID, err)
	}

	return sess, nil
}
