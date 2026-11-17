package monitor

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/IvanRoslov/hopp/internal/activity"
	"github.com/IvanRoslov/hopp/internal/agent"
	"github.com/IvanRoslov/hopp/internal/session"
	"github.com/IvanRoslov/hopp/internal/store"
)

// claudeStartMonitor: a Claude Code root "s" launched in a worktree, stopped
// on the folder-trust screen before any journal or binding exists.
func claudeStartMonitor(t *testing.T, fixture string) (*Monitor, *store.Store, *quizFakeRuntime) {
	t.Helper()
	rt := &quizFakeRuntime{fakeRuntime: fakeRuntime{names: []string{"s"}}, captureOut: pane(t, fixture)}
	m, st, _ := testMonitor(t, rt, &fakeProber{}, nil)
	a := claudeMonAgent{&fakeAgent{err: agent.ErrNoSignal}}
	m.resolveAgent = func(string) (agent.Agent, error) { return a, nil }
	m.claudeSessionsDir = t.TempDir()
	seedSession(t, st, store.Session{ID: "s", Agent: "claude", TmuxName: "s", Activity: string(activity.Ready)})
	return m, st, rt
}

func sweepClaude(t *testing.T, m *Monitor, st *store.Store) {
	t.Helper()
	sess, err := st.GetSession("s")
	if err != nil {
		t.Fatal(err)
	}
	m.pollSession(context.Background(), sess, map[string]bool{"s": true}, true)
}

// The orchestrator Ivan launched sat idle on «Quick safety check …». Now it
// is blocked, with the screen's question and options for the human.
func TestClaudeStartScreenBlocksAndAsksQuiz(t *testing.T) {
	m, st, _ := claudeStartMonitor(t, "claude-start-trust.pane")
	sweepClaude(t, m, st)

	sess, _ := st.GetSession("s")
	if sess.Activity != string(activity.Blocked) {
		t.Errorf("activity = %q, want blocked", sess.Activity)
	}
	q, ok := pendingOfSession(t, st, "s")
	if !ok || !q.IsStartScreen() || !q.Permission.Claude || !q.Permission.Unnumbered {
		t.Fatalf("pending = %+v ok=%v, want a Claude Code start-screen quiz", q, ok)
	}
	if q.Questions[0].Header != "Экран Claude Code" || !strings.Contains(q.Permission.Title, "Is this a project you created or one you trust?") {
		t.Errorf("header %q title %q", q.Questions[0].Header, q.Permission.Title)
	}
	var labels []string
	for _, o := range q.Questions[0].Options {
		labels = append(labels, o.Label)
	}
	if want := []string{"No, continue without these permissions", "Yes, I trust this folder"}; !reflect.DeepEqual(labels, want) {
		t.Errorf("options = %q, want %q", labels, want)
	}
}

// Once the screen is gone for two sweeps the quiz closes and the block goes.
func TestClaudeStartScreenClearsWhenGone(t *testing.T) {
	m, st, rt := claudeStartMonitor(t, "claude-start-trust.pane")
	sweepClaude(t, m, st)
	rt.captureOut = pane(t, "claude-start-neg-idle.pane")
	sweepClaude(t, m, st)
	if _, ok := pendingOfSession(t, st, "s"); !ok {
		t.Fatal("closed after one miss")
	}
	sweepClaude(t, m, st)
	if _, ok := pendingOfSession(t, st, "s"); ok {
		t.Fatal("quiz still pending after two misses")
	}
	if sess, _ := st.GetSession("s"); sess.Activity == string(activity.Blocked) {
		t.Errorf("activity stayed blocked")
	}
}

// Only Claude Code's own screen counts, and an idle start is left alone.
func TestClaudeStartScreenOnlyItsOwnScreen(t *testing.T) {
	for _, fixture := range []string{"codex-start-trust.pane", "claude-start-neg-idle.pane"} {
		m, st, _ := claudeStartMonitor(t, fixture)
		sweepClaude(t, m, st)
		if _, ok := pendingOfSession(t, st, "s"); ok {
			t.Errorf("%s: a quiz was raised", fixture)
		}
	}
}

// A root whose journal shows this launch's turn is past its start: the pane
// is not read for the screen.
func TestClaudeStartScreenNotLookedForAfterTheFirstTurn(t *testing.T) {
	m, st, _, _ := claudeMonitorFixture(t)
	rt := &quizFakeRuntime{fakeRuntime: fakeRuntime{names: []string{"s"}}, captureOut: pane(t, "claude-start-trust.pane")}
	m.rt = rt
	sweepClaude(t, m, st)
	if _, ok := pendingOfSession(t, st, "s"); ok {
		t.Fatal("a quiz was raised after the first turn")
	}
}

func pendingOfSession(t *testing.T, st *store.Store, id string) (session.Quiz, bool) {
	t.Helper()
	sess, err := st.GetSession(id)
	if err != nil {
		t.Fatal(err)
	}
	return session.ParseQuiz(sess.PendingQuiz)
}
