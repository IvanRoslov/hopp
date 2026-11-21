package agy

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/IvanRoslov/hopp/internal/activity"
	"github.com/IvanRoslov/hopp/internal/agent"
)

// The fixture is the journal of a live agy 1.5.14 conversation of 2026-11-21:
// a first prompt given with -i, a three-line message, two messages that
// waited in agy's queue and were recorded as one input, and a turn the human
// cancelled with Esc.
const fixtureConv = "bc78f46a-b140-4531-80ba-1ada963543d6"

// setupHome builds an agy data folder that maps worktree to the fixture
// conversation, and returns the worktree.
func setupHome(t *testing.T) string {
	t.Helper()
	home, worktree := t.TempDir(), t.TempDir()
	prev := homeDir
	homeDir = func() string { return home }
	t.Cleanup(func() { homeDir = prev })

	data, err := os.ReadFile(filepath.Join("testdata", "transcript.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, transcriptPath(fixtureConv), string(data))
	last, _ := json.Marshal(map[string]string{worktree: fixtureConv})
	writeFile(t, filepath.Join(home, "cache", "last_conversations.json"), string(last))
	return worktree
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func at(t *testing.T, s string) time.Time {
	t.Helper()
	v, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func TestLaunchCommandTrustsTheFolderForOneSession(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "agy")
	writeFile(t, bin, "#!/bin/sh\n")
	if err := os.Chmod(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", filepath.Dir(bin))
	dir := t.TempDir()

	cmd := New().LaunchCommand(agent.LaunchSpec{WorktreePath: dir, Model: "gemini-4-neon-high", FirstMessage: "-do it"})
	if len(cmd) != 8 || filepath.Base(cmd[0]) != "agy" {
		t.Fatalf("command = %q", cmd)
	}
	if got := strings.Join(cmd[1:2], " ") + " " + strings.Join(cmd[4:], " "); got != "--dangerously-skip-permissions --model gemini-4-neon-high -i -do it" {
		t.Errorf("flags = %q", got)
	}
	if cmd[2] != "--settings" {
		t.Fatalf("command = %q", cmd)
	}
	var settings struct {
		TrustedWorkspaces []string `json:"trustedWorkspaces"`
	}
	if err := json.Unmarshal([]byte(cmd[3]), &settings); err != nil {
		t.Fatalf("--settings %q: %v", cmd[3], err)
	}
	if len(settings.TrustedWorkspaces) == 0 || settings.TrustedWorkspaces[0] != dir {
		t.Errorf("trustedWorkspaces = %q, want %q first", settings.TrustedWorkspaces, dir)
	}

	bare := New().LaunchCommand(agent.LaunchSpec{WorktreePath: dir})
	if len(bare) != 4 {
		t.Errorf("command without model and first message = %q", bare)
	}
}

func TestSetupWorkspaceWritesAgentsMD(t *testing.T) {
	dir := t.TempDir()
	if err := New().SetupWorkspace(agent.LaunchSpec{WorktreePath: dir, SystemPrompt: "be brief"}); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(dir, "AGENTS.md"))
	if err != nil || !strings.Contains(string(b), "be brief") {
		t.Errorf("AGENTS.md = %q, %v", b, err)
	}
}

func TestActivityFollowsTheLastRecord(t *testing.T) {
	worktree := setupHome(t)
	a := New()
	ref := agent.ActivityRef{WorktreePath: worktree}

	// The fixture ends on a tool call (the cancelled turn).
	state, ts, err := a.Activity(context.Background(), ref)
	if err != nil || state != activity.Active || ts.IsZero() {
		t.Fatalf("Activity = %q, %v, %v; want active", state, ts, err)
	}

	// Cut it after the plain reply «ML-OK» (step 11).
	data, _ := os.ReadFile(transcriptPath(fixtureConv))
	lines := strings.SplitAfter(string(data), "\n")
	writeFile(t, transcriptPath(fixtureConv), strings.Join(lines[:12], ""))
	if state, _, err := a.Activity(context.Background(), ref); err != nil || state != activity.Ready {
		t.Errorf("after a plain reply: Activity = %q, %v; want ready", state, err)
	}

	// The user's input alone: the model is still to answer.
	writeFile(t, transcriptPath(fixtureConv), lines[0])
	if state, _, err := a.Activity(context.Background(), ref); err != nil || state != activity.Active {
		t.Errorf("after the user's input: Activity = %q, %v; want active", state, err)
	}
}

func TestNoJournalIsNoSignal(t *testing.T) {
	worktree := setupHome(t)
	a := New()

	other := agent.ActivityRef{WorktreePath: t.TempDir()}
	if _, _, err := a.Activity(context.Background(), other); !errors.Is(err, agent.ErrNoSignal) {
		t.Errorf("unknown folder: err = %v, want ErrNoSignal", err)
	}

	// A journal last written before this launch belongs to an earlier run.
	later := agent.ActivityRef{WorktreePath: worktree, Since: time.Now().Add(time.Hour)}
	if _, _, err := a.Activity(context.Background(), later); !errors.Is(err, agent.ErrNoSignal) {
		t.Errorf("journal older than the launch: err = %v, want ErrNoSignal", err)
	}
	if _, _, err := a.TranscriptStat(context.Background(), later); !errors.Is(err, agent.ErrNoSignal) {
		t.Errorf("TranscriptStat: err = %v, want ErrNoSignal", err)
	}
}

func TestTranscriptTailReadsChatAndResumes(t *testing.T) {
	worktree := setupHome(t)
	a := New()
	ref := agent.ActivityRef{WorktreePath: worktree}

	entries, cursor, err := a.TranscriptTail(context.Background(), ref, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) < 6 {
		t.Fatalf("entries = %d: %+v", len(entries), entries)
	}
	if e := entries[0]; e.Role != "user" || e.Text != "First prompt via -i: reply FIRST-OK" || e.TS != at(t, "2026-11-21T16:03:45Z").Unix() {
		t.Errorf("first entry = %+v", e)
	}
	if e := entries[1]; e.Role != "assistant" || e.Text != "FIRST-OK" {
		t.Errorf("second entry = %+v", e)
	}
	if e := entries[2]; e.Role != "user" || e.Text != "[from p] line one ML\nline two ML\nRun: sleep 20; then reply ML-OK" {
		t.Errorf("multi-line input = %+v", e)
	}
	if e := entries[3]; e.Role != "tool" || e.ToolName != "run_command" || e.Text != "sleep 20" {
		t.Errorf("tool entry = %+v", e)
	}
	for _, e := range entries {
		if strings.Contains(e.Text, "SYSTEM_MESSAGE") || strings.Contains(e.Text, "ADDITIONAL_METADATA") {
			t.Errorf("agy's own text leaked into chat: %+v", e)
		}
	}

	again, cursor2, err := a.TranscriptTail(context.Background(), ref, cursor)
	if err != nil || len(again) != 0 || cursor2 != cursor {
		t.Errorf("resume at the end: %d entries, cursor %q → %q, %v", len(again), cursor, cursor2, err)
	}

	f, err := os.OpenFile(transcriptPath(fixtureConv), os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString(`{"step_index":15,"type":"PLANNER_RESPONSE","created_at":"2026-11-21T16:05:00Z","content":"new reply"}` + "\n")
	f.Close()
	more, _, err := a.TranscriptTail(context.Background(), ref, cursor)
	if err != nil || len(more) != 1 || more[0].Text != "new reply" {
		t.Errorf("after a new record: %+v, %v", more, err)
	}
}

func TestConfirmDelivered(t *testing.T) {
	worktree := setupHome(t)
	a := New().(*Agy)
	ref := agent.ActivityRef{WorktreePath: worktree}
	ctx := context.Background()
	before := at(t, "2026-11-21T16:03:00Z")

	// Two messages that waited in agy's queue are one record.
	const queuedA = "[from p] QUEUED-A please reply ACK-A and this is a deliberately long message that should exceed the width of the pane so we can see how the queue row wraps or truncates it in the terminal user interface of agy END-A"
	const queuedB = "[from p] QUEUED-B first line\nQUEUED-B second line reply ACK-B"
	for name, text := range map[string]string{"first of a joined record": queuedA, "second of a joined record": queuedB,
		"multi-line": "[from p] line one ML\nline two ML\nRun: sleep 20; then reply ML-OK"} {
		found, when, err := a.ConfirmDelivered(ctx, ref, text, before)
		if err != nil || !found || when.IsZero() {
			t.Errorf("%s: found=%v at=%v err=%v", name, found, when, err)
		}
	}

	if found, _, _ := a.ConfirmDelivered(ctx, ref, "QUEUED-B first line", before); found {
		t.Error("a part of a line must not confirm")
	}
	if found, _, _ := a.ConfirmDelivered(ctx, ref, "never sent", before); found {
		t.Error("text that is not in the journal confirmed")
	}

	// The record is stamped 16:04:13; a paste later in that same second
	// still counts, one in the next second does not.
	if found, _, _ := a.ConfirmDelivered(ctx, ref, queuedB, at(t, "2026-11-21T16:04:13Z").Add(700*time.Millisecond)); !found {
		t.Error("paste in the record's own second: not confirmed")
	}
	if found, _, _ := a.ConfirmDelivered(ctx, ref, queuedB, at(t, "2026-11-21T16:04:14Z")); found {
		t.Error("a record older than the paste confirmed it")
	}

	if _, _, err := a.ConfirmDelivered(ctx, agent.ActivityRef{WorktreePath: t.TempDir()}, queuedB, before); !errors.Is(err, agent.ErrNoSignal) {
		t.Errorf("no journal: err = %v, want ErrNoSignal", err)
	}
}

func TestUsageSumsModelReplies(t *testing.T) {
	worktree := setupHome(t)
	a := New().(*Agy)

	u, err := a.Usage(context.Background(), worktree, time.Time{})
	if err != nil || !u.Found {
		t.Fatalf("Usage = %+v, %v", u, err)
	}
	got := u.Models["gemini-3.8-flash-low"]
	want := agent.Tokens{Input: 9919 + 2138 + 2267 + 2193 + 2271 + 2302 + 2238,
		CacheRead: 7874 + 7977 + 8208 + 8370 + 8610 + 8882, Output: 3 + 42 + 17 + 57 + 28 + 3 + 42, Messages: 7}
	if got != want {
		t.Errorf("tokens = %+v, want %+v", got, want)
	}
	if !u.FirstAt.Equal(at(t, "2026-11-21T16:03:45Z")) || !u.LastAt.Equal(at(t, "2026-11-21T16:04:47Z")) {
		t.Errorf("FirstAt/LastAt = %v / %v", u.FirstAt, u.LastAt)
	}

	// Only the last turn.
	u, err = a.Usage(context.Background(), worktree, at(t, "2026-11-21T16:04:47Z"))
	if err != nil || u.Models["gemini-3.8-flash-low"].Messages != 1 {
		t.Errorf("since the last turn: %+v, %v", u, err)
	}

	// A folder agy never ran in.
	u, err = a.Usage(context.Background(), t.TempDir(), time.Time{})
	if err != nil || u.Found || len(u.Models) != 0 {
		t.Errorf("unknown folder: %+v, %v", u, err)
	}
}

func TestUsageCountsEarlierConversationsFromHistory(t *testing.T) {
	worktree := setupHome(t)
	const earlier = "11111111-2222-3333-4444-555555555555"
	writeFile(t, transcriptPath(earlier),
		`{"step_index":1,"type":"PLANNER_RESPONSE","created_at":"2026-11-20T10:00:00Z","model":"gemini-4-neon-high","input_tokens":5,"cache_read_tokens":7,"output_tokens":11}`+"\n")
	hist, _ := json.Marshal(map[string]string{"display": "hi", "workspace": worktree, "conversationId": earlier})
	other, _ := json.Marshal(map[string]string{"display": "hi", "workspace": "/elsewhere", "conversationId": "99999999-0000-0000-0000-000000000000"})
	writeFile(t, filepath.Join(homeDir(), "history.jsonl"), string(hist)+"\n"+string(other)+"\n")

	u, err := New().(*Agy).Usage(context.Background(), worktree, time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if got := u.Models["gemini-4-neon-high"]; got != (agent.Tokens{Input: 5, CacheRead: 7, Output: 11, Messages: 1}) {
		t.Errorf("earlier conversation = %+v", got)
	}
	if u.Models["gemini-3.8-flash-low"].Messages != 7 {
		t.Errorf("current conversation = %+v", u.Models["gemini-3.8-flash-low"])
	}
}

func TestCatalogReadsAgyModels(t *testing.T) {
	prev := listModels
	t.Cleanup(func() { listModels = prev })

	listModels = func(context.Context) ([]byte, error) {
		return []byte("Fetching available models...\ngemini-4-neon-high\tGemini 4 Neon (High)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n"), nil
	}
	cat, err := New().Catalog(context.Background())
	if err != nil || cat.Source != agent.CatalogSourceCLI || cat.Warning != "" || cat.FetchedAt.IsZero() {
		t.Fatalf("catalog = %+v, %v", cat, err)
	}
	if len(cat.Models) != 2 || cat.Models[0].ID != "gemini-4-neon-high" || cat.Models[0].Name != "Gemini 4 Neon (High)" ||
		!cat.Models[0].Main || len(cat.Models[0].Efforts) != 0 || cat.Models[1].ID != "gemini-3.8-flash-low" {
		t.Errorf("models = %+v", cat.Models)
	}

	listModels = func(context.Context) ([]byte, error) { return nil, errors.New("not signed in") }
	cat, err = New().Catalog(context.Background())
	if err != nil || cat.Source != agent.CatalogSourceBuiltin || !strings.Contains(cat.Warning, "not signed in") || len(cat.Models) == 0 {
		t.Errorf("fallback catalog = %+v, %v", cat, err)
	}

	listModels = func(context.Context) ([]byte, error) { return []byte("Fetching available models...\n"), nil }
	if cat, _ := New().Catalog(context.Background()); cat.Source != agent.CatalogSourceBuiltin || cat.Warning == "" {
		t.Errorf("empty list: catalog = %+v", cat)
	}
}
