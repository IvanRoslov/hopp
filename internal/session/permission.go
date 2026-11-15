package session

import (
	"encoding/json"
	"log/slog"
	"time"

	"github.com/IvanRoslov/hopp/internal/runtime"
)

// QuizSourcePermission marks a pending quiz built from a Claude Code
// permission dialog read off the pane, as opposed to an AskUserQuestion quiz
// reported by the hooks (no source). The monitor owns its lifecycle.
const QuizSourcePermission = "permission"

// permissionQuizHeader is the question header clients show as the badge.
const permissionQuizHeader = "Разрешение"

// PermissionRef is the internal part of a permission quiz: which
// permission_prompts row it is, and the dialog identity (Title + Context)
// the answer path re-checks the pane against. The public API never exposes
// it.
type PermissionRef struct {
	PromptID int64  `json:"prompt_id"`
	Title    string `json:"title"`
	Context  string `json:"context"`
	// StartScreen marks a Codex start screen (runtime.ParseStartScreen)
	// rather than a Claude Code permission dialog: the answer path re-reads
	// the pane with the matching parser and may confirm the digit with
	// Enter.
	StartScreen bool `json:"start_screen,omitempty"`
	// Unnumbered marks a Kimi Code start screen
	// (runtime.ParseKimiStartScreen): its options carry no digits, so the
	// answer path moves the cursor with arrow keys and confirms with Enter.
	Unnumbered bool `json:"unnumbered,omitempty"`
}

// NewPermissionQuiz builds the pending quiz for dialog p journalled as row
// promptID: one single-select question «Title\n\nContext» whose options are
// the dialog's choices in order, so option i is answered by digit i+1.
func NewPermissionQuiz(p runtime.PermissionPrompt, promptID, askedAt int64) Quiz {
	question := p.Title
	if p.Context != "" {
		question += "\n\n" + p.Context
	}
	options := make([]QuizOption, len(p.Options))
	for i, label := range p.Options {
		options[i] = QuizOption{Label: label}
	}
	return Quiz{
		Questions: []QuizQuestion{{
			Question: question,
			Header:   permissionQuizHeader,
			Options:  options,
		}},
		AskedAt:    askedAt,
		Source:     QuizSourcePermission,
		Raw:        p.Raw,
		Permission: &PermissionRef{PromptID: promptID, Title: p.Title, Context: p.Context},
	}
}

// startScreenQuizHeader is the badge of a Codex start-screen quiz.
const startScreenQuizHeader = "Экран Codex"

// NewStartScreenQuiz builds the pending quiz for Codex start screen p
// (runtime.ParseStartScreen) journalled as row promptID: a permission quiz
// flagged StartScreen.
func NewStartScreenQuiz(p runtime.PermissionPrompt, promptID, askedAt int64) Quiz {
	q := NewPermissionQuiz(p, promptID, askedAt)
	q.Questions[0].Header = startScreenQuizHeader
	q.Permission.StartScreen = true
	return q
}

// kimiStartScreenQuizHeader is the badge of a Kimi Code start-screen quiz.
const kimiStartScreenQuizHeader = "Экран Kimi Code"

// NewKimiStartScreenQuiz builds the pending quiz for Kimi Code start screen
// p (runtime.ParseKimiStartScreen): a start-screen quiz flagged Unnumbered.
func NewKimiStartScreenQuiz(p runtime.PermissionPrompt, promptID, askedAt int64) Quiz {
	q := NewStartScreenQuiz(p, promptID, askedAt)
	q.Questions[0].Header = kimiStartScreenQuizHeader
	q.Permission.Unnumbered = true
	return q
}

// ParseQuiz decodes a session's stored pending quiz; ok is false when there
// is none or it does not parse.
func ParseQuiz(pendingQuiz string) (Quiz, bool) {
	if pendingQuiz == "" {
		return Quiz{}, false
	}
	var q Quiz
	if err := json.Unmarshal([]byte(pendingQuiz), &q); err != nil {
		return Quiz{}, false
	}
	return q, true
}

// IsStartScreen reports whether q was built from a Codex start screen.
func (q Quiz) IsStartScreen() bool {
	return q.IsPermission() && q.Permission.StartScreen
}

// IsPermission reports whether q was built from a permission dialog.
func (q Quiz) IsPermission() bool {
	return q.Source == QuizSourcePermission && q.Permission != nil
}

// PermissionPrompt returns the identity of the dialog q was built from, for
// runtime.PermissionPrompt.SameDialog. Zero for a hook quiz.
func (q Quiz) PermissionPrompt() runtime.PermissionPrompt {
	if q.Permission == nil {
		return runtime.PermissionPrompt{}
	}
	return runtime.PermissionPrompt{Title: q.Permission.Title, Context: q.Permission.Context}
}

// clearPendingForTerminal drops what a session that reached a terminal state
// can no longer answer: its pending quiz and any permission dialog still
// open in the journal (closed as terminal, so it shows in the chat feed
// rather than staying open forever). Best-effort, like the state change it
// accompanies.
func (m *Manager) clearPendingForTerminal(id string) {
	_ = m.st.ClearPendingQuiz(id)
	if err := m.st.ResolveOpenPermissionPrompts(id, time.Now().Unix()); err != nil {
		slog.Default().Warn("close open permission prompts", "session", id, "error", err)
	}
}
