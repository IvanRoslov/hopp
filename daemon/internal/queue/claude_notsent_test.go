package queue

import (
	"context"
	"encoding/json"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/IvanRoslov/hopp/internal/activity"
	"github.com/IvanRoslov/hopp/internal/claudeinstance"
	"github.com/IvanRoslov/hopp/internal/socketmsg"
	"github.com/IvanRoslov/hopp/internal/store"
)

// scriptedSocket answers each send with the next outcome of a list; the last
// one repeats.
type scriptedSocket struct {
	*fakeSocket
	outcomes []SocketOutcome
}

func (s *scriptedSocket) Send(ctx context.Context, v claudeinstance.Snapshot) (SocketOutcome, error) {
	n := s.fakeSocket.sendCount()
	s.fakeSocket.Send(ctx, v)
	if n >= len(s.outcomes) {
		n = len(s.outcomes) - 1
	}
	return s.outcomes[n], nil
}

// notices are the daemon's messages to the sender session.
func notices(t *testing.T, h *testHarness, to string) []store.Message {
	t.Helper()
	msgs, err := h.st.ListMessages(to, 0)
	if err != nil {
		t.Fatal(err)
	}
	var out []store.Message
	for _, m := range msgs {
		if m.ToSession == to && m.FromSession == "" {
			out = append(out, m)
		}
	}
	return out
}

func claudeSenderFixture(t *testing.T, outcomes ...SocketOutcome) (*testHarness, *scriptedSocket, int64) {
	t.Helper()
	h := newTestQueue(t)
	h.addRunningSession(t, "recv", activity.Ready)
	h.addRunningSession(t, "sender", activity.Active)
	f := installClaudeSocket(t, h, true)
	s := &scriptedSocket{f, outcomes}
	h.q.SetSocketSender(s)
	id, err := h.st.AddMessage(store.Message{FromSession: "sender", ToSession: "recv", Body: "answer"})
	if err != nil {
		t.Fatal(err)
	}
	return h, s, id
}

// A send that ended before any byte was written is made again.
func TestClaudeNotSentIsRetriedWithAFreshSend(t *testing.T) {
	h, s, id := claudeSenderFixture(t, SocketNotSent, SocketAccepted)
	msg, _ := h.st.GetMessage(id)
	h.q.deliver(h.ctx, msg)
	got, _ := h.st.GetMessage(id)
	if s.sendCount() != 2 || got.Status != "accepted" || got.Reason != "" || got.Attempts != 1 {
		t.Fatalf("after retry: %+v sends=%d", got, s.sendCount())
	}
	if a, b := s.snapshots[0].WireID, s.snapshots[1].WireID; a == b {
		t.Fatalf("the retry reused the wire id %s", a)
	}
	if n := notices(t, h, "sender"); len(n) != 0 {
		t.Fatalf("a retried message told the sender: %+v", n)
	}
}

// Sends that never get written fail the message after a bounded number of
// tries, and the sender is told once.
func TestClaudeNotSentFailsAfterBoundedTriesAndTellsSenderOnce(t *testing.T) {
	h, s, id := claudeSenderFixture(t, SocketNotSent)
	msg, _ := h.st.GetMessage(id)
	h.q.deliver(h.ctx, msg)
	got, _ := h.st.GetMessage(id)
	if s.sendCount() != claudeNotSentTries || got.Status != "failed" || got.Reason != "claude_not_sent" {
		t.Fatalf("after %d sends: %+v", s.sendCount(), got)
	}
	n := notices(t, h, "sender")
	if len(n) != 1 {
		t.Fatalf("notices = %+v", n)
	}
	want := "[hopp] Message " + itoa(id) + " to recv was not delivered: claude_not_sent."
	if !strings.HasPrefix(n[0].Body, want) {
		t.Fatalf("notice %q, want prefix %q", n[0].Body, want)
	}
	h.q.mu.Lock()
	left := len(h.q.notSent)
	h.q.mu.Unlock()
	if left != 0 {
		t.Fatalf("retry counters left: %d", left)
	}
}

