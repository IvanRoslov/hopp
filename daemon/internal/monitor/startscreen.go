package monitor

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/IvanRoslov/hopp/internal/activity"
	"github.com/IvanRoslov/hopp/internal/agent"
	"github.com/IvanRoslov/hopp/internal/runtime"
	"github.com/IvanRoslov/hopp/internal/session"
	"github.com/IvanRoslov/hopp/internal/store"
)

// startScreenMissThreshold is how many consecutive sweeps must see the pane
// without the start screen before its quiz is closed — the same two-miss
// filter as permissionMissThreshold.
const startScreenMissThreshold = 2

// startScreenState is the monitor's per-session memory for checkStartScreen.
type startScreenState struct {
	// launchedAt is the launch (sessionLaunchedAt) the rest of the state
	// belongs to; a restore changes it and resets everything.
	launchedAt int64
	// started: the journal holds a task_started of this launch; the check
	// is over until the next restore (or daemon restart, when one cheap
	// read re-establishes it).
	started bool
	// miss counts sweeps without the screen while its quiz is pending.
	miss int
	// next is a screen other than the pending one, until confirmed.
	next permissionCandidate
}

// SetWake wires the queue's wake function, used to deliver the parent alert
// of a stuck start screen right away. Without it the message waits for the
// queue's own poll.
func (m *Monitor) SetWake(wake func(sessionID string)) {
	m.mu.Lock()
	m.wake = wake
	m.mu.Unlock()
}

// startState returns the session's state for launch launchedAt, starting
// afresh when the session was relaunched since it was recorded.
func (m *Monitor) startState(sessionID string, launchedAt int64) *startScreenState {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.startScreens == nil {
		m.startScreens = make(map[string]*startScreenState)
	}
	s, ok := m.startScreens[sessionID]
	if !ok || s.launchedAt != launchedAt {
		s = &startScreenState{launchedAt: launchedAt}
		m.startScreens[sessionID] = s
	}
	return s
}

// sessionLaunchedAt is when sess's current agent process was launched: the
// latest launch event (store.LaunchEventTypes — Restore relaunches a session
// in its worktree; a persistent agent reuses one row across every start),
// else created_at. The sessions table has no
// launch column; the event log is indexed by session, so this is one cheap
// lookup per sweep.
func (m *Monitor) sessionLaunchedAt(sess store.Session) int64 {
	launched := sess.CreatedAt
	ts, ok, err := m.st.LastLaunchTS(sess.ID)
	if err != nil {
		slog.Warn("monitor: read last restore", "session", sess.ID, "error", err)
	}
	if ok && ts > launched {
		launched = ts
	}
	return launched
}

// checkStartScreen catches a session whose agent CLI stopped on an
// interactive start screen before its first turn (Codex: «Trust this
// folder?», «Update available», «Background server has incompatible feature
// settings»; Kimi Code's folder-trust screen; Claude Code's is
// checkClaudeStartScreen). It applies only to adapters implementing agent.StartupProber,
// and only while HasStartedTurn is false for the current launch
// (sessionLaunchedAt): a restored session in the same worktree is checked
// afresh, since the previous run's journal there already has turns.
//
// A screen on the pane (runtime.ParseStartScreen) makes the session
// blocked and its pending quiz a permission quiz flagged StartScreen, so
// the human sees the screen in the dashboard and answers it there (the
// answer path presses the key; rocket never does on its own). A freshly
// journalled screen also alerts the parent orchestrator, or — for a
// session without one — logs a problem on its task: once per screen, since
// the journal row of the same screen is reused across sweeps and daemon
// restarts.
//
// Once the screen is gone (two misses) or the first turn starts, the quiz is
// closed and the session's state is left to the usual signals.
func (m *Monitor) checkStartScreen(ctx context.Context, sess store.Session, ag agent.Agent, state activity.State, ts time.Time) (activity.State, time.Time) {
	prober, ok := ag.(agent.StartupProber)
	if !ok {
		return state, ts
	}
	pending, hasPending := session.ParseQuiz(sess.PendingQuiz)
	startPending := hasPending && pending.IsStartScreen()
	if sess.PendingQuiz != "" && !startPending {
		// A quiz of another kind owns the session's attention.
		return state, ts
	}

	launchedAt := m.sessionLaunchedAt(sess)
	st := m.startState(sess.ID, launchedAt)
	if st.started {
		return state, ts
	}
	ref := agent.ActivityRef{SessionID: sess.ID, WorktreePath: sess.WorktreePath}
	if launchedAt > 0 {
		ref.Since = time.Unix(launchedAt, 0)
	}
	started, err := prober.HasStartedTurn(ctx, ref)
	switch {
	case err == nil && started:
		st.started = true
		if startPending {
			m.closeStartScreen(sess, pending)
		}
		return state, ts
	case err != nil && !errors.Is(err, agent.ErrNoSignal):
		return state, ts
	}

	out, err := m.rt.Capture(ctx, runtime.Handle{Name: sess.TmuxName}, runtime.PermissionCaptureLines)
	if err != nil {
		return state, ts
	}

	parse, build, screenName := runtime.ParseStartScreen, session.NewStartScreenQuiz, "Codex"
	if agent.PaneDialectOf(ag) == runtime.PaneDialectKimi {
		parse, build, screenName = runtime.ParseKimiStartScreen, session.NewKimiStartScreenQuiz, "Kimi Code"
	}
	switch m.startScreenOnPane(sess, st, pending, startPending, out, parse, build, screenName) {
	case screenShown:
		return activity.Blocked, time.Now()
	case screenPassed:
		return activity.Ready, time.Now()
	}
	return state, ts
}

