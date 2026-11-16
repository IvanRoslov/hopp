package api

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
)

type artifactOut struct {
	ID        int64             `json:"id"`
	Scope     string            `json:"scope"`
	Name      string            `json:"name"`
	Version   int64             `json:"version"`
	Filename  string            `json:"filename"`
	Mime      string            `json:"mime"`
	Size      int64             `json:"size"`
	SHA256    string            `json:"sha256"`
	Path      string            `json:"path"`
	From      string            `json:"from"`
	Labels    map[string]string `json:"labels"`
	CreatedAt int64             `json:"created_at"`
	Unchanged bool              `json:"unchanged"`
}

func writeSrc(t *testing.T, name, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func publish(t *testing.T, e apiEnv, body map[string]any, wantCode int) artifactOut {
	t.Helper()
	var out artifactOut
	if code := e.call(t, "POST", "/v1/artifacts", body, &out); code != wantCode {
		t.Fatalf("POST /v1/artifacts %v: %d, want %d", body, code, wantCode)
	}
	return out
}

// storedFiles lists every file under the artifacts directory except the
// incoming area.
func storedFiles(t *testing.T, e apiEnv) []string {
	t.Helper()
	var out []string
	root := filepath.Join(e.cfg.Home, "artifacts")
	filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			out = append(out, strings.TrimPrefix(p, root+"/"))
		}
		return nil
	})
	return out
}

func TestArtifactPublishStoresReadOnlyCopyInRootScope(t *testing.T) {
	e := newAPIEnv(t)
	dir := t.TempDir()
	e.create(t, map[string]any{"dir": dir, "id": "top", "labels": map[string]string{"team": "a"}})
	e.create(t, map[string]any{"dir": dir, "id": "kid", "parent": "top", "labels": map[string]string{"run": "1"}})
	src := writeSrc(t, "Spec.md", "# spec\n")
	a := publish(t, e, map[string]any{"from": "kid", "name": "spec", "path": src, "labels": map[string]string{"kind": "spec"}}, http.StatusCreated)
	wantPath := filepath.Join(e.cfg.Home, "artifacts", "top", "spec", "v1", "Spec.md")
	if a.Scope != "top" || a.Name != "spec" || a.Version != 1 || a.Filename != "Spec.md" || a.Size != 7 || len(a.SHA256) != 64 ||
		a.Path != wantPath || a.From != "kid" || a.Unchanged || !strings.HasPrefix(a.Mime, "text/markdown") ||
		!reflect.DeepEqual(a.Labels, map[string]string{"team": "a", "run": "1", "kind": "spec"}) {
		t.Errorf("artifact = %+v", a)
	}
	info, err := os.Stat(a.Path)
	if err != nil || info.Mode().Perm()&0o222 != 0 {
		t.Errorf("stored file: %v, mode %v; want read-only", err, info.Mode())
	}
	same := publish(t, e, map[string]any{"from": "kid", "name": "spec", "path": src}, http.StatusOK)
	if !same.Unchanged || same.ID != a.ID || same.Version != 1 {
		t.Errorf("same content = %+v", same)
	}
	os.WriteFile(src, []byte("# spec v2\n"), 0o644)
	v2 := publish(t, e, map[string]any{"from": "kid", "name": "spec", "path": src}, http.StatusCreated)
	if v2.Version != 2 || v2.Unchanged || v2.Path != filepath.Join(e.cfg.Home, "artifacts", "top", "spec", "v2", "Spec.md") {
		t.Errorf("v2 = %+v", v2)
	}
	var got artifactOut
	if code := e.call(t, "GET", fmt.Sprintf("/v1/artifacts/%d", a.ID), nil, &got); code != http.StatusOK || got.Path != a.Path || got.Version != 1 {
		t.Errorf("GET one: %d %+v", code, got)
	}
	for _, path := range []string{"/v1/artifacts/999", "/v1/artifacts/x"} {
		if code, ecode := sessErrCode(t, e, "GET", path, nil); code != http.StatusNotFound || ecode != "artifact_not_found" {
			t.Errorf("%s: %d %q", path, code, ecode)
		}
	}
	// Without a session the scope is given.
	h := publish(t, e, map[string]any{"scope": "mine", "name": "spec", "path": src}, http.StatusCreated)
	if h.Scope != "mine" || h.Version != 1 || h.From != "" {
		t.Errorf("human artifact = %+v", h)
	}
	// A session may name another scope.
	o := publish(t, e, map[string]any{"from": "kid", "scope": "shared", "name": "spec", "path": src}, http.StatusCreated)
	if o.Scope != "shared" || o.From != "kid" {
		t.Errorf("explicit scope = %+v", o)
	}
	if left, _ := os.ReadDir(filepath.Join(e.cfg.Home, "artifacts", ".incoming")); len(left) != 0 {
		t.Errorf("the incoming area keeps %d entries", len(left))
	}
}

