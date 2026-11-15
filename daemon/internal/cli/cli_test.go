package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeAPI is an HTTP server on a temp unix socket that records every request
// and answers from a route table. It stands in for the daemon: no CLI test
// reaches a real one.
type fakeAPI struct {
	sock string

	mu       sync.Mutex
	requests []recorded
	routes   map[string]func(body []byte) (int, any)
	raw      map[string]http.HandlerFunc
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
	rh := f.raw[r.Method+" "+r.URL.Path]
	f.mu.Unlock()
	if rh != nil {
		rh(w, r)
		return
	}
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

// handle serves route with h as is, for answers that are not one JSON body
// (an event stream).
func (f *fakeAPI) handle(route string, h http.HandlerFunc) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.raw == nil {
		f.raw = map[string]http.HandlerFunc{}
	}
	f.raw[route] = h
}

// all returns every recorded request but the health checks.
func (f *fakeAPI) all() []recorded {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]recorded(nil), f.requests...)
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

func TestModelsLsMarksDefault(t *testing.T) {
	f := newFakeAPI(t)
	f.on("GET /v1/model-profiles", 200, map[string]any{"default": "fast", "profiles": []any{
		map[string]any{"name": "fast", "agent": "codex", "model": "", "effort": "low", "description": "quick", "enabled": true},
		map[string]any{"name": "slow", "agent": "claude-code", "model": "opus", "effort": "", "description": "deep", "enabled": false},
	}})
	out, errOut, code := runCLI(t, f, "models", "ls")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) != 3 || !strings.HasPrefix(lines[1], "fast *") || strings.Contains(lines[2], "*") ||
		strings.Join(strings.Fields(lines[2]), " ") != "slow claude-code opus - no deep" {
		t.Errorf("table:\n%s", out)
	}
}

func TestModelsCommandsCallTheAPI(t *testing.T) {
	f := newFakeAPI(t)
	f.on("POST /v1/model-profiles", 201, map[string]any{"name": "x"})
	f.on("PATCH /v1/model-profiles/x", 200, map[string]any{"name": "x"})
	f.on("PUT /v1/model-profiles/default", 200, map[string]any{"default": "x"})
	f.routes["DELETE /v1/model-profiles/x"] = func([]byte) (int, any) { return 204, nil }
	for _, tc := range []struct {
		args       []string
		method     string
		path       string
		wantFields map[string]any
	}{
		{[]string{"models", "add", "x", "--agent", "codex", "--effort", "low"}, "POST", "/v1/model-profiles", map[string]any{"name": "x", "agent": "codex", "effort": "low"}},
		{[]string{"models", "set", "x", "--disable", "--model", "m"}, "PATCH", "/v1/model-profiles/x", map[string]any{"enabled": false, "model": "m"}},
		{[]string{"models", "default", "x"}, "PUT", "/v1/model-profiles/default", map[string]any{"name": "x"}},
		{[]string{"models", "rm", "x"}, "DELETE", "/v1/model-profiles/x", nil},
	} {
		if _, errOut, code := runCLI(t, f, tc.args...); code != 0 {
			t.Fatalf("%v: exit %d: %s", tc.args, code, errOut)
		}
		r := f.last(t)
		if r.Method != tc.method || r.Path != tc.path {
			t.Errorf("%v: request %s %s", tc.args, r.Method, r.Path)
		}
		for k, v := range tc.wantFields {
			if r.Body[k] != v {
				t.Errorf("%v: body[%s] = %v, want %v", tc.args, k, r.Body[k], v)
			}
		}
		if _, ok := r.Body["description"]; tc.method == "PATCH" && ok {
			t.Errorf("set sent an unchanged field: %v", r.Body)
		}
	}
	if _, _, code := runCLI(t, f, "models", "set", "x"); code != 3 {
		t.Errorf("set without changes: exit %d, want 3", code)
	}
}

func TestEventsQuery(t *testing.T) {
	f := newFakeAPI(t)
	f.on("GET /v1/events", 200, map[string]any{"events": []any{
		map[string]any{"id": 7, "ts": 0, "type": "session.spawned", "session_id": "s1", "data": map[string]any{"dir": "/x"}},
	}})
	out, errOut, code := runCLI(t, f, "events", "--session", "s1", "--limit", "5")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if q := f.last(t).Query; !strings.Contains(q, "session=s1") || !strings.Contains(q, "limit=5") {
		t.Errorf("query = %q", q)
	}
	if !strings.Contains(out, "session.spawned s1") || !strings.Contains(out, `{"dir":"/x"}`) {
		t.Errorf("output = %q", out)
	}
}

