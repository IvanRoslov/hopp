package store

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"sync"
	"testing"
)

// placeIn returns a place function that writes body as the version's file
// under dir, and records the undo calls.
func placeIn(t *testing.T, dir, body string, undone *int) func(int64) (string, func(), error) {
	return func(v int64) (string, func(), error) {
		p := filepath.Join(dir, fmt.Sprintf("v%d", v), "f.txt")
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return "", nil, err
		}
		if err := os.WriteFile(p, []byte(body), 0o444); err != nil {
			return "", nil, err
		}
		return p, func() {
			if undone != nil {
				*undone++
			}
			os.RemoveAll(filepath.Dir(p))
		}, nil
	}
}

func TestPublishArtifactVersionsAndUnchanged(t *testing.T) {
	s := openTestStore(t)
	dir := t.TempDir()
	a := ArtifactVersion{Scope: "root", Name: "spec", Filename: "f.txt", Mime: "text/plain", Size: 1, SHA256: "aa", FromSession: "s1", Labels: map[string]string{"k": "v"}}
	v1, unchanged, err := s.PublishArtifact(a, placeIn(t, dir, "1", nil))
	if err != nil || unchanged || v1.Version != 1 || v1.Path != filepath.Join(dir, "v1", "f.txt") || v1.Labels["k"] != "v" || v1.CreatedAt == 0 {
		t.Fatalf("v1 = %+v, %v, %v", v1, unchanged, err)
	}
	called := false
	same, unchanged, err := s.PublishArtifact(a, func(int64) (string, func(), error) { called = true; return "", nil, nil })
	if err != nil || !unchanged || called || same.ID != v1.ID {
		t.Errorf("same sha: %+v unchanged=%v placed=%v err=%v", same, unchanged, called, err)
	}
	a.SHA256 = "bb"
	v2, unchanged, err := s.PublishArtifact(a, placeIn(t, dir, "2", nil))
	if err != nil || unchanged || v2.Version != 2 {
		t.Fatalf("v2 = %+v, %v, %v", v2, unchanged, err)
	}
	// The same sha as an older version is a new version: only the latest counts.
	a.SHA256 = "aa"
	if v3, unchanged, err := s.PublishArtifact(a, placeIn(t, dir, "3", nil)); err != nil || unchanged || v3.Version != 3 {
		t.Errorf("v3 = %+v, %v, %v", v3, unchanged, err)
	}
	// Another scope numbers its own versions.
	a.Scope = "other"
	if o, _, err := s.PublishArtifact(a, placeIn(t, t.TempDir(), "o", nil)); err != nil || o.Version != 1 {
		t.Errorf("other scope = %+v, %v", o, err)
	}
	got, err := s.GetArtifact(v2.ID)
	if err != nil || !reflect.DeepEqual(got, v2) {
		t.Errorf("GetArtifact = %+v, %v; want %+v", got, err, v2)
	}
	if _, err := s.GetArtifact(999); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown: %v", err)
	}
}

func TestPublishArtifactPlaceFailureStoresNothing(t *testing.T) {
	s := openTestStore(t)
	boom := errors.New("boom")
	_, _, err := s.PublishArtifact(ArtifactVersion{Scope: "r", Name: "n", SHA256: "x"}, func(int64) (string, func(), error) { return "", nil, boom })
	if !errors.Is(err, boom) {
		t.Errorf("err = %v", err)
	}
	if l, _ := s.ListArtifacts(ArtifactFilter{AllVersions: true}); len(l) != 0 {
		t.Errorf("rows after a failed place: %v", l)
	}
}

// TestPublishArtifactConcurrent: review focus 2 at the store.
func TestPublishArtifactConcurrent(t *testing.T) {
	s := openTestStore(t)
	dir := t.TempDir()
	const n = 8
	var wg sync.WaitGroup
	versions := make([]int64, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			a := ArtifactVersion{Scope: "r", Name: "same", SHA256: fmt.Sprintf("sha%d", i)}
			v, _, err := s.PublishArtifact(a, func(ver int64) (string, func(), error) {
				p := filepath.Join(dir, fmt.Sprintf("v%d", ver))
				f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o444)
				if err != nil {
					return "", nil, err
				}
				f.Close()
				return p, func() { os.Remove(p) }, nil
			})
			if err != nil {
				t.Error(err)
				return
			}
			versions[i] = v.Version
		}()
	}
	wg.Wait()
	sort.Slice(versions, func(i, j int) bool { return versions[i] < versions[j] })
	for i, v := range versions {
		if v != int64(i+1) {
			t.Fatalf("versions = %v", versions)
		}
		if _, err := os.Stat(filepath.Join(dir, fmt.Sprintf("v%d", v))); err != nil {
			t.Errorf("file of v%d: %v", v, err)
		}
	}
}

