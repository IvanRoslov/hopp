package pi

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/IvanRoslov/hopp/internal/agent"
)

// An id can be used again after its session was removed (`hopp rm`), so a
// folder's Pi session directory may hold two journals named for the same
// session id. Every reader must take the newest one: Pi names its files
// "<timestamp>_<id>.jsonl", so that is the last in sorted order.

func sameIDJournals(t *testing.T) (home, worktree, oldPath, newPath string, at time.Time) {
	t.Helper()
	home, worktree = t.TempDir(), t.TempDir()
	t.Setenv("PI_CODING_AGENT_DIR", home)
	at = time.Date(2026, 11, 15, 10, 0, 0, 0, time.UTC)
	oldLines := []string{
		piMessageLine(t, "o1", "", "user", "old question", at.Add(-48*time.Hour).UnixMilli()),
		piMessageLineWithStop(t, "o2", "o1", "assistant", "old answer", at.Add(-48*time.Hour+time.Second).UnixMilli(), "stop", ""),
	}
	newLines := []string{
		piMessageLine(t, "n1", "", "user", "new question", at.UnixMilli()),
	}
	oldPath = writeSessionFile(t, home, worktree, "2026-11-13T10-00-00-000Z_s1.jsonl")
	newPath = writeSessionFile(t, home, worktree, "2026-11-15T10-00-00-000Z_s1.jsonl")
	if err := os.WriteFile(oldPath, []byte(strings.Join(oldLines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(newPath, []byte(strings.Join(newLines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Old modification times, so activity comes from the records, not from
	// a freshly written file.
	os.Chtimes(oldPath, piOldMtime.Add(-time.Hour), piOldMtime.Add(-time.Hour))
	os.Chtimes(newPath, piOldMtime, piOldMtime)
	return home, worktree, oldPath, newPath, at
}

func TestFindSessionTakesNewestOfTheSameID(t *testing.T) {
	home, worktree, _, newPath, _ := sameIDJournals(t)
	got, err := findSession(home, worktree, "s1")
	if err != nil || got != newPath {
		t.Fatalf("findSession = %q, %v; want the newer %q", got, err, newPath)
	}
}

func TestReadersUseTheNewestJournalOfTheSameID(t *testing.T) {
	_, worktree, _, newPath, at := sameIDJournals(t)
	p := &Pi{}
	ref := agent.ActivityRef{SessionID: "s1", WorktreePath: worktree}
	ctx := context.Background()

	entries, _, err := p.TranscriptTail(ctx, ref, "")
	if err != nil {
		t.Fatalf("TranscriptTail: %v", err)
	}
	var texts []string
	for _, e := range entries {
		texts = append(texts, e.Text)
	}
	if joined := strings.Join(texts, "|"); !strings.Contains(joined, "new question") || strings.Contains(joined, "old") {
		t.Errorf("chat tail = %q, want only the newer journal", joined)
	}

	_, size, err := p.TranscriptStat(ctx, ref)
	info, _ := os.Stat(newPath)
	if err != nil || size != info.Size() {
		t.Errorf("TranscriptStat size = %d, %v; want the newer journal's %d", size, err, info.Size())
	}

	if found, _, err := p.ConfirmDelivered(ctx, ref, "new question", at.Add(-time.Minute)); err != nil || !found {
		t.Errorf("ConfirmDelivered(new) = %v, %v; want found in the newer journal", found, err)
	}
	if found, _, _ := p.ConfirmDelivered(ctx, ref, "old question", at.Add(-72*time.Hour)); found {
		t.Error("ConfirmDelivered found a message that is only in the older journal")
	}

	// Activity reads the newer journal: it equals the activity of a folder
	// holding only that journal.
	gotState, gotTS, gotErr := p.Activity(ctx, ref)
	home2, worktree2 := t.TempDir(), t.TempDir()
	t.Setenv("PI_CODING_AGENT_DIR", home2)
	only := writeSessionFile(t, home2, worktree2, "2026-11-15T10-00-00-000Z_s1.jsonl")
	b, _ := os.ReadFile(newPath)
	if err := os.WriteFile(only, b, 0o644); err != nil {
		t.Fatal(err)
	}
	os.Chtimes(only, piOldMtime, piOldMtime)
	wantState, wantTS, wantErr := p.Activity(ctx, agent.ActivityRef{SessionID: "s1", WorktreePath: worktree2})
	if gotState != wantState || !gotTS.Equal(wantTS) || (gotErr == nil) != (wantErr == nil) {
		t.Errorf("Activity = %v %v %v; want the newer journal's %v %v %v", gotState, gotTS, gotErr, wantState, wantTS, wantErr)
	}
}

// Usage reads every journal of the folder but counts only records since the
// session's launch, so the older journal of the same id adds nothing.
func TestUsageCountsOnlyTheNewerJournalOfTheSameID(t *testing.T) {
	home, worktree := t.TempDir(), t.TempDir()
	t.Setenv("PI_CODING_AGENT_DIR", home)
	writeUsageSession(t, home, worktree, "2026-11-13T10-00-00-000Z_s1.jsonl", []string{
		`{"type":"message","id":"a","parentId":null,"timestamp":"2026-11-13T10:00:01Z","message":{"role":"assistant","provider":"deepseek","model":"deepseek-flash","usage":{"input":1000,"output":1000}}}`,
	})
	writeUsageSession(t, home, worktree, "2026-11-15T10-00-00-000Z_s1.jsonl", []string{
		`{"type":"message","id":"b","parentId":null,"timestamp":"2026-11-15T10:00:01Z","message":{"role":"assistant","provider":"deepseek","model":"deepseek-flash","usage":{"input":7,"output":3}}}`,
	})
	u, err := (&Pi{}).Usage(context.Background(), worktree, time.Date(2026, 11, 15, 10, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	var in, out int64
	for _, m := range u.Models {
		in += m.Input
		out += m.Output
	}
	if in != 7 || out != 3 {
		t.Errorf("usage input %d output %d, want 7 and 3 from the newer journal only (%+v)", in, out, u)
	}
}
