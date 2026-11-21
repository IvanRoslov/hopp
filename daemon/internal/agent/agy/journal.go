package agy

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/IvanRoslov/hopp/internal/agent"
)

// homeDir returns agy's data folder. A var so tests point it at a fixture.
var homeDir = func() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".gemini", "antigravity-cli")
}

// record is one line of a conversation's transcript.jsonl:
//
//	{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE",
//	 "created_at":"2026-11-21T16:03:45Z","content":"<USER_REQUEST>\n…\n</USER_REQUEST>\n…"}
//	{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE",
//	 "created_at":"…","model":"gemini-3.8-flash-low","input_tokens":9919,
//	 "cache_read_tokens":0,"output_tokens":3,"content":"…","tool_calls":[{"name":"run_command","args":{…}}]}
//
// Tool results are GENERIC records and agy's own notices SYSTEM_MESSAGE.
// created_at has one-second precision.
type record struct {
	StepIndex       int64  `json:"step_index"`
	Type            string `json:"type"`
	CreatedAt       string `json:"created_at"`
	Model           string `json:"model"`
	InputTokens     int64  `json:"input_tokens"`
	CacheReadTokens int64  `json:"cache_read_tokens"`
	OutputTokens    int64  `json:"output_tokens"`
	Content         string `json:"content"`
	ToolCalls       []struct {
		Name string                     `json:"name"`
		Args map[string]json.RawMessage `json:"args"`
	} `json:"tool_calls"`
}

const (
	typeUserInput       = "USER_INPUT"
	typePlannerResponse = "PLANNER_RESPONSE"
)

// at is the record's time; zero when absent or malformed.
func (r record) at() time.Time {
	t, err := time.Parse(time.RFC3339, r.CreatedAt)
	if err != nil {
		return time.Time{}
	}
	return t
}

// userText returns what the user sent in a USER_INPUT record: the inside of
// its <USER_REQUEST> block, without the metadata agy appends after it.
func (r record) userText() string {
	const open, end = "<USER_REQUEST>", "</USER_REQUEST>"
	s := r.Content
	i := strings.Index(s, open)
	j := strings.LastIndex(s, end)
	if i < 0 || j < i {
		return strings.TrimSpace(s)
	}
	return strings.TrimSpace(s[i+len(open) : j])
}

// transcriptPath is the journal of conversation id.
func transcriptPath(id string) string {
	return filepath.Join(homeDir(), "brain", id, ".system_generated", "logs", "transcript.jsonl")
}

// workspaceKeys are the forms of worktree agy may have recorded.
func workspaceKeys(worktree string) []string {
	keys := []string{filepath.Clean(worktree)}
	if resolved, err := filepath.EvalSymlinks(worktree); err == nil && filepath.Clean(resolved) != keys[0] {
		keys = append(keys, filepath.Clean(resolved))
	}
	return keys
}

// currentConversation returns the id of the conversation agy last ran in
// worktree, from cache/last_conversations.json (workspace path → id).
func currentConversation(worktree string) (string, bool) {
	b, err := os.ReadFile(filepath.Join(homeDir(), "cache", "last_conversations.json"))
	if err != nil {
		return "", false
	}
	var last map[string]string
	if json.Unmarshal(b, &last) != nil {
		return "", false
	}
	for _, key := range workspaceKeys(worktree) {
		if id := last[key]; id != "" && id == filepath.Base(id) {
			return id, true
		}
	}
	return "", false
}

// findTranscript returns the journal of worktree's current conversation and
// its file info. agy creates a conversation at the first prompt, so before it
// (and after a relaunch, until the new conversation's first prompt) the
// folder still maps to nothing or to an earlier run: a journal last written
// before since is that earlier run's and is not returned.
func findTranscript(worktree string, since time.Time) (string, os.FileInfo, error) {
	id, ok := currentConversation(worktree)
	if !ok {
		return "", nil, agent.ErrNoSignal
	}
	path := transcriptPath(id)
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", nil, agent.ErrNoSignal
	}
	if !since.IsZero() && info.ModTime().Before(since.Truncate(time.Second)) {
		return "", nil, agent.ErrNoSignal
	}
	return path, info, nil
}

// scan calls fn for every complete record of path, oldest first, until fn
// returns false. A trailing partial line (the writer is mid-record) and a
// malformed line are skipped.
func scan(path string, fn func(record) bool) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	reader := bufio.NewReaderSize(f, 64*1024)
	for {
		line, err := reader.ReadBytes('\n')
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		var rec record
		if json.Unmarshal(line, &rec) != nil || rec.Type == "" {
			continue
		}
		if !fn(rec) {
			return nil
		}
	}
}
