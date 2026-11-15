package usage

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/IvanRoslov/hopp/internal/agent"
	"github.com/IvanRoslov/hopp/internal/agent/pi"
	"github.com/IvanRoslov/hopp/internal/bus"
	"github.com/IvanRoslov/hopp/internal/store"
)

// TestUsageCountsOnlySinceLaunch (Review Focus 5): a folder reused by an
// earlier session of the same harness holds that session's journal too;
// only records since this session's launch (its created_at) are counted.
func TestUsageCountsOnlySinceLaunch(t *testing.T) {
	home, worktree := t.TempDir(), t.TempDir()
	t.Setenv("PI_CODING_AGENT_DIR", home)
	physical, err := filepath.EvalSymlinks(worktree)
	if err != nil {
		t.Fatal(err)
	}
	encoded := strings.NewReplacer("/", "-").Replace(strings.TrimPrefix(physical, "/"))
	dir := filepath.Join(home, "sessions", "--"+encoded+"--")
	os.MkdirAll(dir, 0o755)
	write := func(name, line string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(line+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("2026-11-13T10-00-00-000Z_earlier.jsonl", `{"type":"message","id":"a","parentId":null,"timestamp":"2026-11-13T10:00:01Z","message":{"role":"assistant","provider":"deepseek","model":"deepseek-flash","usage":{"input":1000,"output":1000}}}`)
	write("2026-11-15T10-00-00-000Z_s1.jsonl", `{"type":"message","id":"b","parentId":null,"timestamp":"2026-11-15T10:00:01Z","message":{"role":"assistant","provider":"deepseek","model":"deepseek-flash","usage":{"input":7,"output":3}}}`)

	st, err := store.Open(filepath.Join(t.TempDir(), "hopp.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	launch := time.Date(2026, 11, 15, 10, 0, 0, 0, time.UTC).Unix()
	if err := st.AddSession(store.Session{ID: "s1", Agent: "pi", TmuxName: "s1", WorktreePath: worktree, State: "killed", CreatedAt: launch, UpdatedAt: launch + 60}); err != nil {
		t.Fatal(err)
	}
	c := New(st, bus.New(st), Options{Readers: func(string) (agent.UsageReader, bool) { return &pi.Pi{}, true }})
	if err := c.CollectNow(context.Background(), "s1", 0); err != nil {
		t.Fatal(err)
	}
	stats, models, err := st.GetSessionStats("s1")
	if err != nil {
		t.Fatal(err)
	}
	var in, out int64
	for _, m := range models {
		in += m.Tokens.Input
		out += m.Tokens.Output
	}
	if stats.Status != "ok" || in != 7 || out != 3 {
		t.Fatalf("stats %+v input %d output %d, want ok 7 3 (only since launch)", stats, in, out)
	}
}
