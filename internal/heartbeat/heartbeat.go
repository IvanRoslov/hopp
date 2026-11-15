// Package heartbeat implements hopp's stuck-children summary: a periodic
// sweep that detects stalled children of each live session and — if the
// parent itself isn't currently active — sends it a summary message so it
// can act (unblock, restart or replace them) without waiting for a human to
// notice.
package heartbeat

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/IvanRoslov/hopp/internal/activity"
	"github.com/IvanRoslov/hopp/internal/bus"
	"github.com/IvanRoslov/hopp/internal/config"
	"github.com/IvanRoslov/hopp/internal/store"
)

// Heartbeat runs the periodic stall-detection sweep.
type Heartbeat struct {
	st          *store.Store
	bus         *bus.Bus
	cfg         *config.Config
	getActivity func(sessionID string) (activity.State, bool)
	wake        func(to string)

	// nowFunc returns the current time; overridable by tests.
	nowFunc func() time.Time

	mu       sync.Mutex
	lastSent map[string]time.Time
}

// New builds a Heartbeat. getActivity is typically Monitor.Activity; wake is
// typically Queue.Wake. Messages are delivered via st.AddMessage directly
// (mirroring the enqueue pattern in internal/api/messages.go), decoupling
// this package from the concrete *queue.Queue type.
func New(st *store.Store, b *bus.Bus, cfg *config.Config, getActivity func(sessionID string) (activity.State, bool), wake func(to string)) *Heartbeat {
	return &Heartbeat{
		st:          st,
		bus:         b,
		cfg:         cfg,
		getActivity: getActivity,
		wake:        wake,
		nowFunc:     time.Now,
		lastSent:    make(map[string]time.Time),
	}
}

// Run runs Tick at cfg.HeartbeatInterval, blocking until ctx is cancelled.
// It performs one immediate Tick before the first tick.
func (h *Heartbeat) Run(ctx context.Context) {
	if err := h.Tick(ctx); err != nil {
		slog.Error("heartbeat: tick", "error", err)
	}

	ticker := time.NewTicker(h.cfg.HeartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := h.Tick(ctx); err != nil {
				slog.Error("heartbeat: tick", "error", err)
			}
		}
	}
}

// Tick runs a single pass of the heartbeat sweep over every live
// (spawning|running) session. A session without children has nothing to
// report.
func (h *Heartbeat) Tick(ctx context.Context) error {
	parents, err := h.st.ListSessions(store.SessionFilter{})
	if err != nil {
		return fmt.Errorf("list sessions: %w", err)
	}

	for _, parent := range parents {
		if err := h.tickOne(parent); err != nil {
			slog.Error("heartbeat: tick parent", "parent", parent.ID, "error", err)
		}
	}
	return nil
}

// tickOne evaluates and, if warranted, sends a summary to a single parent
// session.
func (h *Heartbeat) tickOne(parent store.Session) error {
	children, err := h.st.ListSessions(store.SessionFilter{Parent: parent.ID, All: true})
	if err != nil {
		return fmt.Errorf("list children: %w", err)
	}

	now := h.nowFunc()
	var stalledLines []string
	for _, c := range children {
		if line, stalled := stalledChildLine(c, now, h.cfg.ChildStallThreshold); stalled {
			stalledLines = append(stalledLines, line)
		}
	}

	if len(stalledLines) == 0 {
		return nil
	}

	if state, known := h.getActivity(parent.ID); known && state == activity.Active {
		// The parent is actively working: don't interrupt it.
		return nil
	}

	if !h.antiSpamOK(parent.ID, now, h.cfg.HeartbeatInterval) {
		return nil
	}

	body := buildSummary(parent.ID, stalledLines)
	if _, err := h.st.AddMessage(store.Message{ToSession: parent.ID, Body: body}); err != nil {
		return fmt.Errorf("enqueue summary message: %w", err)
	}
	if h.bus != nil {
		h.bus.Publish("message.queued", parent.ID, map[string]any{"from": "", "to": parent.ID})
	}
	if h.wake != nil {
		h.wake(parent.ID)
	}

	h.mu.Lock()
	h.lastSent[parent.ID] = now
	h.mu.Unlock()

	if h.bus != nil {
		h.bus.Publish("session.children_summary_sent", parent.ID, map[string]any{
			"stalled": len(stalledLines),
		})
	}

	return nil
}

// liveSession reports whether s is still a live session — one that can
// still make progress or stall.
func liveSession(s store.Session) bool {
	return s.State == "spawning" || s.State == "running"
}

// stalledChildLine reports whether c counts as stalled and, if so, its
// summary line. Only a live session (State spawning/running) can stall: a
// killed or finished session keeps its last Activity forever and would
// otherwise be re-reported on every tick. Within a live session, a child is
// stalled if its activity is "exited" (its tmux pane died;
// store.Session.State stays "running" until the reconciler later promotes it
// to "errored", so State alone is not the field to check here), or if its
// activity is idle/blocked/waiting_input and it has been that way longer
// than threshold.
func stalledChildLine(c store.Session, now time.Time, threshold time.Duration) (string, bool) {
	if !liveSession(c) {
		return "", false
	}

	if activity.State(c.Activity) == activity.Exited {
		return fmt.Sprintf("- %s: exited", c.ID), true
	}

	switch activity.State(c.Activity) {
	case activity.Idle, activity.Blocked, activity.WaitingInput:
		if c.ActivityTS == 0 {
			return "", false
		}
		since := now.Sub(time.Unix(c.ActivityTS, 0))
		if since > threshold {
			mins := int(since.Minutes())
			return fmt.Sprintf("- %s: %s %dm", c.ID, c.Activity, mins), true
		}
	}
	return "", false
}

// antiSpamOK reports whether more than window has passed since the last
// message sent under key (or none has ever been sent). key is a parent
// session id.
func (h *Heartbeat) antiSpamOK(key string, now time.Time, window time.Duration) bool {
	h.mu.Lock()
	last, ok := h.lastSent[key]
	h.mu.Unlock()
	if !ok {
		return true
	}
	return now.Sub(last) > window
}

// buildSummary assembles the summary message body.
func buildSummary(parentID string, stalledLines []string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "[hopp] Session %s status:\n", parentID)
	for _, l := range stalledLines {
		b.WriteString(l)
		b.WriteString("\n")
	}
	b.WriteString("Act autonomously: unblock, restart or replace stalled sessions.")
	return b.String()
}
