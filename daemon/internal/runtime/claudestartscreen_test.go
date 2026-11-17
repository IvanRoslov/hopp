package runtime

import (
	"reflect"
	"strings"
	"testing"
)

// Live captures of Claude Code 2.1.326 in a linked git worktree pre-trusted
// under its own path, whose main repository's .claude/settings.json allows
// five tools (claude-start-trust: 120 columns; -80col: 80 columns), and the
// idle start of a worktree without such settings (claude-start-neg-idle).
func TestParseClaudeStartScreen(t *testing.T) {
	for _, fixture := range []string{"claude-start-trust.pane", "claude-start-trust-80col.pane"} {
		t.Run(fixture, func(t *testing.T) {
			pane := readPane(t, fixture)
			p, ok := ParseClaudeStartScreen(pane)
			if !ok {
				t.Fatal("not recognised")
			}
			if p.Title != "Quick safety check: Is this a project you created or one you trust?" {
				t.Errorf("title = %q", p.Title)
			}
			want := []string{"No, continue without these permissions", "Yes, I trust this folder"}
			if !reflect.DeepEqual(p.Options, want) {
				t.Errorf("options = %q, want %q", p.Options, want)
			}
			for _, sub := range []string{"Accessing workspace:", "pre-approves 5 tool permissions", "Read(*)"} {
				if !strings.Contains(p.Context, sub) {
					t.Errorf("context lacks %q:\n%s", sub, p.Context)
				}
			}
			if c := ClaudeStartScreenCursor(pane); c != 0 {
				t.Errorf("cursor = %d, want 0", c)
			}
			// Codex's parser never takes Claude Code's screen.
			if _, ok := ParseStartScreen(pane); ok {
				t.Error("ParseStartScreen took it")
			}
		})
	}
}

func TestParseClaudeStartScreenCursorMoved(t *testing.T) {
	pane := readPane(t, "claude-start-trust.pane")
	pane = strings.Replace(pane, " ❯ No, continue without these permissions", "   No, continue without these permissions", 1)
	pane = strings.Replace(pane, "   Yes, I trust this folder", " ❯ Yes, I trust this folder", 1)
	if c := ClaudeStartScreenCursor(pane); c != 1 {
		t.Errorf("cursor = %d, want 1", c)
	}
}

func TestParseClaudeStartScreenNegatives(t *testing.T) {
	cases := map[string]string{
		"idle start":  readPane(t, "claude-start-neg-idle.pane"),
		"no heading":  strings.Replace(readPane(t, "claude-start-trust.pane"), "Accessing workspace:", "Something else:", 1),
		"no footer":   strings.Replace(readPane(t, "claude-start-trust.pane"), "Enter to confirm · Esc to cancel", "", 1),
		"no cursor":   strings.Replace(readPane(t, "claude-start-trust.pane"), "❯", " ", 1),
		"codex trust": readPane(t, "codex-start-trust.pane"),
		"kimi trust":  readPane(t, "kimi-trust.pane"),
	}
	for name, pane := range cases {
		if _, ok := ParseClaudeStartScreen(pane); ok {
			t.Errorf("%s: recognised", name)
		}
	}
}
