package api

import (
	"strconv"
	"strings"
	"testing"

	"github.com/IvanRoslov/hopp/internal/store"
)

func createAsk(t *testing.T, e apiEnv, body map[string]any) map[string]any {
	t.Helper()
	var out map[string]any
	if code := e.call(t, "POST", "/v1/asks", body, &out); code != 201 {
		t.Fatalf("create ask: %d %v", code, out)
	}
	return out
}

func askPath(a map[string]any, rest string) string {
	return "/v1/asks/" + strconv.Itoa(int(a["id"].(float64))) + rest
}

func TestAnswerQueuesMessageToAsker(t *testing.T) {
	e := newAPIEnv(t)
	e.create(t, map[string]any{"dir": t.TempDir(), "id": "s1"})
	a := createAsk(t, e, map[string]any{"from": "s1", "body": "Ship it?", "options": []string{"yes", "no"}})
	if a["status"] != "open" || a["from"] != "s1" {
		t.Fatalf("created %v", a)
	}
	var out map[string]any
	if code := e.call(t, "POST", askPath(a, "/answer"), map[string]any{"choice": "maybe"}, &out); code != 400 || errCode(out) != "ask_invalid" {
		t.Fatalf("bad choice: %d %v", code, out)
	}
	if code := e.call(t, "POST", askPath(a, "/answer"), map[string]any{"choice": "yes", "answer": "after lunch"}, &out); code != 200 || out["status"] != "answered" {
		t.Fatalf("answer: %d %v", code, out)
	}
	id := int(a["id"].(float64))
	msgs, _ := e.st.ListMessages("s1", 0)
	if len(msgs) != 1 || msgs[0].FromSession != "" || msgs[0].Body != "[hopp] Answer to ask #"+strconv.Itoa(id)+": yes\nafter lunch" {
		t.Fatalf("messages %+v", msgs)
	}
	if code := e.call(t, "POST", askPath(a, "/answer"), map[string]any{"choice": "no"}, &out); code != 409 || errCode(out) != "ask_closed" {
		t.Fatalf("answer again: %d %v", code, out)
	}

	// Without options the text alone goes back.
	b := createAsk(t, e, map[string]any{"from": "s1", "body": "Name?"})
	e.call(t, "POST", askPath(b, "/answer"), map[string]any{"answer": "hopp"}, nil)
	msgs, _ = e.st.ListMessages("s1", 0)
	if len(msgs) != 2 || msgs[1].Body != "[hopp] Answer to ask #"+strconv.Itoa(int(b["id"].(float64)))+": hopp" {
		t.Fatalf("messages %+v", msgs)
	}
	// With options and no text: just the choice.
	c := createAsk(t, e, map[string]any{"from": "s1", "body": "A or B?", "options": []string{"A", "B"}})
	e.call(t, "POST", askPath(c, "/answer"), map[string]any{"choice": "B"}, nil)
	msgs, _ = e.st.ListMessages("s1", 0)
	if len(msgs) != 3 || msgs[2].Body != "[hopp] Answer to ask #"+strconv.Itoa(int(c["id"].(float64)))+": B" {
		t.Fatalf("messages %+v", msgs)
	}
}

func TestAnswerToEndedAskerQueuesNothing(t *testing.T) {
	e := newAPIEnv(t)
	e.create(t, map[string]any{"dir": t.TempDir(), "id": "s1"})
	a := createAsk(t, e, map[string]any{"from": "s1", "body": "Q?"})
	// The session ends behind the manager's back, so its ask stays open.
	e.st.UpdateSessionState("s1", "done")
	if code := e.call(t, "POST", askPath(a, "/answer"), map[string]any{"answer": "x"}, nil); code != 200 {
		t.Fatalf("answer: %d", code)
	}
	if msgs, _ := e.st.ListMessages("s1", 0); len(msgs) != 0 {
		t.Fatalf("queued to an ended session: %+v", msgs)
	}
}

// An asker that is a mailbox name whose session is down gets the answer in
// its mailbox, as any message to that name.
func TestAnswerToMailboxAskerGoesToInbox(t *testing.T) {
	e := newAPIEnv(t)
	e.create(t, map[string]any{"dir": t.TempDir(), "id": "cto"})
	e.st.AddMailbox("cto")
	a := createAsk(t, e, map[string]any{"from": "cto", "body": "Q?"})
	e.st.UpdateSessionState("cto", "killed")
	e.call(t, "POST", askPath(a, "/answer"), map[string]any{"answer": "later"}, nil)
	msgs, _ := e.st.ListInboxMessages("cto", store.InboxUnread, 0)
	if len(msgs) != 1 || !strings.HasPrefix(msgs[0].Body, "[hopp] Answer to ask #") {
		t.Fatalf("inbox %+v", msgs)
	}
}