// A refusal by the recipient is final: no retry, one notice.
func TestClaudeDeniedTellsSenderWithoutRetry(t *testing.T) {
	for _, out := range []SocketOutcome{SocketDenied, SocketExpired} {
		t.Run(string(out), func(t *testing.T) {
			h, s, id := claudeSenderFixture(t, out)
			msg, _ := h.st.GetMessage(id)
			h.q.deliver(h.ctx, msg)
			got, _ := h.st.GetMessage(id)
			if s.sendCount() != 1 || got.Status != "failed" || got.Reason != "claude_"+string(out) {
				t.Fatalf("%+v sends=%d", got, s.sendCount())
			}
			n := notices(t, h, "sender")
			if len(n) != 1 || !strings.Contains(n[0].Body, "was not delivered: claude_"+string(out)) {
				t.Fatalf("notices = %+v", n)
			}
		})
	}
}

// The notice about a failed notice is never made: it has no sender.
func TestFailedNoticeMakesNoFurtherNotice(t *testing.T) {
	h, _, _ := claudeSenderFixture(t, SocketNotSent)
	id, _ := h.st.AddMessage(store.Message{ToSession: "recv", Body: "[hopp] Message 1 to x was not delivered: y."})
	msg, _ := h.st.GetMessage(id)
	h.q.deliver(h.ctx, msg)
	got, _ := h.st.GetMessage(id)
	if got.Status != "failed" {
		t.Fatalf("%+v", got)
	}
	for _, who := range []string{"sender", "recv"} {
		for _, m := range notices(t, h, who) {
			if m.ID != id {
				t.Fatalf("a notice was made: %+v", m)
			}
		}
	}
}

// A receipt that fails a sent message tells the sender too.
func TestClaudeDeniedReceiptReportsTheFailure(t *testing.T) {
	h, s, _, _ := productionSocketFixture(t)
	r := socketmsg.NewReceipts("rq-denied")
	defer r.Close()
	s.SetReceipts(r)
	type failure struct {
		id     int64
		reason string
	}
	got := make(chan failure, 2)
	s.SetFailureHandler(func(id int64, reason string) { got <- failure{id, reason} })
	v := claimSocketFixture(t, h, s)
	if out, e := s.Send(h.ctx, v); out != SocketUnknown || e != nil {
		t.Fatalf("silence %s %v", out, e)
	}
	h.st.SetClaudePhase(v.MessageID, v.WireID, v.Target, "unknown", time.Now())
	receipt := validFixtureReceipt(v)
	receipt.Status = "denied"
	c, e := net.DialTimeout("unix", v.ReplyPath, time.Second)
	if e != nil {
		t.Fatal(e)
	}
	raw, _ := json.Marshal(receipt)
	c.Write(append(raw, '\n'))
	c.Close()
	select {
	case f := <-got:
		if f.id != v.MessageID || f.reason != "claude_denied" {
			t.Fatalf("failure %+v", f)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the denial was not reported")
	}
	m, _ := h.st.GetMessage(v.MessageID)
	if m.Status != "failed" || m.Reason != "claude_denied" {
		t.Fatalf("%+v", m)
	}
}

// Only the exact unsent claim is released.
func TestReleaseClaudeNotSentOnlyReleasesTheUnsentClaim(t *testing.T) {
	h, s, _, _ := productionSocketFixture(t)
	v := claimSocketFixture(t, h, s)
	if ok, e := h.st.ReleaseClaudeNotSent(v.MessageID, "other-wire", v.Target); ok || e != nil {
		t.Fatalf("released another wire: %v %v", ok, e)
	}
	if ok, e := h.st.ReleaseClaudeNotSent(v.MessageID, v.WireID, v.Target); !ok || e != nil {
		t.Fatalf("release: %v %v", ok, e)
	}
	m, _ := h.st.GetMessage(v.MessageID)
	if m.Status != "queued" || m.Attempts != 0 || m.DeliveryTransport != "" {
		t.Fatalf("released row %+v", m)
	}
	if _, e := h.st.GetClaudeDelivery(v.MessageID); e == nil {
		t.Fatal("the Claude row stayed")
	}
	// A claim whose send may have been written is never released.
	v = claimSocketFixture(t, h, s)
	h.st.SetClaudePhase(v.MessageID, v.WireID, v.Target, "unknown", time.Now())
	if ok, _ := h.st.ReleaseClaudeNotSent(v.MessageID, v.WireID, v.Target); ok {
		t.Fatal("released a possible write")
	}
}

func itoa(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}
