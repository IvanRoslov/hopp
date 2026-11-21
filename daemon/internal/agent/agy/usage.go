package agy

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/IvanRoslov/hopp/internal/agent"
)

var _ agent.UsageReader = (*Agy)(nil)

// conversationsOf returns every conversation agy recorded for worktree: the
// current one (cache/last_conversations.json) and the earlier ones its prompt
// history (history.jsonl) names for that folder.
func conversationsOf(worktree string) []string {
	keys := map[string]bool{}
	for _, key := range workspaceKeys(worktree) {
		keys[key] = true
	}
	seen := map[string]bool{}
	var ids []string
	add := func(id string) {
		if id != "" && id == filepath.Base(id) && !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	if id, ok := currentConversation(worktree); ok {
		add(id)
	}
	f, err := os.Open(filepath.Join(homeDir(), "history.jsonl"))
	if err != nil {
		return ids
	}
	defer f.Close()
	reader := bufio.NewReaderSize(f, 64*1024)
	for {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			if err != io.EOF {
				return ids
			}
			break
		}
		var row struct {
			Workspace      string `json:"workspace"`
			ConversationID string `json:"conversationId"`
		}
		if json.Unmarshal(line, &row) == nil && keys[filepath.Clean(row.Workspace)] {
			add(row.ConversationID)
		}
	}
	return ids
}

// Usage implements agent.UsageReader: it sums the tokens of every model reply
// recorded at or after since in worktree's conversations. agy reports input
// tokens without the cached part and no reasoning or cache-write counts.
func (a *Agy) Usage(ctx context.Context, worktreePath string, since time.Time) (agent.Usage, error) {
	result := agent.Usage{Models: make(map[string]agent.Tokens)}
	from := since.Truncate(time.Second)
	for _, id := range conversationsOf(worktreePath) {
		if err := ctx.Err(); err != nil {
			return agent.Usage{}, err
		}
		path := transcriptPath(id)
		if _, err := os.Stat(path); err != nil {
			continue
		}
		err := scan(path, func(rec record) bool {
			at := rec.at()
			if at.IsZero() || at.Before(from) {
				return ctx.Err() == nil
			}
			result.Found = true
			if result.FirstAt.IsZero() || at.Before(result.FirstAt) {
				result.FirstAt = at
			}
			if at.After(result.LastAt) {
				result.LastAt = at
			}
			if rec.Type == typePlannerResponse && rec.Model != "" {
				tokens := result.Models[rec.Model]
				tokens.Input += rec.InputTokens
				tokens.CacheRead += rec.CacheReadTokens
				tokens.Output += rec.OutputTokens
				tokens.Messages++
				result.Models[rec.Model] = tokens
			}
			return ctx.Err() == nil
		})
		if err != nil {
			return agent.Usage{}, fmt.Errorf("read agy journal %s: %w", path, err)
		}
	}
	if err := ctx.Err(); err != nil {
		return agent.Usage{}, err
	}
	return result, nil
}
