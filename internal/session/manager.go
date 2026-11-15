// Package session implements hopp's session lifecycle: validating and
// executing a launch request, stopping a session, and restoring one that has
// died or errored out.
package session

import (
	"context"
	"regexp"
	"strings"
	"sync"

	"github.com/IvanRoslov/hopp/internal/bus"
	"github.com/IvanRoslov/hopp/internal/claudeinstance"
	"github.com/IvanRoslov/hopp/internal/config"
	"github.com/IvanRoslov/hopp/internal/runtime"
	"github.com/IvanRoslov/hopp/internal/store"
)

// idPattern validates session ids: lowercase alphanumerics and hyphens only.
var idPattern = regexp.MustCompile(`^[a-z0-9-]+$`)

// maxIDLen is the longest session id; the id is also the tmux session name.
const maxIDLen = 60

// ValidationError is returned by Manager methods for request-shaped
// failures (bad input, unknown references, disallowed state transitions).
// The API maps Code to the appropriate HTTP status.
type ValidationError struct {
	Code    string
	Message string
}

func (e *ValidationError) Error() string { return e.Message }

func validationErr(code, msg string) *ValidationError {
	return &ValidationError{Code: code, Message: msg}
}

// LaunchProfile is the resolved model profile a launch runs with. Spawn
// passes Model/Effort to the agent and stores Name, Model and Effort as the
// session's snapshot, which Restore relaunches from.
type LaunchProfile struct {
	Name, Agent, Model, Effort string
}

// Manager owns session lifecycle: spawn, kill, restore.
type Manager struct {
	st          *store.Store
	bus         *bus.Bus
	rt          runtime.Runtime
	cfg         *config.Config
	claudeProbe claudeinstance.Probe
	wake        func(string) // wakes queued first-message delivery after launch

	// firstMessage hands the first message of an agent that takes it by
	// input to the message queue; nil until the queue is wired.
	firstMessage func(sessionID, body string) error

	// ownerProbe reports whether the live tmux session tmuxName belongs to
	// the hopp session id; every Destroy asks it first (see destroyOwned).
	// Defaults to comparing the tmux session's HOPP_SESSION_ID with id.
	ownerProbe func(ctx context.Context, tmuxName, id string) (bool, error)

	// paneOnlyShell reports whether a tmux session's pane holds only a bare
	// shell; defaults to runtime.PaneOnlyShell, shared with the monitor.
	paneOnlyShell func(ctx context.Context, tmuxName string) (bool, error)

	// mu serializes Spawn, Kill, Restore, and Reconcile end-to-end. Without
	// it, a Kill racing a concurrent Spawn between the session's
	// AddSession (state "spawning") and its final UpdateSession (state
	// "running") can lose: Kill marks the session "killed" first, then
	// Spawn's final write clobbers it back to "running" — a zombie session
	// the store believes is running but nothing is actually managing.
	mu sync.Mutex
}

// NewManager builds a Manager wired to the given dependencies.
func NewManager(st *store.Store, b *bus.Bus, rt runtime.Runtime, cfg *config.Config) *Manager {
	return &Manager{
		st: st, bus: b, rt: rt, cfg: cfg,
		claudeProbe:   claudeinstance.SystemProbe{},
		ownerProbe:    tmuxOwner,
		paneOnlyShell: runtime.PaneOnlyShell,
	}
}

// tmuxOwner is the default owner probe: the tmux session carries
// HOPP_SESSION_ID equal to id in its environment.
func tmuxOwner(ctx context.Context, tmuxName, id string) (bool, error) {
	v, ok, err := runtime.SessionEnv(ctx, tmuxName, "HOPP_SESSION_ID")
	if err != nil {
		return false, err
	}
	return ok && v == id, nil
}

// SetOwnerProbe overrides the check that a live tmux session belongs to a
// hopp session. Tests use it to avoid running tmux.
func (m *Manager) SetOwnerProbe(f func(ctx context.Context, tmuxName, id string) (bool, error)) {
	m.ownerProbe = f
}

// SetPaneProber overrides the check that tells whether a live tmux session's
// pane holds only a bare shell. Tests use it to avoid running tmux/ps.
func (m *Manager) SetPaneProber(f func(ctx context.Context, tmuxName string) (bool, error)) {
	m.paneOnlyShell = f
}

// SetWake installs the queue's wake function before sessions are launched.
func (m *Manager) SetWake(wake func(string)) { m.wake = wake }

// SetFirstMessageQueue installs the function that queues the first message
// of an agent that takes it by input (agent.TakesFirstMessageByInput).
func (m *Manager) SetFirstMessageQueue(f func(sessionID, body string) error) { m.firstMessage = f }

// SetClaudeProbe replaces the probe that anchors a Claude Code launch to its
// tmux pane; tests use it to avoid reading real processes.
func (m *Manager) SetClaudeProbe(p claudeinstance.Probe) { m.claudeProbe = p }

// markErrored transitions a session to "errored" and publishes
// session.state_changed with the failure reason. Errors from the store
// update itself are swallowed (best-effort) since the caller already has a
// more relevant error to return.
func (m *Manager) markErrored(id string, cause error) {
	_ = m.st.UpdateSessionState(id, "errored")
	_ = m.st.ClearPendingQuiz(id)
	m.bus.Publish("session.state_changed", id, map[string]any{
		"from": "spawning", "to": "errored", "reason": cause.Error(),
	})
}

func isTerminal(state string) bool {
	return state == "killed" || state == "done" || state == "errored"
}

func containsString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// liveNames returns the set of live tmux session names.
func (m *Manager) liveNames(ctx context.Context) (map[string]bool, error) {
	names, err := m.rt.List(ctx)
	if err != nil {
		return nil, err
	}
	set := make(map[string]bool, len(names))
	for _, n := range names {
		set[n] = true
	}
	return set, nil
}

// mergeEnv combines request-level and agent-level environment variables. On
// conflict the agent's value wins, since agent env carries protocol-level
// HOPP_* variables the runtime depends on.
func mergeEnv(baseEnv, agentEnv map[string]string) map[string]string {
	out := make(map[string]string, len(baseEnv)+len(agentEnv))
	for k, v := range baseEnv {
		out[k] = v
	}
	for k, v := range agentEnv {
		out[k] = v
	}
	return out
}

// shellQuote wraps s in single quotes, escaping embedded single quotes, so
// it can be safely embedded in a command string passed to `sh -c`.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// shellJoin shell-quotes each element of parts and joins them with spaces,
// producing a single command string suitable for runtime.CreateSpec.Command
// (which the launch script hands to sh).
func shellJoin(parts []string) string {
	quoted := make([]string, len(parts))
	for i, p := range parts {
		quoted[i] = shellQuote(p)
	}
	return strings.Join(quoted, " ")
}
