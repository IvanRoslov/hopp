package cli

import (
	"bytes"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// fakeAPI is an HTTP server on a temp unix socket that records every request
// and answers from a route table. It stands in for the daemon: no CLI test
// reaches a real one.
type fakeAPI struct {
	sock string

	mu       sync.Mutex
	requests []recorded
	routes   map[string]func(body []byte) (int, any)
}

type recorded struct {
	Method, Path, Query string
	Body                map[string]any
}

func newFakeAPI(t *testing.T) *fakeAPI {
	t.Helper()
	dir, err := os.MkdirTemp("", "hcli")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	f := &fakeAPI{sock: filepath.Join(dir, "hopp.sock"), routes: map[string]func([]byte) (int, any){}}
	f.routes["GET /v1/health"] = func([]byte) (int, any) {
		return 200, map[string]any{"status": "ok", "pid": 1, "version": "test", "started_at": 0}
	}
	ln, err := net.Listen("unix", f.sock)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(f.serve)}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	// Every test gets fresh global flags and no session of its own unless it
	// sets one.
	flags = globalFlags{}
	t.Setenv("HOPP_SESSION_ID", "")
	t.Setenv("HOPP_HOME", t.TempDir())
	return f
}

func (f *fakeAPI) serve(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	rec := recorded{Method: r.Method, Path: r.URL.Path, Query: r.URL.RawQuery}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &rec.Body)
	}
	f.mu.Lock()
	if r.URL.Path != "/v1/health" {
		f.requests = append(f.requests, rec)
	}
	h := f.routes[r.Method+" "+r.URL.Path]
	f.mu.Unlock()
	if h == nil {
		w.WriteHeader(404)
		w.Write([]byte(`{"error":{"code":"not_found","message":"no route"}}`))
		return
	}
	status, body := h(raw)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
}

func (f *fakeAPI) on(route string, status int, body any) {
	f.routes[route] = func([]byte) (int, any) { return status, body }
}

func (f *fakeAPI) last(t *testing.T) recorded {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.requests) == 0 {
		t.Fatal("no request reached the fake API")
	}
	return f.requests[len(f.requests)-1]
}

// runCLI runs the hopp command line with args against f and returns stdout,
// stderr and the exit code Execute would return.
func runCLI(t *testing.T, f *fakeAPI, args ...string) (string, string, int) {
	t.Helper()
	root := NewRootCmd()
	var out, errOut bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&errOut)
	root.SetArgs(append([]string{"--socket", f.sock}, args...))
	err := root.Execute()
	code := 0
	if err != nil {
		errOut.WriteString(err.Error())
		code = exitCode(err)
	}
	return out.String(), errOut.String(), code
}

var created = map[string]any{"id": "s1", "parent": "", "dir": "/x", "labels": map[string]string{}, "agent": "fake",
	"profile": "", "model": "", "effort": "", "state": "running", "activity": "", "created_at": 1, "updated_at": 1}

func TestRunMakesDirAbsolute(t *testing.T) {
	f := newFakeAPI(t)
	f.on("POST /v1/sessions", 201, created)
	dir := t.TempDir()
	wd, _ := os.Getwd()
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chdir(wd) })

	out, errOut, code := runCLI(t, f, "run", ".")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if strings.TrimSpace(out) != "s1" {
		t.Errorf("stdout = %q, want the session id", out)
	}
	want, _ := filepath.EvalSymlinks(dir)
	got, _ := filepath.EvalSymlinks(f.last(t).Body["dir"].(string))
	if got != want || !filepath.IsAbs(f.last(t).Body["dir"].(string)) {
		t.Errorf("dir = %v, want absolute %s", f.last(t).Body["dir"], dir)
	}
}

func TestRunParentFromEnv(t *testing.T) {
	f := newFakeAPI(t)
	f.on("POST /v1/sessions", 201, created)
	dir := t.TempDir()
	t.Setenv("HOPP_SESSION_ID", "p1")
	for _, tc := range []struct {
		args []string
		want any
	}{
		{nil, "p1"},
		{[]string{"--no-parent"}, nil},
		{[]string{"--parent", "x"}, "x"},
	} {
		_, errOut, code := runCLI(t, f, append([]string{"run", dir}, tc.args...)...)
		if code != 0 {
			t.Fatalf("%v: exit %d: %s", tc.args, code, errOut)
		}
		if got := f.last(t).Body["parent"]; got != tc.want {
			t.Errorf("%v: parent = %v, want %v", tc.args, got, tc.want)
		}
	}
	if _, _, code := runCLI(t, f, "run", dir, "--no-parent", "--parent", "x"); code != 3 {
		t.Errorf("--no-parent with --parent: exit %d, want 3", code)
	}
}

