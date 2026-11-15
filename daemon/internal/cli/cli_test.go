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
	"sort"
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

func questionSession(questions ...map[string]any) map[string]any {
	s := map[string]any{}
	for k, v := range created {
		s[k] = v
	}
	qs := make([]any, len(questions))
	for i, q := range questions {
		qs[i] = q
	}
	s["question"] = map[string]any{"questions": qs, "asked_at": 1}
	return s
}

var colorQuestion = map[string]any{"question": "Which color?", "header": "Color", "multi_select": false,
	"options": []any{map[string]any{"label": "Red", "description": "warm"}, map[string]any{"label": "Green"}}}

func TestAnswerByNumberAndLabel(t *testing.T) {
	for _, tc := range []struct {
		choice string
		want   float64
	}{{"2", 1}, {"Red", 0}} {
		f := newFakeAPI(t)
		f.on("GET /v1/sessions/s1", 200, questionSession(colorQuestion))
		f.on("POST /v1/sessions/s1/quiz/answer", 202, map[string]any{"status": "answering"})
		out, errOut, code := runCLI(t, f, "answer", "s1", tc.choice)
		if code != 0 {
			t.Fatalf("%s: exit %d: %s", tc.choice, code, errOut)
		}
		b := f.last(t)
		if b.Path != "/v1/sessions/s1/quiz/answer" {
			t.Fatalf("%s: last request %+v", tc.choice, b)
		}
		answers, _ := b.Body["answers"].([]any)
		a, _ := answers[0].(map[string]any)
		idx, _ := a["option_indices"].([]any)
		if len(answers) != 1 || a["question_index"] != float64(0) || len(idx) != 1 || idx[0] != tc.want {
			t.Errorf("%s: body %v", tc.choice, b.Body)
		}
		if !strings.Contains(out, "answering") {
			t.Errorf("%s: output %q", tc.choice, out)
		}
	}
}

func TestAnswerUnknownChoiceIsUsageError(t *testing.T) {
	f := newFakeAPI(t)
	f.on("GET /v1/sessions/s1", 200, questionSession(colorQuestion))
	if _, errOut, code := runCLI(t, f, "answer", "s1", "Purple"); code != 3 || !strings.Contains(errOut, "Red") {
		t.Fatalf("exit %d stderr %q, want 3 naming the options", code, errOut)
	}
	if _, _, code := runCLI(t, f, "answer", "s1", "3"); code != 3 {
		t.Fatalf("out-of-range number exit %d, want 3", code)
	}
}

func TestAnswerShowsPendingQuestion(t *testing.T) {
	f := newFakeAPI(t)
	f.on("GET /v1/sessions/s1", 200, questionSession(colorQuestion))
	out, errOut, code := runCLI(t, f, "answer", "s1")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	for _, want := range []string{"Color: Which color?", "1. Red — warm", "2. Green"} {
		if !strings.Contains(out, want) {
			t.Errorf("output %q lacks %q", out, want)
		}
	}
	f2 := newFakeAPI(t)
	f2.on("GET /v1/sessions/s2", 200, created)
	out, _, code = runCLI(t, f2, "answer", "s2")
	if code != 0 || !strings.Contains(out, "no pending question") {
		t.Errorf("no question: exit %d output %q", code, out)
	}
}

func TestAnswerMultiQuestionNeedsFile(t *testing.T) {
	f := newFakeAPI(t)
	second := map[string]any{"question": "Size?", "header": "Size", "multi_select": false, "options": []any{map[string]any{"label": "S"}}}
	f.on("GET /v1/sessions/s1", 200, questionSession(colorQuestion, second))
	out, errOut, code := runCLI(t, f, "answer", "s1", "1")
	if code != 3 || !strings.Contains(out, "Size?") || !strings.Contains(errOut, "--file") {
		t.Fatalf("exit %d stdout %q stderr %q", code, out, errOut)
	}
	path := filepath.Join(t.TempDir(), "a.json")
	os.WriteFile(path, []byte(`{"answers":[{"question_index":0,"option_indices":[1]},{"question_index":1,"text":"XL"}]}`), 0o644)
	f.on("POST /v1/sessions/s1/quiz/answer", 202, map[string]any{"status": "answering"})
	if _, errOut, code := runCLI(t, f, "answer", "s1", "--file", path); code != 0 {
		t.Fatalf("--file exit %d: %s", code, errOut)
	}
	if answers, _ := f.last(t).Body["answers"].([]any); len(answers) != 2 {
		t.Errorf("--file body %v", f.last(t).Body)
	}
}

