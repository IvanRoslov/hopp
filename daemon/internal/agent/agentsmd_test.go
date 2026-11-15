package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUpsertAgentsMDLeavesARocketBlockAlone(t *testing.T) {
	dir := t.TempDir()
	const rocketBlock = "<!-- rocket:start -->\nold\n<!-- rocket:end -->\n"
	path := filepath.Join(dir, "AGENTS.md")
	if err := os.WriteFile(path, []byte("intro\n"+rocketBlock), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := UpsertAgentsMD(dir, "new"); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	got := string(b)
	if !strings.Contains(got, rocketBlock) {
		t.Errorf("rocket block was changed: %q", got)
	}
	if !strings.Contains(got, "<!-- hopp:start -->\nnew\n<!-- hopp:end -->") {
		t.Errorf("hopp block missing: %q", got)
	}
}

func TestUpsertAgentsMDReplacesItsOwnBlock(t *testing.T) {
	dir := t.TempDir()
	if err := UpsertAgentsMD(dir, "one"); err != nil {
		t.Fatal(err)
	}
	if err := UpsertAgentsMD(dir, "two"); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(dir, "AGENTS.md"))
	if err != nil {
		t.Fatal(err)
	}
	got := string(b)
	if !strings.Contains(got, "two") || strings.Contains(got, "one") {
		t.Errorf("block not replaced: %q", got)
	}
	if n := strings.Count(got, "<!-- hopp:start -->"); n != 1 {
		t.Errorf("%d hopp blocks, want 1: %q", n, got)
	}
}
