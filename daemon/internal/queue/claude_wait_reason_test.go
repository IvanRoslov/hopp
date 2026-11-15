package queue

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/IvanRoslov/hopp/internal/activity"
	"github.com/IvanRoslov/hopp/internal/claudeinstance"
	"github.com/IvanRoslov/hopp/internal/store"
)

type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}
func (l *lockedBuffer) String() string { l.mu.Lock(); defer l.mu.Unlock(); return l.b.String() }

func captureLog(t *testing.T) *lockedBuffer {
	t.Helper()
	buf := &lockedBuffer{}
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelInfo})))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return buf
}

// deliverPasses runs deliver for a short while, enough for several
// wait-and-retry loops on the Claude route.
func deliverPasses(h *testHarness, id int64, d time.Duration) {
	m, _ := h.st.GetMessage(id)
	ctx, cancel := context.WithTimeout(h.ctx, d)
	defer cancel()
	h.q.deliver(ctx, m)
}

func TestClaudeWaitReasonRecordedOnce(t *testing.T) {
	h, s, cc, _ := productionSocketFixture(t)
	other := cc
	other.PID = 12
	writeRegistry(t, s.sessionsDir, other)
	logs := captureLog(t)
	id, _ := h.st.AddMessage(store.Message{ToSession: "recv", Body: "feedback"})
	deliverPasses(h, id, 400*time.Millisecond)
	deliverPasses(h, id, 400*time.Millisecond)
	m, _ := h.st.GetMessage(id)
	if m.Status != "queued" || m.Attempts != 0 || m.Reason != "claude_resolve:ambiguous_or_missing_registry" {
		t.Fatalf("waiting message %+v", m)
	}
	if n := strings.Count(logs.String(), "queue: Claude delivery waiting"); n != 1 {
		t.Fatalf("wait logged %d times, want once per change:\n%s", n, logs.String())
	}
	if !strings.Contains(logs.String(), "reason=claude_resolve:ambiguous_or_missing_registry") {
		t.Fatalf("log lacks the reason:\n%s", logs.String())
	}
}

// A wait reason never affects delivery: once the cause clears, the message
// is claimed and delivered as usual and the reason is gone.
func TestWaitReasonClearsAndMessageDeliversWhenCauseClears(t *testing.T) {
	h, s, cc, received := productionSocketFixture(t)
	other := cc
	other.PID = 12
	writeRegistry(t, s.sessionsDir, other)
	id, _ := h.st.AddMessage(store.Message{ToSession: "recv", Body: "feedback"})
	deliverPasses(h, id, 300*time.Millisecond)
	if m, _ := h.st.GetMessage(id); m.Reason == "" {
		t.Fatalf("no wait reason recorded: %+v", m)
	}
	removeRegistry(t, s.sessionsDir, other.PID)
	deliverPasses(h, id, 2*time.Second)
	m, _ := h.st.GetMessage(id)
	if (m.Status != "delivering" && m.Status != "accepted") || m.Attempts != 1 || m.Reason != "" {
		t.Fatalf("after the cause cleared %+v", m)
	}
	if n := receivedCount(received, 300*time.Millisecond); n != 1 {
		t.Fatalf("socket writes %d", n)
	}
	v, _ := h.st.GetClaudeDelivery(id)
	appendQueueClaudeProof(t, v, "record-a")
	h.q.confirmPass(h.ctx, runtimeConfirmState())
	m, _ = h.st.GetMessage(id)
	if m.Status != "delivered" || m.Reason != "" {
		t.Fatalf("delivered %+v", m)
	}
}

func TestClaudeWaitReasonNamesTheIneligibleActivity(t *testing.T) {
	h, _, _, _ := productionSocketFixture(t)
	h.st.UpdateSessionActivity("recv", "", time.Now().Unix())
	id, _ := h.st.AddMessage(store.Message{ToSession: "recv", Body: "feedback"})
	deliverPasses(h, id, 300*time.Millisecond)
	m, _ := h.st.GetMessage(id)
	if m.Status != "queued" || m.Reason != "claude_not_eligible:unknown" {
		t.Fatalf("ineligible wait %+v", m)
	}
}

func removeRegistry(t *testing.T, dir string, pid int) {
	t.Helper()
	if e := os.Remove(filepath.Join(dir, fmt.Sprintf("%d.json", pid))); e != nil {
		t.Fatal(e)
	}
}

// TestClaimedMessageHasNoWaitReasonDuringSend: once a message is claimed it is
// no longer waiting, so the socket write never sees a stale wait reason on it.
func TestClaimedMessageHasNoWaitReasonDuringSend(t *testing.T) {
	h := newTestQueue(t)
	h.addRunningSession(t, "recv", activity.Ready)
	f := installClaudeSocket(t, h, false)
	id, _ := h.st.AddMessage(store.Message{ToSession: "recv", Body: "feedback"})
	deliverPasses(h, id, 300*time.Millisecond)
	if m, _ := h.st.GetMessage(id); m.Status != "queued" || m.Reason == "" {
		t.Fatalf("no wait reason before the cause cleared: %+v", m)
	}
	var atSend store.Message
	f.onSend = func(claudeinstance.Snapshot) { atSend, _ = h.st.GetMessage(id) }
	f.mu.Lock()
	f.available = true
	f.mu.Unlock()
	deliverPasses(h, id, time.Second)
	if f.sendCount() != 1 {
		t.Fatalf("sends %d", f.sendCount())
	}
	if atSend.Status != "delivering" || atSend.Reason != "" {
		t.Fatalf("row during the socket write %+v, want delivering with no reason", atSend)
	}
}
