package session

import (
	"log/slog"
	"time"
)

// withdrawAsksOf withdraws the open asks of a session that has just ended
// (reason session_ended), so nothing keeps waiting for a human answer that
// nobody can receive. It runs on every path that makes a session terminal,
// next to clearPendingForTerminal.
func (m *Manager) withdrawAsksOf(id string) {
	asks, err := m.st.WithdrawOpenAsksOf(id, "session_ended", time.Now().Unix())
	if err != nil {
		slog.Warn("session: withdraw asks of an ended session", "session", id, "error", err)
		return
	}
	if m.bus == nil {
		return
	}
	for _, a := range asks {
		m.bus.Publish("ask.withdrawn", a.FromSession, map[string]any{"id": a.ID, "ask_labels": a.Labels, "reason": a.Reason})
	}
}
