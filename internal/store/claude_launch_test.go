package store

import (
	"errors"
	"github.com/IvanRoslov/hopp/internal/claudeinstance"
	"testing"
	"time"
)

func TestClaudeLaunchGenerationBindingCAS(t *testing.T) {
	st := openTestStore(t)
	if e := st.AddSession(Session{ID: "s", Agent: "deepseek", WorktreePath: "/tmp/s", TmuxName: "s", State: "running"}); e != nil {
		t.Fatal(e)
	}
	now := time.Now().UTC()
	l := claudeinstance.Launch{HoppSessionID: "s", Generation: "g1", PaneIdentity: "s:@1.%1", PanePID: 10, PaneStart: now, StartedAt: now}
	if e := st.PutClaudeLaunch(l); e != nil {
		t.Fatal(e)
	}
	got, pinned, e := st.GetClaudeLaunch("s")
	if e != nil || got.Generation != "g1" || pinned != nil {
		t.Fatalf("launch %+v %v %v", got, pinned, e)
	}
	id := claudeinstance.Identity{HoppSessionID: "s", LaunchGeneration: "g1", ClaudeSessionID: "uuid", PID: 11, ProcessStart: now, PaneIdentity: l.PaneIdentity, Kind: "interactive", PeerProtocol: 1, SocketPath: "/tmp/c.sock", JournalPath: "/tmp/uuid.jsonl"}
	if ok, e := st.BindClaudeIdentity(id); !ok || e != nil {
		t.Fatalf("bind %v %v", ok, e)
	}
	foreign := id
	foreign.PID = 12
	if ok, e := st.BindClaudeIdentity(foreign); ok || e != nil {
		t.Fatalf("overwrite binding %v %v", ok, e)
	}
	if e = st.PutClaudeLaunch(l); e != nil {
		t.Fatal(e)
	}
	_, pinned, e = st.GetClaudeLaunch("s")
	if e != nil || pinned == nil || pinned.PID != 11 {
		t.Fatalf("same generation erased binding %+v %v", pinned, e)
	}
	l.Generation = "g2"

	l.StartedAt = l.StartedAt.Add(time.Nanosecond)
	if e = st.PutClaudeLaunch(l); e != nil {
		t.Fatal(e)
	}
	if ok, e := st.BindClaudeIdentity(id); ok || e != nil {
		t.Fatalf("stale bind %v %v", ok, e)
	}
}

func TestClaudeLaunchNewGenerationClearsActivity(t *testing.T) {
	st := openTestStore(t)
	mustAddSession(t, st, "s")
	if e := st.UpdateSessionActivity("s", "active", 100); e != nil {
		t.Fatal(e)
	}
	now := time.Now().UTC()
	l := claudeinstance.Launch{HoppSessionID: "s", Generation: "g1", StartedAt: now}
	if e := st.PutClaudeLaunch(l); e != nil {
		t.Fatal(e)
	}
	got, e := st.GetSession("s")
	if e != nil || got.Activity != "" || got.ActivityTS != 0 {
		t.Fatalf("activity after new generation = %q/%d, %v; want empty", got.Activity, got.ActivityTS, e)
	}
	if _, _, e := st.GetClaudeLaunch("missing"); !errors.Is(e, ErrNotFound) {
		t.Errorf("GetClaudeLaunch missing = %v, want ErrNotFound", e)
	}
}
