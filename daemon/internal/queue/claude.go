package queue

import (
	"context"
	"errors"
	"github.com/IvanRoslov/hopp/internal/activity"
	"github.com/IvanRoslov/hopp/internal/claudeinstance"
	"github.com/IvanRoslov/hopp/internal/store"
	"log/slog"
	"strings"
	"time"
)

func (q *Queue) claudeDeadline(msg store.Message) time.Time {
	if q.cfg == nil || q.cfg.QueueTimeout <= 0 {
		return time.Time{}
	}
	return time.Unix(msg.CreatedAt, 0).Add(q.cfg.QueueTimeout)
}

// deliverClaude reports done=false only while an unsent row should wait, and
// then wait names why (see claudeWait*). It never dispatches through the
// legacy sender, regardless of probe or send outcome.
func (q *Queue) deliverClaude(ctx context.Context, msg store.Message, sess store.Session) (done bool, wait string) {
	if claudeAgeExpired(q.claudeDeadline(msg), q.now()) {
		q.fail(msg, "timeout")
		return true, ""
	}
	if msg.Attempts > 0 {
		q.fail(msg, "delivery_unconfirmed")
		return true, ""
	}
	cutoff, cutoffErr := q.st.ClaudeLegacyCutoff()
	if cutoffErr != nil {
		slog.Warn("queue: Claude legacy cutoff unavailable", "id", msg.ID, "error", cutoffErr)
		return false, "claude_cutoff_unavailable"
	}
	if msg.ID <= cutoff {
		q.fail(msg, "legacy_unproven")
		return true, ""
	}
	if q.socket == nil {
		return false, "claude_socket_unavailable"
	}
	r := q.socket.Resolve(ctx, sess)
	if r.State == claudeinstance.Dead {
		q.fail(msg, "recipient_unavailable")
		return true, ""
	}
	if r.State != claudeinstance.Verified {
		return false, "claude_resolve:" + r.Reason
	}
	// Eligibility belongs to the resolved durable binding, never a pre-follow cache.
	l, pinned, event, e := q.st.GetClaudeBinding(ctx, sess.ID)
	current, sessionErr := q.st.GetSession(sess.ID)
	check, again, observed, checkErr := q.st.GetClaudeBinding(ctx, sess.ID)
	if e != nil || sessionErr != nil || checkErr != nil || pinned == nil || again == nil || l.BindingRevision != check.BindingRevision || event != observed || !claudeinstance.SameIdentity(*pinned, *again) || !claudeinstance.SameIdentity(*again, r.Identity) {
		return false, "claude_binding_changed"
	}
	if current.Activity == string(activity.Blocked) {
		q.fail(msg, "recipient_unavailable")
		return true, ""
	}
	if !claudeEligible(current.Activity) {
		state := current.Activity
		if state == "" {
			state = "unknown"
		}
		return false, "claude_not_eligible:" + state
	}
	snapshot, e := q.socket.Prepare(ctx, sess, socketFromName(msg), q.prepareText(msg, sess))
	if e != nil {
		return false, "claude_prepare:" + claudePrepareClass(e)
	}
	if snapshot.BindingRevision != l.BindingRevision || !claudeinstance.SameIdentity(snapshot.Target, r.Identity) {
		return false, "claude_snapshot_changed"
	}
	snapshot.MessageID = msg.ID
	snapshot.PreparedAt = q.now().UTC()
	snapshot.Deadline = q.claudeDeadline(msg).UTC()
	snapshot.Phase = "possible_write"
	if claudeAgeExpired(snapshot.Deadline, snapshot.PreparedAt) {
		q.fail(msg, "timeout")
		return true, ""
	}
	ok, e := q.st.ClaimClaudeMessage(snapshot)
	if e != nil || !ok {
		slog.Warn("queue: Claude prewrite claim rejected", "id", msg.ID, "error", e)
		if e != nil {
			return false, "claude_claim_refused"
		}
		return true, ""
	}
	// Claimed: the message no longer waits, so a wait reason recorded by an
	// earlier pass (possibly in this same deliver call, which msg predates)
	// must not show during the socket write.
	if err := q.st.ClearClaimedReason(msg.ID); err != nil {
		slog.Warn("queue: clear Claude wait reason", "id", msg.ID, "error", err)
	}
	outcome, sendErr := q.socket.Send(ctx, snapshot)
	if sendErr != nil {
		slog.Warn("queue: Claude delivery awaits outcome/proof", "id", msg.ID, "outcome", outcome, "error", sendErr)
	}
	switch outcome {
	case SocketNotSent, SocketAccepted, SocketHeld, SocketDenied, SocketExpired:
	default:
		outcome = SocketUnknown
	}
	if outcome == SocketNotSent && !claudeAgeExpired(snapshot.Deadline, q.now()) && q.retryNotSent(msg.ID) {
		// Nothing reached the socket, so a fresh send cannot duplicate it.
		released, e := q.st.ReleaseClaudeNotSent(msg.ID, snapshot.WireID, snapshot.Target)
		if e != nil {
			slog.Warn("queue: release unsent Claude claim", "id", msg.ID, "error", e)
		}
		if released {
			slog.Info("queue: Claude send not made; retrying", "id", msg.ID, "to", msg.ToSession)
			return false, claudeWaitNotSentRetry
		}
	}
	ok, e = q.st.SetClaudePhase(msg.ID, snapshot.WireID, snapshot.Target, string(outcome), q.now())
	if e != nil {
		slog.Warn("queue: Claude outcome persistence uncertain; retaining claim", "id", msg.ID, "error", e)
	}
	q.forgetNotSent(msg.ID)
	if ok {
		if reason := claudeFailReason(outcome); reason != "" {
			q.announceFailure(msg, reason)
		}
	}
	q.kickConfirmer()
	return true, ""
}