// TestAnswerStaleQuestionIsConflict: the question went away between showing
// it and answering (answered in the terminal): the daemon's 409 is reported
// and the exit code is 1.
func TestAnswerStaleQuestionIsConflict(t *testing.T) {
	f := newFakeAPI(t)
	f.on("GET /v1/sessions/s1", 200, questionSession(colorQuestion))
	f.on("POST /v1/sessions/s1/quiz/answer", 409, map[string]any{"error": map[string]any{"code": "no_pending_quiz", "message": "session has no pending quiz"}})
	_, errOut, code := runCLI(t, f, "answer", "s1", "1")
	if code != 1 || !strings.Contains(errOut, "no pending quiz") {
		t.Fatalf("exit %d stderr %q", code, errOut)
	}
}

func TestLsMarksPendingQuestion(t *testing.T) {
	f := newFakeAPI(t)
	asking := questionSession(colorQuestion)
	asking["activity"] = "blocked"
	plain := map[string]any{}
	for k, v := range created {
		plain[k] = v
	}
	plain["id"], plain["activity"] = "s2", "ready"
	f.on("GET /v1/sessions", 200, map[string]any{"sessions": []any{asking, plain}})
	out, errOut, code := runCLI(t, f, "ls")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if !strings.Contains(out, " blocked? ") || strings.Contains(out, "ready?") {
		t.Errorf("output %q, want the ? mark on the asking session only", out)
	}
}

func TestRm(t *testing.T) {
	f := newFakeAPI(t)
	f.on("DELETE /v1/sessions/p", 200, map[string]any{"removed": []string{"p", "c"}})
	out, errOut, code := runCLI(t, f, "rm", "p", "--recursive")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if last := f.last(t); last.Method != "DELETE" || last.Query != "recursive=1" {
		t.Errorf("request %+v", last)
	}
	if out != "removed p\nremoved c\n" {
		t.Errorf("output %q", out)
	}
	if _, _, code := runCLI(t, f, "rm"); code != 3 {
		t.Errorf("no id: exit %d, want 3", code)
	}
}

// TestRmEndedOlderThan: --ended removes the top-most ended sessions whose
// whole subtree has ended before the cutoff, recursively; a session with a
// live descendant, or one that ended after the cutoff, stays.
func TestRmEndedOlderThan(t *testing.T) {
	f := newFakeAPI(t)
	old := time.Now().Add(-48 * time.Hour).Unix()
	recent := time.Now().Add(-time.Hour).Unix()
	row := func(id, parent, state string, updated int64) map[string]any {
		return map[string]any{"id": id, "parent": parent, "dir": "/x", "labels": map[string]string{}, "agent": "fake", "profile": "",
			"model": "", "effort": "", "state": state, "activity": "", "created_at": 1, "updated_at": updated}
	}
	f.on("GET /v1/sessions", 200, map[string]any{"sessions": []any{
		row("a", "", "killed", old), row("a1", "a", "done", old), // whole subtree ended long ago: removed as one
		row("b", "", "killed", old), row("b1", "b", "running", old), // live child: b stays
		row("b2", "b", "killed", old),  // an ended child of b is removed on its own
		row("r", "", "killed", recent), // ended after the cutoff: stays
		row("live", "", "running", old),
	}})
	var deleted []string
	for _, id := range []string{"a", "b2"} {
		id := id
		f.handle("DELETE /v1/sessions/"+id, func(w http.ResponseWriter, r *http.Request) {
			deleted = append(deleted, id+"?"+r.URL.RawQuery)
			w.Header().Set("Content-Type", "application/json")
			removed := []string{id}
			if id == "a" {
				removed = []string{"a", "a1"}
			}
			json.NewEncoder(w).Encode(map[string]any{"removed": removed})
		})
	}
	out, errOut, code := runCLI(t, f, "rm", "--ended", "--older-than", "24h")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if q := f.all()[0].Query; !strings.Contains(q, "all=1") {
		t.Errorf("list query %q", q)
	}
	sort.Strings(deleted)
	if strings.Join(deleted, ",") != "a?recursive=1,b2?recursive=1" {
		t.Errorf("deleted %v", deleted)
	}
	for _, want := range []string{"removed a\n", "removed a1\n", "removed b2\n"} {
		if !strings.Contains(out, want) {
			t.Errorf("output %q lacks %q", out, want)
		}
	}
}

