package session

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/IvanRoslov/hopp/internal/runtime"
	"github.com/IvanRoslov/hopp/internal/store"
)

// TestKillClearsPendingQuiz verifies that transitioning a session to a
// terminal state via Kill clears any pending AskUserQuestion quiz, since a
// terminal session can no longer answer it.
func TestKillClearsPendingQuiz(t *testing.T) {
	e := testManager(t)
	addLiveSession(t, e, "sess1", "", t.TempDir())

	if err := e.st.SetPendingQuiz("sess1", `{"q":1}`); err != nil {
		t.Fatalf("SetPendingQuiz: %v", err)
	}

	if err := e.m.Kill(context.Background(), "sess1", "killed"); err != nil {
		t.Fatalf("Kill: %v", err)
	}

	stored, err := e.st.GetSession("sess1")
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	if stored.PendingQuiz != "" {
		t.Errorf("PendingQuiz after Kill = %q, want empty", stored.PendingQuiz)
	}
}

// TestCompleteClearsPendingQuiz verifies the same for the path that ends a
// session "done" (rocket's Complete; hopp's Kill with final "done").
func TestCompleteClearsPendingQuiz(t *testing.T) {
	e := testManager(t)
	addLiveSession(t, e, "sess1", "", t.TempDir())

	if err := e.st.SetPendingQuiz("sess1", `{"q":1}`); err != nil {
		t.Fatalf("SetPendingQuiz: %v", err)
	}

	if err := e.m.Kill(context.Background(), "sess1", "done"); err != nil {
		t.Fatalf("Kill done: %v", err)
	}

	stored, err := e.st.GetSession("sess1")
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	if stored.PendingQuiz != "" {
		t.Errorf("PendingQuiz after done = %q, want empty", stored.PendingQuiz)
	}
}

// seedPermissionQuiz puts sess1 on the dialog of fixture: journal row and
// pending permission quiz. Returns the test env and the journal row id.
func seedPermissionQuiz(t *testing.T, fixture string) (testEnv, int64) {
	t.Helper()
	e := testManager(t)
	addLiveSession(t, e, "sess1", "", t.TempDir())

	pane := paneFixture(t, fixture)
	p, ok := runtime.ParsePermissionPrompt(pane)
	if !ok {
		t.Fatalf("fixture %s not parsed", fixture)
	}
	id, _, err := e.st.OpenPermissionPrompt("sess1", p.Title, p.Context, "[]", 1)
	if err != nil {
		t.Fatalf("OpenPermissionPrompt: %v", err)
	}
	b, _ := json.Marshal(NewPermissionQuiz(p, id, 1))
	if err := e.st.SetPendingQuiz("sess1", string(b)); err != nil {
		t.Fatalf("SetPendingQuiz: %v", err)
	}
	return e, id
}

func openRowResolved(t *testing.T, st *store.Store, id int64) store.PermissionPromptRow {
	t.Helper()
	r, err := st.GetPermissionPrompt(id)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// A session that ends with a dialog still journalled closes the row, so it
// is not left open forever.
func TestKillClosesOpenPermissionRow(t *testing.T) {
	e, _ := seedPermissionQuiz(t, "permission-bash-rm.pane")
	id, _, _ := e.st.OpenPermissionPrompt("sess1", "x?", "", "[]", 1) // the seeded row is closed by this open; use the new one
	if err := e.m.Kill(context.Background(), "sess1", "killed"); err != nil {
		t.Fatalf("Kill: %v", err)
	}
	if r := openRowResolved(t, e.st, id); r.ResolvedAt == 0 || r.AnsweredVia != "terminal" {
		t.Errorf("row after kill = %+v, want closed via terminal", r)
	}
}

func TestReconcileTmuxMissingClosesOpenPermissionRow(t *testing.T) {
	e, id := seedPermissionQuiz(t, "permission-bash-rm.pane")
	e.rt.Die("sess1")
	if err := e.m.Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if r := openRowResolved(t, e.st, id); r.ResolvedAt == 0 {
		t.Errorf("row after reconcile = %+v, want closed", r)
	}
}