func TestWithdrawOnlyByAsker(t *testing.T) {
	e := newAPIEnv(t)
	e.create(t, map[string]any{"dir": t.TempDir(), "id": "s1"})
	a := createAsk(t, e, map[string]any{"from": "s1", "body": "Q?"})
	var out map[string]any
	if code := e.call(t, "POST", askPath(a, "/withdraw"), map[string]any{"from": "other"}, &out); code != 403 || errCode(out) != "not_asker" {
		t.Fatalf("someone else: %d %v", code, out)
	}
	if code := e.call(t, "POST", askPath(a, "/withdraw"), map[string]any{}, &out); code != 403 {
		t.Fatalf("no caller: %d %v", code, out)
	}
	if code := e.call(t, "POST", askPath(a, "/withdraw"), map[string]any{"from": "s1", "reason": "solved"}, &out); code != 200 || out["status"] != "withdrawn" || out["reason"] != "solved" {
		t.Fatalf("asker: %d %v", code, out)
	}
	m := createAsk(t, e, map[string]any{"body": "module ask"})
	if code := e.call(t, "POST", askPath(m, "/withdraw"), map[string]any{}, &out); code != 200 {
		t.Fatalf("an ask without a session, any caller: %d %v", code, out)
	}
}

func TestAskCreateValidation(t *testing.T) {
	e := newAPIEnv(t)
	e.create(t, map[string]any{"dir": t.TempDir(), "id": "s1"})
	var out map[string]any
	if code := e.call(t, "POST", "/v1/asks", map[string]any{"body": " "}, &out); code != 400 {
		t.Errorf("empty body: %d", code)
	}
	if code := e.call(t, "POST", "/v1/asks", map[string]any{"from": "ghost", "body": "x"}, &out); code != 400 || errCode(out) != "from_unknown" {
		t.Errorf("unknown from: %d %v", code, out)
	}
	e.call(t, "POST", "/v1/sessions/s1/kill", map[string]any{}, nil)
	if code := e.call(t, "POST", "/v1/asks", map[string]any{"from": "s1", "body": "x"}, &out); code != 409 {
		t.Errorf("ended from: %d %v", code, out)
	}
	if code := e.call(t, "GET", "/v1/asks/999", nil, nil); code != 404 {
		t.Errorf("unknown ask: %d", code)
	}
}

func TestAsksFilterByLabel(t *testing.T) {
	e := newAPIEnv(t)
	createAsk(t, e, map[string]any{"body": "a", "labels": map[string]string{"run": "42"}})
	b := createAsk(t, e, map[string]any{"body": "b", "labels": map[string]string{"run": "43"}})
	e.call(t, "POST", askPath(b, "/answer"), map[string]any{"answer": "ok"}, nil)
	var out struct {
		Asks []map[string]any `json:"asks"`
	}
	if code := e.call(t, "GET", "/v1/asks?label=run=42", nil, &out); code != 200 || len(out.Asks) != 1 || out.Asks[0]["body"] != "a" {
		t.Fatalf("label: %d %+v", code, out)
	}
	out.Asks = nil
	if e.call(t, "GET", "/v1/asks", nil, &out); len(out.Asks) != 1 {
		t.Errorf("default open: %+v", out.Asks)
	}
	out.Asks = nil
	if e.call(t, "GET", "/v1/asks?status=all", nil, &out); len(out.Asks) != 2 {
		t.Errorf("all: %+v", out.Asks)
	}
	out.Asks = nil
	if e.call(t, "GET", "/v1/asks?status=answered&label=run=43", nil, &out); len(out.Asks) != 1 {
		t.Errorf("answered: %+v", out.Asks)
	}
	if code := e.call(t, "GET", "/v1/asks?status=bogus", nil, nil); code != 400 {
		t.Errorf("bad status: %d", code)
	}
}

