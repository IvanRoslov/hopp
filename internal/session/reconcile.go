package session

import (
	"context"
	"errors"
	"os"

	"github.com/IvanRoslov/hopp/internal/store"
)

// Reconcile compares the store's sessions against the live runtime and
// their folders, marking any mismatches as errored and publishing
// appropriate events. Live tmux sessions that are not in the store are not
// hopp's and are ignored. Errors from store/runtime are collected and
// returned joined, but reconciliation continues for other sessions.
func (m *Manager) Reconcile(ctx context.Context) error {
	// Reconcile also mutates session state, so it shares Spawn/Kill/
	// Restore's mutex for consistency. In practice it runs once at
	// daemon startup before the API begins serving requests, so there is
	// no real contention here.
	m.mu.Lock()
	defer m.mu.Unlock()

	// List all live tmux sessions from runtime
	liveNames, err := m.rt.List(ctx)
	if err != nil {
		return err
	}

	// Build a map of live session names for O(1) lookup
	liveSet := make(map[string]bool, len(liveNames))
	for _, name := range liveNames {
		liveSet[name] = true
	}

	sessions, err := m.st.ListSessions(store.SessionFilter{All: true})
	if err != nil {
		return err
	}

	// Collect errors but continue processing
	var errs []error

	// Check each non-terminal session (spawning, running only)
	for _, sess := range sessions {
		// Skip terminal sessions (killed, done, errored)
		if sess.State != "spawning" && sess.State != "running" {
			continue
		}

		// Check if tmux session exists
		if !liveSet[sess.TmuxName] {
			// Tmux session is missing: mark errored and publish event
			if err := m.st.UpdateSessionState(sess.ID, "errored"); err != nil {
				errs = append(errs, err)
				continue
			}
			_ = m.st.ClearPendingQuiz(sess.ID)
			m.bus.Publish("session.state_changed", sess.ID, map[string]any{
				"from": sess.State, "to": "errored", "reason": "tmux_missing",
			})
			continue
		}

		// Tmux session exists; check if the folder exists
		if _, err := os.Stat(sess.WorktreePath); err != nil {
			if !os.IsNotExist(err) {
				// Some other error (permission, I/O, etc.); collect it but don't fail
				errs = append(errs, err)
				continue
			}
			// The folder is missing: mark errored and publish event
			// Note: we do NOT kill the tmux session
			if err := m.st.UpdateSessionState(sess.ID, "errored"); err != nil {
				errs = append(errs, err)
				continue
			}
			_ = m.st.ClearPendingQuiz(sess.ID)
			m.bus.Publish("session.state_changed", sess.ID, map[string]any{
				"from": sess.State, "to": "errored", "reason": "dir_missing",
			})
		}
		// Session is healthy (tmux alive, folder present): no action
	}

	if len(errs) > 0 {
		return errors.Join(errs...)
	}
	return nil
}
