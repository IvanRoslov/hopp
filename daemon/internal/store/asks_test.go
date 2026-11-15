package store

import (
	"errors"
	"reflect"
	"sync"
	"testing"
)

func TestAskRoundTrip(t *testing.T) {
	s := openTestStore(t)
	in := Ask{FromSession: "s1", Labels: map[string]string{"run": "42"}, Body: "Ship it?", Options: []string{"yes", "no"}, Attachments: []string{"/tmp/plan.md"}}
	id, err := s.AddAsk(in)
	if err != nil || id == 0 {
		t.Fatalf("AddAsk = %d %v", id, err)
	}
	got, err := s.GetAsk(id)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != AskOpen || got.CreatedAt == 0 || got.ClosedAt != 0 || got.Body != in.Body ||
		!reflect.DeepEqual(got.Labels, in.Labels) || !reflect.DeepEqual(got.Options, in.Options) || !reflect.DeepEqual(got.Attachments, in.Attachments) {
		t.Fatalf("round trip %+v", got)
	}
	bare, _ := s.AddAsk(Ask{Body: "free text?"})
	b, _ := s.GetAsk(bare)
	if b.Options == nil || len(b.Options) != 0 || b.Labels == nil || b.Attachments == nil {
		t.Errorf("empty lists should come back empty, not nil: %+v", b)
	}
	if _, err := s.GetAsk(999); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetAsk(999) = %v", err)
	}
	open, _ := s.ListAsks(AskFilter{Status: AskOpen, Labels: map[string]string{"run": "42"}})
	if len(open) != 1 || open[0].ID != id {
		t.Errorf("ListAsks by label = %+v", open)
	}
	if mine, _ := s.ListAsks(AskFilter{From: "s1"}); len(mine) != 1 {
		t.Errorf("ListAsks by from = %+v", mine)
	}
}

func TestAnswerRequiresListedChoice(t *testing.T) {
	s := openTestStore(t)
	id, _ := s.AddAsk(Ask{Body: "Ship it?", Options: []string{"yes", "no"}})
	for _, bad := range []string{"", "maybe", "Yes"} {
		if _, err := s.AnswerAsk(id, bad, "", 1); !errors.Is(err, ErrAskInvalid) {
			t.Errorf("choice %q: err = %v, want ErrAskInvalid", bad, err)
		}
	}
	a, err := s.AnswerAsk(id, "no", "not this week", 5)
	if err != nil || a.Status != AskAnswered || a.Choice != "no" || a.Answer != "not this week" || a.ClosedAt != 5 {
		t.Fatalf("answer = %+v %v", a, err)
	}
}

func TestAnswerWithoutOptionsNeedsText(t *testing.T) {
	s := openTestStore(t)
	id, _ := s.AddAsk(Ask{Body: "Which name?"})
	if _, err := s.AnswerAsk(id, "", "  ", 1); !errors.Is(err, ErrAskInvalid) {
		t.Errorf("blank text: %v", err)
	}
	if _, err := s.AnswerAsk(id, "x", "text", 1); !errors.Is(err, ErrAskInvalid) {
		t.Errorf("a choice without options: %v", err)
	}
	if a, err := s.AnswerAsk(id, "", "hopp", 1); err != nil || a.Answer != "hopp" {
		t.Fatalf("answer = %+v %v", a, err)
	}
}

func TestAnswerClosedAskIsRefused(t *testing.T) {
	s := openTestStore(t)
	id, _ := s.AddAsk(Ask{Body: "Q?"})
	s.AnswerAsk(id, "", "first", 1)
	if _, err := s.AnswerAsk(id, "", "second", 2); !errors.Is(err, ErrAskClosed) {
		t.Fatalf("second answer: %v", err)
	}
	if a, _ := s.GetAsk(id); a.Answer != "first" {
		t.Fatalf("answer changed: %+v", a)
	}
	w, _ := s.AddAsk(Ask{Body: "W?"})
	if a, err := s.WithdrawAsk(w, "not needed", 3); err != nil || a.Status != AskWithdrawn || a.Reason != "not needed" {
		t.Fatalf("withdraw = %+v %v", a, err)
	}
	if _, err := s.AnswerAsk(w, "", "late", 4); !errors.Is(err, ErrAskClosed) {
		t.Fatalf("answer after withdraw: %v", err)
	}
	if _, err := s.WithdrawAsk(w, "again", 5); !errors.Is(err, ErrAskClosed) {
		t.Fatalf("second withdraw: %v", err)
	}
	if _, err := s.AnswerAsk(999, "", "x", 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown ask: %v", err)
	}
}

func TestTwoConcurrentAnswersOneWins(t *testing.T) {
	s := openTestStore(t)
	id, _ := s.AddAsk(Ask{Body: "Q?"})
	var wg sync.WaitGroup
	var mu sync.Mutex
	wins, closed := 0, 0
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := s.AnswerAsk(id, "", "answer", int64(i))
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil:
				wins++
			case errors.Is(err, ErrAskClosed):
				closed++
			default:
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	if wins != 1 || closed != 7 {
		t.Fatalf("wins %d closed %d, want 1 and 7", wins, closed)
	}
}

func TestWithdrawOpenAsksOf(t *testing.T) {
	s := openTestStore(t)
	a, _ := s.AddAsk(Ask{FromSession: "s1", Body: "a"})
	b, _ := s.AddAsk(Ask{FromSession: "s1", Body: "b"})
	other, _ := s.AddAsk(Ask{FromSession: "s2", Body: "c"})
	s.AnswerAsk(b, "", "done", 1)
	got, err := s.WithdrawOpenAsksOf("s1", "session_ended", 9)
	if err != nil || len(got) != 1 || got[0].ID != a || got[0].Reason != "session_ended" {
		t.Fatalf("withdrawn = %+v %v", got, err)
	}
	if x, _ := s.GetAsk(other); x.Status != AskOpen {
		t.Errorf("another session's ask: %+v", x)
	}
	if x, _ := s.GetAsk(b); x.Status != AskAnswered {
		t.Errorf("answered ask changed: %+v", x)
	}
}

func TestRemoveSessionRemovesItsAsks(t *testing.T) {
	s := openTestStore(t)
	s.AddSession(Session{ID: "gone", Agent: "claude-code", WorktreePath: "/tmp/g", TmuxName: "gone", State: "killed"})
	mine, _ := s.AddAsk(Ask{FromSession: "gone", Body: "a"})
	keep, _ := s.AddAsk(Ask{Body: "module ask"})
	if err := s.RemoveSessions([]string{"gone"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetAsk(mine); !errors.Is(err, ErrNotFound) {
		t.Errorf("ask of a removed session: %v", err)
	}
	if _, err := s.GetAsk(keep); err != nil {
		t.Errorf("an ask without a session: %v", err)
	}
}
