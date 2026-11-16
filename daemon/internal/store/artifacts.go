package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// ArtifactVersion is one immutable version of a named file the daemon keeps.
// Scope groups names (the root of the publishing session's tree, or a scope
// given); Version counts from 1 per scope and name. Path is where the daemon
// stored the file; Labels are the publisher's labels when published. An
// artifact outlives its sessions.
type ArtifactVersion struct {
	ID          int64
	Scope       string
	Name        string
	Version     int64
	Filename    string
	Mime        string
	Size        int64
	SHA256      string
	Path        string
	FromSession string
	Labels      map[string]string
	CreatedAt   int64
}

// ArtifactFilter narrows ListArtifacts. Without AllVersions only the latest
// version of each scope and name is listed, and Labels filter those latest
// versions. Empty fields do not filter.
type ArtifactFilter struct {
	Scope       string
	Name        string
	Labels      map[string]string
	AllVersions bool
}

const artifactColumns = `id, scope, name, version, filename, mime, size, sha256, path, from_session, labels, created_at`

// PublishArtifact stores a new version of a.Scope/a.Name. Inside one write
// transaction it reads the latest version: when its sha256 equals a.SHA256
// nothing is stored and that version is returned with unchanged true.
// Otherwise place is called with the next version number to put the file
// in place and return its path and an undo; the row is inserted and
// committed, and on any failure after place the undo removes the file, so
// the row and the file exist together or not at all. The transaction holds
// the database's write lock, so two concurrent publishes of one name get
// distinct, consecutive versions.
func (s *Store) PublishArtifact(a ArtifactVersion, place func(version int64) (path string, undo func(), err error)) (_ ArtifactVersion, unchanged bool, err error) {
	if a.CreatedAt == 0 {
		a.CreatedAt = time.Now().Unix()
	}
	labels, err := json.Marshal(nonNilMap(a.Labels))
	if err != nil {
		return ArtifactVersion{}, false, err
	}
	ctx := context.Background()
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return ArtifactVersion{}, false, err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, `BEGIN IMMEDIATE`); err != nil {
		return ArtifactVersion{}, false, fmt.Errorf("begin publish: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			conn.ExecContext(ctx, `ROLLBACK`) //nolint:errcheck // best effort
		}
	}()
	latest, err := scanArtifact(conn.QueryRowContext(ctx, `SELECT `+artifactColumns+` FROM artifact_versions
		WHERE scope = ? AND name = ? ORDER BY version DESC LIMIT 1`, a.Scope, a.Name))
	switch {
	case err == nil && latest.SHA256 == a.SHA256:
		return latest, true, nil
	case err == nil:
		a.Version = latest.Version + 1
	case errors.Is(err, ErrNotFound):
		a.Version = 1
	default:
		return ArtifactVersion{}, false, err
	}
	path, undo, err := place(a.Version)
	if err != nil {
		return ArtifactVersion{}, false, err
	}
	defer func() {
		if !committed && undo != nil {
			undo()
		}
	}()
	a.Path = path
	res, err := conn.ExecContext(ctx, `INSERT INTO artifact_versions (scope, name, version, filename, mime, size, sha256, path, from_session, labels, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, a.Scope, a.Name, a.Version, a.Filename, a.Mime, a.Size, a.SHA256, a.Path, a.FromSession, string(labels), a.CreatedAt)
	if err != nil {
		return ArtifactVersion{}, false, fmt.Errorf("insert artifact version: %w", err)
	}
	if a.ID, err = res.LastInsertId(); err != nil {
		return ArtifactVersion{}, false, err
	}
	if _, err := conn.ExecContext(ctx, `COMMIT`); err != nil {
		return ArtifactVersion{}, false, fmt.Errorf("commit publish: %w", err)
	}
	committed = true
	a.Labels = nonNilMap(a.Labels)
	return a, false, nil
}

// GetArtifact returns one artifact version, or ErrNotFound.
func (s *Store) GetArtifact(id int64) (ArtifactVersion, error) {
	return scanArtifact(s.db.QueryRow(`SELECT `+artifactColumns+` FROM artifact_versions WHERE id = ?`, id))
}

// ListArtifacts returns the artifact versions matching f in the order they
// were published.
func (s *Store) ListArtifacts(f ArtifactFilter) ([]ArtifactVersion, error) {
	query := `SELECT ` + artifactColumns + ` FROM artifact_versions a`
	var conds []string
	var args []any
	if !f.AllVersions {
		conds = append(conds, `version = (SELECT MAX(version) FROM artifact_versions b WHERE b.scope = a.scope AND b.name = a.name)`)
	}
	if f.Scope != "" {
		conds = append(conds, `scope = ?`)
		args = append(args, f.Scope)
	}
	if f.Name != "" {
		conds = append(conds, `name = ?`)
		args = append(args, f.Name)
	}
	if len(conds) > 0 {
		query += ` WHERE ` + strings.Join(conds, ` AND `)
	}
	rows, err := s.db.Query(query+` ORDER BY id`, args...)
	if err != nil {
		return nil, fmt.Errorf("query artifacts: %w", err)
	}
	defer rows.Close()
	out := []ArtifactVersion{}
	for rows.Next() {
		a, err := scanArtifact(rows)
		if err != nil {
			return nil, err
		}
		if hasLabels(a.Labels, f.Labels) {
			out = append(out, a)
		}
	}
	return out, rows.Err()
}

// RootSession returns the top-most ancestor of session id (id itself when
// it has no parent), or ErrNotFound when id is unknown.
func (s *Store) RootSession(id string) (string, error) {
	for range 10000 {
		sess, err := s.GetSession(id)
		if err != nil {
			return "", err
		}
		if sess.ParentID == "" {
			return sess.ID, nil
		}
		id = sess.ParentID
	}
	return "", fmt.Errorf("session %s: parent chain does not end", id)
}

func scanArtifact(row interface{ Scan(...any) error }) (ArtifactVersion, error) {
	var a ArtifactVersion
	var labels string
	err := row.Scan(&a.ID, &a.Scope, &a.Name, &a.Version, &a.Filename, &a.Mime, &a.Size, &a.SHA256, &a.Path, &a.FromSession, &labels, &a.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return ArtifactVersion{}, ErrNotFound
	}
	if err != nil {
		return ArtifactVersion{}, fmt.Errorf("scan artifact: %w", err)
	}
	a.Labels = map[string]string{}
	if err := json.Unmarshal([]byte(labels), &a.Labels); err != nil {
		return ArtifactVersion{}, fmt.Errorf("unmarshal artifact %d: %w", a.ID, err)
	}
	return a, nil
}
