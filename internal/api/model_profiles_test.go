package api

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/IvanRoslov/hopp/internal/store"
)

// mpFixture is a real store seeded with the starter profiles (claude-opus,
// claude-sonnet, codex; default = claude-opus).
type mpFixture struct {
	d   Deps
	url string
}

func newMPFixture(t *testing.T) mpFixture {
	t.Helper()
	d := storeDeps(t)
	if err := d.Store.SeedModelProfiles("claude-code"); err != nil {
		t.Fatal(err)
	}
	srv := newTestServer(t, d)
	return mpFixture{d: d, url: srv.URL}
}

// mpDo sends method path with an optional JSON body, returning the status
// and the decoded JSON object (nil for an empty body). session is unused:
// hopp has no caller-session header.
func mpDo(t *testing.T, base, method, path, session string, body any) (int, map[string]any) {
	t.Helper()
	var rdr *strings.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		rdr = strings.NewReader(string(b))
	} else {
		rdr = strings.NewReader("")
	}
	req, err := http.NewRequest(method, base+path, rdr)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func errMessage(body map[string]any) string {
	e, _ := body["error"].(map[string]any)
	m, _ := e["message"].(string)
	return m
}

func profileNamesOf(t *testing.T, body map[string]any) []string {
	t.Helper()
	raw, ok := body["profiles"].([]any)
	if !ok {
		t.Fatalf("profiles missing or not an array: %#v", body)
	}
	out := []string{}
	for _, r := range raw {
		out = append(out, r.(map[string]any)["name"].(string))
	}
	return out
}

func TestListModelProfiles(t *testing.T) {
	f := newMPFixture(t)
	status, body := mpDo(t, f.url, "GET", "/v1/model-profiles", "", nil)
	if status != http.StatusOK {
		t.Fatalf("status = %d", status)
	}
	if got := profileNamesOf(t, body); !reflect.DeepEqual(got, []string{"claude-opus", "claude-sonnet", "codex"}) {
		t.Errorf("names = %v", got)
	}
	first := body["profiles"].([]any)[0].(map[string]any)
	want := map[string]any{"name": "claude-opus", "agent": "claude-code", "model": "opus", "effort": "",
		"description": first["description"], "enabled": true, "position": float64(0)}
	if !reflect.DeepEqual(first, want) {
		t.Errorf("profile JSON = %#v\nwant %#v", first, want)
	}
}

func TestListModelProfilesEmptyIsArray(t *testing.T) {
	d := storeDeps(t)
	srv := newTestServer(t, d)
	_, body := mpDo(t, srv.URL, "GET", "/v1/model-profiles", "", nil)
	if got := profileNamesOf(t, body); len(got) != 0 {
		t.Errorf("names = %v", got)
	}
}

func TestCreateModelProfile(t *testing.T) {
	f := newMPFixture(t)
	status, body := mpDo(t, f.url, "POST", "/v1/model-profiles", "", map[string]any{
		"name": "deep", "agent": "codex", "model": "gpt-5", "effort": "high", "description": "deep thought"})
	if status != http.StatusCreated {
		t.Fatalf("status = %d body %v", status, body)
	}
	if body["name"] != "deep" || body["effort"] != "high" || body["enabled"] != true || body["position"] != float64(3) {
		t.Errorf("created = %v", body)
	}
	p, err := f.d.Store.GetModelProfile("deep")
	if err != nil || p.Model != "gpt-5" || p.Description != "deep thought" {
		t.Errorf("stored = %+v err %v", p, err)
	}
}

func TestCreateModelProfileValidation(t *testing.T) {
	f := newMPFixture(t)
	cases := []struct {
		name   string
		body   map[string]any
		status int
		code   string
	}{
		{"bad name", map[string]any{"name": "Bad_Name", "agent": "codex"}, 400, "bad_request"},
		{"empty name", map[string]any{"name": "", "agent": "codex"}, 400, "bad_request"},
		{"name too long", map[string]any{"name": strings.Repeat("a", 41), "agent": "codex"}, 400, "bad_request"},
		{"unknown agent", map[string]any{"name": "x", "agent": "gemini"}, 400, "agent_unavailable"},
		{"bad effort", map[string]any{"name": "x", "agent": "codex", "effort": "turbo"}, 400, "bad_effort"},
		{"duplicate", map[string]any{"name": "codex", "agent": "codex"}, 409, "profile_exists"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, body := mpDo(t, f.url, "POST", "/v1/model-profiles", "", tc.body)
			if status != tc.status || errCode(body) != tc.code {
				t.Errorf("got %d %q, want %d %q (%v)", status, errCode(body), tc.status, tc.code, body)
			}
		})
	}
	if _, body := mpDo(t, f.url, "POST", "/v1/model-profiles", "", map[string]any{"name": "x", "agent": "codex", "effort": "turbo"}); !strings.Contains(errMessage(body), "minimal") {
		t.Errorf("bad_effort message should list allowed efforts: %q", errMessage(body))
	}
}