func TestListArtifacts(t *testing.T) {
	s := openTestStore(t)
	dir := t.TempDir()
	pub := func(scope, name, sha string, labels map[string]string) ArtifactVersion {
		t.Helper()
		v, _, err := s.PublishArtifact(ArtifactVersion{Scope: scope, Name: name, SHA256: sha, Labels: labels}, placeIn(t, filepath.Join(dir, scope, name, sha), sha, nil))
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	a1 := pub("r", "a", "1", map[string]string{"kind": "spec"})
	b1 := pub("r", "b", "1", nil)
	a2 := pub("r", "a", "2", map[string]string{"kind": "draft"})
	o1 := pub("o", "a", "1", map[string]string{"kind": "spec"})
	ids := func(f ArtifactFilter) []int64 {
		t.Helper()
		l, err := s.ListArtifacts(f)
		if err != nil {
			t.Fatal(err)
		}
		out := []int64{}
		for _, v := range l {
			out = append(out, v.ID)
		}
		return out
	}
	for name, tc := range map[string]struct {
		f    ArtifactFilter
		want []int64
	}{
		"latest":          {ArtifactFilter{}, []int64{b1.ID, a2.ID, o1.ID}},
		"scope":           {ArtifactFilter{Scope: "r"}, []int64{b1.ID, a2.ID}},
		"name":            {ArtifactFilter{Name: "a"}, []int64{a2.ID, o1.ID}},
		"all versions":    {ArtifactFilter{Scope: "r", AllVersions: true}, []int64{a1.ID, b1.ID, a2.ID}},
		"label on latest": {ArtifactFilter{Labels: map[string]string{"kind": "spec"}}, []int64{o1.ID}},
		"label, versions": {ArtifactFilter{Labels: map[string]string{"kind": "spec"}, AllVersions: true}, []int64{a1.ID, o1.ID}},
		"scope+name+all":  {ArtifactFilter{Scope: "r", Name: "a", AllVersions: true}, []int64{a1.ID, a2.ID}},
	} {
		if got := ids(tc.f); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: %v, want %v", name, got, tc.want)
		}
	}
}

func TestRootSession(t *testing.T) {
	s := openTestStore(t)
	mustAddSession(t, s, "top")
	for _, c := range []struct{ id, parent string }{{"mid", "top"}, {"leaf", "mid"}} {
		if err := s.AddSession(Session{ID: c.id, ParentID: c.parent, WorktreePath: "/wt", TmuxName: c.id, Agent: "claude-code", State: "running"}); err != nil {
			t.Fatal(err)
		}
	}
	for id, want := range map[string]string{"top": "top", "mid": "top", "leaf": "top"} {
		if got, err := s.RootSession(id); err != nil || got != want {
			t.Errorf("RootSession(%s) = %q, %v", id, got, err)
		}
	}
	if _, err := s.RootSession("ghost"); !errors.Is(err, ErrNotFound) {
		t.Errorf("ghost: %v", err)
	}
}

// TestArtifactSurvivesSessionRemoval: review focus 1 at the store.
func TestArtifactSurvivesSessionRemoval(t *testing.T) {
	s := openTestStore(t)
	mustAddSession(t, s, "gone")
	v, _, err := s.PublishArtifact(ArtifactVersion{Scope: "gone", Name: "n", SHA256: "x", FromSession: "gone", Labels: map[string]string{"k": "v"}}, placeIn(t, t.TempDir(), "x", nil))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.RemoveSessions([]string{"gone"}); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetArtifact(v.ID)
	if err != nil || got.FromSession != "gone" || got.Labels["k"] != "v" {
		t.Errorf("after removal: %+v, %v", got, err)
	}
}
