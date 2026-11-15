package session

// The quiz types below are ported from rocket's quiz.go. The machinery that
// answers a quiz by sending keys to the pane is not ported.

// QuizOption is a single selectable option in a quiz question, mirroring
// AskUserQuestion's option shape as delivered by the PreToolUse hook (see
// internal/api's internal_quiz.go).
type QuizOption struct {
	Label       string `json:"label"`
	Description string `json:"description"`
}

// QuizQuestion is one question in a pending quiz, as stored (verbatim from
// tool_input.questions) on Session.PendingQuiz.
type QuizQuestion struct {
	Question    string       `json:"question"`
	Header      string       `json:"header"`
	MultiSelect bool         `json:"multiSelect"`
	Options     []QuizOption `json:"options"`
}

// Quiz is the full pending-quiz payload stored on Session.PendingQuiz:
// {"questions":[...],"asked_at":<unix>}. A quiz the monitor built from a
// Claude Code permission dialog (see permission.go) also carries
// source:"permission", the pane tail in raw, and its identity in permission;
// a hook-driven AskUserQuestion quiz has none of them.
type Quiz struct {
	Questions  []QuizQuestion `json:"questions"`
	AskedAt    int64          `json:"asked_at"`
	Source     string         `json:"source,omitempty"`
	Raw        string         `json:"raw,omitempty"`
	Permission *PermissionRef `json:"permission,omitempty"`
}