// startScreenSeen is what startScreenOnPane read off a pane.
type startScreenSeen int

const (
	screenNone   startScreenSeen = iota // no screen, nothing pending (or not yet two misses)
	screenShown                         // the screen is up: the session waits on the human
	screenPassed                        // the pending screen is gone: its quiz was closed
)

// startScreenOnPane applies one sweep's pane capture out to the session's
// start-screen state: a screen parsed by parse becomes (or stays) the
// pending quiz built by build, a different screen replaces it once
// confirmed, and a pending screen missing for startScreenMissThreshold
// sweeps is closed.
func (m *Monitor) startScreenOnPane(sess store.Session, st *startScreenState, pending session.Quiz, startPending bool, out string,
	parse func(string) (runtime.PermissionPrompt, bool), build func(runtime.PermissionPrompt, int64, int64) session.Quiz, screenName string) startScreenSeen {
	if p, ok := parse(out); ok {
		st.miss = 0
		switch {
		case !startPending:
			st.next = permissionCandidate{}
			m.publishStartScreen(sess, p, false, build, screenName)
		case pending.PermissionPrompt().SameDialog(p):
			st.next = permissionCandidate{}
		default:
			if st.next.seen > 0 && st.next.prompt.SameDialog(p) {
				st.next.seen++
			} else {
				st.next = permissionCandidate{prompt: p, seen: 1}
			}
			if st.next.seen >= permissionChangeThreshold {
				st.next = permissionCandidate{}
				m.publishStartScreen(sess, p, true, build, screenName)
			}
		}
		return screenShown
	}

	st.next = permissionCandidate{}
	if !startPending {
		return screenNone
	}
	st.miss++
	if st.miss < startScreenMissThreshold {
		return screenNone
	}
	st.miss = 0
	m.closeStartScreen(sess, pending)
	return screenPassed
}

// checkClaudeStartScreen is checkStartScreen for a Claude Code root (Claude
// Code and DeepSeek): until the root's journal shows a turn of this launch,
// it reads the pane for Claude Code's folder-trust screen
// (runtime.ParseClaudeStartScreen). It runs before the exact binding is
// required, since a root stopped on that screen may have none yet. It reports
// whether the screen is up, in which case the session is marked blocked and
// the rest of the Claude poll is skipped.
func (m *Monitor) checkClaudeStartScreen(ctx context.Context, sess store.Session, r claudeResolution) bool {
	if sess.State != "running" && sess.State != "spawning" {
		return false
	}
	pending, hasPending := session.ParseQuiz(sess.PendingQuiz)
	startPending := hasPending && pending.IsStartScreen()
	if sess.PendingQuiz != "" && !startPending {
		return false
	}
	st := m.startState(sess.ID, m.sessionLaunchedAt(sess))
	if st.started {
		return false
	}
	if r.observation.target.HoppSessionID != "" {
		if _, _, _, err := claudeJournalTurn(ctx, r.Identity); err == nil {
			// The first turn ran: the check is over for this launch.
			st.started = true
			if startPending {
				m.closeStartScreen(sess, pending)
				m.applyMerge(sess, activity.Ready, time.Now(), true, "claude-start-screen")
			}
			return false
		}
	}
	out, err := m.rt.Capture(ctx, runtime.Handle{Name: sess.TmuxName}, runtime.PermissionCaptureLines)
	if err != nil {
		return startPending
	}
	switch m.startScreenOnPane(sess, st, pending, startPending, out, runtime.ParseClaudeStartScreen, session.NewClaudeStartScreenQuiz, "Claude Code") {
	case screenShown:
		m.applyMerge(sess, activity.Blocked, time.Now(), true, "claude-start-screen")
		return true
	case screenPassed:
		// Without this the poll would keep the blocked it set: an uncertain
		// journal never clears a block.
		m.applyMerge(sess, activity.Ready, time.Now(), true, "claude-start-screen")
	}
	return false
}

