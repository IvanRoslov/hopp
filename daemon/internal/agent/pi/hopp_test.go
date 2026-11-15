package pi

import (
	"bytes"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/IvanRoslov/hopp/internal/agent"
)

func TestSetupWorkspaceWritesNothingNamedRocket(t *testing.T) {
	dir := t.TempDir()
	spec := agent.LaunchSpec{SessionID: "s1", ParentID: "p1", WorktreePath: dir,
		SystemPrompt: "be brief", SocketPath: "/tmp/hopp.sock"}
	if err := New().SetupWorkspace(spec); err != nil {
		t.Fatal(err)
	}
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		// Only the part of the path below dir counts: t.TempDir() embeds this
		// test's own name, which contains "Rocket".
		rel, _ := filepath.Rel(dir, p)
		b, _ := os.ReadFile(p)
		if strings.Contains(strings.ToLower(rel), "rocket") || bytes.Contains(bytes.ToLower(b), []byte("rocket")) {
			t.Errorf("%s mentions rocket", rel)
		}
		return nil
	})
	b, err := os.ReadFile(filepath.Join(dir, "AGENTS.md"))
	if err != nil || !strings.Contains(string(b), "be brief") {
		t.Errorf("AGENTS.md does not hold the system prompt: %q, %v", b, err)
	}
}

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

func TestNativeEnvIsHopp(t *testing.T) {
	// Keep the per-session runtime directory out of the real /tmp.
	useNativeRoot(t, shortTempDir(t))
	a := New()
	spec := agent.LaunchSpec{SessionID: "s1", WorktreePath: t.TempDir(), SocketPath: "/tmp/hopp.sock"}
	nl, err := a.(agent.NativeLaunchProvider).PrepareNativeLaunch(spec)
	if err != nil {
		t.Skipf("native launch unavailable on this machine: %v", err)
	}
	spec.NativeDelivery = nl
	for k := range a.Env(spec) {
		if strings.HasPrefix(k, "ROCKET_") {
			t.Errorf("unexpected variable %s", k)
		}
	}
}
