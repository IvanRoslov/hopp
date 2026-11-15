package session

import (
	"context"
	"sync"
	"testing"
	"time"
)

// recordSleeps makes the quiz timing hook record each requested pause
// without sleeping.
func recordSleeps(m *Manager) *[]time.Duration {
	var mu sync.Mutex
	var got []time.Duration
	m.SetQuizTiming(func(d time.Duration) {
		mu.Lock()
		got = append(got, d)
		mu.Unlock()
	}, 50*time.Millisecond)
	return &got
}

const composerPane = "⏺ Done.\n────────────────\n❯ \n────────────────\n  ⏵⏵ bypass permissions on\n"

// The dialog is on the first capture but gone after the settle (the human
// answered and Claude redrew): no key, 409 prompt_changed.
func TestAnswerPermissionSettleDialogThenComposerIsConflict(t *testing.T) {
	m, _, rt, _ := seedPermissionQuiz(t, "permission-bash-rm.pane")
	sleeps := recordSleeps(m)
	rt.captureSeq = []string{paneFixture(t, "permission-bash-rm.pane"), composerPane}
	err := m.AnswerQuiz(context.Background(), "sess1", []QuizAnswer{{QuestionIndex: 0, OptionIndices: []int{0}}})
	assertValidationCode(t, err, "prompt_changed")
	if sent := sentKeysEventually(rt, 0); len(sent) != 0 {
		t.Fatalf("sent %+v, want no keys", sent)
	}
	if len(*sleeps) == 0 || (*sleeps)[0] != answerSettle {
		t.Errorf("sleeps = %v, want the settle %v first", *sleeps, answerSettle)
	}
}

// The same dialog on both captures: the key is sent.
func TestAnswerPermissionSettleSameDialogSendsKey(t *testing.T) {
	m, _, rt, _ := seedPermissionQuiz(t, "permission-bash-rm.pane")
	recordSleeps(m)
	dialog := paneFixture(t, "permission-bash-rm.pane")
	rt.captureSeq = []string{dialog, dialog}
	if err := m.AnswerQuiz(context.Background(), "sess1", []QuizAnswer{{QuestionIndex: 0, OptionIndices: []int{0}}}); err != nil {
		t.Fatalf("AnswerQuiz: %v", err)
	}
	if sent := sentKeysEventually(rt, 1); len(sent) == 0 {
		t.Fatal("no key sent for a dialog that stayed")
	}
}

// Another dialog after the settle: no key, 409 prompt_changed.
func TestAnswerPermissionSettleOtherDialogIsConflict(t *testing.T) {
	m, _, rt, _ := seedPermissionQuiz(t, "permission-bash-rm.pane")
	recordSleeps(m)
	rt.captureSeq = []string{paneFixture(t, "permission-bash-rm.pane"), paneFixture(t, "permission-bash-outside-cwd.pane")}
	err := m.AnswerQuiz(context.Background(), "sess1", []QuizAnswer{{QuestionIndex: 0, OptionIndices: []int{0}}})
	assertValidationCode(t, err, "prompt_changed")
	if sent := sentKeysEventually(rt, 0); len(sent) != 0 {
		t.Fatalf("sent %+v, want no keys", sent)
	}
}

// A start screen that goes away during the settle: no key.
func TestAnswerStartScreenSettleGoneIsConflict(t *testing.T) {
	m, rt := seedStartScreenQuiz(t, "codex-start-trust.pane")
	recordSleeps(m)
	rt.captureSeq = []string{paneFixture(t, "codex-start-trust.pane"), paneFixture(t, "codex-start-neg-idle.pane")}
	err := m.AnswerQuiz(context.Background(), "sess1", []QuizAnswer{{QuestionIndex: 0, OptionIndices: []int{0}}})
	assertValidationCode(t, err, "prompt_changed")
	if sent := sentKeysEventually(rt, 0); len(sent) != 0 {
		t.Fatalf("sent %+v, want no keys", sent)
	}
}

// An AskUserQuestion widget that closes during the settle: no key.
func TestAnswerQuizSettleWidgetThenComposerIsConflict(t *testing.T) {
	m, st, _, rt := answerTestManager(t)
	recordSleeps(m)
	seedRunningSession(t, st, "sess1")
	st.SetPendingQuiz("sess1", quizManagerPendingJSON)
	rt.captureSeq = []string{quizWidgetPane("Color", "Which color?", "Red", "Green", "Blue"), composerPane}
	err := m.AnswerQuiz(context.Background(), "sess1", []QuizAnswer{{QuestionIndex: 0, OptionIndices: []int{0}}})
	assertValidationCode(t, err, "prompt_changed")
	if sent := sentKeysEventually(rt, 0); len(sent) != 0 {
		t.Fatalf("sent %+v, want no keys", sent)
	}
}

// The same widget on both captures: keys are sent.
func TestAnswerQuizSettleSameWidgetSendsKeys(t *testing.T) {
	m, st, _, rt := answerTestManager(t)
	recordSleeps(m)
	seedRunningSession(t, st, "sess1")
	st.SetPendingQuiz("sess1", quizManagerPendingJSON)
	w := quizWidgetPane("Color", "Which color?", "Red", "Green", "Blue")
	rt.captureSeq = []string{w, w}
	if err := m.AnswerQuiz(context.Background(), "sess1", []QuizAnswer{{QuestionIndex: 0, OptionIndices: []int{1}}}); err != nil {
		t.Fatalf("AnswerQuiz: %v", err)
	}
	if sent := sentKeysEventually(rt, 1); len(sent) == 0 {
		t.Fatal("no keys sent")
	}
}
