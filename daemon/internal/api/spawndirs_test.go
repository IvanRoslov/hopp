package api

import (
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestCreateSessionSpawnDirs(t *testing.T) {
	e := newAPIEnv(t)
	base := t.TempDir()
	allowed, outside := filepath.Join(base, "allowed"), filepath.Join(base, "outside")
	for _, d := range []string{allowed, outside} {
		if err := os.Mkdir(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	var out struct {
		SpawnDirs []string `json:"spawn_dirs"`
	}
	if code := e.call(t, "POST", "/v1/sessions", map[string]any{"dir": outside, "id": "free"}, &out); code != http.StatusCreated {
		t.Fatalf("create free: %d", code)
	}
	if out.SpawnDirs == nil || len(out.SpawnDirs) != 0 {
		t.Errorf("spawn_dirs of an unlimited session = %#v, want an empty list", out.SpawnDirs)
	}
	if code := e.call(t, "POST", "/v1/sessions", map[string]any{"dir": allowed, "id": "lim", "spawn_dirs": []string{allowed}}, &out); code != http.StatusCreated {
		t.Fatalf("create lim: %d", code)
	}
	if !reflect.DeepEqual(out.SpawnDirs, []string{allowed}) {
		t.Errorf("spawn_dirs = %v", out.SpawnDirs)
	}

	code, ecode := sessErrCode(t, e, "POST", "/v1/sessions", map[string]any{"dir": outside, "id": "x", "caller": "lim"})
	if code != http.StatusBadRequest || ecode != "dir_not_allowed" {
		t.Errorf("outside: %d %q, want 400 dir_not_allowed", code, ecode)
	}
	code, ecode = sessErrCode(t, e, "POST", "/v1/sessions", map[string]any{"dir": allowed, "id": "y", "caller": "lim",
		"parent": "lim", "spawn_dirs": []string{outside}})
	if code != http.StatusBadRequest || ecode != "spawn_dirs_not_allowed" {
		t.Errorf("widening: %d %q, want 400 spawn_dirs_not_allowed", code, ecode)
	}
	code, ecode = sessErrCode(t, e, "POST", "/v1/sessions", map[string]any{"dir": allowed, "id": "z", "caller": "ghost"})
	if code != http.StatusBadRequest || ecode != "caller_not_found" {
		t.Errorf("unknown caller: %d %q, want 400 caller_not_found", code, ecode)
	}
}