func usageTestRow(session, parent, model string, in, out int) map[string]any {
	return map[string]any{"session": session, "parent": parent, "labels": map[string]string{}, "agent": "claude-code", "state": "running",
		"status": "ok", "final": false, "model": model, "input": in, "cache_write": 0, "cache_read": 0, "output": out, "reasoning": 0, "messages": 1}
}

func TestUsageTable(t *testing.T) {
	f := newFakeAPI(t)
	f.on("GET /v1/usage", 200, map[string]any{"rows": []any{usageTestRow("s1", "", "m1", 10, 2), usageTestRow("s1", "", "m2", 5, 1)}})
	f.on("POST /v1/usage/collect", 200, map[string]any{"collected": 1, "queued": 0})
	out, errOut, code := runCLI(t, f, "usage", "--session", "s1", "--label", "team=a", "--collect")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	reqs := f.all()
	if len(reqs) != 2 || reqs[0].Path != "/v1/usage/collect" || reqs[0].Body["session"] != "s1" {
		t.Fatalf("requests %+v", reqs)
	}
	if q := reqs[1].Query; !strings.Contains(q, "session=s1") || !strings.Contains(q, "label=team%3Da") {
		t.Errorf("query %q", q)
	}
	for _, want := range []string{"SESSION", "s1", "m1", "m2", "TOTAL", "15"} {
		if !strings.Contains(out, want) {
			t.Errorf("output %q lacks %q", out, want)
		}
	}
}

// TestUsageTreeTotals: --tree sums a session and all its descendants, and
// nothing else.
func TestUsageTreeTotals(t *testing.T) {
	f := newFakeAPI(t)
	f.on("GET /v1/usage", 200, map[string]any{"rows": []any{
		usageTestRow("root", "", "m1", 100, 10),
		usageTestRow("child", "root", "m1", 20, 2),
		usageTestRow("grand", "child", "m2", 3, 1),
		usageTestRow("other", "", "m1", 1000, 1000),
	}})
	out, errOut, code := runCLI(t, f, "usage", "--tree", "root")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if strings.Contains(out, "other") {
		t.Errorf("a session outside the tree is listed: %q", out)
	}
	var total string
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "TOTAL") {
			total = strings.Join(strings.Fields(line), " ")
		}
	}
	if total != "TOTAL 123 0 0 13 0 3" {
		t.Errorf("total line %q, want input 123 output 13 messages 3", total)
	}
}

// TestInboxDefaultsToCallerAndNeedsMailbox: the mailbox is --mailbox, else
// $HOPP_SESSION_ID; with neither, a usage error naming --mailbox.
func TestInboxDefaultsToCallerAndNeedsMailbox(t *testing.T) {
	f := newFakeAPI(t)
	f.on("GET /v1/mailboxes/me/inbox", 200, map[string]any{"messages": []any{}})
	f.on("GET /v1/mailboxes/box/inbox", 200, map[string]any{"messages": []any{}})
	_, errOut, code := runCLI(t, f, "inbox")
	if code != 3 || !strings.Contains(errOut, "--mailbox") {
		t.Fatalf("no mailbox: exit %d stderr %q", code, errOut)
	}
	t.Setenv("HOPP_SESSION_ID", "me")
	if _, errOut, code := runCLI(t, f, "inbox"); code != 0 || f.last(t).Path != "/v1/mailboxes/me/inbox" {
		t.Fatalf("from env: exit %d %s %+v", code, errOut, f.last(t))
	}
	if _, errOut, code := runCLI(t, f, "inbox", "--mailbox", "box"); code != 0 || f.last(t).Path != "/v1/mailboxes/box/inbox" {
		t.Fatalf("flag: exit %d %s %+v", code, errOut, f.last(t))
	}
}

