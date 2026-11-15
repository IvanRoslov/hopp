package session

import (
	"context"
	"errors"
	"fmt"

	"github.com/IvanRoslov/hopp/internal/store"
)

// Remove deletes the record of an ended session and returns the ids removed;
// afterwards its id can be used again. Rules, checked before anything is
// deleted:
//   - the session must be terminal (done, killed or errored), else
//     session_live;
//   - a session with descendants in the store needs recursive, else
//     session_has_children; with recursive every descendant must be terminal
//     too, else session_live naming the first live one;
//   - no message addressed to a session of the set may still be queued,
//     delivering or accepted, else session_delivery_pending: something is in
//     flight, so removal waits until it settles.
//
// The whole set is removed in one transaction (store.RemoveSessions), or
// nothing is. The tmux session is never touched: a terminal session has none
// of its own, and Destroy is not called here.
func (m *Manager) Remove(ctx context.Context, id string, recursive bool) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	root, err := m.st.GetSession(id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, validationErr("session_not_found", "session not found: "+id)
		}
		return nil, err
	}
	if !isTerminal(root.State) {
		return nil, validationErr("session_live", fmt.Sprintf("session %q is %s; stop it before removing it", id, root.State))
	}

	// Collect the subtree, parents before children.
	set := []store.Session{root}
	for i := 0; i < len(set); i++ {
		children, err := m.st.ListSessions(store.SessionFilter{Parent: set[i].ID, All: true})
		if err != nil {
			return nil, err
		}
		set = append(set, children...)
	}
	if len(set) > 1 && !recursive {
		return nil, validationErr("session_has_children", fmt.Sprintf("session %q has %d descendants; remove them with it (recursive) or first", id, len(set)-1))
	}
	ids := make([]string, len(set))
	for i, s := range set {
		if !isTerminal(s.State) {
			return nil, validationErr("session_live", fmt.Sprintf("descendant %q of %q is %s; stop it before removing the tree", s.ID, id, s.State))
		}
		ids[i] = s.ID
	}
	n, err := m.st.CountUnsettledMessagesTo(ids)
	if err != nil {
		return nil, err
	}
	if n > 0 {
		return nil, validationErr("session_delivery_pending", fmt.Sprintf("%d message(s) to %q or its descendants are still queued, delivering or accepted; remove it once they settle", n, id))
	}
	if err := m.st.RemoveSessions(ids); err != nil {
		return nil, err
	}
	if m.bus != nil {
		for _, rid := range ids {
			// Not filed under the removed id: its events are gone, and a
			// later session with the same id must not inherit this one.
			m.bus.Publish("session.removed", "", map[string]any{"id": rid})
		}
	}
	return ids, nil
}