func TestWaitingCombinesAsksAndHarnessQuestions(t *testing.T) {
	e := newAPIEnv(t)
	e.create(t, map[string]any{"dir": t.TempDir(), "id": "s1"})
	e.create(t, map[string]any{"dir": t.TempDir(), "id": "s2"})
	createAsk(t, e, map[string]any{"from": "s1", "body": "Ship it?"})
	e.st.SetPendingQuiz("s2", `{"questions":[{"question":"Allow?","header":"Bash","multiSelect":false,"options":[{"label":"Yes"}]}],"asked_at":1}`)
	var out struct {
		Asks      []map[string]any `json:"asks"`
		Questions []struct {
			Session  string         `json:"session"`
			Question map[string]any `json:"question"`
		} `json:"questions"`
	}
	if code := e.call(t, "GET", "/v1/waiting", nil, &out); code != 200 {
		t.Fatalf("waiting: %d", code)
	}
	if len(out.Asks) != 1 || out.Asks[0]["body"] != "Ship it?" || len(out.Questions) != 1 || out.Questions[0].Session != "s2" || out.Questions[0].Question == nil {
		t.Fatalf("waiting %+v", out)
	}
	// An ended session's question no longer waits.
	e.call(t, "POST", "/v1/sessions/s2/kill", map[string]any{}, nil)
	e.st.SetPendingQuiz("s2", `{"questions":[{"question":"Allow?"}],"asked_at":1}`)
	out.Questions = nil
	e.call(t, "GET", "/v1/waiting", nil, &out)
	if len(out.Questions) != 0 {
		t.Errorf("ended session listed: %+v", out.Questions)
	}
}

func TestAskEventsCarryLabels(t *testing.T) {
	e := newAPIEnv(t)
	e.create(t, map[string]any{"dir": t.TempDir(), "id": "s1", "labels": map[string]string{"team": "a"}})
	a := createAsk(t, e, map[string]any{"from": "s1", "body": "Q?", "labels": map[string]string{"run": "42"}})
	e.call(t, "POST", askPath(a, "/answer"), map[string]any{"answer": "x"}, nil)
	b := createAsk(t, e, map[string]any{"from": "s1", "body": "W?", "labels": map[string]string{"run": "42"}})
	e.call(t, "POST", askPath(b, "/withdraw"), map[string]any{"from": "s1"}, nil)
	evs, _ := e.st.ListEvents(0, 0, "s1")
	seen := map[string]bool{}
	for _, ev := range evs {
		if !strings.HasPrefix(ev.Type, "ask.") {
			continue
		}
		seen[ev.Type] = true
		al, _ := ev.Data["ask_labels"].(map[string]any)
		sl, _ := ev.Data["labels"].(map[string]any)
		if al["run"] != "42" || sl["team"] != "a" || ev.Data["id"] == nil {
			t.Errorf("%s data %v", ev.Type, ev.Data)
		}
	}
	for _, typ := range []string{"ask.created", "ask.answered", "ask.withdrawn"} {
		if !seen[typ] {
			t.Errorf("no %s event", typ)
		}
	}
}

// TestAnswerWithChoiceAndText: a choice may carry text ("Return" plus what
// to fix); both are stored, both reach the asker, and the closed ask is
// found again by its labels with status=all.
func TestAnswerWithChoiceAndText(t *testing.T) {
	e := newAPIEnv(t)
	e.create(t, map[string]any{"dir": t.TempDir(), "id": "s1"})
	a := createAsk(t, e, map[string]any{"from": "s1", "body": "Accept?", "options": []string{"Accept", "Return"},
		"labels": map[string]string{"kind": "review"}})
	var out map[string]any
	if code := e.call(t, "POST", askPath(a, "/answer"), map[string]any{"choice": "Return", "answer": "fix the header"}, &out); code != 200 {
		t.Fatalf("answer: %d %v", code, out)
	}
	if out["status"] != "answered" || out["choice"] != "Return" || out["answer"] != "fix the header" {
		t.Errorf("answered ask = %v", out)
	}
	msgs, err := e.st.ListMessages("s1", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 1 || !strings.Contains(msgs[0].Body, "Return\nfix the header") {
		t.Errorf("message to the asker = %+v", msgs)
	}
	var list struct {
		Asks []map[string]any `json:"asks"`
	}
	if code := e.call(t, "GET", "/v1/asks?status=all&label=kind=review", nil, &list); code != 200 || len(list.Asks) != 1 ||
		list.Asks[0]["choice"] != "Return" || list.Asks[0]["answer"] != "fix the header" {
		t.Errorf("history by label: %d %v", code, list.Asks)
	}
	list.Asks = nil
	if e.call(t, "GET", "/v1/asks?label=kind=review", nil, &list); len(list.Asks) != 0 {
		t.Errorf("open asks by label after the answer: %v", list.Asks)
	}
}
