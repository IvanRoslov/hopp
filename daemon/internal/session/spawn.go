package session

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/IvanRoslov/hopp/internal/agent"
	"github.com/IvanRoslov/hopp/internal/runtime"
	"github.com/IvanRoslov/hopp/internal/store"
)

// SpawnReq describes a request to launch a new session. An empty ID is
// derived from Dir; an empty Profile.Agent means the configured default
// agent.
type SpawnReq struct {
	ID             string
	ParentID       string
	Dir            string
	Labels         map[string]string
	Profile        LaunchProfile
	SystemPrompt   string
	FirstMessage   string
	PermissionMode string
	Env            map[string]string
}

// Spawn validates req, records the session and launches its agent in a new
// tmux session named after the session id.
func (m *Manager) Spawn(ctx context.Context, req SpawnReq) (store.Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if !filepath.IsAbs(req.Dir) {
		return store.Session{}, validationErr("dir_not_absolute", "dir must be an absolute path: "+req.Dir)
	}
	if info, err := os.Stat(req.Dir); err != nil || !info.IsDir() {
		return store.Session{}, validationErr("dir_not_found", "dir is not an existing directory: "+req.Dir)
	}

	agentName := req.Profile.Agent
	if agentName == "" {
		agentName = m.cfg.DefaultAgent
	}
	ag, err := agent.Get(agentName)
	if err != nil {
		return store.Session{}, validationErr("agent_unknown", "unknown agent: "+agentName)
	}
	if err := ag.Available(); err != nil {
		return store.Session{}, validationErr("agent_unavailable", "agent unavailable: "+err.Error())
	}
	if v, ok := ag.(agent.PermissionModeValidator); ok {
		if err := v.ValidatePermissionMode(req.PermissionMode); err != nil {
			return store.Session{}, validationErr("invalid_permission_mode", err.Error())
		}
	}

	var parent store.Session
	if req.ParentID != "" {
		if parent, err = m.st.GetSession(req.ParentID); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				return store.Session{}, validationErr("parent_not_found", "parent session not found: "+req.ParentID)
			}
			return store.Session{}, err
		}
	}
	labels := mergeLabels(parent.Labels, req.Labels)

	if agent.TakesFirstMessageByInput(ag) && req.FirstMessage != "" && m.firstMessage == nil {
		return store.Session{}, validationErr("first_message_needs_queue", "this agent takes its first message by input, and no message queue is set")
	}

	if req.ID != "" {
		if !validID(req.ID) {
			return store.Session{}, validationErr("invalid_id", fmt.Sprintf("id must match ^[a-z0-9-]+$ and be at most %d characters", maxIDLen))
		}
		live, err := m.liveNames(ctx)
		if err != nil {
			return store.Session{}, err
		}
		taken, err := m.idTaken(req.ID, live)
		if err != nil {
			return store.Session{}, err
		}
		if taken {
			return store.Session{}, validationErr("session_exists", "session id is taken: "+req.ID)
		}
	}

	// Retry id reservation up to 3 times in case of a concurrent spawn race.
	// The race: reserveID picks a name, but between that check and AddSession,
	// another writer inserts the same name. On ErrExists, recompute the name
	// (suffix search sees the winner) and retry. A given id is not retried.
	var id string
	var sess store.Session
	const maxRetries = 3
	for attempt := 1; attempt <= maxRetries; attempt++ {
		id = req.ID
		if id == "" {
			id, err = m.reserveID(ctx, baseIDFromDir(req.Dir))
			if err != nil {
				return store.Session{}, err
			}
		}

		sess = store.Session{
			ID:             id,
			ParentID:       req.ParentID,
			WorktreePath:   req.Dir,
			TmuxName:       id,
			Labels:         labels,
			Agent:          agentName,
			Profile:        req.Profile.Name,
			Model:          req.Profile.Model,
			Effort:         req.Profile.Effort,
			State:          "spawning",
			Prompt:         req.FirstMessage,
			SystemPrompt:   req.SystemPrompt,
			PermissionMode: req.PermissionMode,
			Env:            req.Env,
		}

		if err := m.st.AddSession(sess); err != nil {
			if errors.Is(err, store.ErrExists) && req.ID != "" {
				return store.Session{}, validationErr("session_exists", "session id is taken: "+req.ID)
			}
			if errors.Is(err, store.ErrExists) && attempt < maxRetries {
				continue // retry
			}
			if errors.Is(err, store.ErrExists) {
				return store.Session{}, fmt.Errorf("session id reservation raced 3 times for %q", baseIDFromDir(req.Dir))
			}
			return store.Session{}, err
		}

		m.bus.Publish("session.spawned", id, map[string]any{
			"parent": req.ParentID, "dir": req.Dir,
		})
		break // success
	}

	spec := agent.LaunchSpec{
		SessionID:      id,
		ParentID:       req.ParentID,
		WorktreePath:   req.Dir,
		SystemPrompt:   req.SystemPrompt,
		FirstMessage:   req.FirstMessage,
		Model:          req.Profile.Model,
		Effort:         req.Profile.Effort,
		PermissionMode: req.PermissionMode,
		SocketPath:     m.cfg.SocketPath(),
	}

	if err := m.prepareNativeLaunch(ag, &spec, &sess); err != nil {
		m.markErrored(id, err)
		return store.Session{}, err
	}
	if err := m.prepareClaudeLaunch(ag, &spec, &sess); err != nil {
		m.markErrored(id, err)
		return store.Session{}, err
	}
	if err := ag.SetupWorkspace(spec); err != nil {
		m.markErrored(id, err)
		return store.Session{}, err
	}
	argv, err := launchArgs(ag, spec)
	if err != nil {
		m.markErrored(id, err)
		return store.Session{}, err
	}
	queuedFirst := agent.TakesFirstMessageByInput(ag) && spec.FirstMessage != ""
	if err := m.queueFirstMessage(ag, &spec); err != nil {
		m.markErrored(id, err)
		return store.Session{}, err
	}

	env, unsetEnv := prepareLaunchEnv(ag, spec, req.Env)
	env["HOPP_HOME"] = m.cfg.Home
	cmd := shellJoin(argv)

	if _, err := m.rt.Create(ctx, runtime.CreateSpec{
		Name:     id,
		Dir:      req.Dir,
		Command:  cmd,
		Env:      env,
		UnsetEnv: unsetEnv,
	}); err != nil {
		m.markErrored(id, err)
		return store.Session{}, err
	}

	m.captureClaudeLaunch(ctx, spec)
	sess.State = "running"
	if err := m.st.UpdateSession(sess); err != nil {
		return store.Session{}, err
	}
	m.bus.Publish("session.state_changed", id, map[string]any{"from": "spawning", "to": "running"})
	if queuedFirst && m.wake != nil {
		m.wake(id)
	}

	return m.st.GetSession(id)
}

// mergeLabels returns the parent's labels overlaid with the request's: the
// request wins on a shared key, and a request label with an empty value
// removes that key. Neither input is changed.
func mergeLabels(parent, req map[string]string) map[string]string {
	out := make(map[string]string, len(parent)+len(req))
	for k, v := range parent {
		out[k] = v
	}
	for k, v := range req {
		if v == "" {
			delete(out, k)
			continue
		}
		out[k] = v
	}
	return out
}
