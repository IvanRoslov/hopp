package session

import (
	"context"
	"os"
	"testing"
)

func TestReconcileKeepsLiveSessions(t *testing.T) {
	e := testManager(t)
	addLiveSession(t, e, "a", "", t.TempDir())
	if err := e.m.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := sessionState(t, e.st, "a"); got != "running" {
		t.Errorf("state = %q, want running", got)
	}
	if len(e.rt.Destroyed)+len(e.rt.Created) != 0 {
		t.Errorf("runtime touched: destroyed %v, created %d", e.rt.Destroyed, len(e.rt.Created))
	}
}

func TestReconcileMarksMissingTmux(t *testing.T) {
	e := testManager(t)
	addLiveSession(t, e, "a", "", t.TempDir())
	e.rt.Die("a")
	if err := e.m.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := sessionState(t, e.st, "a"); got != "errored" {
		t.Errorf("state = %q, want errored", got)
	}
	data, _, _ := e.st.LastSessionEventData("a", "session.state_changed")
	if data["reason"] != "tmux_missing" || data["from"] != "running" {
		t.Errorf("state_changed = %v", data)
	}
}

func TestReconcileMarksMissingDirWithoutDestroy(t *testing.T) {
	e := testManager(t)
	dir := t.TempDir()
	addLiveSession(t, e, "a", "", dir)
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	if err := e.m.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := sessionState(t, e.st, "a"); got != "errored" {
		t.Errorf("state = %q, want errored", got)
	}
	data, _, _ := e.st.LastSessionEventData("a", "session.state_changed")
	if data["reason"] != "dir_missing" {
		t.Errorf("state_changed = %v", data)
	}
	if len(e.rt.Destroyed) != 0 {
		t.Errorf("Destroy calls = %v", e.rt.Destroyed)
	}
}

func TestReconcileIgnoresForeignTmux(t *testing.T) {
	e := testManager(t)
	e.rt.ListNames = []string{"rocket-thing", "my-work"}
	if err := e.m.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	events, err := e.st.ListEvents(0, 0, "")
	if err != nil || len(events) != 0 {
		t.Errorf("events = %+v, %v; want none", events, err)
	}
	if len(e.rt.Destroyed) != 0 {
		t.Errorf("Destroy calls = %v", e.rt.Destroyed)
	}
}

func TestChildrenOutputAttach(t *testing.T) {
	e := testManager(t)
	dir := t.TempDir()
	addLiveSession(t, e, "a", "", dir)
	addLiveSession(t, e, "b", "a", dir)
	kids, err := e.m.Children("a")
	if err != nil || len(kids) != 1 || kids[0].ID != "b" {
		t.Errorf("Children = %+v, %v", kids, err)
	}
	if out, err := e.m.Output(context.Background(), "a", 10); err != nil || out != "fake output" {
		t.Errorf("Output = %q, %v", out, err)
	}
	if argv, err := e.m.AttachCommand("a"); err != nil || len(argv) == 0 || argv[len(argv)-1] != "=a" {
		t.Errorf("AttachCommand = %v, %v", argv, err)
	}
	if _, err := e.m.Output(context.Background(), "ghost", 10); validationCode(err) != "session_not_found" {
		t.Errorf("Output ghost: %v", err)
	}
}
