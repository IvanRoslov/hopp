package session

import (
	"context"
	"testing"
	"time"

	"github.com/IvanRoslov/hopp/internal/bus"
	"github.com/IvanRoslov/hopp/internal/store"
)

// quizWidgetPane is what Claude Code's AskUserQuestion widget looks like on
// the pane for one question (Claude Code 2.1.325, live).
func quizWidgetPane(header, question string, options ...string) string {
	pane := "› Message from @hopp: ask me\n" +
		"────────────────────────────────────────\n" +
		" ☐ " + header + "\n" + question + "\n"
	for i, o := range options {
		mark := "  "
		if i == 0 {
			mark = "❯ "
		}
		pane += mark + string(rune('1'+i)) + ". " + o + "\n     " + o + "\n"
	}
	return pane + "────────────────────────────────────────\n" +
		"  Chat about this\nEnter to select · ↑/↓ to navigate · Esc to cancel\n"
}

// quizTestManager is answerTestManager with the pending question's widget
// on the pane, so an answer passes the pane re-read.
func quizTestManager(t *testing.T) (*Manager, *store.Store, *bus.Bus, *fakeRuntime) {
	m, st, b, rt := answerTestManager(t)
	rt.captureOut = quizWidgetPane("Color", "Which color?", "Red", "Green", "Blue")
	return m, st, b, rt
}

// The widget is gone (answered in the terminal, the hook has not cleared
// the question yet): nothing is sent, 409 prompt_changed.
func TestAnswerQuizWidgetGoneIsConflictWithoutKeys(t *testing.T) {
	m, st, _, rt := answerTestManager(t)
	m.SetQuizTiming(noopSleep, 50*time.Millisecond)
	seedRunningSession(t, st, "sess1")
	st.SetPendingQuiz("sess1", quizManagerPendingJSON)
	rt.captureOut = "⏺ User answered Claude's questions:\n  ⎿  · Which color? → Green\n────\n❯ \n────\n"
	err := m.AnswerQuiz(context.Background(), "sess1", []QuizAnswer{{QuestionIndex: 0, OptionIndices: []int{0}}})
	assertValidationCode(t, err, "prompt_changed")
	if sent := sentKeysEventually(rt, 0); len(sent) != 0 {
		t.Fatalf("sent %+v, want no keys", sent)
	}
	// The in-flight guard is released: a later answer is not refused as in flight.
	rt.captureOut = quizWidgetPane("Color", "Which color?", "Red", "Green", "Blue")
	if err := m.AnswerQuiz(context.Background(), "sess1", []QuizAnswer{{QuestionIndex: 0, OptionIndices: []int{0}}}); err != nil {
		t.Fatalf("answer after the refusal: %v", err)
	}
}

// Another question's widget is on the pane: 409 prompt_changed, no keys.
func TestAnswerQuizOtherQuestionIsConflictWithoutKeys(t *testing.T) {
	m, st, _, rt := answerTestManager(t)
	m.SetQuizTiming(noopSleep, 50*time.Millisecond)
	seedRunningSession(t, st, "sess1")
	st.SetPendingQuiz("sess1", quizManagerPendingJSON)
	rt.captureOut = quizWidgetPane("Milk", "Milk or no milk?", "Milk", "No milk")
	err := m.AnswerQuiz(context.Background(), "sess1", []QuizAnswer{{QuestionIndex: 0, OptionIndices: []int{0}}})
	assertValidationCode(t, err, "prompt_changed")
	if sent := sentKeysEventually(rt, 0); len(sent) != 0 {
		t.Fatalf("sent %+v, want no keys", sent)
	}
}

// An old widget of the same question higher up in the scrollback does not
// count: the question must be the one the bottom widget shows.
func TestAnswerQuizStaleScrollbackIsConflict(t *testing.T) {
	m, st, _, rt := answerTestManager(t)
	m.SetQuizTiming(noopSleep, 50*time.Millisecond)
	seedRunningSession(t, st, "sess1")
	st.SetPendingQuiz("sess1", quizManagerPendingJSON)
	rt.captureOut = quizWidgetPane("Color", "Which color?", "Red", "Green", "Blue") +
		"⏺ User answered Claude's questions:\n  ⎿  · Which color? → Red\n────\n❯ \n────\n"
	err := m.AnswerQuiz(context.Background(), "sess1", []QuizAnswer{{QuestionIndex: 0, OptionIndices: []int{0}}})
	assertValidationCode(t, err, "prompt_changed")
	if sent := sentKeysEventually(rt, 0); len(sent) != 0 {
		t.Fatalf("sent %+v, want no keys", sent)
	}
}

// The same question's widget: keys are sent as before.
func TestAnswerQuizSameQuestionSendsKeys(t *testing.T) {
	m, st, _, rt := answerTestManager(t)
	m.SetQuizTiming(noopSleep, 50*time.Millisecond)
	seedRunningSession(t, st, "sess1")
	st.SetPendingQuiz("sess1", quizManagerPendingJSON)
	rt.captureOut = quizWidgetPane("Color", "Which color?", "Red", "Green", "Blue")
	if err := m.AnswerQuiz(context.Background(), "sess1", []QuizAnswer{{QuestionIndex: 0, OptionIndices: []int{1}}}); err != nil {
		t.Fatalf("AnswerQuiz: %v", err)
	}
	if sent := sentKeysEventually(rt, 1); len(sent) == 0 {
		t.Fatal("no keys sent for the question on screen")
	}
}