// publishStartScreen makes screen p the session's pending quiz and, when its
// journal row is new, raises the alert.
func (m *Monitor) publishStartScreen(sess store.Session, p runtime.PermissionPrompt, replacing bool,
	build func(runtime.PermissionPrompt, int64, int64) session.Quiz, screenName string) {
	published, fresh := m.publishPromptQuiz(sess, p, replacing, build)
	if published && fresh {
		m.alertStartScreen(sess, p, screenName)
	}
}

// closeStartScreen clears the pending start-screen quiz (compare-and-swap
// against what this sweep read) and closes its journal row.
func (m *Monitor) closeStartScreen(sess store.Session, pending session.Quiz) {
	swapped, err := m.st.CompareAndSwapPendingQuiz(sess.ID, sess.PendingQuiz, "")
	if err != nil {
		slog.Warn("monitor: clear start-screen quiz", "session", sess.ID, "error", err)
		return
	}
	if !swapped {
		return
	}
	if err := m.st.ResolvePermissionPrompt(pending.Permission.PromptID, time.Now().Unix()); err != nil {
		slog.Warn("monitor: resolve start-screen prompt", "session", sess.ID, "error", err)
	}
	slog.Info("monitor: start screen passed", "session", sess.ID, "title", pending.Permission.Title)
	m.bus.Publish("session.quiz_resolved", sess.ID, map[string]any{})
}

// startScreenAlert is the text of the alert about session id stuck on
// screen p.
func startScreenAlert(id string, p runtime.PermissionPrompt, screenName string) string {
	opts := make([]string, len(p.Options))
	for i, o := range p.Options {
		opts[i] = fmt.Sprintf("%d. %s", i+1, o)
	}
	return fmt.Sprintf(
		"[hopp] session %s is stuck on a %s start screen: «%s». Options: %s. "+
			"Answer it in the session's terminal; hopp does not press keys on its own.",
		id, screenName, p.Title, strings.Join(opts, "; "),
	)
}

// alertStartScreen tells someone that sess is stuck: a system message to
// its live parent, else a session.alert event.
func (m *Monitor) alertStartScreen(sess store.Session, p runtime.PermissionPrompt, screenName string) {
	m.alertParent(sess, startScreenAlert(sess.ID, p, screenName), "start screen", p.Title)
}

// alertParent sends body as a system message to sess's live parent, else
// publishes it as a session.alert event. what and detail label the log lines
// and the event. It reports whether the alert is done, so the caller must not
// retry it: true once the message is queued or the event is published, false
// only when the write to a live parent failed.
func (m *Monitor) alertParent(sess store.Session, body, what, detail string) bool {
	if sess.ParentID != "" {
		parent, err := m.st.GetSession(sess.ParentID)
		if err == nil && (parent.State == "running" || parent.State == "spawning") {
			id, err := m.st.AddMessage(store.Message{ToSession: parent.ID, Body: body})
			if err != nil {
				slog.Warn("monitor: alert parent about "+what, "session", sess.ID, "parent", parent.ID, "error", err)
				return false
			}
			m.bus.Publish("message.queued", parent.ID, map[string]any{"id": id, "from": "", "to": parent.ID})
			m.mu.Lock()
			wake := m.wake
			m.mu.Unlock()
			if wake != nil {
				wake(parent.ID)
			}
			return true
		}
	}

	slog.Warn("monitor: "+what+", nobody to tell", "session", sess.ID, "detail", detail)
	// Nobody will ever be there to tell: record it as an event, done.
	m.bus.Publish("session.alert", sess.ID, map[string]any{"what": what, "detail": detail, "body": body})
	return true
}
