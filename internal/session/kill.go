package session

import (
	"context"
	"errors"
	"log/slog"

	"github.com/IvanRoslov/hopp/internal/runtime"
	"github.com/IvanRoslov/hopp/internal/store"
)

// Kill stops a session and its live descendants, deepest first. final is
// "killed" (publishes session.killed) or "done" (publishes
// session.state_changed to done). A session already in a terminal state
// (killed/done/errored) is left as it is, and that is not an error.
func (m *Manager) Kill(ctx context.Context, id string, final string) error {
	if final != "killed" && final != "done" {
		return validationErr("invalid_state", `final state must be "killed" or "done"`)
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	sess, err := m.st.GetSession(id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return validationErr("session_not_found", "session not found: "+id)
		}
		return err
	}
	all, err := m.st.ListSessions(store.SessionFilter{All: true})
	if err != nil {
		return err
	}
	children := make(map[string][]store.Session)
	for _, s := range all {
		if s.ParentID != "" {
			children[s.ParentID] = append(children[s.ParentID], s)
		}
	}
	return m.killTree(ctx, sess, final, children, map[string]bool{})
}

// killTree stops sess's live descendants first, then sess. seen guards
// against a parent cycle in the store. Callers must hold m.mu.
func (m *Manager) killTree(ctx context.Context, sess store.Session, final string, children map[string][]store.Session, seen map[string]bool) error {
	if seen[sess.ID] {
		return nil
	}
	seen[sess.ID] = true
	for _, child := range children[sess.ID] {
		if isTerminal(child.State) {
			continue
		}
		if err := m.killTree(ctx, child, final, children, seen); err != nil {
			return err
		}
	}
	return m.terminate(ctx, sess, final)
}

// terminate destroys sess's tmux session through the ownership check and
// moves sess to final. A terminal session is left alone. A tmux session that
// is not hopp's is never destroyed: sess becomes errored and the
// tmux_not_owned error is returned. Any other destroy failure is logged and
// the state change still happens, as rocket's best-effort destroy did.
// Callers must hold m.mu.
func (m *Manager) terminate(ctx context.Context, sess store.Session, final string) error {
	if isTerminal(sess.State) {
		return nil
	}
	if err := m.destroyOwned(ctx, sess); err != nil {
		var ve *ValidationError
		if errors.As(err, &ve) {
			return err
		}
		slog.Default().Warn("session: destroy tmux session", "session", sess.ID, "error", err)
	}
	if err := m.st.UpdateSessionState(sess.ID, final); err != nil {
		return err
	}
	// Terminal sessions can't answer a pending quiz, so clear it along
	// with the state transition (best-effort: the transition already
	// happened, and a leftover pending_quiz is harmless clutter, not a
	// correctness issue worth failing the whole call over).
	_ = m.st.ClearPendingQuiz(sess.ID)
	if final == "killed" {
		m.bus.Publish("session.killed", sess.ID, nil)
	} else {
		m.bus.Publish("session.state_changed", sess.ID, map[string]any{"from": sess.State, "to": final})
	}
	return nil
}

// destroyOwned is the only way the manager destroys a tmux session. A tmux
// session that does not exist needs nothing and returns nil. One that exists
// but does not belong to sess is left running: sess is marked errored with
// reason tmux_not_owned and that validation error is returned.
func (m *Manager) destroyOwned(ctx context.Context, sess store.Session) error {
	h := runtime.Handle{Name: sess.TmuxName}
	if !m.rt.Alive(ctx, h) {
		return nil
	}
	owned, err := m.ownerProbe(ctx, sess.TmuxName, sess.ID)
	if err != nil {
		return err
	}
	if !owned {
		_ = m.st.UpdateSessionState(sess.ID, "errored")
		_ = m.st.ClearPendingQuiz(sess.ID)
		m.bus.Publish("session.state_changed", sess.ID, map[string]any{
			"from": sess.State, "to": "errored", "reason": "tmux_not_owned",
		})
		return validationErr("tmux_not_owned",
			"tmux session "+sess.TmuxName+" is not this hopp session's (its HOPP_SESSION_ID differs); it was left running")
	}
	return m.rt.Destroy(ctx, h)
}
