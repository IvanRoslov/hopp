package claudeinstance

import (
	"strings"
	"testing"
)

// The folders Claude Code 2.1.327 made under CLAUDE_CONFIG_DIR/projects when
// started (claude -p, not logged in) in each of these folders on 2026-11-18;
// caseBase is where the folders were made. "nfd" and "long nfd" name their
// folder in decomposed form, which Claude Code puts in NFC first.
const caseBase = "/private/tmp/claude-501/-Users-ivanroslov-projects-rocket2/1a6e86e2-5c2c-4ed5-b767-a67778f1d895/scratchpad/ccslug/c/"

func TestProjectDirNameMatchesClaudeCode(t *testing.T) {
	for _, c := range []struct{ name, suffix, want string }{
		{"under_score", "a_b", "-private-tmp-claude-501--Users-ivanroslov-projects-rocket2-1a6e86e2-5c2c-4ed5-b767-a67778f1d895-scratchpad-ccslug-c-a-b"},
		{"spaces", "with space", "-private-tmp-claude-501--Users-ivanroslov-projects-rocket2-1a6e86e2-5c2c-4ed5-b767-a67778f1d895-scratchpad-ccslug-c-with-space"},
		{"cyr", "\u043f\u0430\u043f\u043a\u0430", "-private-tmp-claude-501--Users-ivanroslov-projects-rocket2-1a6e86e2-5c2c-4ed5-b767-a67778f1d895-scratchpad-ccslug-c------"},
		{"nfd", "U\u0308-x", "-private-tmp-claude-501--Users-ivanroslov-projects-rocket2-1a6e86e2-5c2c-4ed5-b767-a67778f1d895-scratchpad-ccslug-c---x"},
		{"nfc", "\u00dc-y", "-private-tmp-claude-501--Users-ivanroslov-projects-rocket2-1a6e86e2-5c2c-4ed5-b767-a67778f1d895-scratchpad-ccslug-c---y"},
		{"emoji", "e\U0001f600x", "-private-tmp-claude-501--Users-ivanroslov-projects-rocket2-1a6e86e2-5c2c-4ed5-b767-a67778f1d895-scratchpad-ccslug-c-e--x"},
		{"dots", "v1.2.3", "-private-tmp-claude-501--Users-ivanroslov-projects-rocket2-1a6e86e2-5c2c-4ed5-b767-a67778f1d895-scratchpad-ccslug-c-v1-2-3"},
		{"long", "LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL/MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM", "-private-tmp-claude-501--Users-ivanroslov-projects-rocket2-1a6e86e2-5c2c-4ed5-b767-a67778f1d895-scratchpad-ccslug-c-LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL-5inb2f"},
		{"n200", "pppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp", "-private-tmp-claude-501--Users-ivanroslov-projects-rocket2-1a6e86e2-5c2c-4ed5-b767-a67778f1d895-scratchpad-ccslug-c-pppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp"},
		{"n201", "ppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp", "-private-tmp-claude-501--Users-ivanroslov-projects-rocket2-1a6e86e2-5c2c-4ed5-b767-a67778f1d895-scratchpad-ccslug-c-pppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp-l96s5i"},
		{"long nfd", "U\u0308qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq", "-private-tmp-claude-501--Users-ivanroslov-projects-rocket2-1a6e86e2-5c2c-4ed5-b767-a67778f1d895-scratchpad-ccslug-c--qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq-9jsy5i"},
	} {
		if got := ProjectDirName(caseBase + c.suffix); got != c.want {
			t.Errorf("%s: ProjectDirName = %q\n want %q", c.name, got, c.want)
		}
	}
}

func TestProjectDirNameShortPathsAreOnlyReplaced(t *testing.T) {
	if got := ProjectDirName("/Users/me/.hopp/worktrees/site/fix-the-header"); got != "-Users-me--hopp-worktrees-site-fix-the-header" {
		t.Fatalf("got %q", got)
	}
	// 200 units stay whole; 201 get the hash.
	p200 := "/a/" + strings.Repeat("x", 197)
	if got := ProjectDirName(p200); len(got) != 200 || strings.Contains(got, "x-") {
		t.Fatalf("200 units: got %q", got)
	}
	if got := ProjectDirName(p200 + "x"); len(got) <= 201 || got[200] != '-' {
		t.Fatalf("201 units: got %q", got)
	}
}
