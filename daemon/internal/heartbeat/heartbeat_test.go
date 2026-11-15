package heartbeat

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/IvanRoslov/hopp/internal/activity"
	"github.com/IvanRoslov/hopp/internal/bus"
	"github.com/IvanRoslov/hopp/internal/config"
	"github.com/IvanRoslov/hopp/internal/store"
)

func openTestStore(t *testing.T) *store.Store {
	t.Helper()
	path := filepath.Join(t.TempDir(), "hopp.db")
	s, err := store.Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func testConfig() *config.Config {
	return &config.Config{
		HeartbeatInterval:   5 * time.Minute,
		ChildStallThreshold: 15 * time.Minute,
	}
}

// addSession inserts a session row; parentID may be empty.
func addSession(t *testing.T, st *store.Store, id, parentID, state, activityState string, activityTS int64) {
	t.Helper()
	if err := st.AddSession(store.Session{
		ID: id, ParentID: parentID, Agent: "claude-code", WorktreePath: "/wt/" + id,
		TmuxName: id, State: state, Activity: activityState, ActivityTS: activityTS,
	}); err != nil {
		t.Fatalf("AddSession(%s): %v", id, err)
	}
}

// fixedActivity returns a getActivity func returning a fixed state for every
// session, always "known".
func fixedActivity(state activity.State) func(string) (activity.State, bool) {
	return func(string) (activity.State, bool) {
		return state, true
	}
}

func unknownActivity(string) (activity.State, bool) {
	return "", false
}

func tick(t *testing.T, hb *Heartbeat) {
	t.Helper()
	if err := hb.Tick(context.Background()); err != nil {
		t.Fatalf("Tick: %v", err)
	}
}

// messagesTo returns the messages addressed to id.
func messagesTo(t *testing.T, st *store.Store, id string) []store.Message {
	t.Helper()
	msgs, err := st.ListMessages(id, 0)
	if err != nil {
		t.Fatalf("ListMessages: %v", err)
	}
	var out []store.Message
	for _, m := range msgs {
		if m.ToSession == id {
			out = append(out, m)
		}
	}
	return out
}

func eventsOfType(t *testing.T, st *store.Store, typ string) []store.Event {
	t.Helper()
	evs, err := st.ListEvents(0, 1000, "")
	if err != nil {
		t.Fatalf("ListEvents: %v", err)
	}
	var out []store.Event
	for _, e := range evs {
		if e.Type == typ {
			out = append(out, e)
		}
	}
	return out
}

func stale() int64 { return time.Now().Add(-20 * time.Minute).Unix() }

func TestSummaryGoesToParentOfStalledChild(t *testing.T) {
	st := openTestStore(t)
	b := bus.New(st)
	addSession(t, st, "p", "", "running", "idle", 0)
	addSession(t, st, "c1", "p", "running", "idle", stale())
	addSession(t, st, "c2", "p", "running", "active", time.Now().Unix())

	var woke []string
	hb := New(st, b, testConfig(), unknownActivity, func(to string) { woke = append(woke, to) })
	tick(t, hb)

	msgs := messagesTo(t, st, "p")
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	body := msgs[0].Body
	if msgs[0].FromSession != "" {
		t.Errorf("from = %q, want a system message", msgs[0].FromSession)
	}
	if !strings.HasPrefix(body, "[hopp] Session p status:\n") {
		t.Errorf("body = %q, want the [hopp] headline naming the parent", body)
	}
	if !strings.Contains(body, "- c1: idle 20m\n") || strings.Contains(body, "c2") {
		t.Errorf("body = %q, want only c1's line", body)
	}
	if !strings.HasSuffix(body, "Act autonomously: unblock, restart or replace stalled sessions.") {
		t.Errorf("body = %q, want the closing line", body)
	}
	if strings.Contains(body, "worker") || strings.Contains(body, "PR") {
		t.Errorf("body = %q, want no worker/PR wording", body)
	}
	if len(woke) != 1 || woke[0] != "p" {
		t.Errorf("expected wake(p), got %v", woke)
	}
	if n := len(eventsOfType(t, st, "message.queued")); n != 1 {
		t.Errorf("message.queued events = %d, want 1", n)
	}
	sent := eventsOfType(t, st, "session.children_summary_sent")
	if len(sent) != 1 || sent[0].SessionID != "p" || sent[0].Data["stalled"] != float64(1) {
		t.Errorf("children_summary_sent = %+v, want one for p with stalled=1", sent)
	}
}

func TestNoSummaryWhenNoChildIsStalled(t *testing.T) {
	st := openTestStore(t)
	addSession(t, st, "p", "", "running", "idle", 0)
	addSession(t, st, "fresh", "p", "running", "idle", time.Now().Add(-1*time.Minute).Unix())
	addSession(t, st, "busy", "p", "running", "active", stale())
	addSession(t, st, "nots", "p", "running", "idle", 0) // no activity timestamp yet
	addSession(t, st, "lonely", "", "running", "idle", stale())

	hb := New(st, bus.New(st), testConfig(), unknownActivity, func(string) {})
	tick(t, hb)

	for _, id := range []string{"p", "lonely"} {
		if msgs := messagesTo(t, st, id); len(msgs) != 0 {
			t.Fatalf("messages to %s = %+v, want none", id, msgs)
		}
	}
	if n := len(eventsOfType(t, st, "session.children_summary_sent")); n != 0 {
		t.Errorf("children_summary_sent events = %d, want 0", n)
	}
}

func TestEachStalledStateIsReported(t *testing.T) {
	st := openTestStore(t)
	addSession(t, st, "p", "", "running", "idle", 0)
	addSession(t, st, "c-blocked", "p", "running", "blocked", stale())
	addSession(t, st, "c-waiting", "p", "running", "waiting_input", stale())
	addSession(t, st, "c-spawning", "p", "spawning", "idle", stale())
	// "exited" is an Activity value set when the pane dies; State stays
	// "running" until the reconciler marks the session errored.
	addSession(t, st, "c-exited", "p", "running", "exited", 0)

	hb := New(st, bus.New(st), testConfig(), unknownActivity, func(string) {})
	tick(t, hb)

	msgs := messagesTo(t, st, "p")
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	for _, want := range []string{"- c-blocked: blocked 20m\n", "- c-waiting: waiting_input 20m\n", "- c-spawning: idle 20m\n", "- c-exited: exited\n"} {
		if !strings.Contains(msgs[0].Body, want) {
			t.Errorf("body = %q, lacks %q", msgs[0].Body, want)
		}
	}
}

// TestTerminalChildIsNotReported: a child that is done, killed or errored
// keeps its last activity forever; rocket's rule never reports it.
func TestTerminalChildIsNotReported(t *testing.T) {
	st := openTestStore(t)
	addSession(t, st, "p", "", "running", "idle", 0)
	addSession(t, st, "c-killed", "p", "killed", "exited", 0)
	addSession(t, st, "c-done", "p", "done", "idle", stale())
	addSession(t, st, "c-errored", "p", "errored", "exited", 0)

	hb := New(st, bus.New(st), testConfig(), unknownActivity, func(string) {})
	tick(t, hb)

	if msgs := messagesTo(t, st, "p"); len(msgs) != 0 {
		t.Fatalf("messages = %+v, want none for terminal children", msgs)
	}
}

func TestNoSummaryWhileParentIsActive(t *testing.T) {
	st := openTestStore(t)
	addSession(t, st, "p", "", "running", "active", 0)
	addSession(t, st, "c1", "p", "running", "idle", stale())

	hb := New(st, bus.New(st), testConfig(), fixedActivity(activity.Active), func(string) {})
	tick(t, hb)

	if msgs := messagesTo(t, st, "p"); len(msgs) != 0 {
		t.Fatalf("messages = %+v, want none while the parent is active", msgs)
	}
}

func TestAntiSpam(t *testing.T) {
	st := openTestStore(t)
	addSession(t, st, "p", "", "running", "idle", 0)
	addSession(t, st, "c1", "p", "running", "idle", stale())

	hb := New(st, bus.New(st), testConfig(), unknownActivity, func(string) {})
	now := time.Now()
	hb.nowFunc = func() time.Time { return now }
	tick(t, hb)
	// Second tick shortly after, well within HeartbeatInterval.
	hb.nowFunc = func() time.Time { return now.Add(1 * time.Minute) }
	tick(t, hb)
	if msgs := messagesTo(t, st, "p"); len(msgs) != 1 {
		t.Fatalf("expected 1 message after two ticks within interval, got %d", len(msgs))
	}
	// Past the interval the summary is sent again.
	hb.nowFunc = func() time.Time { return now.Add(6 * time.Minute) }
	tick(t, hb)
	if msgs := messagesTo(t, st, "p"); len(msgs) != 2 {
		t.Fatalf("expected 2 messages once the interval passed, got %d", len(msgs))
	}
}

func TestGrandchildrenReportToTheirOwnParent(t *testing.T) {
	st := openTestStore(t)
	addSession(t, st, "a", "", "running", "idle", 0)
	addSession(t, st, "b", "a", "running", "active", time.Now().Unix())
	addSession(t, st, "c", "b", "running", "idle", stale())

	hb := New(st, bus.New(st), testConfig(), unknownActivity, func(string) {})
	tick(t, hb)

	if msgs := messagesTo(t, st, "a"); len(msgs) != 0 {
		t.Fatalf("messages to a = %+v, want none (b is not stalled)", msgs)
	}
	msgs := messagesTo(t, st, "b")
	if len(msgs) != 1 || !strings.Contains(msgs[0].Body, "- c: idle 20m") {
		t.Fatalf("messages to b = %+v, want one naming c", msgs)
	}
}

func TestTerminalParentGetsNothing(t *testing.T) {
	st := openTestStore(t)
	for _, state := range []string{"killed", "done", "errored"} {
		p := "p-" + state
		addSession(t, st, p, "", state, "exited", 0)
		addSession(t, st, "c-"+state, p, "running", "idle", stale())
	}

	hb := New(st, bus.New(st), testConfig(), unknownActivity, func(string) {})
	tick(t, hb)

	for _, state := range []string{"killed", "done", "errored"} {
		if msgs := messagesTo(t, st, "p-"+state); len(msgs) != 0 {
			t.Fatalf("messages to %s parent = %+v, want none", state, msgs)
		}
	}
	if n := len(eventsOfType(t, st, "message.queued")); n != 0 {
		t.Errorf("message.queued events = %d, want 0", n)
	}
}