func TestArtifactPublishErrors(t *testing.T) {
	e := newAPIEnv(t)
	e.create(t, map[string]any{"dir": t.TempDir(), "id": "s1"})
	src := writeSrc(t, "a.txt", "x")
	dir := t.TempDir()
	link := filepath.Join(t.TempDir(), "dirlink")
	os.Symlink(dir, link)
	for _, tc := range []struct {
		body map[string]any
		code string
	}{
		{map[string]any{"from": "s1", "name": "a", "path": filepath.Join(dir, "missing")}, "file_not_found"},
		{map[string]any{"from": "s1", "name": "a", "path": dir}, "not_regular_file"},
		{map[string]any{"from": "s1", "name": "a", "path": link}, "not_regular_file"},
		{map[string]any{"from": "s1", "name": "a", "path": "a.txt"}, "path_not_absolute"},
		{map[string]any{"from": "s1", "name": "a", "path": ""}, "path_not_absolute"},
		{map[string]any{"from": "s1", "name": "Bad Name", "path": src}, "invalid_name"},
		{map[string]any{"from": "s1", "name": "", "path": src}, "invalid_name"},
		{map[string]any{"from": "ghost", "name": "a", "path": src}, "from_unknown"},
		{map[string]any{"name": "a", "path": src}, "scope_required"},
		{map[string]any{"scope": "../up", "name": "a", "path": src}, "invalid_scope"},
		{map[string]any{"scope": ".incoming", "name": "a", "path": src}, "invalid_scope"},
	} {
		if code, ecode := sessErrCode(t, e, "POST", "/v1/artifacts", tc.body); code != http.StatusBadRequest || ecode != tc.code {
			t.Errorf("%v: %d %q, want 400 %s", tc.body, code, ecode, tc.code)
		}
	}
	if files := storedFiles(t, e); len(files) != 0 {
		t.Errorf("refused publishes stored %v", files)
	}
	var list struct {
		Artifacts []artifactOut `json:"artifacts"`
	}
	e.call(t, "GET", "/v1/artifacts?versions=1", nil, &list)
	if len(list.Artifacts) != 0 {
		t.Errorf("refused publishes left rows: %v", list.Artifacts)
	}
}

func TestArtifactList(t *testing.T) {
	e := newAPIEnv(t)
	src := writeSrc(t, "a.txt", "1")
	a1 := publish(t, e, map[string]any{"scope": "r", "name": "a", "path": src, "labels": map[string]string{"kind": "spec"}}, http.StatusCreated)
	b1 := publish(t, e, map[string]any{"scope": "r", "name": "b", "path": src}, http.StatusCreated)
	os.WriteFile(src, []byte("2"), 0o644)
	a2 := publish(t, e, map[string]any{"scope": "r", "name": "a", "path": src}, http.StatusCreated)
	o1 := publish(t, e, map[string]any{"scope": "o", "name": "a", "path": src, "labels": map[string]string{"kind": "spec"}}, http.StatusCreated)
	for q, want := range map[string][]int64{
		"":                            {b1.ID, a2.ID, o1.ID},
		"?scope=r":                    {b1.ID, a2.ID},
		"?scope=r&versions=1":         {a1.ID, b1.ID, a2.ID},
		"?name=a":                     {a2.ID, o1.ID},
		"?label=kind=spec":            {o1.ID},
		"?label=kind=spec&versions=1": {a1.ID, o1.ID},
		"?scope=r&name=a&versions=1":  {a1.ID, a2.ID},
	} {
		var out struct {
			Artifacts []artifactOut `json:"artifacts"`
		}
		if code := e.call(t, "GET", "/v1/artifacts"+q, nil, &out); code != http.StatusOK {
			t.Fatalf("%s: %d", q, code)
		}
		ids := []int64{}
		for _, a := range out.Artifacts {
			ids = append(ids, a.ID)
		}
		if !reflect.DeepEqual(ids, want) {
			t.Errorf("%q -> %v, want %v", q, ids, want)
		}
	}
	if code := e.call(t, "GET", "/v1/artifacts?label=nokv", nil, nil); code != http.StatusBadRequest {
		t.Errorf("bad label: %d", code)
	}
}

