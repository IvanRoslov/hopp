package session

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/IvanRoslov/hopp/internal/bus"
	"github.com/IvanRoslov/hopp/internal/config"
	"github.com/IvanRoslov/hopp/internal/session/sessiontest"
	"github.com/IvanRoslov/hopp/internal/store"
)

// --- test scaffolding ------------------------------------------------------

type testEnv struct {
	m   *Manager
	st  *store.Store
	rt  *sessiontest.Runtime
	cfg *config.Config
}

func testManager(t *testing.T) testEnv {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOPP_HOME", home)
	t.Setenv("HOME", t.TempDir())
	cfg, err := config.Load(home)
	if err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(filepath.Join(home, "hopp.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	sessiontest.Register()
	rt := &sessiontest.Runtime{}
	m := NewManager(st, bus.New(st), rt, cfg)
	// The default owner probe reads the tmux environment; the fake keeps one
	// per name, so the same rule runs against it.
	m.SetOwnerProbe(rt.OwnerProbe)
	m.SetPaneProber(func(ctx context.Context, tmuxName string) (bool, error) { return false, nil })
	return testEnv{m: m, st: st, rt: rt, cfg: cfg}
}

func fakeProfile() LaunchProfile {
	return LaunchProfile{Name: "p", Agent: "fake", Model: "m1", Effort: "high"}
}

func eventTypes(t *testing.T, st *store.Store, sessionID string) []string {
	t.Helper()
	events, err := st.ListEvents(0, 0, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	out := make([]string, 0, len(events))
	for _, e := range events {
		out = append(out, e.Type)
	}
	return out
}

func validationCode(err error) string {
	var ve *ValidationError
	if errors.As(err, &ve) {
		return ve.Code
	}
	return ""
}

// addLiveSession records a running session whose tmux session exists in the
// fake runtime with this id in its environment, as Spawn leaves it.
func addLiveSession(t *testing.T, e testEnv, id, parent, dir string) {
	t.Helper()
	if err := e.st.AddSession(store.Session{ID: id, ParentID: parent, WorktreePath: dir, TmuxName: id, Agent: "fake",
		State: "running", Model: "m1", Effort: "high", SystemPrompt: "be brief", PermissionMode: "plan",
		Env: map[string]string{"FOO": "bar"}, Prompt: "first"}); err != nil {
		t.Fatal(err)
	}
	e.rt.SetLive(id, map[string]string{"HOPP_SESSION_ID": id})
}

func sessionState(t *testing.T, st *store.Store, id string) string {
	t.Helper()
	s, err := st.GetSession(id)
	if err != nil {
		t.Fatal(err)
	}
	return s.State
}