// claudeNotSentTries bounds the sends of one message that end before any
// byte is written (a recheck right before the write refused, or the socket
// did not accept the connection); the last one fails the message.
const claudeNotSentTries = 3

// claudeWaitNotSentRetry is the wait reason of a message whose send was not
// made and is tried again.
const claudeWaitNotSentRetry = "claude_not_sent_retry"

// retryNotSent counts one unsent send of id and reports whether another
// send is allowed.
func (q *Queue) retryNotSent(id int64) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.notSent[id]++
	return q.notSent[id] < claudeNotSentTries
}

func (q *Queue) forgetNotSent(id int64) {
	q.mu.Lock()
	delete(q.notSent, id)
	q.mu.Unlock()
}

// claudeFailReason is the message reason a terminal socket outcome writes
// (see store.SetClaudePhase), or "" when the outcome does not fail it.
func claudeFailReason(o SocketOutcome) string {
	switch o {
	case SocketNotSent, SocketDenied, SocketExpired:
		return "claude_" + string(o)
	}
	return ""
}

// claudePrepareClass names a Prepare failure for a wait reason: a fixed
// class, never the error text, goes into the message row.
func claudePrepareClass(e error) string {
	switch {
	case errors.Is(e, ErrNoSocket):
		return "no_socket"
	case strings.Contains(e.Error(), "incomplete tail"):
		return "journal_incomplete_tail"
	case strings.Contains(e.Error(), "not a regular file"), strings.Contains(e.Error(), "changed during open"):
		return "journal_unusable"
	}
	return "error"
}
func claudeAgeExpired(deadline, now time.Time) bool {
	return !deadline.IsZero() && !now.Before(deadline)
}

// Lifecycle evidence belongs to the immutable saved target. Current generation
// changes and exited activity hints cannot decide an older process's fate.
func (q *Queue) claudeTargetEnded(ctx context.Context, v claudeinstance.Snapshot) bool {
	probeCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if claudeinstance.ExactLiveness(probeCtx, v.Target, q.claudeProbe) == claudeinstance.Dead {
		return true
	}
	if ctx.Err() != nil {
		return false
	}
	sess, e := q.getSession(v.Target.HoppSessionID)
	gone := errors.Is(e, store.ErrNotFound)
	if e != nil && !gone {
		return false
	}
	terminal := sess.State == "done" || sess.State == "killed" || sess.State == "errored"
	if !gone && !terminal {
		return false
	}
	launch, _, e := q.st.GetClaudeLaunch(v.Target.HoppSessionID)
	return e == nil && launch.Generation == v.Target.LaunchGeneration
}
func (q *Queue) confirmClaudeRecipient(ctx context.Context, msgs []store.Message) (pending int) {
	for i, msg := range msgs {
		if ctx.Err() != nil {
			return pending + len(msgs) - i
		}
		v, e := q.st.GetClaudeDelivery(msg.ID)
		if e == nil && !claudeAgeExpired(v.Deadline, q.now()) && !claudeAgeExpired(v.Deadline, time.Now()) {
			ended := q.claudeTargetEnded(ctx, v)
			scanCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			proof, found, scanErr := claudeinstance.FindProof(scanCtx, v)
			if found && scanErr == nil && scanCtx.Err() == nil && ctx.Err() == nil {
				ok, confirmErr := q.st.ConfirmClaudeMessageContext(scanCtx, msg.ID, proof, q.now())
				if confirmErr != nil {
					slog.Warn("queue: Claude proof remains uncertain", "id", msg.ID, "error", confirmErr)
				}
				if ok {
					cancel()
					q.bus.Publish("message.delivered", msg.ToSession, map[string]any{"id": msg.ID, "to": msg.ToSession, "from": msg.FromSession})
					continue
				}
			}
			cancel()
			if ctx.Err() != nil {
				return pending + len(msgs) - i
			}
			if ended {
				ok, err := q.st.SetClaudePhase(msg.ID, v.WireID, v.Target, "unconfirmed", q.now())
				if err != nil {
					pending++
					continue
				}
				if ok {
					q.announceFailure(msg, "delivery_unconfirmed")
					continue
				}
			}
		}
		if ctx.Err() != nil {
			return pending + len(msgs) - i
		}
		ok, e := q.st.ExpireClaudeMessage(msg.ID, q.now())
		if e != nil {
			pending++
			continue
		}
		if ok {
			q.announceFailure(msg, "delivery_unconfirmed")
			continue
		}
		current, e := q.st.GetMessage(msg.ID)
		if e != nil || (current.Status != "delivered" && current.Status != "failed") {
			pending++
		}
	}
	return pending
}

func claudeEligible(state string) bool {
	switch activity.State(state) {
	case activity.Active, activity.Ready, activity.Idle, activity.WaitingInput:
		return true
	}
	return false
}
