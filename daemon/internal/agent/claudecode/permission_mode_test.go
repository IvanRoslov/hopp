package claudecode

import (
	"reflect"
	"strings"
	"testing"

	"github.com/IvanRoslov/hopp/internal/agent"
)

// No mode: the command is what every hopp Claude launch used before modes
// were honoured.
func TestLaunchCommandWithoutPermissionModeSkipsPermissions(t *testing.T) {
	got := New().LaunchCommand(agent.LaunchSpec{})
	want := []string{"claude", "--dangerously-skip-permissions", "--settings", sessionSettingsJSON}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("cmd = %q, want %q", got, want)
	}
}

// bypassPermissions keeps the command byte-identical to before.
func TestLaunchCommandBypassPermissionsUnchanged(t *testing.T) {
	got := New().LaunchCommand(agent.LaunchSpec{PermissionMode: "bypassPermissions", Model: "m"})
	want := []string{"claude", "--dangerously-skip-permissions", "--settings", sessionSettingsJSON, "--model", "m", "--permission-mode", "bypassPermissions"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("cmd = %q, want %q", got, want)
	}
}

// Any other accepted mode is passed on and the skip flag is left out, so the
// mode takes effect.
func TestLaunchCommandOtherModeDropsSkipFlag(t *testing.T) {
	for _, mode := range []string{"acceptEdits", "auto", "manual", "dontAsk", "plan"} {
		got := New().LaunchCommand(agent.LaunchSpec{PermissionMode: mode})
		want := []string{"claude", "--settings", sessionSettingsJSON, "--permission-mode", mode}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s: cmd = %q, want %q", mode, got, want)
		}
	}
}

func TestValidatePermissionMode(t *testing.T) {
	cc := New().(agent.PermissionModeValidator)
	for _, mode := range []string{"", "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"} {
		if err := cc.ValidatePermissionMode(mode); err != nil {
			t.Errorf("%q: %v", mode, err)
		}
	}
	for _, mode := range []string{"default", "strict", "Manual"} {
		err := cc.ValidatePermissionMode(mode)
		if err == nil {
			t.Errorf("%q accepted", mode)
			continue
		}
		for _, v := range []string{"acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"} {
			if !strings.Contains(err.Error(), v) {
				t.Errorf("%q: error %q does not list %s", mode, err, v)
			}
		}
	}
}
