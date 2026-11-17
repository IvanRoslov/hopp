package session

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/IvanRoslov/hopp/internal/runtime"
)

// claudeTrustCursorOnYes is Claude Code's trust screen with the ❯ cursor on
// «Yes, I trust this folder».
func claudeTrustCursorOnYes(t *testing.T) string {
	t.Helper()
	p := paneFixture(t, "claude-start-trust.pane")
	p = strings.Replace(p, " ❯ No, continue without these permissions", "   No, continue without these permissions", 1)
	return strings.Replace(p, "   Yes, I trust this folder", " ❯ Yes, I trust this folder", 1)
}

func seedClaudeStartScreenQuiz(t *testing.T, pane string) (*Manager, *fakeRuntime) {
	t.Helper()
	m, st, _, rt := answerTestManager(t)
	m.SetQuizTiming(noopSleep, 50*time.Millisecond)
	seedRunningSession(t, st, "sess1")
	p, ok := runtime.ParseClaudeStartScreen(pane)
	if !ok {
		t.Fatal("pane not parsed")
	}
	id, _, err := st.OpenPermissionPrompt("sess1", p.Title, p.Context, "[]", 1)
	if err != nil {
		t.Fatalf("OpenPermissionPrompt: %v", err)
	}
	b, _ := json.Marshal(NewClaudeStartScreenQuiz(p, id, 1))
	if err := st.SetPendingQuiz("sess1", string(b)); err != nil {
		t.Fatalf("SetPendingQuiz: %v", err)
	}
	rt.captureOut = pane
	return m, rt
}

// Answering «Yes, I trust this folder» from the Questions column: one arrow
// down, then Enter once the same screen shows the cursor there.
func TestAnswerClaudeStartScreenArrowThenEnter(t *testing.T) {
	m, rt := seedClaudeStartScreenQuiz(t, paneFixture(t, "claude-start-trust.pane"))
	rt.captureAfterKeys = claudeTrustCursorOnYes(t)
	if err := m.AnswerQuiz(context.Background(), "sess1", []QuizAnswer{{QuestionIndex: 0, OptionIndices: []int{1}}}); err != nil {
		t.Fatalf("AnswerQuiz: %v", err)
	}
	if got := keysOf(sentKeysEventually(rt, 2)); !reflect.DeepEqual(got, []string{"Down", "Enter"}) {
		t.Fatalf("keys = %q, want Down, Enter", got)
	}
}

func TestAnswerClaudeStartScreenNoEnterWhenCursorElsewhere(t *testing.T) {
	m, rt := seedClaudeStartScreenQuiz(t, paneFixture(t, "claude-start-trust.pane"))
	if err := m.AnswerQuiz(context.Background(), "sess1", []QuizAnswer{{QuestionIndex: 0, OptionIndices: []int{1}}}); err != nil {
		t.Fatalf("AnswerQuiz: %v", err)
	}
	if got := keysOf(sentKeysEventually(rt, 2)); !reflect.DeepEqual(got, []string{"Down"}) {
		t.Fatalf("keys = %q, want only Down", got)
	}
}

// Esc on Claude Code's trust screen exits Claude Code: not offered.
func TestAnswerClaudeStartScreenRejectsEsc(t *testing.T) {
	m, rt := seedClaudeStartScreenQuiz(t, paneFixture(t, "claude-start-trust.pane"))
	err := m.AnswerQuiz(context.Background(), "sess1", []QuizAnswer{{QuestionIndex: 0, OptionIndices: []int{-1}}})
	assertValidationCode(t, err, "invalid_answer")
	if n := len(sentKeysEventually(rt, 1)); n != 0 {
		t.Fatalf("%d keys sent", n)
	}
}
