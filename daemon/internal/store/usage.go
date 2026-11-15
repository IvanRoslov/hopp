package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// SessionStats records the collection state for one session. EndedAt is nil
// for a live snapshot.
type SessionStats struct {
	SessionID   string
	Status      string
	Final       bool
	StartedAt   int64
	EndedAt     *int64
	CollectedAt int64
	Error       string
	Attempts    int
}

type UsageTokens struct {
	Input, CacheWrite, CacheRead, Output, Reasoning, Messages int64
}

type ModelUsage struct {
	Model  string
	Tokens UsageTokens
}

// ReplaceSessionUsage replaces the entire per-model breakdown and collection
// state in one transaction. A failed insert leaves the previous snapshot intact.
func (s *Store) ReplaceSessionUsage(st SessionStats, models []ModelUsage) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin usage replacement: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM session_usage WHERE session_id = ?`, st.SessionID); err != nil {
		return fmt.Errorf("delete session usage: %w", err)
	}
	for _, model := range models {
		v := model.Tokens
		if _, err := tx.Exec(`INSERT INTO session_usage
			(session_id, model, input, cache_write, cache_read, output, reasoning, messages)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, st.SessionID, model.Model,
			v.Input, v.CacheWrite, v.CacheRead, v.Output, v.Reasoning, v.Messages); err != nil {
			return fmt.Errorf("insert model usage %q: %w", model.Model, err)
		}
	}
	if _, err := tx.Exec(`INSERT INTO session_stats
		(session_id, status, final, started_at, ended_at, collected_at, error, attempts)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(session_id) DO UPDATE SET
		 status=excluded.status,
		 final=excluded.final, started_at=excluded.started_at, ended_at=excluded.ended_at,
		 collected_at=excluded.collected_at, error=excluded.error, attempts=excluded.attempts`,
		st.SessionID, st.Status, st.Final,
		st.StartedAt, st.EndedAt, st.CollectedAt, st.Error, st.Attempts); err != nil {
		return fmt.Errorf("upsert session stats: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit usage replacement: %w", err)
	}
	return nil
}

// GetSessionStats returns a session's collection state and per-model rows.
func (s *Store) GetSessionStats(sessionID string) (SessionStats, []ModelUsage, error) {
	var st SessionStats
	var endedAt sql.NullInt64
	err := s.db.QueryRow(`SELECT session_id, status, final,
		started_at, ended_at, collected_at, error, attempts
		FROM session_stats WHERE session_id = ?`, sessionID).Scan(
		&st.SessionID, &st.Status, &st.Final,
		&st.StartedAt, &endedAt, &st.CollectedAt, &st.Error, &st.Attempts)
	if errors.Is(err, sql.ErrNoRows) {
		return SessionStats{}, nil, ErrNotFound
	}
	if err != nil {
		return SessionStats{}, nil, fmt.Errorf("get session stats: %w", err)
	}
	if endedAt.Valid {
		st.EndedAt = &endedAt.Int64
	}
	rows, err := s.db.Query(`SELECT model, input, cache_write, cache_read, output, reasoning, messages
		FROM session_usage WHERE session_id = ? ORDER BY model`, sessionID)
	if err != nil {
		return SessionStats{}, nil, fmt.Errorf("get model usage: %w", err)
	}
	defer rows.Close()
	var models []ModelUsage
	for rows.Next() {
		var model ModelUsage
		v := &model.Tokens
		if err := rows.Scan(&model.Model, &v.Input, &v.CacheWrite, &v.CacheRead,
			&v.Output, &v.Reasoning, &v.Messages); err != nil {
			return SessionStats{}, nil, fmt.Errorf("scan model usage: %w", err)
		}
		models = append(models, model)
	}
	if err := rows.Err(); err != nil {
		return SessionStats{}, nil, fmt.Errorf("iterate model usage: %w", err)
	}
	return st, models, nil
}

// SessionsNeedingUsage selects terminal sessions with no final successful or
// missing result. Errors are retried no more than three times, once per hour.
func (s *Store) SessionsNeedingUsage(limit int, now int64) ([]Session, error) {
	cols := "s." + strings.ReplaceAll(strings.Join(strings.Fields(sessionColumns), " "), ", ", ", s.")
	rows, err := s.db.Query(`SELECT `+cols+`
		FROM sessions s LEFT JOIN session_stats st ON st.session_id = s.id
		WHERE s.state IN ('done', 'killed', 'errored')
		AND (st.session_id IS NULL OR st.final = 0 OR
			(st.status = 'error' AND st.attempts < 3 AND st.collected_at < ?))
		ORDER BY s.created_at, s.id LIMIT ?`, now-3600, limit)
	if err != nil {
		return nil, fmt.Errorf("query sessions needing usage: %w", err)
	}
	defer rows.Close()
	var out []Session
	for rows.Next() {
		sess, err := scanSession(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sess)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate sessions needing usage: %w", err)
	}
	return out, nil
}

