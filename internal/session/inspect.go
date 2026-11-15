package session

import (
	"context"
	"errors"

	"github.com/IvanRoslov/hopp/internal/runtime"
	"github.com/IvanRoslov/hopp/internal/store"
)

// Output returns the last `lines` lines of the session's runtime pane.
func (m *Manager) Output(ctx context.Context, id string, lines int) (string, error) {
	sess, err := m.st.GetSession(id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return "", validationErr("session_not_found", "session not found: "+id)
		}
		return "", err
	}
	return m.rt.Capture(ctx, runtime.Handle{Name: sess.TmuxName}, lines)
}

// AttachCommand returns the argv a user can run to attach to the session.
func (m *Manager) AttachCommand(id string) ([]string, error) {
	sess, err := m.st.GetSession(id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, validationErr("session_not_found", "session not found: "+id)
		}
		return nil, err
	}
	return m.rt.AttachCommand(runtime.Handle{Name: sess.TmuxName}), nil
}

// Children returns the sessions id launched, in any state.
func (m *Manager) Children(id string) ([]store.Session, error) {
	if _, err := m.st.GetSession(id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, validationErr("session_not_found", "session not found: "+id)
		}
		return nil, err
	}
	return m.st.ListSessions(store.SessionFilter{Parent: id, All: true})
}
