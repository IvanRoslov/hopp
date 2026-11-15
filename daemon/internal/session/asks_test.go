package session

import (
	"context"
	"testing"

	"github.com/IvanRoslov/hopp/internal/store"
)

// TestEndedSessionWithdrawsItsOpenAsks: kill and a reconcile that finds the
// tmux session gone both withdraw the session's open asks (session_ended).
func TestEndedSessionWithdrawsItsOpenAsks(t *testing.T) {
	e := testManager(t)
	addLiveSession(t, e, "killed1", "", t.TempDir())
	addLiveSession(t, e, "gone1", "", t.TempDir())
	k, _ := e.st.AddAsk(store.Ask{FromSession: "killed1", Body: "k?"})
	g, _ := e.st.AddAsk(store.Ask{FromSession: "gone1", Body: "g?"})
	answered, _ := e.st.AddAsk(store.Ask{FromSession: "killed1", Body: "a?"})
	e.st.AnswerAsk(answered, "", "yes", 1)

	if err := e.m.Kill(context.Background(), "killed1", "killed"); err != nil {
		t.Fatal(err)
	}
	e.rt.Die("gone1")
	if err := e.m.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, id := range []int64{k, g} {
		a, _ := e.st.GetAsk(id)
		if a.Status != store.AskWithdrawn || a.Reason != "session_ended" {
			t.Errorf("ask %d = %+v, want withdrawn session_ended", id, a)
		}
	}
	if a, _ := e.st.GetAsk(answered); a.Status != store.AskAnswered {
		t.Errorf("an answered ask changed: %+v", a)
	}
	found := false
	for _, typ := range eventTypes(t, e.st, "killed1") {
		if typ == "ask.withdrawn" {
			found = true
		}
	}
	if !found {
		t.Error("no ask.withdrawn event")
	}
}