func TestRunLabelsAndEnvParsing(t *testing.T) {
	f := newFakeAPI(t)
	f.on("POST /v1/sessions", 201, created)
	dir := t.TempDir()
	prompt := filepath.Join(t.TempDir(), "prompt.md")
	if err := os.WriteFile(prompt, []byte("be brief\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, errOut, code := runCLI(t, f, "run", dir, "--label", "a=1", "--label", "b=x=y", "--env", "FOO=bar",
		"--system-prompt-file", prompt, "-m", "hello", "--name", "s1", "--agent", "codex", "--model", "m", "--effort", "high",
		"--permission-mode", "plan")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	b := f.last(t).Body
	labels, _ := b["labels"].(map[string]any)
	env, _ := b["env"].(map[string]any)
	if labels["a"] != "1" || labels["b"] != "x=y" || env["FOO"] != "bar" || b["system_prompt"] != "be brief\n" ||
		b["message"] != "hello" || b["id"] != "s1" || b["agent"] != "codex" || b["model"] != "m" || b["effort"] != "high" ||
		b["permission_mode"] != "plan" {
		t.Errorf("body = %v", b)
	}
	n := len(f.requests)
	for _, bad := range [][]string{{"--label", "nokv"}, {"--env", "=x"}, {"-m", "a", "--message-file", prompt}} {
		_, errOut, code := runCLI(t, f, append([]string{"run", dir}, bad...)...)
		if code != 3 || errOut == "" {
			t.Errorf("%v: exit %d, stderr %q; want usage error 3", bad, code, errOut)
		}
	}
	if len(f.requests) != n {
		t.Errorf("a bad flag still sent a request")
	}
}

func TestLsTable(t *testing.T) {
	f := newFakeAPI(t)
	row := map[string]any{"id": "s1", "parent": "p", "dir": "/work", "agent": "codex", "model": "", "state": "running", "activity": "idle"}
	f.on("GET /v1/sessions", 200, map[string]any{"sessions": []any{row}})
	out, errOut, code := runCLI(t, f, "ls", "--all", "--parent", "p", "--label", "a=1")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) != 2 || strings.Join(strings.Fields(lines[0]), " ") != "ID PARENT AGENT MODEL STATE ACTIVITY DIR" ||
		strings.Join(strings.Fields(lines[1]), " ") != "s1 p codex - running idle /work" {
		t.Errorf("table:\n%s", out)
	}
	q := f.last(t).Query
	for _, part := range []string{"all=1", "parent=p", "label=a%3D1"} {
		if !strings.Contains(q, part) {
			t.Errorf("query %q lacks %s", q, part)
		}
	}
}

func TestLsMine(t *testing.T) {
	f := newFakeAPI(t)
	f.on("GET /v1/sessions", 200, map[string]any{"sessions": []any{}})
	if _, _, code := runCLI(t, f, "ls", "--mine"); code != 3 {
		t.Errorf("--mine without HOPP_SESSION_ID: exit %d, want 3", code)
	}
	t.Setenv("HOPP_SESSION_ID", "me")
	if _, errOut, code := runCLI(t, f, "ls", "--mine"); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if q := f.last(t).Query; q != "parent=me" {
		t.Errorf("query = %q, want parent=me", q)
	}
}

func TestKillDone(t *testing.T) {
	f := newFakeAPI(t)
	f.on("POST /v1/sessions/s1/kill", 200, map[string]any{"id": "s1", "state": "done"})
	f.on("POST /v1/sessions/s1/restore", 200, map[string]any{"id": "s1", "state": "running"})
	if _, errOut, code := runCLI(t, f, "kill", "s1", "--done"); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if r := f.last(t); r.Path != "/v1/sessions/s1/kill" || r.Body["final"] != "done" {
		t.Errorf("request = %+v", r)
	}
	if _, errOut, code := runCLI(t, f, "kill", "s1"); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if r := f.last(t); r.Body["final"] != "killed" {
		t.Errorf("default final = %v", r.Body["final"])
	}
	if _, errOut, code := runCLI(t, f, "restore", "s1", "--force"); code != 0 {
		t.Fatalf("restore exit %d: %s", code, errOut)
	}
	if r := f.last(t); r.Path != "/v1/sessions/s1/restore" || r.Body["force"] != true {
		t.Errorf("restore request = %+v", r)
	}
	f.on("POST /v1/sessions/ghost/kill", 404, map[string]any{"error": map[string]string{"code": "session_not_found", "message": "session not found: ghost"}})
	if _, errOut, code := runCLI(t, f, "kill", "ghost"); code != 1 || !strings.Contains(errOut, "session_not_found") {
		t.Errorf("unknown: exit %d, stderr %q", code, errOut)
	}
}

func TestAttachRunsTheDaemonsCommand(t *testing.T) {
	f := newFakeAPI(t)
	f.on("GET /v1/sessions/s1/attach", 200, map[string]any{"command": []string{"tmux", "attach", "-t", "=s1"}})
	var got []string
	old := execCommand
	execCommand = func(argv []string) error { got = argv; return nil }
	t.Cleanup(func() { execCommand = old })

	t.Setenv("TMUX", "")
	if _, errOut, code := runCLI(t, f, "attach", "s1"); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if strings.Join(got, " ") != "tmux attach -t =s1" {
		t.Errorf("exec = %v", got)
	}
	t.Setenv("TMUX", "/tmp/tmux-1/default,1,0")
	if _, _, code := runCLI(t, f, "attach", "s1"); code != 0 || strings.Join(got, " ") != "tmux switch-client -t =s1" {
		t.Errorf("inside tmux: exit %d, exec %v", code, got)
	}
}

func TestJSONFlagPrintsAPIBody(t *testing.T) {
	f := newFakeAPI(t)
	f.on("POST /v1/sessions", 201, created)
	out, errOut, code := runCLI(t, f, "--json", "run", t.TempDir())
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(out), &got); err != nil || got["id"] != "s1" || got["state"] != "running" {
		t.Errorf("--json output = %q (%v)", out, err)
	}
}
