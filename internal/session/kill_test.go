package session

import (
	"context"
	"reflect"
	"testing"
)

func TestKillStopsDescendantsDeepestFirst(t *testing.T) {
	e := testManager(t)
	dir := t.TempDir()
	addLiveSession(t, e, "a", "", dir)
	addLiveSession(t, e, "b", "a", dir)
	addLiveSession(t, e, "c", "b", dir)
	addLiveSession(t, e, "d", "a", dir)
	if err := e.st.UpdateSessionState("d", "killed"); err != nil {
		t.Fatal(err)
	}
	if err := e.m.Kill(context.Background(), "a", "killed"); err != nil {
		t.Fatalf("Kill: %v", err)
	}
	if !reflect.DeepEqual(e.rt.destroyed, []string{"c", "b", "a"}) {
		t.Errorf("Destroy order = %v, want [c b a]", e.rt.destroyed)
	}
	for _, id := range []string{"a", "b", "c", "d"} {
		if got := sessionState(t, e.st, id); got != "killed" {
			t.Errorf("%s state = %q, want killed", id, got)
		}
	}
	if n := len(eventTypes(t, e.st, "d")); n != 0 {
		t.Errorf("d got %d events, want none", n)
	}
	if types := eventTypes(t, e.st, "a"); !reflect.DeepEqual(types, []string{"session.killed"}) {
		t.Errorf("a events = %v", types)
	}
}

func TestKillDoneState(t *testing.T) {
	e := testManager(t)
	addLiveSession(t, e, "a", "", t.TempDir())
	if err := e.m.Kill(context.Background(), "a", "done"); err != nil {
		t.Fatal(err)
	}
	if got := sessionState(t, e.st, "a"); got != "done" {
		t.Errorf("state = %q, want done", got)
	}
	data, ok, err := e.st.LastSessionEventData("a", "session.state_changed")
	if err != nil || !ok || data["to"] != "done" {
		t.Errorf("state_changed = %v, %v, %v", data, ok, err)
	}
}

func TestKillRejectsUnknownFinalState(t *testing.T) {
	e := testManager(t)
	addLiveSession(t, e, "a", "", t.TempDir())
	if err := e.m.Kill(context.Background(), "a", "errored"); validationCode(err) != "invalid_state" {
		t.Errorf("err = %v, want invalid_state", err)
	}
	if len(e.rt.destroyed) != 0 {
		t.Errorf("Destroy calls = %v", e.rt.destroyed)
	}
}

func TestKillTerminalIsNoop(t *testing.T) {
	e := testManager(t)
	addLiveSession(t, e, "a", "", t.TempDir())
	if err := e.st.UpdateSessionState("a", "errored"); err != nil {
		t.Fatal(err)
	}
	if err := e.m.Kill(context.Background(), "a", "killed"); err != nil {
		t.Fatalf("Kill terminal: %v", err)
	}
	if got := sessionState(t, e.st, "a"); got != "errored" {
		t.Errorf("state = %q, want errored left alone", got)
	}
	if len(e.rt.destroyed) != 0 {
		t.Errorf("Destroy calls = %v", e.rt.destroyed)
	}
}

func TestKillUnknownSession(t *testing.T) {
	e := testManager(t)
	if err := e.m.Kill(context.Background(), "ghost", "killed"); validationCode(err) != "session_not_found" {
		t.Errorf("err = %v, want session_not_found", err)
	}
}

func TestKillRefusesForeignTmux(t *testing.T) {
	e := testManager(t)
	addLiveSession(t, e, "a", "", t.TempDir())
	// The hopp tmux session died and another program took the name.
	e.rt.envs["a"] = map[string]string{"ROCKET_SESSION_ID": "a"}
	err := e.m.Kill(context.Background(), "a", "killed")
	if validationCode(err) != "tmux_not_owned" {
		t.Fatalf("err = %v, want tmux_not_owned", err)
	}
	if len(e.rt.destroyed) != 0 {
		t.Errorf("Destroy calls = %v, want none", e.rt.destroyed)
	}
	if got := sessionState(t, e.st, "a"); got != "errored" {
		t.Errorf("state = %q, want errored", got)
	}
	data, _, _ := e.st.LastSessionEventData("a", "session.state_changed")
	if data["reason"] != "tmux_not_owned" {
		t.Errorf("state_changed = %v", data)
	}
}

func TestKillWithTmuxAlreadyGone(t *testing.T) {
	e := testManager(t)
	addLiveSession(t, e, "a", "", t.TempDir())
	delete(e.rt.aliveMap, "a")
	if err := e.m.Kill(context.Background(), "a", "killed"); err != nil {
		t.Fatalf("Kill: %v", err)
	}
	if got := sessionState(t, e.st, "a"); got != "killed" {
		t.Errorf("state = %q, want killed", got)
	}
}
