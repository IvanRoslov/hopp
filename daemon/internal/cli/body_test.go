package cli

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// asTerminal makes stdin look like a terminal (nothing piped in).
func asTerminal(t *testing.T) {
	t.Helper()
	old := stdinIsTerminal
	stdinIsTerminal = func(io.Reader) bool { return true }
	t.Cleanup(func() { stdinIsTerminal = old })
}

// The commands that take a text, each with what an agent most likely
// typed: the body must arrive whole, or the command must refuse (exit 3)
// without sending anything.
func TestTextBodiesArriveOrAreRefused(t *testing.T) {
	file := filepath.Join(t.TempDir(), "body.md")
	doc := "# Отчёт\n\nСтрока с `кодом` и $HOME.\n"
	if err := os.WriteFile(file, []byte(doc), 0o600); err != nil {
		t.Fatal(err)
	}
	blank := filepath.Join(t.TempDir(), "blank.md")
	os.WriteFile(blank, []byte(" \n\t\n"), 0o600)

	type cmdCase struct {
		name  string
		route string
		pre   []string // the command and its session argument, if any
	}
	cmds := []cmdCase{
		{"send", "POST /v1/messages", []string{"send", "you"}},
		{"post", "POST /v1/posts", []string{"post"}},
		{"lesson", "POST /v1/lessons", []string{"lesson"}},
		{"ask", "POST /v1/asks", []string{"ask", "--from", "me"}},
	}
	type tc struct {
		what  string
		args  []string
		stdin string
		tty   bool
		want  string // "" means refused with exit 3
	}
	cases := []tc{
		{"heredoc into a lone dash", []string{"-"}, doc, false, doc},
		{"heredoc into --file -", []string{"--file", "-"}, doc, false, doc},
		{"echo piped into a dash", []string{"-"}, "hi there\n", false, "hi there\n"},
		{"a file", []string{"--file", file}, "", false, doc},
		{"plain text", []string{"привет"}, "", false, "привет"},
		{"text and --file -", []string{"x", "--file", "-"}, doc, false, ""},
		{"text and a file", []string{"x", "--file", file}, "", false, ""},
		{"dash and a file", []string{"-", "--file", file}, "", false, ""},
		{"--file - with nothing piped (a terminal)", []string{"--file", "-"}, "", true, ""},
		{"dash with nothing piped (a terminal)", []string{"-"}, "", true, ""},
		{"heredoc the shell tool dropped (empty stdin)", []string{"--file", "-"}, "", false, ""},
		{"dash with only whitespace on stdin", []string{"-"}, "  \n\n", false, ""},
		{"a whitespace-only text", []string{"   "}, "", false, ""},
		{"a whitespace-only file", []string{"--file", blank}, "", false, ""},
	}
	for _, c := range cmds {
		for _, k := range cases {
			t.Run(c.name+"/"+k.what, func(t *testing.T) {
				if k.tty {
					asTerminal(t)
				}
				f := newFakeAPI(t)
				f.on(c.route, 201, map[string]any{"id": 1, "status": "queued", "body": "x", "from": "me", "labels": map[string]string{},
					"options": []string{}, "attachments": []string{}, "created_at": 1})
				args := append(append([]string{}, c.pre...), k.args...)
				_, errOut, code := runCLIIn(t, f, k.stdin, args...)
				if k.want == "" {
					if code != 3 || errOut == "" {
						t.Fatalf("exit %d, stderr %q; want a usage error (3)", code, errOut)
					}
					if n := len(f.all()); n != 0 {
						t.Fatalf("refused, yet %d request(s) were sent", n)
					}
					return
				}
				if code != 0 {
					t.Fatalf("exit %d: %s", code, errOut)
				}
				if got := f.last(t).Body["body"]; got != k.want {
					t.Errorf("body = %q, want %q", got, k.want)
				}
			})
		}
	}
}

// What the refusals say: the agent must learn what to do instead.
func TestTextRefusalsSayWhatToDo(t *testing.T) {
	f := newFakeAPI(t)
	_, errOut, _ := runCLIIn(t, f, "", "send", "you", "x", "--file", "-")
	if !strings.Contains(errOut, "not both") || !strings.Contains(errOut, "--file -") {
		t.Errorf("both: %q", errOut)
	}
	_, errOut, _ = runCLIIn(t, f, "", "send", "you", "--file", "-")
	if !strings.Contains(errOut, "no message text arrived on stdin") || !strings.Contains(errOut, "--file <path>") {
		t.Errorf("empty stdin: %q", errOut)
	}
	asTerminal(t)
	_, errOut, _ = runCLIIn(t, f, "", "send", "you", "-")
	if !strings.Contains(errOut, "nothing is piped in") {
		t.Errorf("terminal: %q", errOut)
	}
}
