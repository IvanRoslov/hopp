package runtime

import "strings"

// Claude Code's folder-trust start screen, shown before the first turn when
// a folder is not trusted for what its project settings carry:
//
//	 Accessing workspace:
//
//	 /path/to/the/folder
//
//	 Quick safety check: Is this a project you created or one you trust? …
//	 ⚠ This folder pre-approves 5 tool permissions in .claude/settings.json: …
//
//	 ❯ No, continue without these permissions
//	   Yes, I trust this folder
//
//	 Enter to confirm · Esc to cancel
//
// Layouts: live captures of Claude Code 2.1.326
// (internal/runtime/testdata/claude-start-*). The options carry no digits;
// one ❯ marks the cursor.

const (
	// claudeStartHeading opens the screen.
	claudeStartHeading = "Accessing workspace:"
	// claudeStartFooter is the key hint under the options.
	claudeStartFooter = "Enter to confirm"
	// claudeStartRows bounds how far above the footer the heading is looked for.
	claudeStartRows = 40
)

// ParseClaudeStartScreen reports whether the bottom of a pane is Claude
// Code's folder-trust start screen and reads it as a PermissionPrompt: Title
// is its question, Context the rest of the screen above the options, Options
// the choices top to bottom.
func ParseClaudeStartScreen(pane string) (PermissionPrompt, bool) {
	p, _, ok := parseClaudeStartScreen(pane)
	return p, ok
}

// ClaudeStartScreenCursor returns the index into Options of the choice the ❯
// cursor sits on, or -1 when pane shows no such screen.
func ClaudeStartScreenCursor(pane string) int {
	_, cursor, ok := parseClaudeStartScreen(pane)
	if !ok {
		return -1
	}
	return cursor
}

func parseClaudeStartScreen(pane string) (PermissionPrompt, int, bool) {
	rows := visiblePaneRows(pane)
	foot := len(rows) - 1
	for foot >= 0 && strings.TrimSpace(rows[foot]) == "" {
		foot--
	}
	if foot < 0 || !strings.HasPrefix(strings.TrimSpace(rows[foot]), claudeStartFooter) {
		return PermissionPrompt{}, -1, false
	}
	heading := -1
	for i := foot - 1; i >= 0 && foot-i <= claudeStartRows; i-- {
		if strings.TrimSpace(rows[i]) == claudeStartHeading {
			heading = i
			break
		}
	}
	if heading < 0 {
		return PermissionPrompt{}, -1, false
	}

	// The options: the run of non-blank rows right above the footer.
	end := foot - 1
	for end > heading && strings.TrimSpace(rows[end]) == "" {
		end--
	}
	start := end
	for start > heading && strings.TrimSpace(rows[start-1]) != "" {
		start--
	}
	var options []string
	cursor, cursors := -1, 0
	for _, r := range rows[start : end+1] {
		t := strings.TrimSpace(r)
		if rest, ok := strings.CutPrefix(t, "❯"); ok {
			cursors++
			cursor = len(options)
			t = strings.TrimSpace(rest)
		}
		options = append(options, t)
	}
	if len(options) < 2 || cursors != 1 {
		return PermissionPrompt{}, -1, false
	}

	header := startHeader(rows[heading:start], maxRowWidth(rows))
	title, context := startTitle(header)
	if title == "" {
		return PermissionPrompt{}, -1, false
	}
	return PermissionPrompt{
		Title:   title,
		Context: context,
		Options: options,
		Raw:     strings.Join(tailRows(rows, startRawRows), "\n"),
	}, cursor, true
}