func TestInboxListNextPeek(t *testing.T) {
	f := newFakeAPI(t)
	now := time.Now().Unix()
	f.on("GET /v1/mailboxes/box/inbox", 200, map[string]any{"messages": []any{
		map[string]any{"id": 3, "mailbox": "box", "from": "s1", "body": "first line\nmore", "status": "unread", "created_at": now},
		map[string]any{"id": 4, "mailbox": "box", "from": "", "body": "x", "status": "unread", "created_at": now - 600},
	}})
	out, errOut, code := runCLI(t, f, "inbox", "--mailbox", "box")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if q := f.last(t).Query; q != "status=unread" {
		t.Errorf("query %q", q)
	}
	for _, want := range []string{"2 unread", "#3", "s1", "just now", "first line", "#4", "10m"} {
		if !strings.Contains(out, want) {
			t.Errorf("list %q lacks %q", out, want)
		}
	}
	if strings.Contains(out, "more") {
		t.Errorf("list shows more than the first line: %q", out)
	}
	f.on("POST /v1/mailboxes/box/inbox/next", 200, map[string]any{"id": 3, "from": "s1", "body": "first line\nmore", "status": "read", "created_at": now})
	out, _, code = runCLI(t, f, "inbox", "next", "--mailbox", "box")
	if code != 0 || !strings.Contains(out, "#3 from s1") || !strings.Contains(out, "first line\nmore") {
		t.Errorf("next: exit %d %q", code, out)
	}
	f.on("GET /v1/mailboxes/box/inbox/4", 200, map[string]any{"id": 4, "from": "", "body": "x", "status": "unread", "created_at": now})
	out, _, code = runCLI(t, f, "inbox", "peek", "#4", "--mailbox", "box")
	if code != 0 || !strings.Contains(out, "#4 from -") {
		t.Errorf("peek: exit %d %q", code, out)
	}
	if _, _, code := runCLI(t, f, "inbox", "peek", "x", "--mailbox", "box"); code != 3 {
		t.Errorf("peek bad id: exit %d", code)
	}
	f.handle("POST /v1/mailboxes/box/inbox/next", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })
	out, _, code = runCLI(t, f, "inbox", "next", "--mailbox", "box")
	if code != 0 || !strings.Contains(out, "inbox is empty") {
		t.Errorf("drained: exit %d %q", code, out)
	}
}

func TestMailboxCommands(t *testing.T) {
	f := newFakeAPI(t)
	f.on("POST /v1/mailboxes", 201, map[string]any{"name": "cto"})
	f.on("DELETE /v1/mailboxes/cto", 200, map[string]any{"removed": "cto"})
	f.on("GET /v1/mailboxes", 200, map[string]any{"mailboxes": []any{map[string]any{"name": "cto", "unread": 2, "total": 5, "created_at": 1}}})
	if out, errOut, code := runCLI(t, f, "mailbox", "add", "cto"); code != 0 || f.last(t).Body["name"] != "cto" || !strings.Contains(out, "cto") {
		t.Fatalf("add: %d %s %q", code, errOut, out)
	}
	out, _, code := runCLI(t, f, "mailbox", "ls")
	if code != 0 || !strings.Contains(out, "cto") || !strings.Contains(out, "2") {
		t.Errorf("ls: %d %q", code, out)
	}
	if _, errOut, code := runCLI(t, f, "mailbox", "rm", "cto"); code != 0 || f.last(t).Method != "DELETE" {
		t.Errorf("rm: %d %s", code, errOut)
	}
}

// TestSendToInboxReturnsAtOnce: a message stored in a mailbox has no
// delivery to follow, so --wait returns at once and says where it went.
func TestSendToInboxReturnsAtOnce(t *testing.T) {
	f := newFakeAPI(t)
	f.on("POST /v1/messages", 202, map[string]any{"id": 9, "to": "cto", "status": "inbox"})
	out, errOut, code := runCLI(t, f, "send", "cto", "hello", "--wait")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if !strings.Contains(out, "inbox") || !strings.Contains(out, "cto") {
		t.Errorf("output %q", out)
	}
	if len(f.all()) != 1 {
		t.Errorf("polled after an inbox delivery: %+v", f.all())
	}
}

func TestFirstLine(t *testing.T) {
	if got := firstLine("one\ntwo"); got != "one" {
		t.Errorf("firstLine(multiline) = %q, want one", got)
	}
	if got := firstLine("short"); got != "short" {
		t.Errorf("firstLine(short) = %q", got)
	}
	long := strings.Repeat("x", 100)
	got := firstLine(long)
	if !strings.HasSuffix(got, "…") || len([]rune(got)) != 73 {
		t.Errorf("firstLine(long) = %q, want it truncated to 72 runes plus an ellipsis", got)
	}
}

func TestAge(t *testing.T) {
	now := time.Now()
	cases := map[string]int64{
		"just now": now.Unix(),
		"5m":       now.Add(-5 * time.Minute).Unix(),
		"3h":       now.Add(-3 * time.Hour).Unix(),
		"2d":       now.Add(-48 * time.Hour).Unix(),
		"-":        0,
	}
	for want, in := range cases {
		if got := age(in); got != want {
			t.Errorf("age(%v) = %q, want %q", in, got, want)
		}
	}
}
