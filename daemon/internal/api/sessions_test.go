package api

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
	"time"

	"github.com/IvanRoslov/hopp/internal/bus"
	"github.com/IvanRoslov/hopp/internal/config"
	"github.com/IvanRoslov/hopp/internal/session"
	"github.com/IvanRoslov/hopp/internal/session/sessiontest"
	"github.com/IvanRoslov/hopp/internal/store"
)

type apiEnv struct {
	srv *httptest.Server
	st  *store.Store
	rt  *sessiontest.Runtime
	cfg *config.Config
}

func newAPIEnv(t *testing.T) apiEnv {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOPP_HOME", home)
	t.Setenv("HOME", t.TempDir())
	cfg, err := config.Load(home)
	if err != nil {
		t.Fatal(err)
	}
	cfg.DefaultAgent = "fake"
	st, err := store.Open(filepath.Join(home, "hopp.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	sessiontest.Register()
	rt := &sessiontest.Runtime{}
	b := bus.New(st)
	m := session.NewManager(st, b, rt, cfg)
	m.SetOwnerProbe(rt.OwnerProbe)
	srv := httptest.NewServer(NewHandler(Deps{Store: st, Bus: b, Cfg: cfg, Manager: m, Shutdown: func() {}, StartedAt: time.Now()}))
	t.Cleanup(srv.Close)
	return apiEnv{srv: srv, st: st, rt: rt, cfg: cfg}
}

// call sends method path with body (JSON-encoded unless nil) and decodes
// the response into out when out is not nil. It returns the status.
func (e apiEnv) call(t *testing.T, method, path string, body, out any) int {
	t.Helper()
	var r io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		r = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, e.srv.URL+path, r)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			t.Fatalf("decode %s %s (%d): %v: %s", method, path, resp.StatusCode, err, raw)
		}
	}
	return resp.StatusCode
}

type sessionOut struct {
	ID        string            `json:"id"`
	Parent    string            `json:"parent"`
	Dir       string            `json:"dir"`
	Labels    map[string]string `json:"labels"`
	Agent     string            `json:"agent"`
	Profile   string            `json:"profile"`
	Model     string            `json:"model"`
	Effort    string            `json:"effort"`
	State     string            `json:"state"`
	Activity  string            `json:"activity"`
	CreatedAt int64             `json:"created_at"`
	UpdatedAt int64             `json:"updated_at"`
	Children  []string          `json:"children"`
}

func (e apiEnv) create(t *testing.T, body map[string]any) sessionOut {
	t.Helper()
	var out sessionOut
	if code := e.call(t, "POST", "/v1/sessions", body, &out); code != http.StatusCreated {
		t.Fatalf("create %v: status %d, %+v", body, code, out)
	}
	return out
}

func sessErrCode(t *testing.T, e apiEnv, method, path string, body any) (int, string) {
	t.Helper()
	var out errBody
	code := e.call(t, method, path, body, &out)
	return code, out.Error.Code
}

func TestCreateSession(t *testing.T) {
	e := newAPIEnv(t)
	dir := t.TempDir()
	out := e.create(t, map[string]any{"dir": dir, "id": "s1", "agent": "fake", "model": "m", "effort": "high",
		"labels": map[string]string{"k": "v"}, "system_prompt": "sp", "message": "hi", "permission_mode": "plan",
		"env": map[string]string{"FOO": "bar"}})
	if out.ID != "s1" || out.Dir != dir || out.Agent != "fake" || out.Model != "m" || out.Effort != "high" ||
		out.State != "running" || out.Labels["k"] != "v" || out.CreatedAt == 0 {
		t.Errorf("created = %+v", out)
	}
	got, err := e.st.GetSession("s1")
	if err != nil || got.SystemPrompt != "sp" || got.Prompt != "hi" || got.PermissionMode != "plan" || got.Env["FOO"] != "bar" {
		t.Errorf("stored = %+v, %v", got, err)
	}
}

func TestCreateSessionRelativeDirIs400(t *testing.T) {
	e := newAPIEnv(t)
	code, ecode := sessErrCode(t, e, "POST", "/v1/sessions", map[string]any{"dir": "relative/path"})
	if code != http.StatusBadRequest || ecode != "dir_not_absolute" {
		t.Errorf("status %d code %q", code, ecode)
	}
	if all, _ := e.st.ListSessions(store.SessionFilter{All: true}); len(all) != 0 {
		t.Errorf("left sessions: %+v", all)
	}
	code, ecode = sessErrCode(t, e, "POST", "/v1/sessions", map[string]any{})
	if code != http.StatusBadRequest || ecode != "bad_request" {
		t.Errorf("missing dir: status %d code %q", code, ecode)
	}
}

