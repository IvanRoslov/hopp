package session

import (
	"context"
	"errors"
	"path/filepath"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/IvanRoslov/hopp/internal/activity"
	"github.com/IvanRoslov/hopp/internal/agent"
	"github.com/IvanRoslov/hopp/internal/bus"
	"github.com/IvanRoslov/hopp/internal/config"
	"github.com/IvanRoslov/hopp/internal/runtime"
	"github.com/IvanRoslov/hopp/internal/store"
)

// --- fakes ---------------------------------------------------------------

// fakeRuntime records Create and Destroy calls and keeps the set of live
// tmux names with each one's environment. listNames are live names the
// store does not know about (sessions of rocket or of a human).
type fakeRuntime struct {
	mu        sync.Mutex
	created   []runtime.CreateSpec
	destroyed []string
	aliveMap  map[string]bool
	envs      map[string]map[string]string
	listNames []string
	createErr error
}

func (f *fakeRuntime) Create(ctx context.Context, spec runtime.CreateSpec) (runtime.Handle, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.createErr != nil {
		return runtime.Handle{}, f.createErr
	}
	f.created = append(f.created, spec)
	if f.aliveMap == nil {
		f.aliveMap = map[string]bool{}
	}
	if f.envs == nil {
		f.envs = map[string]map[string]string{}
	}
	f.aliveMap[spec.Name] = true
	env := make(map[string]string, len(spec.Env))
	for k, v := range spec.Env {
		env[k] = v
	}
	f.envs[spec.Name] = env
	return runtime.Handle{Name: spec.Name}, nil
}

func (f *fakeRuntime) Inject(ctx context.Context, h runtime.Handle, text string, opts runtime.InjectOpts) error {
	return nil
}

func (f *fakeRuntime) SendKeys(ctx context.Context, h runtime.Handle, key string, literal bool) error {
	return nil
}

func (f *fakeRuntime) Capture(ctx context.Context, h runtime.Handle, lines int) (string, error) {
	return "fake output", nil
}

func (f *fakeRuntime) CaptureEscaped(ctx context.Context, h runtime.Handle, lines int) (string, error) {
	return f.Capture(ctx, h, lines)
}

func (f *fakeRuntime) Alive(ctx context.Context, h runtime.Handle) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.aliveMap[h.Name] || containsString(f.listNames, h.Name)
}

func (f *fakeRuntime) Destroy(ctx context.Context, h runtime.Handle) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.destroyed = append(f.destroyed, h.Name)
	delete(f.aliveMap, h.Name)
	delete(f.envs, h.Name)
	return nil
}

func (f *fakeRuntime) AttachCommand(h runtime.Handle) []string {
	return []string{"tmux", "attach", "-t", h.Name}
}

func (f *fakeRuntime) PinWindowSize(ctx context.Context, h runtime.Handle, clientCols, clientRows int) error {
	return nil
}

func (f *fakeRuntime) UnpinWindowSize(ctx context.Context, h runtime.Handle) error { return nil }

func (*fakeRuntime) ScrollHistory(context.Context, runtime.Handle, int) error { return nil }
func (*fakeRuntime) ExitHistory(context.Context, runtime.Handle) error        { return nil }

func (f *fakeRuntime) List(ctx context.Context) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	names := append([]string(nil), f.listNames...)
	for n := range f.aliveMap {
		names = append(names, n)
	}
	sort.Strings(names)
	return names, nil
}

// sessionEnv is the fake counterpart of runtime.SessionEnv.
func (f *fakeRuntime) sessionEnv(name, key string) (string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	v, ok := f.envs[name][key]
	return v, ok
}

// fakeAgent records the specs it was given.
type fakeAgent struct {
	name         string
	firstByInput bool
	availableErr error
	setupErr     error
	setupCalls   []agent.LaunchSpec
	launchCalls  []agent.LaunchSpec
	envOverrides map[string]string
}

func (a *fakeAgent) Name() string              { return a.name }
func (a *fakeAgent) Efforts() []string         { return nil }
func (a *fakeAgent) Available() error          { return a.availableErr }
func (a *fakeAgent) FirstMessageByInput() bool { return a.firstByInput }
func (a *fakeAgent) SetupWorkspace(spec agent.LaunchSpec) error {
	a.setupCalls = append(a.setupCalls, spec)
	return a.setupErr
}

func (a *fakeAgent) LaunchCommand(spec agent.LaunchSpec) []string {
	a.launchCalls = append(a.launchCalls, spec)
	return []string{"fake-agent", "--session", spec.SessionID, "--msg", spec.FirstMessage}
}

func (a *fakeAgent) Env(spec agent.LaunchSpec) map[string]string {
	env := map[string]string{
		"FAKE_ENV":        "1",
		"HOPP_SESSION_ID": spec.SessionID,
		"HOPP_PARENT_ID":  spec.ParentID,
		"HOPP_SOCKET":     spec.SocketPath,
	}
	for k, v := range a.envOverrides {
		env[k] = v
	}
	return env
}

func (a *fakeAgent) Catalog(ctx context.Context) (agent.Catalog, error) {
	return agent.Catalog{}, nil
}

func (a *fakeAgent) Activity(ctx context.Context, ref agent.ActivityRef) (activity.State, time.Time, error) {
	return "", time.Time{}, agent.ErrNoSignal
}

func (a *fakeAgent) TranscriptTail(ctx context.Context, ref agent.ActivityRef, cursor string) ([]agent.ChatEntry, string, error) {
	return nil, "", agent.ErrNoSignal
}

func (a *fakeAgent) TranscriptStat(ctx context.Context, ref agent.ActivityRef) (int64, int64, error) {
	return 0, 0, agent.ErrNoSignal
}

// testFakeAgent and testFakeInputAgent are the instances the "fake" and
// "fake-input" builders return. Tests reset them through testManager; tests
// in this package run sequentially, so the package-level indirection is safe.
var (
	testFakeAgent      *fakeAgent
	testFakeInputAgent *fakeAgent
)

func init() {
	agent.Register("fake", func() agent.Agent { return testFakeAgent })
	agent.Register("fake-input", func() agent.Agent { return testFakeInputAgent })
}

// --- test scaffolding ------------------------------------------------------

type testEnv struct {
	m   *Manager
	st  *store.Store
	rt  *fakeRuntime
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
	testFakeAgent = &fakeAgent{name: "fake"}
	testFakeInputAgent = &fakeAgent{name: "fake-input", firstByInput: true}
	rt := &fakeRuntime{}
	m := NewManager(st, bus.New(st), rt, cfg)
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
