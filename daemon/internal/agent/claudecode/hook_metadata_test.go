package claudecode

import (
	"context"
	"encoding/json"
	"github.com/IvanRoslov/hopp/internal/claudeinstance"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestHookExtractsOnlyBoundedMetadata(t *testing.T) {
	for _, tc := range []struct {
		name, input string
		want        bool
	}{
		{"valid", `{"session_id":"target","hook_event_name":"Stop","prompt":"SECRET_PROMPT","tool_input":{"secret":"SECRET_TOOL"},"message":"SECRET_MESSAGE"}`, true},
		{"malformed", "{", false}, {"missing", "", false}, {"oversize", strings.Repeat("x", (16<<10)+1), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			capture := filepath.Join(dir, "capture.json")
			curl := "#!/bin/sh\nprev=''\nfor arg in \"$@\"; do\n if [ \"$prev\" = '-d' ]; then printf '%s' \"$arg\" > \"$HOOK_CAPTURE\"; fi\n prev=\"$arg\"\ndone\n"
			mustWriteHookFixture(t, filepath.Join(dir, "curl"), curl)
			mustWriteHookFixture(t, filepath.Join(dir, "ps"), "#!/bin/sh\nprintf '%s\\n' 'Sun Nov 1 00:00:00 2026'\n")
			// 15s, not rocket's 3s: under a full parallel `go test ./...` the
			// python start-up alone exceeded 3s and the test killed the hook.
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			// Metadata extraction is deterministic here: subprocess startup can
			// legitimately exceed the production best-effort0.5s ps budget
			// under contention. Separate tests exercise real process failure.
			probe := `import os
from types import SimpleNamespace
def run(args, **kwargs):
    assert args == ["ps", "-p", str(int(os.environ["HOPP_HOOK_PID"])), "-o", "lstart="]
    assert kwargs["timeout"] == 0.5 and kwargs["check"] and kwargs["capture_output"] and kwargs["text"]
    assert kwargs["env"]["TZ"] == "UTC" and kwargs["env"]["LC_ALL"] == "C"
    with open(os.environ["HOOK_PS_CALL"], "w") as out:
        out.write(args[2])
    return SimpleNamespace(stdout="Sun Nov 1 00:00:00 2026\n")
`
			mustWriteHookFixture(t, filepath.Join(dir, "subprocess.py"), probe)
			psCall := filepath.Join(dir, "ps-call")
			cmd := activityHookCmd(ctx)
			cmd.Env = []string{"PATH=" + dir + ":" + os.Getenv("PATH"), "HOPP_SOCKET=/tmp/fixture.sock", "HOPP_SESSION_ID=s", "HOPP_CLAUDE_LAUNCH=g", "HOOK_CAPTURE=" + capture, "PYTHONPATH=" + dir, "HOOK_PS_CALL=" + psCall}
			cmd.Stdin = strings.NewReader(tc.input)
			out, runErr := cmd.CombinedOutput()
			if ctx.Err() != nil {
				t.Fatalf("hook still running after the 15s test deadline; its process group was killed: %v %s", runErr, out)
			}
			if e := runErr; e != nil {
				t.Fatalf("hook must be best effort: %v %s", e, out)
			}
			raw, e := os.ReadFile(capture)
			if !tc.want {
				if e == nil {
					t.Fatal("invalid stdin emitted activity")
				}
				return
			}
			if e != nil {
				t.Fatalf("missing metadata capture: %v; output=%s", e, out)
			}
			if _, e := os.ReadFile(psCall); e != nil {
				t.Fatalf("deterministic metadata process fixture not invoked: %v", e)
			}
			if strings.Contains(string(raw), "SECRET_") {
				t.Fatal("input content leaked into metadata")
			}
			var req struct {
				Claude claudeinstance.HookEvent `json:"claude"`
			}
			if e = json.Unmarshal(raw, &req); e != nil || req.Claude.HookEventName != "Stop" || req.Claude.ClaudeSessionID != "target" || req.Claude.LaunchGeneration != "g" || req.Claude.ProducerPID <= 0 || !req.Claude.ProducerStart.Equal(time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)) || req.Claude.At <= 0 {
				t.Fatalf("missing qualified metadata %s %v", raw, e)
			}
		})
	}
}

func mustWriteHookFixture(t *testing.T, path, body string) {
	t.Helper()
	if e := os.WriteFile(path, []byte(body), 0700); e != nil {
		t.Fatal(e)
	}
}

// activityHookCmd runs the activity hook in its own process group. When ctx
// ends, the whole group is killed (the shell, the inline python and anything
// they started), so a stuck run is reported by the test and leaves no
// orphan behind.
func activityHookCmd(ctx context.Context) *exec.Cmd {
	return activityHookCmdWith(ctx, "sh")
}

// activityHookCmdWith is activityHookCmd under the given shell.
func activityHookCmdWith(ctx context.Context, shell string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, shell, "-c", activityHookScript, "hook", "ready")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	cmd.WaitDelay = time.Second
	return cmd
}