func TestCreateSessionDuplicateIDIs409(t *testing.T) {
	e := newAPIEnv(t)
	dir := t.TempDir()
	e.create(t, map[string]any{"dir": dir, "id": "s1"})
	code, ecode := sessErrCode(t, e, "POST", "/v1/sessions", map[string]any{"dir": dir, "id": "s1"})
	if code != http.StatusConflict || ecode != "session_exists" {
		t.Errorf("status %d code %q", code, ecode)
	}
	code, ecode = sessErrCode(t, e, "POST", "/v1/sessions", map[string]any{"dir": dir, "parent": "ghost"})
	if code != http.StatusNotFound || ecode != "parent_not_found" {
		t.Errorf("unknown parent: status %d code %q", code, ecode)
	}
}

func listIDs(t *testing.T, e apiEnv, query string) []string {
	t.Helper()
	var out struct {
		Sessions []sessionOut `json:"sessions"`
	}
	if code := e.call(t, "GET", "/v1/sessions"+query, nil, &out); code != http.StatusOK {
		t.Fatalf("list %s: status %d", query, code)
	}
	ids := []string{}
	for _, s := range out.Sessions {
		ids = append(ids, s.ID)
	}
	sort.Strings(ids)
	return ids
}

func TestListSessionsFilters(t *testing.T) {
	e := newAPIEnv(t)
	dir := t.TempDir()
	e.create(t, map[string]any{"dir": dir, "id": "p", "labels": map[string]string{"a": "1", "b": "2"}})
	e.create(t, map[string]any{"dir": dir, "id": "c1", "parent": "p", "labels": map[string]string{"a": "1"}})
	e.create(t, map[string]any{"dir": dir, "id": "c2", "parent": "p"})
	if code := e.call(t, "POST", "/v1/sessions/c2/kill", nil, nil); code != http.StatusOK {
		t.Fatalf("kill c2: %d", code)
	}
	for query, want := range map[string][]string{
		"":                     {"c1", "p"},
		"?all=1":               {"c1", "c2", "p"},
		"?parent=p":            {"c1"},
		"?parent=p&all=1":      {"c1", "c2"},
		"?state=killed&all=1":  {"c2"},
		"?label=a=1":           {"c1", "p"},
		"?label=a=1&label=b=2": {"p"},
		"?label=a=2":           {},
	} {
		if got := listIDs(t, e, query); !reflect.DeepEqual(got, want) {
			t.Errorf("%q -> %v, want %v", query, got, want)
		}
	}
	code, ecode := sessErrCode(t, e, "GET", "/v1/sessions?label=nokv", nil)
	if code != http.StatusBadRequest || ecode != "bad_request" {
		t.Errorf("bad label: status %d code %q", code, ecode)
	}
}

func TestGetSessionListsChildren(t *testing.T) {
	e := newAPIEnv(t)
	dir := t.TempDir()
	e.create(t, map[string]any{"dir": dir, "id": "p"})
	e.create(t, map[string]any{"dir": dir, "id": "c1", "parent": "p"})
	var out sessionOut
	if code := e.call(t, "GET", "/v1/sessions/p", nil, &out); code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	if out.ID != "p" || !reflect.DeepEqual(out.Children, []string{"c1"}) {
		t.Errorf("got %+v", out)
	}
	code, ecode := sessErrCode(t, e, "GET", "/v1/sessions/ghost", nil)
	if code != http.StatusNotFound || ecode != "session_not_found" {
		t.Errorf("unknown: status %d code %q", code, ecode)
	}
}

func TestKillCascadesAndReturnsSession(t *testing.T) {
	e := newAPIEnv(t)
	dir := t.TempDir()
	e.create(t, map[string]any{"dir": dir, "id": "p"})
	e.create(t, map[string]any{"dir": dir, "id": "c1", "parent": "p"})
	var out sessionOut
	if code := e.call(t, "POST", "/v1/sessions/p/kill", map[string]any{}, &out); code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	if out.ID != "p" || out.State != "killed" {
		t.Errorf("killed = %+v", out)
	}
	if c, _ := e.st.GetSession("c1"); c.State != "killed" {
		t.Errorf("child state = %q", c.State)
	}
	e.create(t, map[string]any{"dir": dir, "id": "d"})
	if code := e.call(t, "POST", "/v1/sessions/d/kill", map[string]any{"final": "done"}, &out); code != http.StatusOK || out.State != "done" {
		t.Errorf("done: status %d, %+v", code, out)
	}
	code, ecode := sessErrCode(t, e, "POST", "/v1/sessions/d/kill", map[string]any{"final": "errored"})
	if code != http.StatusBadRequest || ecode != "invalid_state" {
		t.Errorf("bad final: status %d code %q", code, ecode)
	}
}

