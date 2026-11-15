// Package sessiontest holds the fake runtime and fake agents that the
// session and api tests share. Nothing in it starts a real tmux session.
package sessiontest

import (
	"context"
	"sort"
	"sync"
	"time"

	"github.com/IvanRoslov/hopp/internal/activity"
	"github.com/IvanRoslov/hopp/internal/agent"
	"github.com/IvanRoslov/hopp/internal/runtime"
)

// Runtime is a fake runtime.Runtime. It records Create and Destroy calls and
// keeps the set of live tmux names with each one's environment. ListNames
// are live names nothing created through it (sessions of rocket or of a
// human). Tests read and change the fields under Mu.
type Runtime struct {
	Mu        sync.Mutex
	Created   []runtime.CreateSpec
	Destroyed []string
	Live      map[string]bool
	Envs      map[string]map[string]string
	ListNames []string
	CreateErr error
}

var _ runtime.Runtime = (*Runtime)(nil)

func (f *Runtime) Create(ctx context.Context, spec runtime.CreateSpec) (runtime.Handle, error) {
	f.Mu.Lock()
	defer f.Mu.Unlock()
	if f.CreateErr != nil {
		return runtime.Handle{}, f.CreateErr
	}
	f.Created = append(f.Created, spec)
	env := make(map[string]string, len(spec.Env))
	for k, v := range spec.Env {
		env[k] = v
	}
	f.setLive(spec.Name, env)
	return runtime.Handle{Name: spec.Name}, nil
}

// SetLive marks name as a live tmux session with the given environment.
func (f *Runtime) SetLive(name string, env map[string]string) {
	f.Mu.Lock()
	defer f.Mu.Unlock()
	f.setLive(name, env)
}

func (f *Runtime) setLive(name string, env map[string]string) {
	if f.Live == nil {
		f.Live = map[string]bool{}
	}
	if f.Envs == nil {
		f.Envs = map[string]map[string]string{}
	}
	f.Live[name] = true
	f.Envs[name] = env
}

// Die makes name's tmux session disappear without a Destroy call.
func (f *Runtime) Die(name string) {
	f.Mu.Lock()
	defer f.Mu.Unlock()
	delete(f.Live, name)
}

// Env is the fake counterpart of runtime.SessionEnv.
func (f *Runtime) Env(name, key string) (string, bool) {
	f.Mu.Lock()
	defer f.Mu.Unlock()
	v, ok := f.Envs[name][key]
	return v, ok
}

// OwnerProbe applies the session manager's default owner rule (the tmux
// session's HOPP_SESSION_ID equals the id) to the fake environments.
func (f *Runtime) OwnerProbe(ctx context.Context, tmuxName, id string) (bool, error) {
	v, ok := f.Env(tmuxName, "HOPP_SESSION_ID")
	return ok && v == id, nil
}

func (f *Runtime) Inject(ctx context.Context, h runtime.Handle, text string, opts runtime.InjectOpts) error {
	return nil
}

func (f *Runtime) SendKeys(ctx context.Context, h runtime.Handle, key string, literal bool) error {
	return nil
}

func (f *Runtime) Capture(ctx context.Context, h runtime.Handle, lines int) (string, error) {
	return "fake output", nil
}

func (f *Runtime) CaptureEscaped(ctx context.Context, h runtime.Handle, lines int) (string, error) {
	return f.Capture(ctx, h, lines)
}

func (f *Runtime) Alive(ctx context.Context, h runtime.Handle) bool {
	f.Mu.Lock()
	defer f.Mu.Unlock()
	if f.Live[h.Name] {
		return true
	}
	for _, n := range f.ListNames {
		if n == h.Name {
			return true
		}
	}
	return false
}

func (f *Runtime) Destroy(ctx context.Context, h runtime.Handle) error {
	f.Mu.Lock()
	defer f.Mu.Unlock()
	f.Destroyed = append(f.Destroyed, h.Name)
	delete(f.Live, h.Name)
	delete(f.Envs, h.Name)
	return nil
}