// TerminalSessionIDs lists terminal sessions for a manual re-collection.
// includeCollected selects every terminal session whose last result is not
// "missing" (including never-collected ones); includeMissing selects the
// "missing" ones, which the sweeper never retries on its own.
func (s *Store) TerminalSessionIDs(includeCollected, includeMissing bool) ([]string, error) {
	if !includeCollected && !includeMissing {
		return nil, nil
	}
	rows, err := s.db.Query(`SELECT s.id FROM sessions s
		LEFT JOIN session_stats st ON st.session_id = s.id
		WHERE s.state IN ('done', 'killed', 'errored')
		AND ((? AND COALESCE(st.status, '') <> 'missing') OR (? AND st.status = 'missing'))
		ORDER BY s.created_at, s.id`, includeCollected, includeMissing)
	if err != nil {
		return nil, fmt.Errorf("query terminal sessions: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan terminal session: %w", err)
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate terminal sessions: %w", err)
	}
	return out, nil
}

// UsageFilter narrows UsageRows. Empty fields do not filter. From and To
// bound the session's usage time: the end of a final collection, the time of
// a live snapshot, or, before any collection, the session's last update.
type UsageFilter struct {
	Session, Parent string
	Labels          map[string]string
	From, To        int64
}

// UsageRow is one session and model. A session without collected usage, or
// whose collection found nothing or failed, has one row without a model.
type UsageRow struct {
	SessionID   string
	Parent      string
	Labels      map[string]string
	Agent       string
	State       string
	Status      string // "ok", "missing", "error", or "" before any collection
	Error       string
	Final       bool
	StartedAt   int64
	EndedAt     *int64
	CollectedAt int64
	Model       string
	Tokens      UsageTokens
}

// UsageRows returns one row per session and model, ordered by session and
// model.
func (s *Store) UsageRows(f UsageFilter) ([]UsageRow, error) {
	query := `SELECT s.id, COALESCE(s.parent_id,''), s.labels, s.agent, s.state,
		COALESCE(st.status,''), COALESCE(st.error,''), COALESCE(st.final,0),
		COALESCE(st.started_at, s.created_at), st.ended_at, COALESCE(st.collected_at,0),
		COALESCE(u.model,''), COALESCE(u.input,0), COALESCE(u.cache_write,0), COALESCE(u.cache_read,0),
		COALESCE(u.output,0), COALESCE(u.reasoning,0), COALESCE(u.messages,0)
		FROM sessions s
		LEFT JOIN session_stats st ON st.session_id = s.id
		LEFT JOIN session_usage u ON u.session_id = s.id`
	var conds []string
	var args []any
	if f.Session != "" {
		conds = append(conds, `s.id = ?`)
		args = append(args, f.Session)
	}
	if f.Parent != "" {
		conds = append(conds, `s.parent_id = ?`)
		args = append(args, f.Parent)
	}
	const at = `CASE WHEN st.final = 1 THEN st.ended_at WHEN st.session_id IS NOT NULL THEN st.collected_at ELSE s.updated_at END`
	if f.From > 0 {
		conds = append(conds, at+` >= ?`)
		args = append(args, f.From)
	}
	if f.To > 0 {
		conds = append(conds, at+` < ?`)
		args = append(args, f.To)
	}
	if len(conds) > 0 {
		query += ` WHERE ` + strings.Join(conds, ` AND `)
	}
	query += ` ORDER BY s.created_at, s.id, u.model`
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("query usage rows: %w", err)
	}
	defer rows.Close()
	var out []UsageRow
	for rows.Next() {
		var r UsageRow
		var labels string
		var endedAt sql.NullInt64
		v := &r.Tokens
		if err := rows.Scan(&r.SessionID, &r.Parent, &labels, &r.Agent, &r.State,
			&r.Status, &r.Error, &r.Final, &r.StartedAt, &endedAt, &r.CollectedAt,
			&r.Model, &v.Input, &v.CacheWrite, &v.CacheRead, &v.Output, &v.Reasoning, &v.Messages); err != nil {
			return nil, fmt.Errorf("scan usage row: %w", err)
		}
		r.Labels = map[string]string{}
		if err := json.Unmarshal([]byte(labels), &r.Labels); err != nil {
			return nil, fmt.Errorf("unmarshal labels of %s: %w", r.SessionID, err)
		}
		if !hasLabels(r.Labels, f.Labels) {
			continue
		}
		if endedAt.Valid {
			r.EndedAt = &endedAt.Int64
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate usage rows: %w", err)
	}
	return out, nil
}
