package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func artifactJSON(id int, scope, name string, version int, path string) map[string]any {
	return map[string]any{"id": id, "scope": scope, "name": name, "version": version, "filename": filepath.Base(path), "mime": "text/plain",
		"size": 2048, "sha256": strings.Repeat("a", 64), "path": path, "from": "kid", "labels": map[string]string{}, "created_at": time.Now().Unix()}
}

func sessionTree(f *fakeAPI) {
	f.on("GET /v1/sessions/kid", 200, map[string]any{"id": "kid", "parent": "top"})
	f.on("GET /v1/sessions/top", 200, map[string]any{"id": "top", "parent": ""})
}

func TestArtifactPublish(t *testing.T) {
	f := newFakeAPI(t)
	f.on("POST /v1/artifacts", 201, artifactJSON(1, "top", "my-spec", 3, "/h/artifacts/top/my-spec/v3/My Spec.md"))
	t.Setenv("HOPP_SESSION_ID", "kid")
	dir := t.TempDir()
	src := filepath.Join(dir, "My Spec.md")
	os.WriteFile(src, []byte("x"), 0o644)
	t.Chdir(dir)
	out, errOut, code := runCLI(t, f, "artifact", "publish", "My Spec.md", "--label", "kind=spec")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if strings.TrimSpace(out) != "my-spec@3" {
		t.Errorf("stdout = %q", out)
	}
	b := f.last(t).Body
	labels, _ := b["labels"].(map[string]any)
	if b["from"] != "kid" || b["name"] != "my-spec" || b["path"] != src || labels["kind"] != "spec" {
		t.Errorf("body = %v", b)
	}
	if _, ok := b["scope"]; ok {
		t.Errorf("scope sent without --scope: %v", b)
	}
	if _, errOut, code := runCLI(t, f, "artifact", "publish", src, "--name", "other", "--scope", "shared"); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if b := f.last(t).Body; b["name"] != "other" || b["scope"] != "shared" {
		t.Errorf("body = %v", b)
	}
}

func TestArtifactPublishUnchanged(t *testing.T) {
	f := newFakeAPI(t)
	a := artifactJSON(1, "s", "a", 2, "/h/a.txt")
	a["unchanged"] = true
	f.on("POST /v1/artifacts", 200, a)
	src := filepath.Join(t.TempDir(), "a.txt")
	os.WriteFile(src, []byte("x"), 0o644)
	out, errOut, code := runCLI(t, f, "artifact", "publish", src, "--scope", "s")
	if code != 0 || strings.TrimSpace(out) != "a@2" || !strings.Contains(errOut, "unchanged") {
		t.Errorf("exit %d, stdout %q, stderr %q", code, out, errOut)
	}
}

func TestArtifactPublishUsageErrors(t *testing.T) {
	f := newFakeAPI(t)
	f.on("POST /v1/artifacts", 201, artifactJSON(1, "s", "a", 1, "/h/a"))
	src := filepath.Join(t.TempDir(), "....")
	os.WriteFile(src, []byte("x"), 0o644)
	ok := filepath.Join(t.TempDir(), "ok.txt")
	os.WriteFile(ok, []byte("x"), 0o644)
	n := len(f.all())
	for _, args := range [][]string{
		{"artifact", "publish", ok},                                  // no session, no --scope
		{"artifact", "publish", src, "--scope", "s"},                 // no name can be derived
		{"artifact", "publish", ok, "--scope", "s", "--name", "Bad"}, // bad name
		{"artifact", "publish", ok, "--scope", "s", "--label", "x"},  // bad label
	} {
		if _, errOut, code := runCLI(t, f, args...); code != 3 || errOut == "" {
			t.Errorf("%v: exit %d, stderr %q; want usage error 3", args, code, errOut)
		}
	}
	if len(f.all()) != n {
		t.Errorf("a usage error still sent a request")
	}
}

func TestArtifactsListScopeFromSession(t *testing.T) {
	f := newFakeAPI(t)
	sessionTree(f)
	f.on("GET /v1/artifacts", 200, map[string]any{"artifacts": []map[string]any{
		artifactJSON(1, "top", "spec", 2, "/h/artifacts/top/spec/v2/spec.md"),
	}})
	t.Setenv("HOPP_SESSION_ID", "kid")
	out, errOut, code := runCLI(t, f, "artifacts")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if !strings.Contains(out, "spec@2") || !strings.Contains(out, "top") || !strings.Contains(out, "spec.md") {
		t.Errorf("table = %q", out)
	}
	if got := f.last(t).Query; got != "scope=top" {
		t.Errorf("query = %q, want scope=top", got)
	}
	if _, errOut, code := runCLI(t, f, "artifacts", "--all-versions", "--label", "k=v", "--scope", "s"); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if got := f.last(t).Query; got != "label=k%3Dv&scope=s&versions=1" {
		t.Errorf("query = %q", got)
	}
	t.Setenv("HOPP_SESSION_ID", "")
	if _, errOut, code := runCLI(t, f, "artifacts"); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if got := f.last(t).Query; got != "" {
		t.Errorf("outside a session query = %q, want every scope", got)
	}
	out, _, code = runCLI(t, f, "--json", "artifacts")
	if code != 0 || !strings.Contains(out, `"artifacts"`) {
		t.Errorf("--json: %d %q", code, out)
	}
}

func TestArtifactGet(t *testing.T) {
	f := newFakeAPI(t)
	sessionTree(f)
	f.on("GET /v1/artifacts", 200, map[string]any{"artifacts": []map[string]any{
		artifactJSON(1, "top", "spec", 1, "/h/v1/spec.md"),
		artifactJSON(2, "top", "spec", 2, "/h/v2/spec.md"),
	}})
	t.Setenv("HOPP_SESSION_ID", "kid")
	for arg, want := range map[string]string{"spec": "/h/v2/spec.md", "spec@1": "/h/v1/spec.md"} {
		out, errOut, code := runCLI(t, f, "artifact", "get", arg)
		if code != 0 || strings.TrimSpace(out) != want {
			t.Errorf("get %s: exit %d, %q %s", arg, code, out, errOut)
		}
		if got := f.last(t).Query; got != "name=spec&scope=top&versions=1" {
			t.Errorf("query = %q", got)
		}
	}
	if _, _, code := runCLI(t, f, "artifact", "get", "spec@9"); code == 0 {
		t.Errorf("unknown version: exit 0")
	}
	for _, arg := range []string{"spec@x", "Bad"} {
		if _, _, code := runCLI(t, f, "artifact", "get", arg); code != 3 {
			t.Errorf("get %s: exit %d, want 3", arg, code)
		}
	}
	t.Setenv("HOPP_SESSION_ID", "")
	if _, _, code := runCLI(t, f, "artifact", "get", "spec"); code != 3 {
		t.Errorf("no session, no scope: exit %d, want 3", code)
	}
	if out, _, code := runCLI(t, f, "artifact", "get", "spec", "--scope", "top"); code != 0 || strings.TrimSpace(out) != "/h/v2/spec.md" {
		t.Errorf("--scope: %d %q", code, out)
	}
}