func TestRestore(t *testing.T) {
	e := newAPIEnv(t)
	dir := t.TempDir()
	e.create(t, map[string]any{"dir": dir, "id": "s1"})
	code, ecode := sessErrCode(t, e, "POST", "/v1/sessions/s1/restore", nil)
	if code != http.StatusBadRequest || ecode != "restore_not_allowed" {
		t.Errorf("alive: status %d code %q", code, ecode)
	}
	var out sessionOut
	if code := e.call(t, "POST", "/v1/sessions/s1/restore", map[string]any{"force": true}, &out); code != http.StatusOK || out.State != "running" {
		t.Errorf("force: status %d, %+v", code, out)
	}
}

func TestAttachCommand(t *testing.T) {
	e := newAPIEnv(t)
	e.create(t, map[string]any{"dir": t.TempDir(), "id": "s1"})
	var out struct {
		Command []string `json:"command"`
	}
	if code := e.call(t, "GET", "/v1/sessions/s1/attach", nil, &out); code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	if !reflect.DeepEqual(out.Command, []string{"tmux", "attach", "-t", "=s1"}) {
		t.Errorf("command = %v", out.Command)
	}
	var output struct {
		Output string `json:"output"`
	}
	if code := e.call(t, "GET", "/v1/sessions/s1/output?lines=5", nil, &output); code != http.StatusOK || output.Output != "fake output" {
		t.Errorf("output: status %d, %+v", code, output)
	}
}

func TestResolveProfile(t *testing.T) {
	e := newAPIEnv(t)
	for _, p := range []store.ModelProfile{
		{Name: "fast", Agent: "fake", Model: "m1", Effort: "low", Enabled: true},
		{Name: "off", Agent: "fake", Enabled: false},
	} {
		if err := e.st.CreateModelProfile(p); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		name                          string
		profile, agent, model, effort string
		setDefault                    string
		want                          session.LaunchProfile
		code                          string
	}{
		{name: "named profile", profile: "fast", want: session.LaunchProfile{Name: "fast", Agent: "fake", Model: "m1", Effort: "low"}},
		{name: "missing profile", profile: "nope", code: "profile_not_found"},
		{name: "disabled profile", profile: "off", code: "profile_disabled"},
		{name: "profile with other agent", profile: "fast", agent: "codex", code: "bad_request"},
		{name: "agent as given", agent: "fake-input", model: "x", effort: "y", want: session.LaunchProfile{Agent: "fake-input", Model: "x", Effort: "y"}},
		{name: "default profile", setDefault: "fast", want: session.LaunchProfile{Name: "fast", Agent: "fake", Model: "m1", Effort: "low"}},
		{name: "default profile gone", setDefault: "deleted", want: session.LaunchProfile{Agent: "fake"}},
		{name: "no default", want: session.LaunchProfile{Agent: "fake"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_ = e.st.DeleteSetting("default_profile")
			if tc.setDefault != "" {
				if err := e.st.SetSetting("default_profile", tc.setDefault); err != nil {
					t.Fatal(err)
				}
			}
			got, err := resolveProfile(e.st, e.cfg, tc.profile, tc.agent, tc.model, tc.effort)
			if tc.code != "" {
				var ae *apiError
				if !asAPIError(err, &ae) || ae.code != tc.code {
					t.Fatalf("err = %v, want code %s", err, tc.code)
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("got %+v, %v; want %+v", got, err, tc.want)
			}
		})
	}
}

func TestSessionJSONHasNoScenarioKeys(t *testing.T) {
	e := newAPIEnv(t)
	e.create(t, map[string]any{"dir": t.TempDir(), "id": "s1"})
	var raw map[string]any
	e.call(t, "GET", "/v1/sessions/s1", nil, &raw)
	for _, k := range []string{"kind", "project", "project_id", "repo", "repo_id", "feature", "feature_slug", "branch", "task", "task_id", "pr_number", "ci_state", "worktree_path"} {
		if _, ok := raw[k]; ok {
			t.Errorf("session JSON has %q", k)
		}
	}
	for _, k := range []string{"id", "parent", "dir", "labels", "agent", "profile", "model", "effort", "state", "activity", "created_at", "updated_at"} {
		if _, ok := raw[k]; !ok {
			t.Errorf("session JSON lacks %q", k)
		}
	}
}
