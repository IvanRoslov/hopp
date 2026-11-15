package queue

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/IvanRoslov/hopp/internal/claudeinstance"
	"github.com/IvanRoslov/hopp/internal/socketmsg"
	"github.com/IvanRoslov/hopp/internal/store"
)

// absentJournalFixture is productionSocketFixture for a verified, idle Claude
// root launched without a prompt: its exact journal does not exist yet.
func absentJournalFixture(t *testing.T) (*testHarness, *ClaudeSocketSender, string, <-chan socketmsg.Message) {
	t.Helper()
	h, s, _, received := productionSocketFixture(t)
	sess, _ := h.st.GetSession("recv")
	r := s.Resolve(h.ctx, sess)
	if r.State != claudeinstance.Verified {
		t.Fatalf("fixture root not verified: %+v", r)
	}
	path := r.Identity.JournalPath
	if e := os.RemoveAll(filepath.Dir(path)); e != nil {
		t.Fatal(e)
	}
	return h, s, path, received
}

// writeAbsentJournal creates the journal the way Claude does on the first
// turn, holding one exact incoming record for each snapshot.
func writeAbsentJournal(t *testing.T, path string, vs ...claudeinstance.Snapshot) {
	t.Helper()
	os.MkdirAll(filepath.Dir(path), 0700)
	f, e := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	for i, v := range vs {
		raw, _ := json.Marshal(map[string]any{"type": "user", "sessionId": v.Target.ClaudeSessionID, "uuid": "record-" + string(rune('a'+i)), "message": map[string]string{"role": "user", "content": v.Envelope}})
		f.Write(append(raw, '\n'))
	}
}

func receivedCount(ch <-chan socketmsg.Message, wait time.Duration) int {
	n := 0
	deadline := time.After(wait)
	for {
		select {
		case <-ch:
			n++
		case <-deadline:
			return n
		}
	}
}

func deliverOnce(t *testing.T, h *testHarness, id int64) {
	t.Helper()
	m, _ := h.st.GetMessage(id)
	ctx, cancel := context.WithTimeout(h.ctx, 2*time.Second)
	defer cancel()
	h.q.deliver(ctx, m)
}

func TestDeliverClaudeToVerifiedIdleRootWithoutJournal(t *testing.T) {
	h, _, path, received := absentJournalFixture(t)
	id, _ := h.st.AddMessage(store.Message{ToSession: "recv", Body: "feedback"})
	deliverOnce(t, h, id)
	v, e := h.st.GetClaudeDelivery(id)
	if e != nil {
		t.Fatalf("no claim for a root without a journal: %v", e)
	}
	if v.Boundary != (claudeinstance.JournalBoundary{Path: path}) {
		t.Fatalf("boundary %+v, want the absent sentinel at %s", v.Boundary, path)
	}
	if n := receivedCount(received, 300*time.Millisecond); n != 1 {
		t.Fatalf("socket writes %d, want 1", n)
	}
	writeAbsentJournal(t, path, v)
	h.q.confirmPass(h.ctx, runtimeConfirmState())
	m, _ := h.st.GetMessage(id)
	if m.Status != "delivered" || m.Attempts != 1 || h.rt.callCount() != 0 {
		t.Fatalf("settlement %+v inject=%d", m, h.rt.callCount())
	}
}

func TestAbsentClaimWaitsWhileJournalMissing(t *testing.T) {
	h, _, _, _ := absentJournalFixture(t)
	id, _ := h.st.AddMessage(store.Message{ToSession: "recv", Body: "feedback"})
	deliverOnce(t, h, id)
	h.q.confirmPass(h.ctx, runtimeConfirmState())
	m, _ := h.st.GetMessage(id)
	if m.Status == "delivered" || m.Status == "failed" || m.Attempts != 1 {
		t.Fatalf("missing journal settled the message: %+v", m)
	}
}

func TestTwoAbsentClaimsBothDeliverOnce(t *testing.T) {
	h, _, path, received := absentJournalFixture(t)
	a, _ := h.st.AddMessage(store.Message{ToSession: "recv", Body: "first"})
	b, _ := h.st.AddMessage(store.Message{ToSession: "recv", Body: "second"})
	deliverOnce(t, h, a)
	deliverOnce(t, h, b)
	va, ea := h.st.GetClaudeDelivery(a)
	vb, eb := h.st.GetClaudeDelivery(b)
	if ea != nil || eb != nil || va.Boundary.Inode != 0 || vb.Boundary.Inode != 0 || va.Envelope == vb.Envelope {
		t.Fatalf("two absent claims: %+v %v / %+v %v", va.Boundary, ea, vb.Boundary, eb)
	}
	if n := receivedCount(received, 300*time.Millisecond); n != 2 {
		t.Fatalf("socket writes %d, want 2", n)
	}
	writeAbsentJournal(t, path, va, vb)
	h.q.confirmPass(h.ctx, runtimeConfirmState())
	for _, id := range []int64{a, b} {
		m, _ := h.st.GetMessage(id)
		if m.Status != "delivered" || m.Attempts != 1 {
			t.Fatalf("message %d %+v", id, m)
		}
	}
}

func TestAbsentClaimSurvivesRecover(t *testing.T) {
	h, _, path, received := absentJournalFixture(t)
	id, _ := h.st.AddMessage(store.Message{ToSession: "recv", Body: "feedback"})
	deliverOnce(t, h, id)
	v, _ := h.st.GetClaudeDelivery(id)
	h.q.Recover(h.ctx)
	h.q.confirmPass(h.ctx, runtimeConfirmState())
	writeAbsentJournal(t, path, v)
	h.q.confirmPass(h.ctx, runtimeConfirmState())
	m, _ := h.st.GetMessage(id)
	if m.Status != "delivered" || m.Attempts != 1 {
		t.Fatalf("after recover %+v", m)
	}
	if n := receivedCount(received, 300*time.Millisecond); n != 1 {
		t.Fatalf("socket writes %d, want 1 (no resend after Recover)", n)
	}
}

func TestAbsentJournalNeverAppearsEndsUnconfirmed(t *testing.T) {
	h, _, _, received := absentJournalFixture(t)
	h.q.cfg.QueueTimeout = 2 * time.Second
	id, _ := h.st.AddMessage(store.Message{ToSession: "recv", Body: "feedback"})
	deliverOnce(t, h, id)
	time.Sleep(2500 * time.Millisecond)
	h.q.confirmPass(h.ctx, runtimeConfirmState())
	m, _ := h.st.GetMessage(id)
	if m.Status != "failed" || m.Reason != "delivery_unconfirmed" || m.Attempts != 1 {
		t.Fatalf("expired absent claim %+v", m)
	}
	if n := receivedCount(received, 300*time.Millisecond); n != 1 {
		t.Fatalf("socket writes %d, want 1", n)
	}
}
