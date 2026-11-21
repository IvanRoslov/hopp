package runtime

import "strings"

// agyQueueMark starts each row of agy's pending queue.
const agyQueueMark = "▸"

// agyQueueHint ends the last row of agy's pending queue. It is what tells a
// live queue from a «▸» row in the agent's own output.
const agyQueueHint = "(alt+m to send immediately)"

// agyCut is what agy puts where it cut a queue row short.
const agyCut = "..."

// looksLikeAgyQueued reports whether pane shows agy's own pending queue at
// the bottom of the screen holding text. agy, busy with a turn, moves a
// submitted message into rows right above its composer, one row per message
// (seen live with agy 1.5.14):
//
//	▸ [from p] QUEUED-A please reply ACK-A and this is a deliberately long mess...
//	▸ [from p] QUEUED-B first line... (alt+m to send immediately)
//	────────────────────────────────
//	>
//	────────────────────────────────
//	  Press up to edit queued messages                    auto · Gemini 3.8 Flash · low
//
// A row holds the first line of its message and is cut with «...» when that
// line is too wide or more lines follow. So a row matches when it holds the
// whole text, or when it is cut and the text starts with what is visible —
// at least minQueuedPrefix characters of it, or exactly its first line.
//
// The block must be live: its last row carries agyQueueHint and the composer
// between two rules follows it near the bottom. The text must also have left
// the composer.
func looksLikeAgyQueued(pane, text string) bool {
	want := stripWhitespace(text)
	if want == "" {
		return false
	}
	lines := strings.Split(trimTrailingBlank(pane), "\n")

	// The composer's closing rule is the last rule on screen, its opening
	// rule the one before it, with a «>» row right below.
	bottom := -1
	for i := len(lines) - 1; i >= 0; i-- {
		if isComposerRule(lines[i]) {
			bottom = i
			break
		}
	}
	if bottom < 0 || nonBlankLineCount(strings.Join(lines[bottom+1:], "\n")) > queueFooterRows {
		return false
	}
	top := -1
	for i := bottom - 1; i >= 0; i-- {
		if isComposerRule(lines[i]) {
			top = i
			break
		}
	}
	if top < 1 || top+1 >= bottom || !strings.HasPrefix(lines[top+1], ">") {
		return false
	}
	if !strings.HasSuffix(strings.TrimSpace(lines[top-1]), agyQueueHint) {
		return false
	}

	head := []rune(want)
	if len(head) > minQueuedPrefix {
		head = head[:minQueuedPrefix]
	}
	if strings.Contains(stripWhitespace(strings.Join(lines[top+1:bottom], "\n")), string(head)) {
		return false
	}

	firstLine := stripWhitespace(strings.SplitN(strings.TrimSpace(text), "\n", 2)[0])
	for i := top - 1; i >= 0; i-- {
		row, ok := strings.CutPrefix(strings.TrimSpace(lines[i]), agyQueueMark)
		if !ok {
			break
		}
		row = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(row), agyQueueHint))
		shown, cut := strings.CutSuffix(row, agyCut)
		shown = stripWhitespace(shown)
		if shown == "" {
			continue
		}
		if shown == want {
			return true
		}
		if cut && strings.HasPrefix(want, shown) && (shown == firstLine || len([]rune(shown)) >= minQueuedPrefix) {
			return true
		}
	}
	return false
}
