package runtime

import (
	"strings"
	"testing"
)

// The panes below are captures of agy 1.5.14 in a 120-column tmux pane,
// taken live on 2026-11-21.

const agyRule = "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────"

const agyQueuedPane = `> [from p] line one ML
  line two ML
  Run: sleep 20; then reply ML-OK
○ Running (sleep 20) (ctrl+o to expand)
⣻  Running command...
└ Tip: Use @ to mention files and give the model more context.
▸ [from p] QUEUED-A please reply ACK-A and this is a deliberately long message that should exceed the width of the pa...
▸ [from p] QUEUED-B first line... (alt+m to send immediately)
` + agyRule + `
>
` + agyRule + `
  Press up to edit queued messages                                                         auto · Gemini 3.8 Flash · low
`

const agyOneQueuedPane = `> Run the shell command: sleep 25; echo $HOPP_PROBE   Then report its output.
○ Running (sleep 25; echo $HOPP_PROBE) (ctrl+o to expand)
⣟  Running command...
▸ [from parent-x] Second message: reply SECOND-OK (alt+m to send immediately)
` + agyRule + `
>
` + agyRule + `
  Press up to edit queued messages                                                         auto · Gemini 3.8 Flash · low
`

const agyBusyPane = `> Run the shell command: sleep 25; echo $HOPP_PROBE   Then report its output.
○ Running (sleep 25; echo $HOPP_PROBE) (ctrl+o to expand)
⡿  Running command...
└ Tip: When reviewing a file edit, press f to see the full diff.
` + agyRule + `
>
` + agyRule + `
esc to cancel                                                                              auto · Gemini 3.8 Flash · low
`

const (
	agyQueuedA = "[from p] QUEUED-A please reply ACK-A and this is a deliberately long message that should exceed the width of the pane so we can see how the queue row wraps or truncates it in the terminal user interface of agy END-A"
	agyQueuedB = "[from p] QUEUED-B first line\nQUEUED-B second line reply ACK-B"
)

func TestLooksLikeAgentQueuedAgy(t *testing.T) {
	cases := []struct {
		name, pane, text string
		want             bool
	}{
		{"a whole one-line message", agyOneQueuedPane, "[from parent-x] Second message: reply SECOND-OK", true},
		{"a long line cut short", agyQueuedPane, agyQueuedA, true},
		{"a multi-line message shown by its first line", agyQueuedPane, agyQueuedB, true},
		{"a short first line", strings.Replace(agyOneQueuedPane, "[from parent-x] Second message: reply SECOND-OK", "ok...", 1), "ok\nthanks", true},
		{"another message", agyQueuedPane, "[from p] QUEUED-C not sent", false},
		{"a cut row that is only a short start of the text", strings.Replace(agyOneQueuedPane, "[from parent-x] Second message: reply SECOND-OK", "[from p]...", 1), "[from p] something else entirely", false},
		{"busy without a queue", agyBusyPane, "[from parent-x] Second message: reply SECOND-OK", false},
		{"the turn's own echo is not the queue", agyQueuedPane, "[from p] line one ML\nline two ML\nRun: sleep 20; then reply ML-OK", false},
		{"text still in the composer", strings.Replace(agyOneQueuedPane, agyRule+"\n>\n", agyRule+"\n> [from parent-x] Second message: reply SECOND-OK\n", 1),
			"[from parent-x] Second message: reply SECOND-OK", false},
		{"a ▸ row in output without the queue hint", strings.Replace(agyOneQueuedPane, " (alt+m to send immediately)", "", 1),
			"[from parent-x] Second message: reply SECOND-OK", false},
		{"the queue scrolled into history", agyOneQueuedPane + strings.Repeat("more output\n", 6), "[from parent-x] Second message: reply SECOND-OK", false},
		{"empty text", agyOneQueuedPane, " \n", false},
	}
	for _, c := range cases {
		if got := LooksLikeAgentQueued(c.pane, c.text); got != c.want {
			t.Errorf("%s: LooksLikeAgentQueued = %v, want %v", c.name, got, c.want)
		}
	}
}

// The same panes as tmux captures them with -e: «>» is painted blue and the
// empty composer's hint grey (SGR 90), which is not the dim attribute.
func TestLooksLikeUserDraftAgy(t *testing.T) {
	const prompt = "\x1b[94m>\x1b[39m "
	footer := "? for shortcuts                                                                            auto · Gemini 3.8 Flash · low\n"
	history := "────────────────────────────────────────────────────────────\n> First prompt via -i: reply FIRST-OK\n\n  FIRST-OK\n\n"
	pane := func(composer string) string { return history + agyRule + "\n" + composer + agyRule + "\n" + footer }

	cases := []struct {
		name, pane string
		want       bool
	}{
		{"the mode hint of an empty composer", pane(prompt + "\x1b[90mAuto mode: edits & safe commands auto-approved (shift+tab to cycle)\x1b[39m\n"), false},
		{"plan mode's hint", pane(prompt + "\x1b[90mPlan mode: research & plan only (shift+tab to cycle)\x1b[39m\n"), false},
		{"an empty composer", pane("\x1b[94m>\x1b[39m\n"), false},
		{"a typed draft", pane(prompt + "human draft text\n"), true},
		{"a multi-line draft", pane(prompt + "[from p] line one ML\n  line two ML\n  Run: sleep 20; then reply ML-OK\n"), true},
		{"a busy composer with a queue above it", agyQueuedPane, false},
		{"a quoted line in output has no rule above it", "some output\n> quoted text\nmore output\n" + agyRule + "\n", false},
	}
	for _, c := range cases {
		if got := LooksLikeUserDraft(c.pane); got != c.want {
			t.Errorf("%s: LooksLikeUserDraft = %v, want %v", c.name, got, c.want)
		}
	}
}