func TestLogsReadsTheFileWithoutTheDaemon(t *testing.T) {
	flags = globalFlags{}
	home := t.TempDir()
	t.Setenv("HOPP_HOME", home)
	if err := os.MkdirAll(filepath.Join(home, "logs"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "logs", "hoppd.log"), []byte("one\ntwo\nthree\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	root := NewRootCmd()
	var out bytes.Buffer
	root.SetOut(&out)
	// No --socket: under go test connect() would refuse, so passing proves
	// that logs never contacts the daemon.
	root.SetArgs([]string{"logs", "-n", "2"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	if out.String() != "two\nthree\n" {
		t.Errorf("logs = %q", out.String())
	}
}

func TestDoctorListsFiveAdapters(t *testing.T) {
	f := newFakeAPI(t)
	out, _, _ := runCLI(t, f, "doctor")
	for _, name := range []string{"claude-code", "codex", "deepseek", "kimi-code", "pi"} {
		if !strings.Contains(out, "agent:"+name+":") {
			t.Errorf("doctor output lacks %s:\n%s", name, out)
		}
	}
	for _, want := range []string{"tmux:", "state:", "daemon: running (pid 1, version test)"} {
		if !strings.Contains(out, want) {
			t.Errorf("doctor output lacks %q:\n%s", want, out)
		}
	}
	if strings.Count(out, "agent:") != 5 {
		t.Errorf("doctor lists %d agents, want 5:\n%s", strings.Count(out, "agent:"), out)
	}
}

func TestDoctorDoesNotStartTheDaemon(t *testing.T) {
	f := newFakeAPI(t)
	dead := filepath.Join(filepath.Dir(f.sock), "none.sock")
	root := NewRootCmd()
	var out bytes.Buffer
	root.SetOut(&out)
	root.SetArgs([]string{"--socket", dead, "doctor"})
	_ = root.Execute()
	if !strings.Contains(out.String(), "daemon: not running") {
		t.Errorf("doctor output:\n%s", out.String())
	}
	if _, err := os.Stat(dead); !os.IsNotExist(err) {
		t.Errorf("a daemon socket appeared: %v", err)
	}
}

func TestSendFromEnv(t *testing.T) {
	f := newFakeAPI(t)
	f.on("POST /v1/messages", 201, map[string]any{"id": 5, "status": "queued", "body": "hi"})
	t.Setenv("HOPP_SESSION_ID", "me")
	out, errOut, code := runCLI(t, f, "send", "you", "hi")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	b := f.last(t).Body
	if b["from"] != "me" || b["to"] != "you" || b["body"] != "hi" {
		t.Errorf("request body = %v", b)
	}
	if out != "message 5 queued\n" {
		t.Errorf("output = %q", out)
	}
}

func TestSendWithoutSessionSendsNoFrom(t *testing.T) {
	f := newFakeAPI(t)
	f.on("POST /v1/messages", 201, map[string]any{"id": 5, "status": "queued", "body": "hi"})
	if _, errOut, code := runCLI(t, f, "send", "you", "hi"); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if _, has := f.last(t).Body["from"]; has {
		t.Errorf("request body = %v, want no from", f.last(t).Body)
	}
}

func TestSendFileBody(t *testing.T) {
	f := newFakeAPI(t)
	f.on("POST /v1/messages", 201, map[string]any{"id": 6, "status": "queued", "body": ""})
	path := filepath.Join(t.TempDir(), "msg.md")
	if err := os.WriteFile(path, []byte("line `one`\nline two\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, errOut, code := runCLI(t, f, "send", "you", "--file", path); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if got := f.last(t).Body["body"]; got != "line `one`\nline two\n" {
		t.Errorf("body = %q", got)
	}
}

func TestSendWaitExitsOneOnFailed(t *testing.T) {
	defer setPollIntervalForTest(t, 10*time.Millisecond)()
	f := newFakeAPI(t)
	f.on("POST /v1/messages", 201, map[string]any{"id": 8, "status": "queued", "body": "hi"})
	f.on("GET /v1/messages/8", 200, map[string]any{"id": 8, "status": "failed", "reason": "recipient_gone"})
	out, errOut, code := runCLI(t, f, "send", "you", "hi", "--wait")
	if code != 1 {
		t.Fatalf("exit %d, want 1: %s", code, errOut)
	}
	if !strings.Contains(out, "message 8 queued") || !strings.Contains(errOut, "message 8 failed: recipient_gone") {
		t.Errorf("stdout %q stderr %q", out, errOut)
	}
}

func TestSendUnknownRecipientExitsOne(t *testing.T) {
	f := newFakeAPI(t)
	f.on("POST /v1/messages", 404, map[string]any{"error": map[string]any{"code": "session_not_found", "message": "recipient session not found"}})
	_, errOut, code := runCLI(t, f, "send", "nosuch", "hi")
	if code != 1 || !strings.Contains(errOut, "recipient session not found") {
		t.Fatalf("exit %d stderr %q", code, errOut)
	}
}

func TestMessagesListsHistory(t *testing.T) {
	f := newFakeAPI(t)
	f.on("GET /v1/messages", 200, map[string]any{"messages": []any{
		map[string]any{"id": 1, "from": "a", "to": "b", "body": "one\ntwo", "status": "delivered", "created_at": 0},
		map[string]any{"id": 2, "to": "a", "body": "x", "status": "failed", "reason": "timeout", "created_at": 0},
	}})
	out, errOut, code := runCLI(t, f, "messages", "a", "--limit", "7")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if q := f.last(t).Query; !strings.Contains(q, "session=a") || !strings.Contains(q, "limit=7") {
		t.Errorf("query = %q", q)
	}
	for _, want := range []string{"#1 ", "a -> b delivered\n  one\n  two\n", "- -> a failed (timeout)\n  x\n"} {
		if !strings.Contains(out, want) {
			t.Errorf("output %q lacks %q", out, want)
		}
	}
}

// TestEventsFollowStreamsAndExitsWhenStreamEnds: --follow asks the stream
// for events after the tail it printed, passes the session and labels on,
// prints what arrives, and exits 0 when the daemon closes the stream.
func TestEventsFollowStreamsAndExitsWhenStreamEnds(t *testing.T) {
	f := newFakeAPI(t)
	f.on("GET /v1/events", 200, map[string]any{"events": []any{
		map[string]any{"id": 4, "ts": 0, "type": "old", "session_id": "s1", "data": map[string]any{"labels": map[string]any{"team": "a"}}},
	}})
	var gotQuery string
	f.handle("GET /v1/events/stream", func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, ": ping\n\n")
		fmt.Fprint(w, "id: 5\nevent: new\ndata: {\"id\":5,\"ts\":0,\"type\":\"new\",\"session_id\":\"s1\",\"data\":{\"labels\":{\"team\":\"a\"}}}\n\n")
	})
	out, errOut, code := runCLI(t, f, "events", "--follow", "--session", "s1", "--label", "team=a")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	for _, want := range []string{"since=4", "session=s1", "label=team%3Da"} {
		if !strings.Contains(gotQuery, want) {
			t.Errorf("stream query %q lacks %q", gotQuery, want)
		}
	}
	if !strings.Contains(out, "4 ") || !strings.Contains(out, " old s1") || !strings.Contains(out, " new s1") {
		t.Errorf("output = %q", out)
	}
}

func TestEventsLabelFilterOnTail(t *testing.T) {
	f := newFakeAPI(t)
	f.on("GET /v1/events", 200, map[string]any{"events": []any{
		map[string]any{"id": 1, "ts": 0, "type": "mine", "session_id": "s1", "data": map[string]any{"labels": map[string]any{"team": "a"}}},
		map[string]any{"id": 2, "ts": 0, "type": "theirs", "session_id": "s2", "data": map[string]any{"labels": map[string]any{"team": "b"}}},
		map[string]any{"id": 3, "ts": 0, "type": "bare", "session_id": "s3"},
	}})
	out, errOut, code := runCLI(t, f, "events", "--label", "team=a")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if !strings.Contains(out, " mine ") || strings.Contains(out, "theirs") || strings.Contains(out, "bare") {
		t.Errorf("output = %q", out)
	}
	if _, _, code := runCLI(t, f, "events", "--label", "nokey"); code != 3 {
		t.Errorf("bad --label exit %d, want 3", code)
	}
}

// TestEventsFollowExitsCleanlyWhenDaemonGoes: the stream breaks off and the
// daemon no longer answers — --follow says so and exits 0 instead of
// failing on its polling fallback.
func TestEventsFollowExitsCleanlyWhenDaemonGoes(t *testing.T) {
	f := newFakeAPI(t)
	f.on("GET /v1/events", 200, map[string]any{"events": []any{}})
	f.handle("GET /v1/events/stream", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "id: 1\nevent: e\ndata: {\"id\":1,\"ts\":0,\"type\":\"e\"}\n\n")
		w.(http.Flusher).Flush()
		f.on("GET /v1/health", 503, map[string]any{"error": map[string]any{"code": "gone", "message": "gone"}})
		panic(http.ErrAbortHandler) // drop the connection mid-stream
	})
	out, errOut, code := runCLI(t, f, "events", "--follow")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if !strings.Contains(out, " e -") || !strings.Contains(errOut, "the daemon stopped") {
		t.Errorf("stdout %q stderr %q", out, errOut)
	}
}

func TestChatPrintsEntries(t *testing.T) {
	f := newFakeAPI(t)
	ts := time.Date(2026, 11, 15, 10, 4, 5, 0, time.Local).Unix()
	f.on("GET /v1/sessions/s1/chat", 200, map[string]any{
		"entries": []any{
			map[string]any{"role": "user", "text": "hello\nsecond line", "ts": ts},
			map[string]any{"role": "tool", "tool_name": "Bash", "text": `{"command":"ls"}`, "ts": ts},
			map[string]any{"role": "assistant", "text": "done", "ts": ts},
			map[string]any{"role": "permission", "text": "Bash command", "ts": ts, "permission": map[string]any{"title": "Bash command", "answer_label": "Yes", "answered_via": "terminal"}},
		},
		"next_cursor": "c1",
		"session":     map[string]any{"id": "s1", "state": "running", "activity": "ready"},
	})
	out, errOut, code := runCLI(t, f, "chat", "s1", "--limit", "7")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if q := f.last(t).Query; !strings.Contains(q, "limit=7") {
		t.Errorf("query = %q", q)
	}
	want := "10:04:05 user: hello\n  second line\n10:04:05 tool Bash: {\"command\":\"ls\"}\n10:04:05 assistant: done\n10:04:05 permission: Bash command -> Yes (terminal)\n"
	if out != want {
		t.Errorf("output = %q, want %q", out, want)
	}
}

// TestChatFollowExitsWhenDaemonGoes: --follow polls with the cursor and, once
// the daemon stops answering, says so and exits 0.
func TestChatFollowExitsWhenDaemonGoes(t *testing.T) {
	old := chatFollowInterval
	chatFollowInterval = 10 * time.Millisecond
	defer func() { chatFollowInterval = old }()
	f := newFakeAPI(t)
	var calls int
	var cursors []string
	f.handle("GET /v1/sessions/s1/chat", func(w http.ResponseWriter, r *http.Request) {
		calls++
		cursors = append(cursors, r.URL.Query().Get("cursor"))
		w.Header().Set("Content-Type", "application/json")
		switch calls {
		case 1:
			fmt.Fprint(w, `{"entries":[{"role":"user","text":"one","ts":0}],"next_cursor":"c1","session":{"id":"s1","state":"running"}}`)
		case 2:
			fmt.Fprint(w, `{"entries":[{"role":"assistant","text":"two","ts":0}],"next_cursor":"c2","session":{"id":"s1","state":"running"}}`)
		default:
			f.on("GET /v1/health", 503, map[string]any{"error": map[string]any{"code": "gone", "message": "gone"}})
			w.WriteHeader(503)
			fmt.Fprint(w, `{"error":{"code":"gone","message":"gone"}}`)
		}
	})
	out, errOut, code := runCLI(t, f, "chat", "s1", "--follow")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if !strings.Contains(out, "user: one") || !strings.Contains(out, "assistant: two") || !strings.Contains(errOut, "the daemon stopped") {
		t.Errorf("stdout %q stderr %q", out, errOut)
	}
	if len(cursors) < 3 || cursors[0] != "" || cursors[1] != "c1" || cursors[2] != "c2" {
		t.Errorf("cursors = %q, want \"\", c1, c2", cursors)
	}
}
