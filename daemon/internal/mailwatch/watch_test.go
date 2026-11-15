package mailwatch

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/IvanRoslov/hopp/internal/config"
	"github.com/IvanRoslov/hopp/internal/store"
)

// These are rocket's agentwatch notification tests. Rocket's watcher
// learned an agent's session was up from tmux and adopted it; hopp's reads
// the session record, so "the session appears" is a running session row,
// "goes away" is a terminal state and "restarts between ticks" is a new
// launch (a session.restored event).

type harness struct {
	w     *Watcher
	st    *store.Store
	woken []string
	now   time.Time
}

func newHarness(t *testing.T, mailboxes ...string) *harness {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "hopp.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	for _, name := range mailboxes {
		if err := st.AddMailbox(name); err != nil {
			t.Fatalf("AddMailbox %s: %v", name, err)
		}
	}
	h := &harness{st: st, now: time.Unix(1_800_000_000, 0)}
	cfg := &config.Config{
		ActivityPollInterval:  time.Second,
		MailboxNotifyInterval: 5 * time.Minute,
	}
	h.w = New(st, cfg, func(to string) { h.woken = append(h.woken, to) })
	h.w.now = func() time.Time { return h.now }
	return h
}

// up makes the session named id running (creating it on first use).
func (h *harness) up(t *testing.T, id string) {
	t.Helper()
	if _, err := h.st.GetSession(id); err != nil {
		if err := h.st.AddSession(store.Session{ID: id, Agent: "claude-code", WorktreePath: "/tmp/" + id, TmuxName: id, State: "running", CreatedAt: 100}); err != nil {
			t.Fatal(err)
		}
		return
	}
	if err := h.st.UpdateSessionState(id, "running"); err != nil {
		t.Fatal(err)
	}
}

func (h *harness) down(t *testing.T, id string) {
	t.Helper()
	if err := h.st.UpdateSessionState(id, "killed"); err != nil {
		t.Fatal(err)
	}
}

// unread appends an unread message to a mailbox.
func (h *harness) unread(t *testing.T, mailbox, body string) {
	t.Helper()
	if _, err := h.st.AddInboxMessage(store.InboxMessage{Mailbox: mailbox, Body: body}); err != nil {
		t.Fatalf("AddInboxMessage: %v", err)
	}
}

// notices returns the notification messages queued to a session.
func (h *harness) notices(t *testing.T, id string) []string {
	t.Helper()
	msgs, err := h.st.ListMessages(id, 0)
	if err != nil {
		t.Fatalf("ListMessages: %v", err)
	}
	var out []string
	for _, m := range msgs {
		out = append(out, m.Body)
	}
	return out
}

func TestNotifiesOnceWhenTheSessionAppears(t *testing.T) {
	h := newHarness(t, "sre")
	h.up(t, "sre")
	h.unread(t, "sre", "one")
	h.unread(t, "sre", "two")

	h.w.Tick(context.Background())

	notices := h.notices(t, "sre")
	if len(notices) != 1 {
		t.Fatalf("notices = %v, want exactly one", notices)
	}
	if want := "[hopp] You have 2 unread messages. Read them one by one with: hopp inbox next"; notices[0] != want {
		t.Errorf("notice = %q, want %q", notices[0], want)
	}
	if len(h.woken) != 1 || h.woken[0] != "sre" {
		t.Errorf("woken = %v, want [sre]", h.woken)
	}

	// A second tick over the same unread pile stays quiet.
	h.now = h.now.Add(time.Hour)
	h.w.Tick(context.Background())
	if notices := h.notices(t, "sre"); len(notices) != 1 {
		t.Errorf("notices after a quiet tick = %v, want still one", notices)
	}
}

func TestSingularWording(t *testing.T) {
	h := newHarness(t, "sre")
	h.up(t, "sre")
	h.unread(t, "sre", "one")

	h.w.Tick(context.Background())

	notices := h.notices(t, "sre")
	if len(notices) != 1 || !strings.Contains(notices[0], "1 unread message.") {
		t.Fatalf("notice = %v, want the singular wording", notices)
	}
}

