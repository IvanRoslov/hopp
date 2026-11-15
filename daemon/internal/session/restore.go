package session

import (
	"context"
	"errors"
	"os"

	"github.com/IvanRoslov/hopp/internal/agent"
	"github.com/IvanRoslov/hopp/internal/runtime"
	"github.com/IvanRoslov/hopp/internal/store"
)

// RestoreOpts tunes Manager.Restore.
type RestoreOpts struct {
	// Force restores a "running" session whose agent still looks alive: the
	// tmux session is destroyed and the agent relaunched. Without it such a
	// session is rejected with restore_not_allowed.
	Force bool
}

// Restore relaunches a dead/errored session's agent in its stored folder
// from the stored snapshot, then marks it running. It is allowed from state
// "errored"/"killed", or from "running" when the runtime handle is gone or
// its pane holds only a bare shell (the agent exited and nothing replaced
// it). A running session whose agent still looks alive is restored only
// with opts.Force.
func (m *Manager) Restore(ctx context.Context, id string, opts RestoreOpts) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	sess, err := m.st.GetSession(id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return validationErr("session_not_found", "session not found: "+id)
		}
		return err
	}

	allowed := sess.State == "errored" || sess.State == "killed"
	destroyTmux := false
	if !allowed && sess.State == "running" {
		h := runtime.Handle{Name: sess.TmuxName}
		switch {
		case !m.rt.Alive(ctx, h):
			allowed = true
		case opts.Force:
			allowed, destroyTmux = true, true
		default:
			// A probe error is inconclusive, never "dead".
			if only, err := m.paneOnlyShell(ctx, sess.TmuxName); err == nil && only {
				allowed, destroyTmux = true, true
			}
		}
		if !allowed {
			return validationErr("restore_not_allowed",
				"session is running and its agent looks alive; use --force to kill the tmux session and relaunch")
		}
	}
	if !allowed {
		return validationErr("restore_not_allowed", "session cannot be restored from state: "+sess.State)
	}

	ag, err := agent.Get(sess.Agent)
	if err != nil {
		return err
	}
	if err := ag.Available(); err != nil {
		return validationErr("agent_unavailable", "agent unavailable: "+err.Error())
	}
	if info, err := os.Stat(sess.WorktreePath); err != nil || !info.IsDir() {
		return validationErr("dir_not_found", "dir is not an existing directory: "+sess.WorktreePath)
	}

	if destroyTmux {
		// Create would fail on the name still held by the stale tmux session.
		if err := m.destroyOwned(ctx, sess); err != nil {
			return err
		}
	}

	spec := agent.LaunchSpec{
		SessionID:      id,
		ParentID:       sess.ParentID,
		WorktreePath:   sess.WorktreePath,
		SystemPrompt:   sess.SystemPrompt,
		FirstMessage:   "",
		PermissionMode: sess.PermissionMode,
		SocketPath:     m.cfg.SocketPath(),
		// The snapshot, not the policy: a session that was launched may be
		// restored even if its profile has since been disabled or deleted.
		Model:  sess.Model,
		Effort: sess.Effort,
	}

	if err := m.prepareNativeLaunch(ag, &spec, &sess); err != nil {
		m.markErrored(id, err)
		return err
	}
	if err := m.prepareClaudeLaunch(ag, &spec, &sess); err != nil {
		m.markErrored(id, err)
		return err
	}
	if err := ag.SetupWorkspace(spec); err != nil {
		m.markErrored(id, err)
		return err
	}
	argv, err := launchArgs(ag, spec)
	if err != nil {
		m.markErrored(id, err)
		return err
	}
	queuedFirst := agent.TakesFirstMessageByInput(ag) && spec.FirstMessage != ""
	if err := m.queueFirstMessage(ag, &spec); err != nil {
		m.markErrored(id, err)
		return err
	}

	env, unsetEnv := prepareLaunchEnv(ag, spec, sess.Env)
	env["HOPP_HOME"] = m.cfg.Home
	cmd := shellJoin(argv)

	if _, err := m.rt.Create(ctx, runtime.CreateSpec{
		Name:     id,
		Dir:      sess.WorktreePath,
		Command:  cmd,
		Env:      env,
		UnsetEnv: unsetEnv,
	}); err != nil {
		return err
	}

	m.captureClaudeLaunch(ctx, spec)
	sess.State = "running"
	if err := m.st.UpdateSession(sess); err != nil {
		return err
	}
	m.bus.Publish("session.restored", id, nil)
	if queuedFirst && m.wake != nil {
		m.wake(id)
	}

	return nil
}
