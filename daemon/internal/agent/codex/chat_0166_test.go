package codex

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/IvanRoslov/hopp/internal/agent"
)

// fixtureLines reads a testdata rollout (without its session_meta line,
// which writeSessionFile adds) and puts cwd in place of {{CWD}}.
func fixtureLines(t *testing.T, path, cwd string) []string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, l := range strings.Split(strings.TrimRight(string(raw), "\n"), "\n") {
		out = append(out, strings.ReplaceAll(l, "{{CWD}}", cwd))
	}
	return out
}

// codex-0.166.jsonl is the trimmed, sanitized rollout of a live Codex 0.166
// session (one "Reply with OK" turn): it has no event_msg user_message or
// agent_message, only item_completed items and response_item messages.
func TestTranscriptTailReadsCodex0166Turn(t *testing.T) {
	home := withCodexHome(t)
	wt := t.TempDir()
	now := time.Now()
	writeSessionFile(t, home, now, "rollout-0166", wt, fixtureLines(t, "testdata/chat/codex-0.166.jsonl", wt), now)

	entries, _, err := New().TranscriptTail(context.Background(), agent.ActivityRef{WorktreePath: wt}, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %+v, want the user turn and the reply only", entries)
	}
	if entries[0].Role != "user" || entries[0].Text != "Reply with the single word OK and do nothing else." {
		t.Errorf("entries[0] = %+v", entries[0])
	}
	if entries[1].Role != "assistant" || entries[1].Text != "OK" {
		t.Errorf("entries[1] = %+v", entries[1])
	}
	if entries[0].TS == 0 || entries[1].TS < entries[0].TS {
		t.Errorf("timestamps out of order: %+v", entries)
	}
}

// A rollout carrying both shapes for the same turn shows it once, also when
// the legacy records come in a later read than the first item.
func TestTranscriptTailBothShapesShowOnce(t *testing.T) {
	home := withCodexHome(t)
	wt := t.TempDir()
	now := time.Now()
	user := `{"type":"event_msg","timestamp":"2026-11-15T18:47:43.097Z","payload":{"type":"user_message","message":"hello"}}`
	userItem := `{"type":"event_msg","timestamp":"2026-11-15T18:47:43.097Z","payload":{"type":"item_completed","item":{"type":"UserMessage","content":[{"type":"text","text":"hello"}]}}}`
	agentItem := `{"type":"event_msg","timestamp":"2026-11-15T18:47:46.762Z","payload":{"type":"item_completed","item":{"type":"AgentMessage","content":[{"type":"Text","text":"hi"}]}}}`
	agentMsg := `{"type":"event_msg","timestamp":"2026-11-15T18:47:46.763Z","payload":{"type":"agent_message","message":"hi"}}`
	path := writeSessionFile(t, home, now, "rollout-both", wt, []string{user, userItem, agentItem, agentMsg}, now)

	c := New()
	entries, cursor, err := c.TranscriptTail(context.Background(), agent.ActivityRef{WorktreePath: wt}, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 || entries[0].Text != "hello" || entries[1].Text != "hi" {
		t.Fatalf("entries = %+v, want hello and hi once each", entries)
	}

	// The next turn arrives item first; the file already showed legacy
	// records, so the item is dropped and the legacy record shows.
	appendLine(t, path, strings.ReplaceAll(userItem, "hello", "again"))
	entries, cursor, err = c.TranscriptTail(context.Background(), agent.ActivityRef{WorktreePath: wt}, cursor)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("entries = %+v, want none before the legacy record", entries)
	}
	appendLine(t, path, strings.ReplaceAll(user, "hello", "again"))
	entries, _, err = c.TranscriptTail(context.Background(), agent.ActivityRef{WorktreePath: wt}, cursor)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Text != "again" {
		t.Fatalf("entries = %+v, want again once", entries)
	}
}

// A 0.166 rollout read incrementally shows each turn once.
func TestTranscriptTailCodex0166Incremental(t *testing.T) {
	home := withCodexHome(t)
	wt := t.TempDir()
	now := time.Now()
	lines := fixtureLines(t, "testdata/chat/codex-0.166.jsonl", wt)
	cut := 0
	for i, l := range lines {
		if strings.Contains(l, `"AgentMessage"`) {
			cut = i
		}
	}
	path := writeSessionFile(t, home, now, "rollout-0166", wt, lines[:cut], now)
	c := New()
	first, cursor, err := c.TranscriptTail(context.Background(), agent.ActivityRef{WorktreePath: wt}, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, l := range lines[cut:] {
		appendLine(t, path, l)
	}
	second, _, err := c.TranscriptTail(context.Background(), agent.ActivityRef{WorktreePath: wt}, cursor)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 1 || first[0].Role != "user" || len(second) != 1 || second[0].Role != "assistant" || second[0].Text != "OK" {
		t.Fatalf("first = %+v, second = %+v", first, second)
	}
}
