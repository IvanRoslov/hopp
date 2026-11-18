package queue

import (
	"strings"
	"testing"
	"time"

	"github.com/IvanRoslov/hopp/internal/activity"
	"github.com/IvanRoslov/hopp/internal/store"
)

// Review Focus 2: a message to a terminal recipient fails at once with
// recipient_gone, nothing is injected, and the live sender is told.
func TestRecipientTerminalFailsAtOnceAndTellsSender(t *testing.T) {
	h := newTestQueue(t)
	if err := h.st.AddSession(store.Session{
		ID: "recv", Agent: "claude-code",
		WorktreePath: "/tmp/recv", TmuxName: "recv", State: "killed",
	}); err != nil {
		t.Fatal(err)
	}
	if err := h.st.AddSession(store.Session{
		ID: "sender", Agent: "claude-code",
		WorktreePath: "/tmp/sender", TmuxName: "sender", State: "running",
	}); err != nil {
		t.Fatal(err)
	}
	// The sender is busy, so the notice stays queued where the test can read it.
	h.ac.set("sender", activity.Active)

	id, err := h.st.AddMessage(store.Message{FromSession: "sender", ToSession: "recv", Body: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	h.q.Wake("recv")

	waitUntil(t, func() bool { return messageStatus(t, h.st, id) == "failed" }, "message failed for the killed recipient")
	msg, err := h.st.GetMessage(id)
	if err != nil || msg.Reason != "recipient_gone" {
		t.Fatalf("message = %+v, %v; want reason recipient_gone", msg, err)
	}
	if n := h.rt.callCount(); n != 0 {
		t.Fatalf("Inject called %d times, want 0", n)
	}

	var notice store.Message
	waitUntil(t, func() bool {
		msgs, _ := h.st.ListMessages("sender", 0)
		for _, m := range msgs {
			if m.ToSession == "sender" && m.FromSession == "" {
				notice = m
				return true
			}
		}
		return false
	}, "failure notice queued to the sender")
	if !strings.HasPrefix(notice.Body, "[hopp] Message 1 to recv was not delivered: recipient_gone.") || !strings.Contains(notice.Body, "recipient_gone") ||
		!strings.Contains(notice.Body, "hopp send --wait") {
		t.Errorf("notice = %q", notice.Body)
	}
}

// Review Focus 3: a Claude Code registry record whose tmux pane belongs to
// another tmux session (a rocket or human session) is never used: the
// message is not written to its socket. As in rocket, a recipient on the
// Claude route never falls back to typing into tmux; the message waits.
func TestSocketIgnoresRegistryRecordOfForeignTmuxName(t *testing.T) {
	h, s, cc, incoming := productionSocketFixture(t)
	foreign := cc
	foreign.Tmux = "503-orch:@1.%1"
	writeRegistry(t, s.sessionsDir, foreign)

	sess, err := h.st.GetSession("recv")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Prepare(h.ctx, sess, "hopp", "feedback"); err == nil {
		t.Fatal("Prepare accepted a registry record whose tmux pane is not the recipient's")
	}

	id, err := h.st.AddMessage(store.Message{ToSession: "recv", Body: "feedback"})
	if err != nil {
		t.Fatal(err)
	}
	h.q.Wake("recv")
	select {
	case m := <-incoming:
		t.Fatalf("wrote to the foreign record's socket: %+v", m)
	case <-time.After(time.Second):
	}
	msg, err := h.st.GetMessage(id)
	if err != nil {
		t.Fatal(err)
	}
	if msg.Status != "queued" || msg.DeliveryTransport == ClaudeSocketTransport {
		t.Errorf("message = %+v, want it still queued off the socket route", msg)
	}
	if n := h.rt.callCount(); n != 0 {
		t.Errorf("Inject called %d times, want 0: the Claude route never types into tmux", n)
	}
}
