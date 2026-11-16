package session

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestInside(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "work")
	for _, d := range []string{"work/sub/deep", "work-other", "outside"} {
		if err := os.MkdirAll(filepath.Join(base, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	link := filepath.Join(root, "link-out")
	if err := os.Symlink(filepath.Join(base, "outside"), link); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, dir string
		want      bool
	}{
		{"equal", root, true},
		{"nested", filepath.Join(root, "sub", "deep"), true},
		{"sibling with a common string prefix", filepath.Join(base, "work-other"), false},
		{"dot-dot out", root + "/sub/../../outside", false},
		{"dot-dot back in", root + "/sub/..", true},
		{"symlink out", link, false},
		{"parent of root", base, false},
	} {
		if got := inside(tc.dir, root); got != tc.want {
			t.Errorf("%s: inside(%s, %s) = %v, want %v", tc.name, tc.dir, root, got, tc.want)
		}
	}
	// A root reached through a symlink is the same root.
	rootLink := filepath.Join(base, "work-link")
	if err := os.Symlink(root, rootLink); err != nil {
		t.Fatal(err)
	}
	if !inside(filepath.Join(root, "sub"), rootLink) {
		t.Error("a folder inside a root named through a symlink is not inside")
	}
	if inside(filepath.Join(base, "gone"), root) || inside(root, filepath.Join(base, "gone")) {
		t.Error("a missing folder counts as inside")
	}
}

// dirsEnv is a manager with a folder tree:
//
//	base/allowed/sub, base/allowed-other, base/outside
//
// and a session "limited" whose spawn dirs are [base/allowed], plus an
// unlimited session "free".
type dirsEnv struct {
	testEnv
	base, allowed, sub, outside string
}

func newDirsEnv(t *testing.T) dirsEnv {
	t.Helper()
	e := testManager(t)
	base := t.TempDir()
	d := dirsEnv{testEnv: e, base: base,
		allowed: filepath.Join(base, "allowed"), sub: filepath.Join(base, "allowed", "sub"),
		outside: filepath.Join(base, "outside")}
	for _, p := range []string{d.sub, filepath.Join(base, "allowed-other"), d.outside} {
		if err := os.MkdirAll(p, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	d.spawn(t, SpawnReq{ID: "limited", Dir: d.allowed, SpawnDirs: []string{d.allowed}})
	d.spawn(t, SpawnReq{ID: "free", Dir: d.outside})
	return d
}

func (d dirsEnv) spawn(t *testing.T, req SpawnReq) []string {
	t.Helper()
	req.Profile = fakeProfile()
	sess, err := d.m.Spawn(context.Background(), req)
	if err != nil {
		t.Fatalf("Spawn %+v: %v", req, err)
	}
	stored, err := d.st.GetSession(sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	return stored.SpawnDirs
}

func (d dirsEnv) refuse(t *testing.T, req SpawnReq, code string) error {
	t.Helper()
	req.Profile = fakeProfile()
	n := len(d.rt.Created)
	_, err := d.m.Spawn(context.Background(), req)
	if validationCode(err) != code {
		t.Fatalf("Spawn %+v: err = %v, want %s", req, err, code)
	}
	if len(d.rt.Created) != n {
		t.Errorf("a refused launch still created a tmux session")
	}
	if req.ID != "" {
		if _, err := d.st.GetSession(req.ID); err == nil {
			t.Errorf("a refused launch still recorded %s", req.ID)
		}
	}
	return err
}

func TestSpawnDirsAllowedFolderPasses(t *testing.T) {
	d := newDirsEnv(t)
	d.spawn(t, SpawnReq{ID: "a", ParentID: "limited", CallerID: "limited", Dir: d.allowed})
	d.spawn(t, SpawnReq{ID: "b", ParentID: "limited", CallerID: "limited", Dir: d.sub})
}

func TestSpawnDirsOutsideRefusedAndNamesTheAllowedFolders(t *testing.T) {
	d := newDirsEnv(t)
	err := d.refuse(t, SpawnReq{ID: "x", ParentID: "limited", CallerID: "limited", Dir: d.outside}, "dir_not_allowed")
	if !strings.Contains(err.Error(), d.allowed) {
		t.Errorf("message %q does not name the allowed folder %s", err, d.allowed)
	}
	d.refuse(t, SpawnReq{ID: "y", ParentID: "limited", CallerID: "limited", Dir: filepath.Join(d.base, "allowed-other")}, "dir_not_allowed")
}

func TestSpawnDirsCheckedAgainstCallerNotParent(t *testing.T) {
	d := newDirsEnv(t)
	// --no-parent from inside the limited session.
	d.refuse(t, SpawnReq{ID: "x", CallerID: "limited", Dir: d.outside}, "dir_not_allowed")
	// --parent free from inside the limited session.
	d.refuse(t, SpawnReq{ID: "y", ParentID: "free", CallerID: "limited", Dir: d.outside}, "dir_not_allowed")
}

func TestSpawnDirsSymlinkOutRefused(t *testing.T) {
	d := newDirsEnv(t)
	link := filepath.Join(d.allowed, "out")
	if err := os.Symlink(d.outside, link); err != nil {
		t.Fatal(err)
	}
	d.refuse(t, SpawnReq{ID: "x", CallerID: "limited", Dir: link}, "dir_not_allowed")
	d.refuse(t, SpawnReq{ID: "y", CallerID: "limited", Dir: d.allowed + "/sub/../../outside"}, "dir_not_allowed")
}

func TestSpawnDirsUnknownCallerRefused(t *testing.T) {
	d := newDirsEnv(t)
	d.refuse(t, SpawnReq{ID: "x", CallerID: "ghost", Dir: d.outside}, "caller_not_found")
}

func TestSpawnDirsChildInheritsLimit(t *testing.T) {
	d := newDirsEnv(t)
	got := d.spawn(t, SpawnReq{ID: "c", ParentID: "limited", CallerID: "limited", Dir: d.sub})
	if !reflect.DeepEqual(got, []string{d.allowed}) {
		t.Errorf("child spawn dirs = %v, want %v", got, []string{d.allowed})
	}
	// Without a caller (a client outside any session) the parent's limit applies.
	got = d.spawn(t, SpawnReq{ID: "c2", ParentID: "limited", Dir: d.sub})
	if !reflect.DeepEqual(got, []string{d.allowed}) {
		t.Errorf("child of a limited parent without a caller: spawn dirs = %v", got)
	}
	d.refuse(t, SpawnReq{ID: "c3", ParentID: "limited", Dir: d.outside}, "dir_not_allowed")
	// The grandchild is held by the inherited limit.
	d.refuse(t, SpawnReq{ID: "g", ParentID: "c", CallerID: "c", Dir: d.outside}, "dir_not_allowed")
}

func TestSpawnDirsChildNarrows(t *testing.T) {
	d := newDirsEnv(t)
	got := d.spawn(t, SpawnReq{ID: "c", ParentID: "limited", CallerID: "limited", Dir: d.sub, SpawnDirs: []string{d.sub}})
	if !reflect.DeepEqual(got, []string{d.sub}) {
		t.Errorf("narrowed spawn dirs = %v, want %v", got, []string{d.sub})
	}
	d.refuse(t, SpawnReq{ID: "g", ParentID: "c", CallerID: "c", Dir: d.allowed}, "dir_not_allowed")
}

func TestSpawnDirsChildWideningRefused(t *testing.T) {
	d := newDirsEnv(t)
	d.refuse(t, SpawnReq{ID: "c", ParentID: "limited", CallerID: "limited", Dir: d.sub,
		SpawnDirs: []string{d.sub, d.outside}}, "spawn_dirs_not_allowed")
	d.refuse(t, SpawnReq{ID: "c2", ParentID: "limited", CallerID: "limited", Dir: d.sub,
		SpawnDirs: []string{d.base}}, "spawn_dirs_not_allowed")
}

func TestSpawnDirsWithoutLimitAnyFolderAndRequestStored(t *testing.T) {
	d := newDirsEnv(t)
	if got := d.spawn(t, SpawnReq{ID: "c", ParentID: "free", CallerID: "free", Dir: d.outside}); len(got) != 0 {
		t.Errorf("child of an unlimited session got spawn dirs %v", got)
	}
	got := d.spawn(t, SpawnReq{ID: "c2", CallerID: "free", Dir: d.outside, SpawnDirs: []string{d.allowed, d.outside}})
	if !reflect.DeepEqual(got, []string{d.allowed, d.outside}) {
		t.Errorf("spawn dirs = %v", got)
	}
}

func TestSpawnDirsRequestMustBeAbsoluteAndExist(t *testing.T) {
	d := newDirsEnv(t)
	d.refuse(t, SpawnReq{ID: "x", Dir: d.outside, SpawnDirs: []string{filepath.Join(d.base, "gone")}}, "spawn_dir_not_found")
	d.refuse(t, SpawnReq{ID: "y", Dir: d.outside, SpawnDirs: []string{"relative/dir"}}, "spawn_dir_not_absolute")
}
