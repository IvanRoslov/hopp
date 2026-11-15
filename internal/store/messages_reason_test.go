package store

import (
	"testing"
	"time"
)

func TestSetQueuedReasonTouchesOnlyQueued(t *testing.T) {
	st := openTestStore(t)
	st.AddSession(Session{ID: "s", Agent: "claude-code", WorktreePath: "/tmp/s", TmuxName: "s", State: "running"})
	id, _ := st.AddMessage(Message{ToSession: "s", Body: "x"})
	if e := st.SetQueuedReason(id, "claude_prepare:no_socket"); e != nil {
		t.Fatal(e)
	}
	m, _ := st.GetMessage(id)
	if m.Status != "queued" || m.Reason != "claude_prepare:no_socket" || m.Attempts != 0 {
		t.Fatalf("queued reason %+v", m)
	}
	st.UpdateMessageStatus(id, "failed", 0, 0, "recipient_gone")
	st.SetQueuedReason(id, "claude_binding_changed")
	if m, _ = st.GetMessage(id); m.Reason != "recipient_gone" {
		t.Fatalf("a terminal reason was overwritten: %+v", m)
	}
}

// A wait reason is display only: expiry treats the row as any queued row.
func TestQueuedReasonDoesNotAffectExpiry(t *testing.T) {
	st := openTestStore(t)
	st.AddSession(Session{ID: "s", Agent: "claude-code", WorktreePath: "/tmp/s", TmuxName: "s", State: "running"})
	id, _ := st.AddMessage(Message{ToSession: "s", Body: "x"})
	st.SetQueuedReason(id, "claude_resolve:ambiguous_or_missing_registry")
	expired, e := st.ExpireQueuedBefore(time.Now().Add(time.Hour).Unix())
	if e != nil || len(expired) != 1 || expired[0].ID != id {
		t.Fatalf("expiry %+v %v", expired, e)
	}
	if m, _ := st.GetMessage(id); m.Status != "failed" || m.Reason != "timeout" {
		t.Fatalf("expired row %+v", m)
	}
}
