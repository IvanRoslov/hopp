package deepseek

import (
	"slices"
	"testing"

	"github.com/IvanRoslov/hopp/internal/agent"
)

// DeepSeek runs Claude Code, so it honours and validates the permission mode
// the same way.
func TestDeepSeekHonoursPermissionMode(t *testing.T) {
	d := New()
	cmd := d.LaunchCommand(agent.LaunchSpec{PermissionMode: "manual"})
	if slices.Contains(cmd, "--dangerously-skip-permissions") || !slices.Contains(cmd, "manual") {
		t.Errorf("manual: cmd = %q", cmd)
	}
	if cmd := d.LaunchCommand(agent.LaunchSpec{}); !slices.Contains(cmd, "--dangerously-skip-permissions") {
		t.Errorf("no mode: cmd = %q", cmd)
	}
	v, ok := d.(agent.PermissionModeValidator)
	if !ok || v.ValidatePermissionMode("default") == nil || v.ValidatePermissionMode("manual") != nil {
		t.Errorf("DeepSeek should validate modes like Claude Code")
	}
}
