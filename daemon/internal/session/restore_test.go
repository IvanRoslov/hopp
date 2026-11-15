package session

import (
	"context"
	"github.com/IvanRoslov/hopp/internal/session/sessiontest"
	"os"
	"reflect"
	"testing"
)

func TestRestoreFromKilled(t *testing.T) {
	e := testManager(t)
	dir := t.TempDir()
	addLiveSession(t, e, "a", "", dir)
	if err := e.m.Kill(context.Background(), "a", "killed"); err != nil {
		t.Fatal(err)
	}
	if err := e.m.Restore(context.Background(), "a", RestoreOpts{}); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if got := sessionState(t, e.st, "a"); got != "running" {
		t.Errorf("state = %q, want running", got)
	}
	if len(e.rt.Created) != 1 || e.rt.Created[0].Name != "a" || e.rt.Created[0].Dir != dir {
		t.Fatalf("Create calls = %+v", e.rt.Created)
	}
	env := e.rt.Created[0].Env
	if env["FOO"] != "bar" || env["HOPP_SESSION_ID"] != "a" || env["HOPP_HOME"] != e.cfg.Home {
		t.Errorf("env = %v", env)
	}
	spec := sessiontest.FakeAgent.LaunchCalls[0]
	if spec.SystemPrompt != "be brief" || spec.FirstMessage != "" || spec.Model != "m1" || spec.Effort != "high" || spec.PermissionMode != "plan" {
		t.Errorf("relaunch spec = %+v", spec)
	}
	if types := eventTypes(t, e.st, "a"); !reflect.DeepEqual(types, []string{"session.killed", "session.restored"}) {
		t.Errorf("events = %v", types)
	}
}

func TestRestoreRunningAndAliveNeedsForce(t *testing.T) {
	e := testManager(t)
	addLiveSession(t, e, "a", "", t.TempDir())
	if err := e.m.Restore(context.Background(), "a", RestoreOpts{}); validationCode(err) != "restore_not_allowed" {
		t.Fatalf("err = %v, want restore_not_allowed", err)
	}
	if len(e.rt.Destroyed)+len(e.rt.Created) != 0 {
		t.Fatalf("runtime touched: destroyed %v, created %d", e.rt.Destroyed, len(e.rt.Created))
	}
	if err := e.m.Restore(context.Background(), "a", RestoreOpts{Force: true}); err != nil {
		t.Fatalf("Restore force: %v", err)
	}
	if !reflect.DeepEqual(e.rt.Destroyed, []string{"a"}) || len(e.rt.Created) != 1 {
		t.Errorf("destroyed %v, created %d", e.rt.Destroyed, len(e.rt.Created))
	}
}

func TestRestoreRunningWithTmuxGone(t *testing.T) {
	e := testManager(t)
	addLiveSession(t, e, "a", "", t.TempDir())
	e.rt.Die("a")
	if err := e.m.Restore(context.Background(), "a", RestoreOpts{}); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if len(e.rt.Destroyed) != 0 || len(e.rt.Created) != 1 {
		t.Errorf("destroyed %v, created %d", e.rt.Destroyed, len(e.rt.Created))
	}
}

func TestRestoreForceRefusesForeignTmux(t *testing.T) {
	e := testManager(t)
	addLiveSession(t, e, "a", "", t.TempDir())
	e.rt.Envs["a"] = map[string]string{}
	err := e.m.Restore(context.Background(), "a", RestoreOpts{Force: true})
	if validationCode(err) != "tmux_not_owned" {
		t.Fatalf("err = %v, want tmux_not_owned", err)
	}
	if len(e.rt.Destroyed)+len(e.rt.Created) != 0 {
		t.Errorf("runtime touched: destroyed %v, created %d", e.rt.Destroyed, len(e.rt.Created))
	}
	if got := sessionState(t, e.st, "a"); got != "errored" {
		t.Errorf("state = %q, want errored", got)
	}
}

func TestRestoreDirGone(t *testing.T) {
	e := testManager(t)
	dir := t.TempDir()
	addLiveSession(t, e, "a", "", dir)
	if err := e.st.UpdateSessionState("a", "killed"); err != nil {
		t.Fatal(err)
	}
	e.rt.Die("a")
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	if err := e.m.Restore(context.Background(), "a", RestoreOpts{}); validationCode(err) != "dir_not_found" {
		t.Fatalf("err = %v, want dir_not_found", err)
	}
	if len(e.rt.Created) != 0 {
		t.Errorf("Create called %d times", len(e.rt.Created))
	}
}

func TestRestoreUnknownAndDone(t *testing.T) {
	e := testManager(t)
	if err := e.m.Restore(context.Background(), "ghost", RestoreOpts{}); validationCode(err) != "session_not_found" {
		t.Errorf("unknown: err = %v", err)
	}
	addLiveSession(t, e, "a", "", t.TempDir())
	if err := e.st.UpdateSessionState("a", "done"); err != nil {
		t.Fatal(err)
	}
	if err := e.m.Restore(context.Background(), "a", RestoreOpts{}); validationCode(err) != "restore_not_allowed" {
		t.Errorf("done: err = %v, want restore_not_allowed", err)
	}
}
