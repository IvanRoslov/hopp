// Package mailwatch tells a session that mail is waiting in the mailbox of
// its name. It is the unread notifier of rocket's agentwatch: rocket's watcher
// also adopted and retired persistent agents' tmux sessions, which hopp has
// no use for, so only the notice is ported. Whether a session is up comes
// from hopp's session record.
//
// When the session named after a mailbox is live and unread mail is waiting,
// the watcher queues exactly one line — "You have N unread messages" — and
// then stays quiet. The session pulls the messages itself with
// `hopp inbox next`; a new notice is only due once new unread mail has
// arrived since the last one, and never more often than
// cfg.MailboxNotifyInterval. A new launch of the session (it ended and came
// back, or was restored) starts over.
package mailwatch

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/IvanRoslov/hopp/internal/config"
	"github.com/IvanRoslov/hopp/internal/store"
)

// notifyState is what the watcher remembers per mailbox between ticks: the
// highest unread id it has already announced, when it announced it, and the
// launch of the session it told.
type notifyState struct {
	lastID int64
	at     time.Time
	launch int64
}

// Watcher notifies the sessions of mailboxes of unread mail.
type Watcher struct {
	st  *store.Store
	cfg *config.Config
	// wake kicks the delivery worker of a session the watcher queued a
	// notice for; typically Queue.Wake.
	wake func(to string)

	// now returns the current time; overridable by tests.
	now func() time.Time

	mu sync.Mutex
	// notified is the per-mailbox anti-spam bookkeeping. It is deliberately
	// in-memory: after a daemon restart, one extra notice per mailbox with
	// unread mail is the worst case, which is the right side to err on — a
	// missed notice is worse than a repeated one.
	notified map[string]notifyState
}

// New builds a Watcher. wake is typically Queue.Wake.
func New(st *store.Store, cfg *config.Config, wake func(to string)) *Watcher {
	if wake == nil {
		wake = func(string) {}
	}
	return &Watcher{st: st, cfg: cfg, wake: wake, now: time.Now, notified: map[string]notifyState{}}
}

// Run sweeps on a ticker until ctx is cancelled, starting with one immediate
// tick so sessions already running when the daemon starts are told.
func (w *Watcher) Run(ctx context.Context) {
	w.Tick(ctx)

	ticker := time.NewTicker(w.cfg.ActivityPollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.Tick(ctx)
		}
	}
}

// Tick runs one sweep: for every mailbox whose session is live, notify it of
// unread mail when a notice is due.
func (w *Watcher) Tick(ctx context.Context) {
	boxes, err := w.st.ListMailboxes()
	if err != nil {
		slog.Error("mailwatch: list mailboxes", "error", err)
		return
	}
	for _, b := range boxes {
		if ctx.Err() != nil {
			return
		}
		sess, err := w.st.GetSession(b.Name)
		if err != nil || (sess.State != "running" && sess.State != "spawning") {
			w.forget(b.Name)
			continue
		}
		launch := sess.CreatedAt
		if ts, ok, err := w.st.LastLaunchTS(sess.ID); err == nil && ok && ts > launch {
			launch = ts
		}
		w.notifyUnread(b.Name, launch)
	}
}

// notifyUnread queues the "N unread" line to the mailbox's live session, if
// one is due: unread messages exist, and this launch has not been told, or at
// least one of them arrived after the last notice (and that notice is old
// enough).
func (w *Watcher) notifyUnread(name string, launch int64) {
	maxID, err := w.st.MaxUnreadInboxID(name)
	if err != nil {
		slog.Error("mailwatch: max unread inbox id", "mailbox", name, "error", err)
		return
	}
	if maxID == 0 {
		return
	}

	now := w.now()
	w.mu.Lock()
	prev, seen := w.notified[name]
	if seen && prev.launch != launch {
		// A new launch has not been told whatever the previous one was.
		seen = false
	}
	due := !seen || (maxID > prev.lastID && now.Sub(prev.at) >= w.cfg.MailboxNotifyInterval)
	if due {
		w.notified[name] = notifyState{lastID: maxID, at: now, launch: launch}
	}
	w.mu.Unlock()

	if !due {
		return
	}

	n, err := w.st.CountUnreadInbox(name)
	if err != nil {
		slog.Error("mailwatch: count unread inbox", "mailbox", name, "error", err)
		return
	}
	if n == 0 {
		return
	}

	// A system message (no sender) so the session sees the bare line.
	if _, err := w.st.AddMessage(store.Message{
		ToSession: name,
		Body: fmt.Sprintf(
			"[hopp] You have %d unread message%s. Read them one by one with: hopp inbox next",
			n, plural(n)),
	}); err != nil {
		slog.Error("mailwatch: queue unread notice", "mailbox", name, "error", err)
		return
	}
	w.wake(name)
	slog.Info("mailwatch: notified session of unread messages", "mailbox", name, "unread", n)
}

// forget drops a mailbox's notice bookkeeping, so the next session of that
// name is told about the mail waiting for it even if the pile has not grown.
func (w *Watcher) forget(name string) {
	w.mu.Lock()
	delete(w.notified, name)
	w.mu.Unlock()
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}