func TestHookDropsFailedProcessMetadataWithinBounds(t *testing.T) {
	for _, which := range []string{"nonzero", "malformed start", "timeout"} {
		t.Run(which, func(t *testing.T) {
			dir := t.TempDir()
			capture := filepath.Join(dir, "capture")
			body := "#!/bin/sh\nexit 1\n"
			if which == "malformed start" {
				body = "#!/bin/sh\nprintf '%s\\n' 'invalid process start'\n"
			}
			if which == "timeout" {
				body = "#!/bin/sh\nexec sleep 2\n"
			}
			mustWriteHookFixture(t, filepath.Join(dir, "ps"), body)
			mustWriteHookFixture(t, filepath.Join(dir, "curl"), "#!/bin/sh\nprintf unexpected > \"$HOOK_CAPTURE\"\n")
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			cmd := activityHookCmd(ctx)
			cmd.Env = []string{"PATH=" + dir + ":" + os.Getenv("PATH"), "HOPP_SOCKET=/tmp/fixture.sock", "HOPP_SESSION_ID=s", "HOPP_CLAUDE_LAUNCH=g", "HOOK_CAPTURE=" + capture}
			cmd.Stdin = strings.NewReader(`{"session_id":"target","hook_event_name":"Stop","prompt":"SECRET_PROMPT"}`)
			start := time.Now()
			out, e := cmd.CombinedOutput()
			elapsed := time.Since(start)
			if ctx.Err() != nil {
				t.Fatalf("hook still running after the 3s test deadline; its process group was killed: %v %s", e, out)
			}
			if e != nil || len(out) != 0 || elapsed >= 2*time.Second {
				t.Fatalf("best-effort bound: error=%v elapsed=%s output=%s", e, elapsed, out)
			}
			if _, e := os.Stat(capture); !os.IsNotExist(e) {
				t.Fatalf("failed metadata emitted activity: %v", e)
			}
		})
	}
}

// The hook's 1-second alarm is armed before any other import, so a slow
// interpreter start-up spends the hook's own budget rather than the agent's.
func TestActivityHookArmsAlarmFirst(t *testing.T) {
	i := strings.Index(activityHookScript, "python3 -c '\n")
	if i < 0 {
		t.Fatal("no inline python in the activity hook")
	}
	body := activityHookScript[i+len("python3 -c '\n"):]
	if !strings.HasPrefix(body, "import signal; signal.alarm(1)\n") {
		t.Fatalf("inline python starts with %q, want the alarm first", body[:60])
	}
	if strings.Count(activityHookScript, "signal.alarm(") != 1 {
		t.Error("the alarm must be armed exactly once")
	}
}

// The hook names its own shell as the producer: the process that stays
// alive until curl returns and whose parent is Claude. A command
// substitution's subshell (bash 3.2 as macOS /bin/sh forks one) has already
// exited by the time the daemon checks it. The fake curl, a child of the
// hook's shell, records its parent's pid and start; the payload must carry
// exactly those, under bash-as-sh and dash alike.
func TestHookProducerIsTheHookShell(t *testing.T) {
	shells := []string{"/bin/sh"}
	if _, err := os.Stat("/bin/dash"); err == nil {
		shells = append(shells, "/bin/dash")
	}
	for _, shell := range shells {
		t.Run(filepath.Base(shell), func(t *testing.T) {
			dir := t.TempDir()
			capture := filepath.Join(dir, "capture.json")
			parent := filepath.Join(dir, "parent")
			curl := "#!/bin/sh\nprintf '%s %s' \"$PPID\" \"$(TZ=UTC LC_ALL=C ps -p $PPID -o lstart=)\" > \"$HOOK_PARENT\"\nprev=''\nfor arg in \"$@\"; do\n if [ \"$prev\" = '-d' ]; then printf '%s' \"$arg\" > \"$HOOK_CAPTURE\"; fi\n prev=\"$arg\"\ndone\n"
			mustWriteHookFixture(t, filepath.Join(dir, "curl"), curl)
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			cmd := activityHookCmdWith(ctx, shell)
			cmd.Env = []string{"PATH=" + dir + ":" + os.Getenv("PATH"), "HOPP_SOCKET=/tmp/fixture.sock", "HOPP_SESSION_ID=s", "HOPP_CLAUDE_LAUNCH=g", "HOOK_CAPTURE=" + capture, "HOOK_PARENT=" + parent}
			cmd.Stdin = strings.NewReader(`{"session_id":"target","hook_event_name":"Stop"}`)
			if out, err := cmd.CombinedOutput(); err != nil || ctx.Err() != nil {
				t.Fatalf("hook: %v %s", err, out)
			}
			raw, err := os.ReadFile(capture)
			if err != nil {
				t.Fatalf("no payload: %v", err)
			}
			var req struct {
				Claude claudeinstance.HookEvent `json:"claude"`
			}
			if err := json.Unmarshal(raw, &req); err != nil {
				t.Fatal(err)
			}
			if req.Claude.ProducerPID != cmd.Process.Pid {
				t.Fatalf("producer_pid = %d, want the hook shell %d", req.Claude.ProducerPID, cmd.Process.Pid)
			}
			rec, _ := os.ReadFile(parent)
			pid, lstart, _ := strings.Cut(strings.TrimSpace(string(rec)), " ")
			if pid != strconv.Itoa(cmd.Process.Pid) {
				t.Fatalf("curl's parent %s is not the hook shell %d", pid, cmd.Process.Pid)
			}
			start, err := time.Parse("Mon Jan _2 15:04:05 2006", strings.Join(strings.Fields(lstart), " "))
			if err != nil {
				t.Fatalf("lstart %q: %v", lstart, err)
			}
			if !req.Claude.ProducerStart.Equal(start.UTC()) {
				t.Fatalf("producer_start = %s, want the shell's start %s", req.Claude.ProducerStart, start.UTC())
			}
		})
	}
}
