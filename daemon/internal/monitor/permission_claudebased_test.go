package monitor

import (
	"context"
	"testing"
	"time"

	"github.com/IvanRoslov/hopp/internal/activity"
	"github.com/IvanRoslov/hopp/internal/agent"
	"github.com/IvanRoslov/hopp/internal/store"
)

// A DeepSeek session runs the Claude Code binary: in waiting_input with a
// permission dialog on its pane, it gets the pending question like a
// claude-code session.
func TestPermissionReadForClaudeBasedHarness(t *testing.T) {
	rt := &permFakeRuntime{fakeRuntime: fakeRuntime{names: []string{"sess1"}}, pane: pane(t, "permission-bash-rm.pane")}
	m, st, _ := testMonitor(t, rt, &fakeProber{onlyShell: map[string]bool{}}, nil)
	m.resolveAgent = func(name string) (agent.Agent, error) {
		return claudeMonAgent{&fakeAgent{state: activity.WaitingInput, ts: time.Now()}}, nil
	}
	seedSession(t, st, store.Session{ID: "sess1", Agent: "deepseek", TmuxName: "sess1", Activity: "waiting_input"})
	st.UpdateSessionActivity("sess1", "waiting_input", time.Now().Unix())
	sess, _ := st.GetSession("sess1")
	m.pollPermission(context.Background(), sess)
	if q, ok := pendingOf(t, st); !ok || !q.IsPermission() {
		t.Fatalf("no permission question for a DeepSeek session (pending %+v, %v)", q, ok)
	}
}
