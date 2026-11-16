package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// runCLIIn is runCLI with stdin.
func runCLIIn(t *testing.T, f *fakeAPI, stdin string, args ...string) (string, string, int) {
	t.Helper()
	root := NewRootCmd()
	var out, errOut bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&errOut)
	root.SetIn(strings.NewReader(stdin))
	root.SetArgs(append([]string{"--socket", f.sock}, args...))
	err := root.Execute()
	code := 0
	if err != nil {
		errOut.WriteString(err.Error())
		code = exitCode(err)
	}
	return out.String(), errOut.String(), code
}

var lessonCreated = map[string]any{"id": 7, "from": "", "labels": map[string]string{}, "body": "x", "status": "new", "created_at": 1, "closed_at": 0}

func TestLessonTextSources(t *testing.T) {
	f := newFakeAPI(t)
	f.on("POST /v1/lessons", 201, lessonCreated)
	file := filepath.Join(t.TempDir(), "l.md")
	if err := os.WriteFile(file, []byte("from a file\n`code` $HOME\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		stdin string
		args  []string
		want  string
	}{
		{"", []string{"lesson", "from the argument"}, "from the argument"},
		{"", []string{"lesson", "-f", file}, "from a file\n`code` $HOME\n"},
		{"from stdin\n", []string{"lesson"}, "from stdin\n"},
		{"ignored stdin", []string{"lesson", "arg wins"}, "arg wins"},
	} {
		out, errOut, code := runCLIIn(t, f, tc.stdin, tc.args...)
		if code != 0 {
			t.Fatalf("%v: exit %d: %s", tc.args, code, errOut)
		}
		if strings.TrimSpace(out) != "7" {
			t.Errorf("%v: stdout %q, want the id", tc.args, out)
		}
		if got := f.last(t).Body["body"]; got != tc.want {
			t.Errorf("%v: body = %q, want %q", tc.args, got, tc.want)
		}
		if _, ok := f.last(t).Body["from"]; ok {
			t.Errorf("%v: from sent outside a session", tc.args)
		}
	}
}

func TestLessonUsageErrors(t *testing.T) {
	f := newFakeAPI(t)
	f.on("POST /v1/lessons", 201, lessonCreated)
	file := filepath.Join(t.TempDir(), "l.md")
	os.WriteFile(file, []byte("x"), 0o600)
	n := len(f.all())
	for _, tc := range []struct {
		stdin string
		args  []string
	}{
		{"", []string{"lesson", "text", "-f", file}},
		{"", []string{"lesson"}},
		{"  \n", []string{"lesson"}},
		{"", []string{"lesson", "x", "--label", "nokv"}},
	} {
		if _, errOut, code := runCLIIn(t, f, tc.stdin, tc.args...); code != 3 || errOut == "" {
			t.Errorf("%v stdin %q: exit %d, stderr %q; want usage error 3", tc.args, tc.stdin, code, errOut)
		}
	}
	if len(f.all()) != n {
		t.Errorf("a usage error still sent a request")
	}
}

func TestLessonFromEnvLabelsAndJSON(t *testing.T) {
	f := newFakeAPI(t)
	f.on("POST /v1/lessons", 201, lessonCreated)
	t.Setenv("HOPP_SESSION_ID", "me")
	out, errOut, code := runCLI(t, f, "--json", "lesson", "x", "--label", "topic=hooks")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	b := f.last(t).Body
	labels, _ := b["labels"].(map[string]any)
	if b["from"] != "me" || labels["topic"] != "hooks" {
		t.Errorf("body = %v", b)
	}
	if !strings.Contains(out, `"status": "new"`) {
		t.Errorf("--json output = %q", out)
	}
}

func TestLessonsTableAndQuery(t *testing.T) {
	f := newFakeAPI(t)
	long := strings.Repeat("я", 90) + "\nsecond line"
	f.on("GET /v1/lessons", 200, map[string]any{"lessons": []map[string]any{
		{"id": 1, "from": "s1", "labels": map[string]string{}, "body": "first\nmore", "status": "new", "created_at": time.Now().Unix(), "closed_at": 0},
		{"id": 2, "from": "", "labels": map[string]string{}, "body": long, "status": "new", "created_at": time.Now().Unix(), "closed_at": 0},
	}})
	out, errOut, code := runCLI(t, f, "lessons")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if !strings.Contains(out, "#1") || !strings.Contains(out, "s1") || !strings.Contains(out, "first") || strings.Contains(out, "more") {
		t.Errorf("table = %q", out)
	}
	if !strings.Contains(out, strings.Repeat("я", 80)+"…") || strings.Contains(out, strings.Repeat("я", 81)) || strings.Contains(out, "second line") {
		t.Errorf("long body not cut at 80 runes: %q", out)
	}
	if f.last(t).Query != "" {
		t.Errorf("default query = %q, want none", f.last(t).Query)
	}
	for args, want := range map[string]string{
		"--all":                 "status=all",
		"--closed":              "status=closed",
		"--label k=v --from s1": "from=s1&label=k%3Dv",
	} {
		if _, errOut, code := runCLI(t, f, append([]string{"lessons"}, strings.Fields(args)...)...); code != 0 {
			t.Fatalf("%s: exit %d: %s", args, code, errOut)
		}
		if got := f.last(t).Query; got != want {
			t.Errorf("%s: query %q, want %q", args, got, want)
		}
	}
	if _, _, code := runCLI(t, f, "lessons", "--all", "--closed"); code != 3 {
		t.Errorf("--all --closed: exit %d, want 3", code)
	}
}

func TestLessonsClose(t *testing.T) {
	f := newFakeAPI(t)
	f.on("POST /v1/lessons/3/close", 200, map[string]any{"id": 3, "status": "closed"})
	f.on("POST /v1/lessons/4/close", 200, map[string]any{"id": 4, "status": "closed"})
	out, errOut, code := runCLI(t, f, "lessons", "close", "3", "#4")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if strings.Fields(out)[0] != "3" || strings.Fields(out)[1] != "4" {
		t.Errorf("stdout = %q", out)
	}
	if _, _, code := runCLI(t, f, "lessons", "close", "abc"); code != 3 {
		t.Errorf("bad id: exit %d, want 3", code)
	}
	if _, _, code := runCLI(t, f, "lessons", "close", "9"); code == 0 {
		t.Errorf("unknown lesson: exit 0")
	}
}