func TestNoNotificationWithoutUnread(t *testing.T) {
	h := newHarness(t, "sre")
	h.up(t, "sre")

	h.w.Tick(context.Background())

	if notices := h.notices(t, "sre"); len(notices) != 0 {
		t.Errorf("notices = %v, want none", notices)
	}
}

func TestNoNotificationWithoutLiveSession(t *testing.T) {
	h := newHarness(t, "sre")
	h.unread(t, "sre", "one")
	h.w.Tick(context.Background())
	if len(h.woken) != 0 {
		t.Errorf("woken = %v with no session", h.woken)
	}
}

func TestNewUnreadRenotifiesOnlyAfterTheInterval(t *testing.T) {
	h := newHarness(t, "sre")
	h.up(t, "sre")
	h.unread(t, "sre", "one")
	h.w.Tick(context.Background())

	// New mail, but too soon after the first notice.
	h.unread(t, "sre", "two")
	h.now = h.now.Add(time.Minute)
	h.w.Tick(context.Background())
	if notices := h.notices(t, "sre"); len(notices) != 1 {
		t.Fatalf("notices inside the anti-spam window = %v, want still one", notices)
	}

	// Past the interval, the new message earns a fresh notice.
	h.now = h.now.Add(5 * time.Minute)
	h.w.Tick(context.Background())
	notices := h.notices(t, "sre")
	if len(notices) != 2 {
		t.Fatalf("notices after the interval = %v, want two", notices)
	}
	if !strings.Contains(notices[1], "2 unread messages") {
		t.Errorf("second notice = %q, want the current unread count", notices[1])
	}
}

// TestUnreadNoticeSentOnceUntilNewMail is the plan's name for the rule the
// two tests above pin: one notice per unread pile, again only for new mail.
func TestUnreadNoticeSentOnceUntilNewMail(t *testing.T) {
	h := newHarness(t, "sre")
	h.up(t, "sre")
	h.unread(t, "sre", "one")
	for i := 0; i < 3; i++ {
		h.now = h.now.Add(10 * time.Minute)
		h.w.Tick(context.Background())
	}
	if n := len(h.notices(t, "sre")); n != 1 {
		t.Fatalf("notices = %d, want 1 while nothing new arrived", n)
	}
	h.unread(t, "sre", "two")
	h.now = h.now.Add(10 * time.Minute)
	h.w.Tick(context.Background())
	if n := len(h.notices(t, "sre")); n != 2 {
		t.Fatalf("notices = %d, want 2 after new mail", n)
	}
}

func TestSessionRestartNotifiesAgain(t *testing.T) {
	h := newHarness(t, "sre")
	h.up(t, "sre")
	h.unread(t, "sre", "one")
	h.w.Tick(context.Background())

	// The session goes away and comes back with the same mail still unread:
	// the new session has not been told about it.
	h.down(t, "sre")
	h.w.Tick(context.Background())
	h.up(t, "sre")
	h.now = h.now.Add(time.Second)
	h.w.Tick(context.Background())

	if notices := h.notices(t, "sre"); len(notices) != 2 {
		t.Fatalf("notices = %v, want one per session", notices)
	}
}

// TestRestartBetweenTicksNotifiesAgain guards the case the anti-spam window
// would otherwise swallow: the session is restored quickly enough that no
// tick ever saw it ended. The new launch is still a new session and has not
// been told about the waiting mail.
func TestRestartBetweenTicksNotifiesAgain(t *testing.T) {
	h := newHarness(t, "sre")
	h.up(t, "sre")
	h.unread(t, "sre", "one")
	h.w.Tick(context.Background())

	if _, err := h.st.AppendEvent(store.Event{TS: 200, Type: "session.restored", SessionID: "sre"}); err != nil {
		t.Fatal(err)
	}
	h.now = h.now.Add(time.Second)
	h.w.Tick(context.Background())

	if notices := h.notices(t, "sre"); len(notices) != 2 {
		t.Fatalf("notices = %v, want one per session", notices)
	}
}