func TestArtifactPublishedEvent(t *testing.T) {
	e := newAPIEnv(t)
	e.create(t, map[string]any{"dir": t.TempDir(), "id": "s1", "labels": map[string]string{"team": "a"}})
	src := writeSrc(t, "a.txt", "x")
	a := publish(t, e, map[string]any{"from": "s1", "name": "a", "path": src}, http.StatusCreated)
	publish(t, e, map[string]any{"from": "s1", "name": "a", "path": src}, http.StatusOK)
	evs, err := e.st.ListEvents(0, 0, "s1")
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, ev := range evs {
		if ev.Type != "artifact.published" {
			continue
		}
		n++
		al, _ := ev.Data["artifact_labels"].(map[string]any)
		if ev.Data["id"] != float64(a.ID) || ev.Data["scope"] != "s1" || ev.Data["name"] != "a" || ev.Data["version"] != float64(1) || al["team"] != "a" {
			t.Errorf("artifact.published data = %v", ev.Data)
		}
	}
	if n != 1 {
		t.Errorf("%d artifact.published events, want 1 (an unchanged publish adds none)", n)
	}
}

// TestArtifactOutlivesRemovedSession: review focus 1.
func TestArtifactOutlivesRemovedSession(t *testing.T) {
	e := newAPIEnv(t)
	e.create(t, map[string]any{"dir": t.TempDir(), "id": "s1", "labels": map[string]string{"team": "a"}})
	a := publish(t, e, map[string]any{"from": "s1", "name": "a", "path": writeSrc(t, "a.txt", "x")}, http.StatusCreated)
	if code := e.call(t, "POST", "/v1/sessions/s1/kill", nil, nil); code != http.StatusOK {
		t.Fatalf("kill: %d", code)
	}
	if code := e.call(t, "DELETE", "/v1/sessions/s1", nil, nil); code != http.StatusOK {
		t.Fatalf("remove: %d", code)
	}
	var got artifactOut
	if code := e.call(t, "GET", fmt.Sprintf("/v1/artifacts/%d", a.ID), nil, &got); code != http.StatusOK || got.Labels["team"] != "a" || got.Scope != "s1" {
		t.Errorf("after removal: %d %+v", code, got)
	}
	if b, err := os.ReadFile(a.Path); err != nil || string(b) != "x" {
		t.Errorf("file after removal: %q, %v", b, err)
	}
}

// TestArtifactConcurrentPublishes: review focus 2.
func TestArtifactConcurrentPublishes(t *testing.T) {
	e := newAPIEnv(t)
	const n = 6
	var wg sync.WaitGroup
	outs := make([]artifactOut, n)
	for i := 0; i < n; i++ {
		src := writeSrc(t, "same.txt", fmt.Sprintf("content %d", i))
		wg.Add(1)
		go func() {
			defer wg.Done()
			var out artifactOut
			if code := e.call(t, "POST", "/v1/artifacts", map[string]any{"scope": "r", "name": "same", "path": src}, &out); code != http.StatusCreated {
				t.Errorf("publish %d: %d", i, code)
			}
			outs[i] = out
		}()
	}
	wg.Wait()
	var versions []int64
	for i, o := range outs {
		versions = append(versions, o.Version)
		if b, err := os.ReadFile(o.Path); err != nil || string(b) != fmt.Sprintf("content %d", i) {
			t.Errorf("v%d holds %q, %v", o.Version, b, err)
		}
	}
	sort.Slice(versions, func(i, j int) bool { return versions[i] < versions[j] })
	if !reflect.DeepEqual(versions, []int64{1, 2, 3, 4, 5, 6}) {
		t.Errorf("versions = %v", versions)
	}
}

// TestArtifactIgnoresLaterSourceChanges: review focus 4.
func TestArtifactIgnoresLaterSourceChanges(t *testing.T) {
	e := newAPIEnv(t)
	src := writeSrc(t, "a.txt", "original")
	a := publish(t, e, map[string]any{"scope": "r", "name": "a", "path": src}, http.StatusCreated)
	if err := os.WriteFile(src, []byte("changed in place"), 0o644); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(a.Path); string(b) != "original" {
		t.Errorf("after the source changed the version holds %q", b)
	}
	os.Remove(src)
	if b, _ := os.ReadFile(a.Path); string(b) != "original" {
		t.Errorf("after the source was deleted the version holds %q", b)
	}
	var got artifactOut
	e.call(t, "GET", fmt.Sprintf("/v1/artifacts/%d", a.ID), nil, &got)
	if got.SHA256 != a.SHA256 || got.Size != int64(len("original")) {
		t.Errorf("row changed: %+v", got)
	}
}
