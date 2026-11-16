package toolcatalog

import (
	_ "embed"
	"strings"
)

// Guide is the instruction for an agent that adds a tool to the catalog.
//
//go:embed guide.md
var Guide string

// promptRules are the four rules every session's start text carries with
// the tool list. The human's rules.md is not copied in: the agent reads it
// with `hopp tools rules` each time, so a change reaches running sessions.
var promptRules = []string{
	"Before you use a tool, read `hopp tools show NAME`.",
	"Before you choose a tool for a piece of work, read `hopp tools rules`, which is read fresh each time so the human's latest preferences apply.",
	"Before you call a paid tool, ask the human with `hopp ask` and wait for Go, which covers exactly the call or the enumerated batch you asked about.",
	"If the tool you need is missing or switched off, do not silently use another one: ask the human and record it with `hopp lesson`.",
}

// Prompt is the tools section of a session's start text for harness: one
// line per switched-on tool available there, then the four rules. With no
// such tool it is empty.
func Prompt(tools []Tool, harness string) string {
	var b strings.Builder
	n := 0
	for _, t := range tools {
		if !t.Enabled || !t.AvailableIn(harness) {
			continue
		}
		if n == 0 {
			b.WriteString("## Tools\n\n")
		}
		n++
		b.WriteString("- " + t.Name + " — " + t.Description)
		if t.Paid {
			b.WriteString(" (paid)")
		}
		if t.Via == ViaMCP {
			b.WriteString(" (MCP server " + t.MCPServer + ")")
		}
		b.WriteString("\n")
	}
	if n == 0 {
		return ""
	}
	b.WriteString("\n")
	for i, r := range promptRules {
		b.WriteString(string(rune('1'+i)) + ". " + r + "\n")
	}
	return b.String()
}
