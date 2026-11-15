package monitor

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/IvanRoslov/hopp/internal/activity"
	"github.com/IvanRoslov/hopp/internal/claudeinstance"
	"github.com/IvanRoslov/hopp/internal/store"
)

// journalRecord is one Claude journal line for these tests.
type journalRecord struct {
	Type       string
	At         time.Time
	StopReason string
}

func writeClaudeJournal(t *testing.T, path, conversation string, recs ...journalRecord) {
	t.Helper()
	var out []byte
	for _, r := range recs {
		line := map[string]any{"sessionId": conversation, "type": r.Type, "timestamp": r.At.UTC().Format(time.RFC3339Nano)}
		if r.StopReason != "" {
			line["message"] = map[string]any{"stop_reason": r.StopReason}
		}
		b, _ := json.Marshal(line)
		out = append(out, append(b, '\n')...)
	}
	if err := os.WriteFile(path, out, 0o600); err != nil {
		t.Fatal(err)
	}
}

func appendClaudeJournal(t *testing.T, path, conversation string, r journalRecord) {
	t.Helper()
	line, _ := json.Marshal(map[string]any{"sessionId": conversation, "type": r.Type, "timestamp": r.At.UTC().Format(time.RFC3339Nano)})
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	f.Write(append(line, '\n'))
}

// stopFixture is the Claude monitor fixture with a turn that ended a moment
// ago (a user record, then the assistant's end_turn record) and a qualified
// Stop hook after it.
func stopFixture(t *testing.T) (*Monitor, *store.Store, claudeinstance.Identity, claudeinstance.HookEvent) {
	t.Helper()
	m, st, _, event := claudeMonitorFixture(t)
	_, id, _ := st.GetClaudeLaunch("s")
	// As live: Claude writes the turn's end_turn record and the Stop hook
	// runs some tens of milliseconds later, inside the same second. The
	// store orders activity by whole seconds, so this is the case where
	// the journal's recency rule used to win the tie and flip back.
	end := time.Now().Truncate(time.Second).Add(-2*time.Second + 100*time.Millisecond)
	writeClaudeJournal(t, id.JournalPath, id.ClaudeSessionID,
		journalRecord{Type: "user", At: end.Add(-time.Second)},
		journalRecord{Type: "assistant", At: end, StopReason: "end_turn"})
	event.HookEventName = "Stop"
	event.At = end.Add(50 * time.Millisecond).UnixNano()
	return m, st, *id, event
}

func pollOnce(t *testing.T, m *Monitor, st *store.Store) string {
	t.Helper()
	sess, _ := st.GetSession("s")
	m.pollSession(context.Background(), sess, map[string]bool{"s": true}, true)
	got, _ := st.GetSession("s")
	return got.Activity
}

// The ended turn's own records do not undo a qualified Stop: the session
// stays ready across sweeps.
func TestQualifiedStopIsNotUndoneByTheEndedTurn(t *testing.T) {
	m, st, _, event := stopFixture(t)
	if r := m.PushClaudeUpdate(context.Background(), "s", activity.Ready, event); r != "" {
		t.Fatalf("Stop rejected: %s", r)
	}
	for pass := 0; pass < 2; pass++ {
		if got := pollOnce(t, m, st); got != "ready" {
			t.Fatalf("pass %d: activity = %s, want ready", pass, got)
		}
	}
}

// A record that starts new work after the Stop shows active on the next
// sweep.
func TestNewTurnAfterQualifiedStopIsActive(t *testing.T) {
	m, st, id, event := stopFixture(t)
	if r := m.PushClaudeUpdate(context.Background(), "s", activity.Ready, event); r != "" {
		t.Fatalf("Stop rejected: %s", r)
	}
	pollOnce(t, m, st)
	appendClaudeJournal(t, id.JournalPath, id.ClaudeSessionID, journalRecord{Type: "user", At: time.Now()})
	if got := pollOnce(t, m, st); got != "active" {
		t.Fatalf("activity = %s, want active after a new user record", got)
	}
}

// After a qualified Stop, ready still becomes idle at the usual time,
// counted from the turn's last record.
func TestQualifiedStopBecomesIdleOnTime(t *testing.T) {
	m, st, _, event := stopFixture(t)
	m.cfg.ReadyToIdle = 1500 * time.Millisecond
	if r := m.PushClaudeUpdate(context.Background(), "s", activity.Ready, event); r != "" {
		t.Fatalf("Stop rejected: %s", r)
	}
	if got := pollOnce(t, m, st); got != "idle" {
		t.Fatalf("activity = %s, want idle (last record about 2s ago, ready_to_idle 1.5s)", got)
	}
}

// A Stop from another conversation is rejected as today, so the journal's
// recency rule still says active.
func TestForeignStopLeavesJournalRule(t *testing.T) {
	m, st, _, event := stopFixture(t)
	event.ClaudeSessionID = "another-conversation"
	if r := m.PushClaudeUpdate(context.Background(), "s", activity.Ready, event); r == "" {
		t.Fatal("foreign Stop accepted")
	}
	if got := pollOnce(t, m, st); got != "active" {
		t.Fatalf("activity = %s, want active from the journal", got)
	}
}

// A later qualified hook that is not Stop (the next turn started) drops the
// Stop mark: the journal rule applies again.
func TestHookAfterStopDropsTheMark(t *testing.T) {
	m, st, _, event := stopFixture(t)
	if r := m.PushClaudeUpdate(context.Background(), "s", activity.Ready, event); r != "" {
		t.Fatalf("Stop rejected: %s", r)
	}
	pollOnce(t, m, st)
	event.HookEventName = "PreToolUse"
	event.At = time.Now().UnixNano()
	if r := m.PushClaudeUpdate(context.Background(), "s", activity.Active, event); r != "" {
		t.Fatalf("PreToolUse rejected: %s", r)
	}
	if got := pollOnce(t, m, st); got != "active" {
		t.Fatalf("activity = %s, want active once the Stop mark is gone", got)
	}
}
