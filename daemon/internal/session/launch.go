package session

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/IvanRoslov/hopp/internal/agent"
	"github.com/IvanRoslov/hopp/internal/claudeinstance"
	"github.com/IvanRoslov/hopp/internal/socketmsg"
	"github.com/IvanRoslov/hopp/internal/store"
)

func (m *Manager) prepareNativeLaunch(ag agent.Agent, spec *agent.LaunchSpec, sess *store.Session) error {
	provider, ok := ag.(agent.NativeLaunchProvider)
	if !ok {
		return nil
	}
	native, err := provider.PrepareNativeLaunch(*spec)
	if err != nil {
		return err
	}
	if err := native.Validate(); err != nil {
		return err
	}
	spec.NativeDelivery = native
	sess.DeliveryTransport = native.Transport
	sess.DeliveryInstance = native.InstanceID
	sess.DeliveryEndpoint = native.Endpoint
	return m.st.UpdateSessionDelivery(sess.ID, native.Transport, native.InstanceID, native.Endpoint)
}

func (m *Manager) prepareClaudeLaunch(a agent.Agent, spec *agent.LaunchSpec, sess *store.Session) error {
	if !agent.SupportsClaudeSocket(a) {
		return nil
	}
	generation, e := socketmsg.NewMsgID()
	if e != nil {
		return e
	}
	l := claudeinstance.Launch{HoppSessionID: sess.ID, Generation: generation, StartedAt: time.Now().UTC()}
	if e = m.st.PutClaudeLaunch(l); e != nil {
		return e
	}
	spec.ClaudeLaunchGeneration = generation
	sess.Activity = ""
	sess.ActivityTS = 0
	return nil
}

func (m *Manager) captureClaudeLaunch(ctx context.Context, spec agent.LaunchSpec) {
	if spec.ClaudeLaunchGeneration == "" {
		return
	}
	probeCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	l, _, e := m.st.GetClaudeLaunch(spec.SessionID)
	if e == nil && l.Generation == spec.ClaudeLaunchGeneration && m.claudeProbe != nil {
		var pane claudeinstance.Pane
		var exists bool
		pane, exists, e = m.claudeProbe.Pane(probeCtx, spec.SessionID)
		if e == nil && exists && pane.PID > 0 && pane.Identity != "" && !pane.Start.IsZero() {
			l.PaneIdentity, l.PanePID, l.PaneStart = pane.Identity, pane.PID, pane.Start
			e = m.st.PutClaudeLaunch(l)
			if e == nil {
				return
			}
		}
	}
	slog.Warn("session: Claude launch anchor unavailable; socket delivery disabled for this launch", "session", spec.SessionID)
}

// launchArgs validates the interactive command before queueing a prompt.
// Availability can change between its earlier check and this call; an empty
// command would otherwise start a bare tmux shell while marking the session
// running. Input-first agents receive an argv copy without the first message.
func launchArgs(ag agent.Agent, spec agent.LaunchSpec) ([]string, error) {
	if agent.TakesFirstMessageByInput(ag) {
		spec.FirstMessage = ""
	}
	argv := ag.LaunchCommand(spec)
	if len(argv) == 0 || argv[0] == "" {
		return nil, fmt.Errorf("%s launch command is empty", ag.Name())
	}
	return argv, nil
}

// queueFirstMessage hands the launch prompt of an input-first agent to the
// message queue before the runtime starts. A spawning session is not
// eligible for delivery yet, so the prompt is ready when the session becomes
// running; the caller wakes delivery after launch.
func (m *Manager) queueFirstMessage(ag agent.Agent, spec *agent.LaunchSpec) error {
	if !agent.TakesFirstMessageByInput(ag) || spec.FirstMessage == "" {
		return nil
	}
	if m.firstMessage == nil {
		return validationErr("first_message_needs_queue", "this agent takes its first message by input, and no message queue is set")
	}
	if err := m.firstMessage(spec.SessionID, spec.FirstMessage); err != nil {
		return fmt.Errorf("queue first message: %w", err)
	}
	spec.FirstMessage = ""
	return nil
}

func prepareLaunchEnv(a agent.Agent, spec agent.LaunchSpec, baseEnv map[string]string) (map[string]string, []string) {
	env := mergeEnv(baseEnv, a.Env(spec))
	unsetEnv := agent.LaunchEnvUnsets(a, spec)
	for _, key := range unsetEnv {
		delete(env, key)
	}
	return env, unsetEnv
}
