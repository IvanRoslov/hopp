package store

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/IvanRoslov/hopp/internal/claudeinstance"
	"github.com/IvanRoslov/hopp/internal/socketmsg"
)

func count(t *testing.T, st *Store, query string, args ...any) int {
	t.Helper()
	var n int
	if err := st.db.QueryRow(query, args...).Scan(&n); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
	return n
}

func TestRemoveSessionsDeletesOwnedRows(t *testing.T) {
	st := openTestStore(t)
	for _, s := range []Session{
		{ID: "p", Agent: "claude-code", WorktreePath: "/tmp/p", TmuxName: "p", State: "killed"},
		{ID: "c", ParentID: "p", Agent: "claude-code", WorktreePath: "/tmp/c", TmuxName: "c", State: "done"},
		{ID: "keep", Agent: "claude-code", WorktreePath: "/tmp/k", TmuxName: "keep", State: "running"},
	} {
		if err := st.AddSession(s); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now().UTC()
	if err := st.PutClaudeLaunch(claudeinstance.Launch{HoppSessionID: "p", Generation: "g", PaneIdentity: "p:@1.%1", PanePID: 1, PaneStart: now, StartedAt: now}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.OpenPermissionPrompt("c", "Bash?", "", "[]", 1); err != nil {
		t.Fatal(err)
	}
	toP, _ := st.AddMessage(Message{ToSession: "p", Body: "to p"})
	fromCToKeep, _ := st.AddMessage(Message{FromSession: "c", ToSession: "keep", Body: "from c"})
	toKeep, _ := st.AddMessage(Message{ToSession: "keep", Body: "to keep"})
	st.AppendEvent(Event{TS: 1, Type: "x", SessionID: "p"})
	st.AppendEvent(Event{TS: 1, Type: "x", SessionID: "c"})
	st.AppendEvent(Event{TS: 1, Type: "x", SessionID: "keep"})

	if err := st.RemoveSessions([]string{"p", "c"}); err != nil {
		t.Fatalf("RemoveSessions: %v", err)
	}
	for _, id := range []string{"p", "c"} {
		if _, err := st.GetSession(id); err != ErrNotFound {
			t.Errorf("session %s still there: %v", id, err)
		}
	}
	if n := count(t, st, `SELECT count(*) FROM claude_launches WHERE session_id IN ('p','c')`); n != 0 {
		t.Errorf("claude_launches left: %d", n)
	}
	if n := count(t, st, `SELECT count(*) FROM permission_prompts WHERE session_id IN ('p','c')`); n != 0 {
		t.Errorf("permission_prompts left: %d", n)
	}
	if _, err := st.GetMessage(toP); err != ErrNotFound {
		t.Errorf("message to a removed session still there: %v", err)
	}
	if m, err := st.GetMessage(fromCToKeep); err != nil || m.FromSession != "c" {
		t.Errorf("message from a removed session to a remaining one: %+v %v, want kept with its sender id", m, err)
	}
	if _, err := st.GetMessage(toKeep); err != nil {
		t.Errorf("message to a remaining session: %v", err)
	}
	if n := count(t, st, `SELECT count(*) FROM events WHERE session_id IN ('p','c')`); n != 0 {
		t.Errorf("events left: %d", n)
	}
	if n := count(t, st, `SELECT count(*) FROM events WHERE session_id='keep'`); n != 1 {
		t.Errorf("events of the remaining session: %d, want 1", n)
	}
	if _, err := st.GetSession("keep"); err != nil {
		t.Errorf("remaining session: %v", err)
	}
}

// claudeFixtureFor is claudeStoreFixture for any session id, with its own
// journal and Claude conversation id.
func claudeFixtureFor(t *testing.T, st *Store, id, uuid string) claudeinstance.Snapshot {
	t.Helper()
	now := time.Now().UTC()
	st.AddSession(Session{ID: id, Agent: "claude-code", WorktreePath: "/tmp/" + id, TmuxName: id, State: "running"})
	l := claudeinstance.Launch{HoppSessionID: id, Generation: "g-" + id, PaneIdentity: id + ":@1.%1", PanePID: 10, PaneStart: now, StartedAt: now}
	if e := st.PutClaudeLaunch(l); e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(t.TempDir(), "journal.jsonl")
	os.WriteFile(path, nil, 0600)
	target := claudeinstance.Identity{HoppSessionID: id, LaunchGeneration: "g-" + id, ClaudeSessionID: uuid, PID: 11, ProcessStart: now, PaneIdentity: l.PaneIdentity, Kind: "interactive", PeerProtocol: 1, SocketPath: "/tmp/c.sock", JournalPath: path}
	if ok, e := st.BindClaudeIdentity(target); !ok || e != nil {
		t.Fatalf("bind %v %v", ok, e)
	}
	st.UpdateSessionActivity(id, "ready", now.Unix())
	return claudeinstance.Snapshot{EnvelopeVersion: 1, Transport: "claude-socket-v1", Target: target}
}

func claimNext(t *testing.T, st *Store, base claudeinstance.Snapshot, body string) claudeinstance.Snapshot {
	t.Helper()
	v := base
	var e error
	if v.MessageID, e = st.AddMessage(Message{ToSession: base.Target.HoppSessionID, Body: body}); e != nil {
		t.Fatal(e)
	}
	v.WireID, _ = socketmsg.NewMsgID()
	v.Envelope, _ = socketmsg.EnvelopeWithID(v.WireID, "", "", body)
	if v.Boundary, e = claudeinstance.PinJournalForSend(v.Target); e != nil {
		t.Fatal(e)
	}
	v.PreparedAt = time.Now().UTC()
	v.Deadline = v.PreparedAt.Add(time.Hour)
	if ok, e := st.ClaimClaudeMessage(v); !ok || e != nil {
		t.Fatalf("claim %v %v", ok, e)
	}
	return v
}

// TestRemoveKeepsRemainingSessionsClaudeProof: removing a recipient with a
// delivered Claude message deletes its rows (consumed records go with them by
// cascade), and a remaining session's proofs are untouched: its earlier
// consumed record stays and a delivery claimed before the removal still
// confirms from its own journal afterwards.
func TestRemoveKeepsRemainingSessionsClaudeProof(t *testing.T) {
	st := openTestStore(t)
	gone := claudeFixtureFor(t, st, "gone", "11111111-1111-4111-8111-111111111111")
	keep := claudeFixtureFor(t, st, "keep", "22222222-2222-4222-8222-222222222222")

	g := claimNext(t, st, gone, "feedback")
	if ok, e := st.ConfirmClaudeMessage(g.MessageID, appendClaudeIncoming(t, g, "rec-g"), time.Now()); !ok || e != nil {
		t.Fatalf("confirm gone %v %v", ok, e)
	}
	k1 := claimNext(t, st, keep, "feedback")
	if ok, e := st.ConfirmClaudeMessage(k1.MessageID, appendClaudeIncoming(t, k1, "rec-k1"), time.Now()); !ok || e != nil {
		t.Fatalf("confirm keep 1 %v %v", ok, e)
	}
	k2 := claimNext(t, st, keep, "feedback")

	st.UpdateSessionState("gone", "killed")
	if err := st.RemoveSessions([]string{"gone"}); err != nil {
		t.Fatalf("RemoveSessions: %v", err)
	}
	if n := count(t, st, `SELECT count(*) FROM claude_consumed_records WHERE target_key=?`, gone.Target.ClaudeSessionID); n != 0 {
		t.Errorf("the removed recipient's consumed records: %d, want gone with its messages", n)
	}
	if n := count(t, st, `SELECT count(*) FROM claude_consumed_records WHERE target_key=? AND record_id='rec-k1'`, keep.Target.ClaudeSessionID); n != 1 {
		t.Errorf("the remaining session's consumed record: %d, want 1", n)
	}
	if ok, e := st.ConfirmClaudeMessage(k2.MessageID, appendClaudeIncoming(t, k2, "rec-k2"), time.Now()); !ok || e != nil {
		t.Fatalf("a remaining session's delivery after the removal: %v %v", ok, e)
	}
	if m, _ := st.GetMessage(k2.MessageID); m.Status != "delivered" {
		t.Errorf("status %s", m.Status)
	}
}