func TestPatchModelProfile(t *testing.T) {
	f := newMPFixture(t)
	status, body := mpDo(t, f.url, "PATCH", "/v1/model-profiles/claude-sonnet", "", map[string]any{
		"effort": "max", "enabled": false, "position": 9})
	if status != http.StatusOK {
		t.Fatalf("status = %d %v", status, body)
	}
	if body["effort"] != "max" || body["enabled"] != false || body["position"] != float64(9) || body["model"] != "sonnet" {
		t.Errorf("patched = %v", body)
	}
	// Switching agent re-validates the kept effort against the new agent's
	// model (gpt-5.5 tops out at xhigh).
	status, body = mpDo(t, f.url, "PATCH", "/v1/model-profiles/claude-sonnet", "", map[string]any{"agent": "codex", "model": "gpt-5.5"})
	if status != 400 || errCode(body) != "bad_effort" {
		t.Errorf("agent switch with stale effort = %d %v", status, body)
	}
	status, body = mpDo(t, f.url, "PATCH", "/v1/model-profiles/claude-sonnet", "", map[string]any{"agent": "codex", "effort": ""})
	if status != 200 || body["agent"] != "codex" || body["effort"] != "" {
		t.Errorf("agent switch clearing effort = %d %v", status, body)
	}
	status, body = mpDo(t, f.url, "PATCH", "/v1/model-profiles/nope", "", map[string]any{"model": "x"})
	if status != 404 || errCode(body) != "profile_not_found" {
		t.Errorf("missing = %d %v", status, body)
	}
}

func TestDeleteModelProfile(t *testing.T) {
	f := newMPFixture(t)
	if status, _ := mpDo(t, f.url, "DELETE", "/v1/model-profiles/codex", "", nil); status != http.StatusNoContent {
		t.Errorf("delete status = %d", status)
	}
	if _, err := f.d.Store.GetModelProfile("codex"); err == nil {
		t.Error("codex still there")
	}
	status, body := mpDo(t, f.url, "DELETE", "/v1/model-profiles/codex", "", nil)
	if status != 404 || errCode(body) != "profile_not_found" {
		t.Errorf("delete missing = %d %v", status, body)
	}
}

// Review Focus 2: no agent session may widen its own choice.
// Review Focus 1: a worker sees its PARENT feature task's allowlist.
// Review Focus 5 (API side): an unknown name rejects the whole PATCH.
// Agents keep patching other task fields as before.
// A worker whose subtask was handed to a newer worker no longer owns any
// task; it must still see its orchestrator's feature allowlist, not every
// enabled profile.

func TestListModelProfilesShowsDefault(t *testing.T) {
	f := newMPFixture(t)
	_, body := mpDo(t, f.url, "GET", "/v1/model-profiles", "", nil)
	if body["default"] != "claude-opus" {
		t.Errorf("default = %v, want claude-opus", body["default"])
	}
}

func TestSetDefaultProfile(t *testing.T) {
	f := newMPFixture(t)
	status, body := mpDo(t, f.url, "PUT", "/v1/model-profiles/default", "", map[string]any{"name": "codex"})
	if status != http.StatusOK || body["default"] != "codex" {
		t.Fatalf("PUT default = %d %v", status, body)
	}
	if v, _ := f.d.Store.GetSetting(store.SettingDefaultProfile); v != "codex" {
		t.Errorf("setting = %q, want codex", v)
	}
	status, body = mpDo(t, f.url, "PUT", "/v1/model-profiles/default", "", map[string]any{"name": "nope"})
	if status != http.StatusNotFound || errCode(body) != "profile_not_found" {
		t.Errorf("unknown = %d %v", status, body)
	}
	if status, body := mpDo(t, f.url, "PATCH", "/v1/model-profiles/claude-sonnet", "", map[string]any{"enabled": false}); status != http.StatusOK {
		t.Fatalf("disable: %d %v", status, body)
	}
	status, body = mpDo(t, f.url, "PUT", "/v1/model-profiles/default", "", map[string]any{"name": "claude-sonnet"})
	if status != http.StatusBadRequest || errCode(body) != "profile_disabled" {
		t.Errorf("disabled = %d %v", status, body)
	}
	status, body = mpDo(t, f.url, "PUT", "/v1/model-profiles/default", "", map[string]any{})
	if status != http.StatusBadRequest || errCode(body) != "bad_request" {
		t.Errorf("no name = %d %v", status, body)
	}
}

func TestDeleteDefaultProfileClearsDefault(t *testing.T) {
	f := newMPFixture(t)
	if status, _ := mpDo(t, f.url, "DELETE", "/v1/model-profiles/claude-opus", "", nil); status != http.StatusNoContent {
		t.Fatalf("delete status = %d", status)
	}
	if _, err := f.d.Store.GetSetting(store.SettingDefaultProfile); err == nil {
		t.Error("default_profile still set after its profile was deleted")
	}
	_, body := mpDo(t, f.url, "GET", "/v1/model-profiles", "", nil)
	if body["default"] != "" {
		t.Errorf("default = %v, want empty", body["default"])
	}
}
