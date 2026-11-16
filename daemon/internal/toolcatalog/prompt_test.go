package toolcatalog

import (
	"strings"
	"testing"
)

func TestPromptListsEnabledToolsOfTheHarness(t *testing.T) {
	tools := []Tool{
		{Name: "fetcher", Description: "Fetch a page", Via: ViaCommand, Enabled: true},
		{Name: "voice", Description: "Speech and music", Via: ViaMCP, MCPServer: "elevenvoice", Harnesses: []string{"claude-code"}, Paid: true, Enabled: true},
		{Name: "refs", Description: "References", Via: ViaGuide, Enabled: false},
		{Name: "render", Description: "Render video", Via: ViaCommand, Paid: true, Enabled: true},
	}
	got := Prompt(tools, "claude-code")
	if !strings.HasPrefix(got, "## Tools\n") {
		t.Errorf("no heading: %q", got)
	}
	for _, want := range []string{
		"- fetcher — Fetch a page\n",
		"- voice — Speech and music (paid) (MCP server elevenvoice)\n",
		"- render — Render video (paid)\n",
		"hopp tools show", "hopp tools rules", "hopp ask", "hopp lesson",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("prompt lacks %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "refs") {
		t.Errorf("a switched-off tool is in the prompt:\n%s", got)
	}
	// Review Focus 5: a tool limited to claude-code is absent for codex.
	codex := Prompt(tools, "codex")
	if strings.Contains(codex, "voice") || !strings.Contains(codex, "fetcher") {
		t.Errorf("codex prompt:\n%s", codex)
	}
	if n := strings.Count(got, "\n1. ") + strings.Count(got, "\n2. ") + strings.Count(got, "\n3. ") + strings.Count(got, "\n4. "); n != 4 {
		t.Errorf("want four numbered rules, got %d:\n%s", n, got)
	}
	if strings.Contains(got, "\n5. ") {
		t.Errorf("more than four rules:\n%s", got)
	}
}

func TestPromptEmpty(t *testing.T) {
	if got := Prompt(nil, "codex"); got != "" {
		t.Errorf("empty catalog: %q", got)
	}
	only := []Tool{{Name: "voice", Description: "d", Via: ViaMCP, MCPServer: "s", Harnesses: []string{"claude-code"}, Enabled: true},
		{Name: "off", Description: "d", Via: ViaGuide}}
	if got := Prompt(only, "codex"); got != "" {
		t.Errorf("nothing available: %q", got)
	}
}

func TestGuideIsEmbedded(t *testing.T) {
	for _, want := range []string{"hopp tools path", "hopp tools check", "tool.yaml", "USAGE.md", "via: command", "via: mcp", "via: guide", "paid", "enabled", "environment"} {
		if !strings.Contains(Guide, want) {
			t.Errorf("guide lacks %q", want)
		}
	}
}
