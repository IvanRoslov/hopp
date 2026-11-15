package session

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"

	"github.com/IvanRoslov/hopp/internal/bus"
	"github.com/IvanRoslov/hopp/internal/config"
	"github.com/IvanRoslov/hopp/internal/runtime"
	"github.com/IvanRoslov/hopp/internal/session/sessiontest"
	"github.com/IvanRoslov/hopp/internal/store"
)

// The answer tests (quiz_test.go, quiz_manager_test.go,
// permission_answer_test.go, startscreen_answer_test.go,
// kimi_startscreen_answer_test.go) come from rocket and drive rocket's
// recording fake runtime. It is rocket's fakeRuntime from its
// manager_test.go, with the three Runtime methods hopp's interface adds.

type sentKey struct {
	handle  string
	key     string
	literal bool
}

type fakeRuntime struct {
	mu        sync.Mutex
	created   []runtime.CreateSpec
	destroyed []string
	aliveMap  map[string]bool
	listNames []string
	sentKeys  []sentKey
	sendErr   error
	onCreate  func()
	createErr error

	// captureOut, when set, is what Capture returns (default "fake
	// output"); captureErr fails it; captureLines records each requested
	// depth.
	captureOut   string
	captureErr   error
	captureLines []int
	// captureAfterKeys, when set, is what Capture returns once any key
	// has been sent (the screen changed in response).
	captureAfterKeys string
	// captureSeq, when not empty, is returned one pane per Capture (before
	// the fields above); once used up, Capture falls back to them.
	captureSeq []string
}

func (f *fakeRuntime) Create(ctx context.Context, spec runtime.CreateSpec) (runtime.Handle, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.onCreate != nil {
		f.onCreate()
	}
	if f.createErr != nil {
		return runtime.Handle{}, f.createErr
	}
	f.created = append(f.created, spec)
	if f.aliveMap == nil {
		f.aliveMap = map[string]bool{}
	}
	f.aliveMap[spec.Name] = true
	return runtime.Handle{Name: spec.Name}, nil
}

func (f *fakeRuntime) Inject(ctx context.Context, h runtime.Handle, text string, opts runtime.InjectOpts) error {
	return nil
}

func (f *fakeRuntime) SendKeys(ctx context.Context, h runtime.Handle, key string, literal bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sentKeys = append(f.sentKeys, sentKey{handle: h.Name, key: key, literal: literal})
	return f.sendErr
}

func (f *fakeRuntime) Capture(ctx context.Context, h runtime.Handle, lines int) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.captureLines = append(f.captureLines, lines)
	if f.captureErr != nil {
		return "", f.captureErr
	}
	if len(f.captureSeq) > 0 {
		out := f.captureSeq[0]
		f.captureSeq = f.captureSeq[1:]
		return out, nil
	}
	if f.captureAfterKeys != "" && len(f.sentKeys) > 0 {
		return f.captureAfterKeys, nil
	}
	if f.captureOut != "" {
		return f.captureOut, nil
	}
	return "fake output", nil
}

func (f *fakeRuntime) CaptureEscaped(ctx context.Context, h runtime.Handle, lines int) (string, error) {
	return f.Capture(ctx, h, lines)
}

func (f *fakeRuntime) Alive(ctx context.Context, h runtime.Handle) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.aliveMap[h.Name]
}

func (f *fakeRuntime) PinWindowSize(ctx context.Context, h runtime.Handle, clientCols, clientRows int) error {
	return nil
}

func (f *fakeRuntime) UnpinWindowSize(ctx context.Context, h runtime.Handle) error { return nil }

func (f *fakeRuntime) ScrollHistory(ctx context.Context, h runtime.Handle, lines int) error {
	return nil
}

func (f *fakeRuntime) ExitHistory(ctx context.Context, h runtime.Handle) error { return nil }

func (f *fakeRuntime) Destroy(ctx context.Context, h runtime.Handle) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.destroyed = append(f.destroyed, h.Name)
	delete(f.aliveMap, h.Name)
	return nil
}

func (f *fakeRuntime) AttachCommand(h runtime.Handle) []string {
	return []string{"tmux", "attach", "-t", h.Name}
}

func (f *fakeRuntime) List(ctx context.Context) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.listNames, nil
}

// answerTestManager is rocket's testManager for the answer tests, built on
// hopp's NewManager with a temporary HOPP_HOME and HOME.
func answerTestManager(t *testing.T) (*Manager, *store.Store, *bus.Bus, *fakeRuntime) {
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
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	sessiontest.Register()
	b := bus.New(st)
	rt := &fakeRuntime{}
	return NewManager(st, b, rt, cfg), st, b, rt
}

// seedRunningSession is rocket's helper without its scenario fields.
func seedRunningSession(t *testing.T, st *store.Store, id string) store.Session {
	t.Helper()
	sess := store.Session{
		ID: id, Agent: "fake", WorktreePath: "/fake/wt/" + id, TmuxName: id, State: "running",
	}
	if err := st.AddSession(sess); err != nil {
		t.Fatalf("AddSession: %v", err)
	}
	return sess
}

// assertValidationCode is rocket's helper from its manager_test.go.
func assertValidationCode(t *testing.T, err error, code string) {
	t.Helper()
	var verr *ValidationError
	if !errors.As(err, &verr) {
		t.Fatalf("err = %v, want *ValidationError", err)
	}
	if verr.Code != code {
		t.Errorf("code = %q, want %q", verr.Code, code)
	}
}
