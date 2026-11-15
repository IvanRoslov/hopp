package monitor

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/IvanRoslov/hopp/internal/activity"
	"github.com/IvanRoslov/hopp/internal/agent"
)

// PushClaudeUpdate reports why it dropped a hook update ("" when it took
// it), so the handler can log the reason.
func TestPushClaudeUpdateReportsWhy(t *testing.T) {
	for _, tc := range []struct {
		name, want string
		setup      func(*Monitor, *claudeMonProbe)
		session    string
	}{
		{"accepted", "", nil, "s"},
		{"unknown session", "unknown session", nil, "nobody"},
		{"not claude", "not a Claude session", func(m *Monitor, _ *claudeMonProbe) {
			m.resolveAgent = func(string) (agent.Agent, error) { return &fakeAgent{}, nil }
		}, "s"},
		{"resolve", "resolve not verified: ", func(m *Monitor, _ *claudeMonProbe) {
			os.Remove(filepath.Join(m.claudeSessionsDir, "11.json"))
		}, "s"},
		{"validation", "hook validation failed: unqualified Claude activity: launch generation differs", nil, "s"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m, _, p, event := claudeMonitorFixture(t)
			event.HookEventName = "Stop"
			if tc.name == "validation" {
				event.LaunchGeneration = "old"
			}
			if tc.setup != nil {
				tc.setup(m, p)
			}
			got := m.PushClaudeUpdate(context.Background(), tc.session, activity.Ready, event)
			if tc.want == "" && got != "" || tc.want != "" && !strings.HasPrefix(got, tc.want) {
				t.Fatalf("reason = %q, want %q", got, tc.want)
			}
		})
	}
}

// A replay of the last accepted hook is reported as stale.
func TestPushClaudeUpdateReportsStaleReplay(t *testing.T) {
	m, _, _, event := claudeMonitorFixture(t)
	event.HookEventName = "Stop"
	if got := m.PushClaudeUpdate(context.Background(), "s", activity.Ready, event); got != "" {
		t.Fatalf("first: %q", got)
	}
	if got := m.PushClaudeUpdate(context.Background(), "s", activity.Ready, event); got != "stale" {
		t.Fatalf("replay: reason = %q, want stale", got)
	}
}
