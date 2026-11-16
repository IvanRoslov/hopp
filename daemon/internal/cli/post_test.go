package cli

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

var postCreated = map[string]any{"id": 9, "from": "", "labels": map[string]string{}, "body": "x", "attachments": []string{}, "created_at": 1}

func TestPostTextSourcesAndFlags(t *testing.T) {
	f := newFakeAPI(t)
	f.on("POST /v1/posts", 201, postCreated)
	file := filepath.Join(t.TempDir(), "p.md")
	if err := os.WriteFile(file, []byte("from a file\n`code` $HOME\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		stdin string
		args  []string
		want  string
	}{
		{"", []string{"post", "from the argument"}, "from the argument"},
		{"", []string{"post", "-f", file}, "from a file\n`code` $HOME\n"},
		{"from stdin\n", []string{"post"}, "from stdin\n"},
	} {
		out, errOut, code := runCLIIn(t, f, tc.stdin, tc.args...)
		if code != 0 {
			t.Fatalf("%v: exit %d: %s", tc.args, code, errOut)
		}
		if strings.TrimSpace(out) != "9" {
			t.Errorf("%v: stdout %q, want the id", tc.args, out)
		}
		if got := f.last(t).Body["body"]; got != tc.want {
			t.Errorf("%v: body = %q, want %q", tc.args, got, tc.want)
		}
		if _, ok := f.last(t).Body["from"]; ok {
			t.Errorf("%v: from sent outside a session", tc.args)
		}
	}
	if _, errOut, code := runCLI(t, f, "post", "x", "--label", "kind=done", "--attach", "/tmp/a.md", "--attach", "report@2"); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	b := f.last(t).Body
	labels, _ := b["labels"].(map[string]any)
	if labels["kind"] != "done" || !reflect.DeepEqual(b["attachments"], []any{"/tmp/a.md", "report@2"}) {
		t.Errorf("body = %v", b)
	}
}

func TestPostFrom(t *testing.T) {
	f := newFakeAPI(t)
	f.on("POST /v1/posts", 201, postCreated)
	t.Setenv("HOPP_SESSION_ID", "me")
	if _, errOut, code := runCLI(t, f, "post", "x"); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if f.last(t).Body["from"] != "me" {
		t.Errorf("default from = %v", f.last(t).Body["from"])
	}
	if _, errOut, code := runCLI(t, f, "post", "x", "--from", "other"); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if f.last(t).Body["from"] != "other" {
		t.Errorf("--from other = %v", f.last(t).Body["from"])
	}
	if _, errOut, code := runCLI(t, f, "post", "x", "--from", ""); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if from, ok := f.last(t).Body["from"]; ok && from != "" {
		t.Errorf(`--from "" sent from = %v`, from)
	}
}

func TestPostUsageErrors(t *testing.T) {
	f := newFakeAPI(t)
	f.on("POST /v1/posts", 201, postCreated)
	file := filepath.Join(t.TempDir(), "p.md")
	os.WriteFile(file, []byte("x"), 0o600)
	n := len(f.all())
	for _, tc := range []struct {
		stdin string
		args  []string
	}{
		{"", []string{"post", "text", "-f", file}},
		{"", []string{"post"}},
		{"  \n", []string{"post"}},
		{"", []string{"post", "x", "--label", "nokv"}},
	} {
		if _, errOut, code := runCLIIn(t, f, tc.stdin, tc.args...); code != 3 || errOut == "" {
			t.Errorf("%v stdin %q: exit %d, stderr %q; want usage error 3", tc.args, tc.stdin, code, errOut)
		}
	}
	if len(f.all()) != n {
		t.Errorf("a usage error still sent a request")
	}
}

func TestPostsTableAndQuery(t *testing.T) {
	f := newFakeAPI(t)
	f.on("GET /v1/posts", 200, map[string]any{"posts": []map[string]any{
		{"id": 1, "from": "s1", "labels": map[string]string{}, "body": "first\nmore", "attachments": []string{"a.md", "b@1"}, "created_at": time.Now().Unix()},
		{"id": 2, "from": "", "labels": map[string]string{}, "body": "second", "attachments": []string{}, "created_at": time.Now().Unix()},
	}})
	out, errOut, code := runCLI(t, f, "posts")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if !strings.Contains(out, "#1") || !strings.Contains(out, "s1") || !strings.Contains(out, "first") || strings.Contains(out, "more") ||
		!strings.Contains(out, "#2") || !strings.Contains(out, "second") {
		t.Errorf("table = %q", out)
	}
	if f.last(t).Query != "" {
		t.Errorf("default query = %q, want none", f.last(t).Query)
	}
	if _, errOut, code := runCLI(t, f, "posts", "--label", "k=v", "--from", "s1", "--after", "5", "--limit", "10"); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if got, want := f.last(t).Query, "after=5&from=s1&label=k%3Dv&limit=10"; got != want {
		t.Errorf("query %q, want %q", got, want)
	}
	out, _, code = runCLI(t, f, "--json", "posts")
	if code != 0 || !strings.Contains(out, `"posts"`) {
		t.Errorf("--json: exit %d, %q", code, out)
	}
	if _, _, code := runCLI(t, f, "posts", "--label", "nokv"); code != 3 {
		t.Errorf("bad label: exit %d, want 3", code)
	}
}
