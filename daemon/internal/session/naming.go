package session

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/IvanRoslov/hopp/internal/store"
)

// slugWordRe matches runs of characters that are not lowercase ASCII
// alphanumerics; baseIDFromDir collapses each run to a single "-".
var slugWordRe = regexp.MustCompile(`[^a-z0-9]+`)

// maxBaseIDLen caps a generated id before its "-N" suffix.
const maxBaseIDLen = 40

// baseIDFromDir derives the default id from the last element of dir:
// lowercased, non-alphanumeric runs collapsed to "-", trimmed of "-", cut to
// 40 characters (trimming a "-" the cut leaves at the end), "session" when
// nothing is left.
func baseIDFromDir(dir string) string {
	s := slugWordRe.ReplaceAllString(strings.ToLower(filepath.Base(dir)), "-")
	s = strings.Trim(s, "-")
	if len(s) > maxBaseIDLen {
		s = strings.TrimRight(s[:maxBaseIDLen], "-")
	}
	if s == "" {
		s = "session"
	}
	return s
}

// validID reports whether id may name a session (and its tmux session).
func validID(id string) bool {
	return len(id) <= maxIDLen && idPattern.MatchString(id)
}

// idTaken reports whether id is in the store in any state or is a live tmux
// session name, so hopp never picks the name of a rocket or human session.
func (m *Manager) idTaken(id string, live map[string]bool) (bool, error) {
	if live[id] {
		return true, nil
	}
	if _, err := m.st.GetSession(id); err == nil {
		return true, nil
	} else if !errors.Is(err, store.ErrNotFound) {
		return false, err
	}
	return false, nil
}

// reserveID returns an unused id: base, then base-2, base-3, ...
func (m *Manager) reserveID(ctx context.Context, base string) (string, error) {
	live, err := m.liveNames(ctx)
	if err != nil {
		return "", err
	}
	for i := 1; ; i++ {
		candidate := base
		if i > 1 {
			candidate = fmt.Sprintf("%s-%d", base, i)
		}
		taken, err := m.idTaken(candidate, live)
		if err != nil {
			return "", err
		}
		if !taken {
			return candidate, nil
		}
	}
}
