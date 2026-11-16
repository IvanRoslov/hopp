package session

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/IvanRoslov/hopp/internal/store"
)

// spawnDirs applies the folder rule to a launch and returns the spawn dirs
// the new session is stored with.
//
// The limit is the caller's spawn dirs when the request names a caller (the
// session the request came from), else the parent's. It is checked against
// the caller, not only the parent, so a limited session cannot escape its
// folders with --no-parent or --parent <other>. A child keeps the limit, or
// narrows it with folders inside it; it never widens it.
func (m *Manager) spawnDirs(req SpawnReq, parent store.Session) ([]string, error) {
	var limit []string
	switch {
	case req.CallerID != "":
		caller, err := m.st.GetSession(req.CallerID)
		if errors.Is(err, store.ErrNotFound) {
			return nil, validationErr("caller_not_found", "caller session not found: "+req.CallerID)
		}
		if err != nil {
			return nil, err
		}
		limit = caller.SpawnDirs
	case req.ParentID != "":
		limit = parent.SpawnDirs
	}

	if len(limit) > 0 && !insideAny(req.Dir, limit) {
		return nil, validationErr("dir_not_allowed",
			"dir is outside the folders this session may launch in: "+req.Dir+"; allowed: "+strings.Join(limit, ", "))
	}

	if len(req.SpawnDirs) == 0 {
		return limit, nil
	}
	out := make([]string, 0, len(req.SpawnDirs))
	for _, d := range req.SpawnDirs {
		if !filepath.IsAbs(d) {
			return nil, validationErr("spawn_dir_not_absolute", "spawn dir must be an absolute path: "+d)
		}
		if info, err := os.Stat(d); err != nil || !info.IsDir() {
			return nil, validationErr("spawn_dir_not_found", "spawn dir is not an existing directory: "+d)
		}
		if len(limit) > 0 && !insideAny(d, limit) {
			return nil, validationErr("spawn_dirs_not_allowed",
				"spawn dir is outside the folders this session may launch in: "+d+"; allowed: "+strings.Join(limit, ", "))
		}
		out = append(out, filepath.Clean(d))
	}
	return out, nil
}

func insideAny(dir string, roots []string) bool {
	for _, r := range roots {
		if inside(dir, r) {
			return true
		}
	}
	return false
}

// inside reports whether dir is root or a folder under it. Both are resolved
// through symlinks first, so a link inside root that points out of it is
// outside, and the match is on whole path segments, so /a/work-other is not
// inside /a/work. A path that does not resolve is never inside.
func inside(dir, root string) bool {
	d, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return false
	}
	r, err := filepath.EvalSymlinks(root)
	if err != nil {
		return false
	}
	d, r = filepath.Clean(d), filepath.Clean(r)
	if d == r {
		return true
	}
	if r == string(filepath.Separator) {
		return true
	}
	return strings.HasPrefix(d, r+string(filepath.Separator))
}
