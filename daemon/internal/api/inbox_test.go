package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"testing"

	"github.com/IvanRoslov/hopp/internal/store"
)

func decodeMapResp(t *testing.T, resp *http.Response) map[string]any {
	t.Helper()
	defer resp.Body.Close()
	var m map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return m
}

func TestSendToMailboxWithLiveSessionUsesQueue(t *testing.T) {
	d := messagesTestDeps(t)
	d.Queue = nil
	srv := newTestServer(t, d)
	d.Store.AddMailbox("cto")
	addMsgTestSession(t, d, "cto", "running")
	resp := postJSON(t, srv.URL+"/v1/messages", map[string]any{"to": "cto", "body": "hi"})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("status %d, want 201", resp.StatusCode)
	}
	if b := decodeMapResp(t, resp); b["status"] != "queued" {
		t.Fatalf("body %v", b)
	}
	if n, _ := d.Store.CountUnreadInbox("cto"); n != 0 {
		t.Fatalf("inbox got %d", n)
	}
}

func TestSendToMailboxWithoutSessionGoesToInbox(t *testing.T) {
	for _, state := range []string{"", "killed"} {
		d := messagesTestDeps(t)
		srv := newTestServer(t, d)
		d.Store.AddMailbox("cto")
		if state != "" {
			addMsgTestSession(t, d, "cto", state)
		}
		addMsgTestSession(t, d, "sender", "running")
		ch, cancel := d.Bus.Subscribe()
		resp := postJSON(t, srv.URL+"/v1/messages", map[string]any{"to": "cto", "from": "sender", "body": "while you were out"})
		if resp.StatusCode != http.StatusAccepted {
			t.Fatalf("%q: status %d, want 202", state, resp.StatusCode)
		}
		b := decodeMapResp(t, resp)
		if b["status"] != "inbox" || b["to"] != "cto" || b["id"] == nil {
			t.Fatalf("%q: body %v", state, b)
		}
		msgs, _ := d.Store.ListInboxMessages("cto", store.InboxUnread, 0)
		if len(msgs) != 1 || msgs[0].From != "sender" || msgs[0].Body != "while you were out" {
			t.Fatalf("%q: inbox %+v", state, msgs)
		}
		if queued, _ := d.Store.ListMessages("cto", 0); len(queued) != 0 {
			t.Fatalf("%q: queued %+v", state, queued)
		}
		got := false
		for len(ch) > 0 {
			if e := <-ch; e.Type == "mailbox.received" && e.Data["mailbox"] == "cto" {
				got = true
			}
		}
		cancel()
		if !got {
			t.Errorf("%q: no mailbox.received event", state)
		}
		resp = postJSON(t, srv.URL+"/v1/messages", map[string]any{"to": "cto", "from": "ghost", "body": "x"})
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("%q: unknown sender %d, want 400", state, resp.StatusCode)
		}
		resp.Body.Close()
	}
}

// TestSendToEndedSessionWithoutMailboxIs409: unchanged behaviour for an id
// that is not a mailbox.
func TestSendToEndedSessionWithoutMailboxIs409(t *testing.T) {
	d := messagesTestDeps(t)
	srv := newTestServer(t, d)
	addMsgTestSession(t, d, "gone", "killed")
	resp := postJSON(t, srv.URL+"/v1/messages", map[string]any{"to": "gone", "body": "x"})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusConflict || decodeErr(t, resp).Error.Code != "recipient_terminal" {
		t.Fatalf("status %d", resp.StatusCode)
	}
}

func TestMailboxRoutes(t *testing.T) {
	e := newAPIEnv(t)
	if code := e.call(t, "POST", "/v1/mailboxes", map[string]any{"name": "Bad Name"}, nil); code != 400 {
		t.Errorf("bad name: %d", code)
	}
	if code := e.call(t, "POST", "/v1/mailboxes", map[string]any{"name": "cto"}, nil); code != 201 {
		t.Fatalf("add: %d", code)
	}
	var errBody map[string]any
	if code := e.call(t, "POST", "/v1/mailboxes", map[string]any{"name": "cto"}, &errBody); code != 409 || errCode(errBody) != "mailbox_exists" {
		t.Errorf("duplicate: %d %v", code, errBody)
	}
	e.st.AddInboxMessage(store.InboxMessage{Mailbox: "cto", Body: "first\nmore"})
	second, _ := e.st.AddInboxMessage(store.InboxMessage{Mailbox: "cto", From: "s1", Body: "second"})

	var list struct {
		Mailboxes []map[string]any `json:"mailboxes"`
	}
	if code := e.call(t, "GET", "/v1/mailboxes", nil, &list); code != 200 || len(list.Mailboxes) != 1 || list.Mailboxes[0]["unread"] != float64(2) {
		t.Fatalf("list: %d %+v", code, list)
	}
	var inbox struct {
		Messages []map[string]any `json:"messages"`
	}
	if code := e.call(t, "GET", "/v1/mailboxes/cto/inbox", nil, &inbox); code != 200 || len(inbox.Messages) != 2 {
		t.Fatalf("inbox: %d %+v", code, inbox)
	}
	var peek map[string]any
	if code := e.call(t, "GET", "/v1/mailboxes/cto/inbox/"+strconv.FormatInt(second, 10), nil, &peek); code != 200 || peek["body"] != "second" || peek["status"] != "unread" {
		t.Fatalf("peek: %d %v", code, peek)
	}
	if code := e.call(t, "GET", "/v1/mailboxes/other/inbox/"+strconv.FormatInt(second, 10), nil, nil); code != 404 {
		t.Errorf("peek in another mailbox: %d", code)
	}
	var next map[string]any
	if code := e.call(t, "POST", "/v1/mailboxes/cto/inbox/next", nil, &next); code != 200 || next["body"] != "first\nmore" {
		t.Fatalf("next: %d %v", code, next)
	}
	e.call(t, "POST", "/v1/mailboxes/cto/inbox/next", nil, nil)
	if code := e.call(t, "POST", "/v1/mailboxes/cto/inbox/next", nil, nil); code != 204 {
		t.Errorf("drained: %d, want 204", code)
	}
	inbox.Messages = nil
	if code := e.call(t, "GET", "/v1/mailboxes/cto/inbox?status=all", nil, &inbox); code != 200 || len(inbox.Messages) != 2 {
		t.Errorf("all: %d %+v", code, inbox)
	}
	if code := e.call(t, "GET", "/v1/mailboxes/nosuch/inbox", nil, nil); code != 404 {
		t.Errorf("unknown mailbox: %d", code)
	}
	if code := e.call(t, "DELETE", "/v1/mailboxes/cto", nil, nil); code != 200 {
		t.Errorf("remove: %d", code)
	}
	if code := e.call(t, "DELETE", "/v1/mailboxes/cto", nil, nil); code != 404 {
		t.Errorf("remove again: %d", code)
	}
}
