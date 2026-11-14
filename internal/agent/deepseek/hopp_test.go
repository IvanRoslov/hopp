package deepseek

import (
	"strings"
	"testing"

	"github.com/IvanRoslov/hopp/internal/agent"
)

func TestEnvIsHoppOnly(t *testing.T) {
	env := New().Env(agent.LaunchSpec{SessionID: "s1", ParentID: "p1", WorktreePath: t.TempDir(), SocketPath: "/tmp/hopp.sock"})
	for _, k := range []string{"HOPP_SESSION_ID", "HOPP_PARENT_ID", "HOPP_SOCKET"} {
		if env[k] == "" {
			t.Errorf("missing %s", k)
		}
	}
	for k := range env {
		if strings.HasPrefix(k, "ROCKET_") || k == "HOPP_KIND" || k == "HOPP_PROJECT_ID" || k == "HOPP_REPO_ID" || k == "HOPP_FEATURE" {
			t.Errorf("unexpected variable %s", k)
		}
	}
}
