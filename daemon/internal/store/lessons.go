package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Lesson statuses.
const (
	LessonNew    = "new"
	LessonClosed = "closed"
)

// Lesson is a note about what would make the harness better, from a session
// (FromSession) or from the human (FromSession empty). Labels are the
// writer's labels when it was written; the daemon stores and lists lessons
// and never interprets them. A lesson outlives its session.
type Lesson struct {
	ID          int64
	FromSession string
	Labels      map[string]string
	Body        string
	Status      string
	CreatedAt   int64
	ClosedAt    int64
}

// LessonFilter narrows ListLessons. An empty Status means LessonNew and
// "all" means every status; empty From and Labels do not filter.
type LessonFilter struct {
	Status string
	Labels map[string]string
	From   string
}

const lessonColumns = `id, from_session, labels, body, status, created_at, closed_at`

// AddLesson stores a new lesson and returns its id.
func (s *Store) AddLesson(l Lesson) (int64, error) {
	if l.CreatedAt == 0 {
		l.CreatedAt = time.Now().Unix()
	}
	labels, err := json.Marshal(nonNilMap(l.Labels))
	if err != nil {
		return 0, err
	}
	res, err := s.db.Exec(`INSERT INTO lessons (from_session, labels, body, status, created_at) VALUES (?, ?, ?, ?, ?)`,
		l.FromSession, string(labels), l.Body, LessonNew, l.CreatedAt)
	if err != nil {
		return 0, fmt.Errorf("insert lesson: %w", err)
	}
	return res.LastInsertId()
}

// GetLesson returns one lesson, or ErrNotFound.
func (s *Store) GetLesson(id int64) (Lesson, error) {
	return scanLesson(s.db.QueryRow(`SELECT `+lessonColumns+` FROM lessons WHERE id = ?`, id))
}

// ListLessons returns the lessons matching f, oldest first.
func (s *Store) ListLessons(f LessonFilter) ([]Lesson, error) {
	query := `SELECT ` + lessonColumns + ` FROM lessons`
	var conds []string
	var args []any
	switch f.Status {
	case "":
		conds = append(conds, `status = ?`)
		args = append(args, LessonNew)
	case "all":
	default:
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
		return nil, fmt.Errorf("query lessons: %w", err)
	}
	defer rows.Close()
	var out []Lesson
	for rows.Next() {
		l, err := scanLesson(rows)
		if err != nil {
			return nil, err
		}
		if hasLabels(l.Labels, f.Labels) {
			out = append(out, l)
		}
	}
	return out, rows.Err()
}

// CloseLesson marks a lesson closed. ErrNotFound when unknown; closing a
// closed lesson changes nothing.
func (s *Store) CloseLesson(id int64) error {
	res, err := s.db.Exec(`UPDATE lessons SET status = ?, closed_at = ? WHERE id = ? AND status = ?`,
		LessonClosed, time.Now().Unix(), id, LessonNew)
	if err != nil {
		return fmt.Errorf("close lesson: %w", err)
	}
	if n, err := res.RowsAffected(); err != nil || n == 1 {
		return err
	}
	_, err = s.GetLesson(id)
	return err
}

// SetLessonLabels changes a lesson's labels: each key in set gets its value,
// and a key whose value is empty is removed. It returns the lesson as it is
// now; ErrNotFound when unknown.
func (s *Store) SetLessonLabels(id int64, set map[string]string) (Lesson, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return Lesson{}, fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback()
	l, err := scanLesson(tx.QueryRow(`SELECT `+lessonColumns+` FROM lessons WHERE id = ?`, id))
	if err != nil {
		return Lesson{}, err
	}
	for k, v := range set {
		if v == "" {
			delete(l.Labels, k)
		} else {
			l.Labels[k] = v
		}
	}
	raw, err := json.Marshal(nonNilMap(l.Labels))
	if err != nil {
		return Lesson{}, err
	}
	if _, err := tx.Exec(`UPDATE lessons SET labels = ? WHERE id = ?`, string(raw), id); err != nil {
		return Lesson{}, fmt.Errorf("label lesson: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Lesson{}, fmt.Errorf("commit: %w", err)
	}
	return l, nil
}

func scanLesson(row interface{ Scan(...any) error }) (Lesson, error) {
	var l Lesson
	var labels string
	err := row.Scan(&l.ID, &l.FromSession, &labels, &l.Body, &l.Status, &l.CreatedAt, &l.ClosedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Lesson{}, ErrNotFound
	}
	if err != nil {
		return Lesson{}, fmt.Errorf("scan lesson: %w", err)
	}
	l.Labels = map[string]string{}
	if err := json.Unmarshal([]byte(labels), &l.Labels); err != nil {
		return Lesson{}, fmt.Errorf("unmarshal lesson %d: %w", l.ID, err)
	}
	return l, nil
}