func (f *Runtime) AttachCommand(h runtime.Handle) []string {
	return []string{"tmux", "attach", "-t", "=" + h.Name}
}

func (f *Runtime) PinWindowSize(ctx context.Context, h runtime.Handle, clientCols, clientRows int) error {
	return nil
}

func (f *Runtime) UnpinWindowSize(ctx context.Context, h runtime.Handle) error { return nil }

func (*Runtime) ScrollHistory(context.Context, runtime.Handle, int) error { return nil }
func (*Runtime) ExitHistory(context.Context, runtime.Handle) error        { return nil }

func (f *Runtime) List(ctx context.Context) ([]string, error) {
	f.Mu.Lock()
	defer f.Mu.Unlock()
	names := append([]string(nil), f.ListNames...)
	for n := range f.Live {
		names = append(names, n)
	}
	sort.Strings(names)
	return names, nil
}

// Agent is a fake agent.Agent that records the specs it was given.
type Agent struct {
	AgentName    string
	FirstByInput bool
	AvailableErr error
	SetupErr     error
	SetupCalls   []agent.LaunchSpec
	LaunchCalls  []agent.LaunchSpec
	EnvOverrides map[string]string
	EffortLevels []string
}

func (a *Agent) Name() string              { return a.AgentName }
func (a *Agent) Efforts() []string         { return a.EffortLevels }
func (a *Agent) Available() error          { return a.AvailableErr }
func (a *Agent) FirstMessageByInput() bool { return a.FirstByInput }

func (a *Agent) SetupWorkspace(spec agent.LaunchSpec) error {
	a.SetupCalls = append(a.SetupCalls, spec)
	return a.SetupErr
}

func (a *Agent) LaunchCommand(spec agent.LaunchSpec) []string {
	a.LaunchCalls = append(a.LaunchCalls, spec)
	return []string{"fake-agent", "--session", spec.SessionID, "--msg", spec.FirstMessage}
}

func (a *Agent) Env(spec agent.LaunchSpec) map[string]string {
	env := map[string]string{
		"FAKE_ENV":        "1",
		"HOPP_SESSION_ID": spec.SessionID,
		"HOPP_PARENT_ID":  spec.ParentID,
		"HOPP_SOCKET":     spec.SocketPath,
	}
	for k, v := range a.EnvOverrides {
		env[k] = v
	}
	return env
}

func (a *Agent) Catalog(ctx context.Context) (agent.Catalog, error) {
	return agent.Catalog{}, nil
}

func (a *Agent) Activity(ctx context.Context, ref agent.ActivityRef) (activity.State, time.Time, error) {
	return "", time.Time{}, agent.ErrNoSignal
}

func (a *Agent) TranscriptTail(ctx context.Context, ref agent.ActivityRef, cursor string) ([]agent.ChatEntry, string, error) {
	return nil, "", agent.ErrNoSignal
}

func (a *Agent) TranscriptStat(ctx context.Context, ref agent.ActivityRef) (int64, int64, error) {
	return 0, 0, agent.ErrNoSignal
}

// FakeAgent and FakeInputAgent are the instances the "fake" and
// "fake-input" builders return; Register resets them. Tests in one package
// run sequentially, so the package-level indirection is safe.
var (
	FakeAgent      *Agent
	FakeInputAgent *Agent
	registerOnce   sync.Once
)

// Register adds the "fake" and "fake-input" agents to the agent registry of
// the calling test binary (once) and gives both fresh state. Only tests that
// need the fakes call it, so no other test binary sees them.
func Register() {
	FakeAgent = &Agent{AgentName: "fake", EffortLevels: []string{"low", "high"}}
	FakeInputAgent = &Agent{AgentName: "fake-input", FirstByInput: true}
	registerOnce.Do(func() {
		agent.Register("fake", func() agent.Agent { return FakeAgent })
		agent.Register("fake-input", func() agent.Agent { return FakeInputAgent })
	})
}
