package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// DefaultPostLimit is how many posts ListPosts returns when the filter names
// no limit.
const DefaultPostLimit = 200

// Post is a note that waits for no answer: from a session to the human
// (FromSession set) or the human's own note (FromSession empty). Labels are
// the writer's labels when it was written; Attachments are file paths, URLs
// or artifact references, stored as given. The daemon stores and lists posts
// and never interprets them. A post outlives its session.
type Post struct {
	ID          int64
	FromSession string
	Labels      map[string]string
	Body        string
	Attachments []string
	CreatedAt   int64
}

// PostFilter narrows ListPosts. After returns only posts with a greater id,
// so the last id seen works as a cursor; Limit 0 means DefaultPostLimit.
// Empty From and Labels do not filter.
type PostFilter struct {
	Labels map[string]string
	From   string
	After  int64
	Limit  int
}

const postColumns = `id, from_session, labels, body, attachments, created_at`

// AddPost stores a new post and returns its id. Ids grow in the order posts
// are committed (SQLite has one writer at a time), so a reader that pages
// with PostFilter.After never skips a post written while it reads.
func (s *Store) AddPost(p Post) (int64, error) {
	if p.CreatedAt == 0 {
		p.CreatedAt = time.Now().Unix()
	}
	labels, err := json.Marshal(nonNilMap(p.Labels))
	if err != nil {
		return 0, err
	}
	attachments, err := json.Marshal(nonNilList(p.Attachments))
	if err != nil {
		return 0, err
	}
	res, err := s.db.Exec(`INSERT INTO posts (from_session, labels, body, attachments, created_at) VALUES (?, ?, ?, ?, ?)`,
		p.FromSession, string(labels), p.Body, string(attachments), p.CreatedAt)
	if err != nil {
		return 0, fmt.Errorf("insert post: %w", err)
	}
	return res.LastInsertId()
}

// GetPost returns one post, or ErrNotFound.
func (s *Store) GetPost(id int64) (Post, error) {
	return scanPost(s.db.QueryRow(`SELECT `+postColumns+` FROM posts WHERE id = ?`, id))
}

// ListPosts returns at most f.Limit posts matching f, oldest first.
func (s *Store) ListPosts(f PostFilter) ([]Post, error) {
	limit := f.Limit
	if limit <= 0 {
		limit = DefaultPostLimit
	}
	conds := []string{`id > ?`}
	args := []any{f.After}
	if f.From != "" {
		conds = append(conds, `from_session = ?`)
		args = append(args, f.From)
	}
	rows, err := s.db.Query(`SELECT `+postColumns+` FROM posts WHERE `+strings.Join(conds, ` AND `)+` ORDER BY id`, args...)
	if err != nil {
		return nil, fmt.Errorf("query posts: %w", err)
	}
	defer rows.Close()
	out := []Post{}
	for rows.Next() && len(out) < limit {
		p, err := scanPost(rows)
		if err != nil {
			return nil, err
		}
		if hasLabels(p.Labels, f.Labels) {
			out = append(out, p)
		}
	}
	return out, rows.Err()
}

func scanPost(row interface{ Scan(...any) error }) (Post, error) {
	var p Post
	var labels, attachments string
	err := row.Scan(&p.ID, &p.FromSession, &labels, &p.Body, &attachments, &p.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Post{}, ErrNotFound
	}
	if err != nil {
		return Post{}, fmt.Errorf("scan post: %w", err)
	}
	p.Labels, p.Attachments = map[string]string{}, []string{}
	if err := json.Unmarshal([]byte(labels), &p.Labels); err != nil {
		return Post{}, fmt.Errorf("unmarshal post %d: %w", p.ID, err)
	}
	if err := json.Unmarshal([]byte(attachments), &p.Attachments); err != nil {
		return Post{}, fmt.Errorf("unmarshal post %d: %w", p.ID, err)
	}
	return p, nil
}
