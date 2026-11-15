package monitor

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/IvanRoslov/hopp/internal/activity"
	"github.com/IvanRoslov/hopp/internal/agent"
	"github.com/IvanRoslov/hopp/internal/store"
)

// failingAgent is a blocked agent whose journal names the failed turn.
type failingAgent struct {
	fakeAgent
	mu     sync.Mutex
	turnID string
	msg    string
}

func (a *failingAgent) LastTurnFailure(ctx context.Context, ref agent.ActivityRef) (string, string, bool, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.turnID, a.msg, a.turnID != "", nil
}

func (a *failingAgent) fail(turnID, msg string) {
	a.mu.Lock()
	a.turnID, a.msg = turnID, msg
	a.mu.Unlock()
}

var _ agent.TurnFailureReporter = (*failingAgent)(nil)

func turnFailureMonitor(t *testing.T, withParent bool) (*Monitor, *store.Store, *failingAgent) {
	t.Helper()
	rt := &fakeRuntime{names: []string{"sess1", "orch1"}}
	m, st, _ := testMonitor(t, rt, &fakeProber{onlyShell: map[string]bool{}}, map[string]*fakeAgent{})
	ag := &failingAgent{fakeAgent: fakeAgent{state: activity.Blocked}}
	orch := &fakeAgent{state: activity.Ready}
	m.resolveAgent = func(name string) (agent.Agent, error) {
		switch name {
		case "kimi-code":
			return ag, nil
		case claudeCodeAgent:
			return orch, nil
		}
		return nil, errors.New("agent not found: " + name)
	}
	parent := ""
	if withParent {
		seedSession(t, st, store.Session{ID: "orch1", Agent: claudeCodeAgent, TmuxName: "orch1"})
		parent = "orch1"
	}
	seedSession(t, st, store.Session{ID: "sess1", Agent: "kimi-code", TmuxName: "sess1", ParentID: parent})
	return m, st, ag
}

// restarted is m after a daemon restart: same store and wiring, no memory.
func restarted(t *testing.T, m *Monitor) *Monitor {
	t.Helper()
	m2, _, _ := testMonitor(t, m.rt, m.prober.(*fakeProber), map[string]*fakeAgent{})
	m2.st, m2.bus, m2.resolveAgent = m.st, m.bus, m.resolveAgent
	return m2
}

func TestTurnFailureAlertsParentOncePerTurn(t *testing.T) {
	m, st, ag := turnFailureMonitor(t, true)
	ag.fail("session_a/0", "HTTP 429: quota exhausted")

	for i := 0; i < 3; i++ {
		m.sweep(context.Background())
	}
	msgs := messagesTo(t, st, "orch1")
	if len(msgs) != 1 {
		t.Fatalf("alerts = %d, want 1: %+v", len(msgs), msgs)
	}
	if want := "[hopp] session sess1: Kimi turn failed: HTTP 429: quota exhausted. " +
		"The session stays blocked and will not take messages; kill and respawn it (possibly on another profile)."; msgs[0].Body != want {
		t.Errorf("body = %q, want %q", msgs[0].Body, want)
	}
	if got := activityOf(t, st, "sess1"); got != string(activity.Blocked) {
		t.Errorf("activity = %q, want blocked", got)
	}

	// Daemon restart: the same failed turn is not reported again.
	m2 := restarted(t, m)
	m2.sweep(context.Background())
	if n := len(messagesTo(t, st, "orch1")); n != 1 {
		t.Fatalf("alerts after restart = %d, want 1", n)
	}

	// A new failed turn is.
	ag.fail("session_a/1", "HTTP 429: still exhausted")
	m2.sweep(context.Background())
	m2.sweep(context.Background())
	msgs = messagesTo(t, st, "orch1")
	if len(msgs) != 2 || !strings.Contains(msgs[1].Body, "still exhausted.") {
		t.Fatalf("alerts = %+v, want a second one for the new turn", msgs)
	}
}

// A blocked session whose last turn did not fail (an open question) raises
// no turn-failure alert.
func TestTurnFailureNotReportedWithoutFailure(t *testing.T) {
	m, st, _ := turnFailureMonitor(t, true)
	m.sweep(context.Background())
	if n := len(messagesTo(t, st, "orch1")); n != 0 {
		t.Fatalf("alerts = %d, want 0", n)
	}
}

// The in-memory record alone stops a repeat (e.g. when the journal event
// could not be written).
func TestTurnFailureMemoryBackstop(t *testing.T) {
	m, st, ag := turnFailureMonitor(t, true)
	ag.fail("session_a/0", "boom")
	m.turnFailures = map[string]string{"sess1": "session_a/0"}
	m.sweep(context.Background())
	if n := len(messagesTo(t, st, "orch1")); n != 0 {
		t.Fatalf("alerts = %d, want 0", n)
	}
}

// Review Focus 5: a child whose parent is no longer live alerts by event, not
// by a message to the dead parent, and only once per failed turn.
func TestAlertWithoutLiveParentPublishesEvent(t *testing.T) {
	m, st, ag := turnFailureMonitor(t, true)
	if err := st.UpdateSessionState("orch1", "killed"); err != nil {
		t.Fatal(err)
	}
	ag.fail("session_a/0", "HTTP 429: quota exhausted")
	m.sweep(context.Background())
	m.sweep(context.Background())

	if msgs := messagesTo(t, st, "orch1"); len(msgs) != 0 {
		t.Fatalf("messages to the killed parent = %+v, want none", msgs)
	}
	events, err := st.ListEvents(0, 0, "sess1")
	if err != nil {
		t.Fatal(err)
	}
	var alerts []store.Event
	for _, e := range events {
		if e.Type == "session.alert" {
			alerts = append(alerts, e)
		}
	}
	if len(alerts) != 1 {
		t.Fatalf("session.alert events = %d, want 1: %+v", len(alerts), alerts)
	}
	if alerts[0].Data["what"] != "turn failure" || alerts[0].Data["detail"] != "HTTP 429: quota exhausted" ||
		!strings.Contains(alerts[0].Data["body"].(string), "Kimi turn failed: HTTP 429") {
		t.Errorf("alert = %+v", alerts[0].Data)
	}
}

func TestAlertWithLiveParentQueuesMessage(t *testing.T) {
	m, st, ag := turnFailureMonitor(t, true)
	ag.fail("session_a/0", "HTTP 429: quota exhausted")
	m.sweep(context.Background())

	msgs := messagesTo(t, st, "orch1")
	if len(msgs) != 1 || msgs[0].FromSession != "" || !strings.Contains(msgs[0].Body, "Kimi turn failed") {
		t.Fatalf("messages to parent = %+v, want one system alert", msgs)
	}
	events, err := st.ListEvents(0, 0, "sess1")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range events {
		if e.Type == "session.alert" {
			t.Errorf("a live parent got a message, yet a session.alert event was published too: %+v", e)
		}
	}
}
