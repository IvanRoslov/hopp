package monitor

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/IvanRoslov/hopp/internal/activity"
	"github.com/IvanRoslov/hopp/internal/agent"
	"github.com/IvanRoslov/hopp/internal/claudeinstance"
	"io"
	"io/fs"
	"os"
	"time"
)

// errNoJournal reports that the exact journal does not exist yet: Claude
// creates it on the root's first turn. It is still no signal on its own.
var errNoJournal = fmt.Errorf("%w: journal not created yet", agent.ErrNoSignal)

// claudeJournalActivity reads lifecycle metadata only from the exact verified
// UUID journal. The adapter's newest-transcript UI selection is not authority
// for another root's readiness or API-error block.
func claudeJournalActivity(ctx context.Context, id claudeinstance.Identity) (activity.State, time.Time, error) {
	state, at, _, e := claudeJournalTurn(ctx, id)
	return state, at, e
}

// claudeJournalTurn is claudeJournalActivity plus whether the last counted
// record is the assistant's end_turn record: the last record of a finished
// turn (Claude writes only skipped bookkeeping after it).
func claudeJournalTurn(ctx context.Context, id claudeinstance.Identity) (activity.State, time.Time, bool, error) {
	info, e := os.Lstat(id.JournalPath)
	if errors.Is(e, fs.ErrNotExist) {
		return "", time.Time{}, false, errNoJournal
	}
	if e != nil || !info.Mode().IsRegular() {
		return "", time.Time{}, false, agent.ErrNoSignal
	}
	f, e := os.Open(id.JournalPath)
	if e != nil {
		return "", time.Time{}, false, agent.ErrNoSignal
	}
	defer f.Close()
	actual, e := f.Stat()
	if e != nil || !os.SameFile(info, actual) || actual.ModTime().Before(id.ProcessStart) {
		return "", time.Time{}, false, agent.ErrNoSignal
	}
	if actual.Size() == 0 {
		return "", time.Time{}, false, agent.ErrNoSignal
	}
	var tail [1]byte
	if _, e = f.ReadAt(tail[:], actual.Size()-1); e != nil || tail[0] != '\n' {
		return "", time.Time{}, false, agent.ErrNoSignal
	}
	start := actual.Size() - (1 << 20)
	if start < 0 {
		start = 0
	}
	if _, e = f.Seek(start, io.SeekStart); e != nil {
		return "", time.Time{}, false, e
	}
	scanner := bufio.NewScanner(io.LimitReader(f, actual.Size()-start))
	scanner.Buffer(make([]byte, 64*1024), 1<<20)
	first := true
	found, blocked, endTurn := false, false, false
	var lastAt time.Time
	for scanner.Scan() {
		if e = ctx.Err(); e != nil {
			return "", time.Time{}, false, e
		}
		if first && start > 0 {
			first = false
			continue
		}
		first = false
		var record struct {
			SessionID string    `json:"sessionId"`
			Type      string    `json:"type"`
			Subtype   string    `json:"subtype"`
			Timestamp time.Time `json:"timestamp"`
			Error     bool      `json:"isApiErrorMessage"`
			Message   struct {
				Error      bool   `json:"isApiErrorMessage"`
				StopReason string `json:"stop_reason"`
			} `json:"message"`
		}
		if json.Unmarshal(scanner.Bytes(), &record) != nil {
			return "", time.Time{}, false, agent.ErrNoSignal
		}
		if record.SessionID != id.ClaudeSessionID {
			continue
		}
		// Claude intersperses non-lifecycle metadata with conversation records;
		// several of these types have no timestamp. They cannot establish activity
		// or clear an API-error block. Keep decoding strict and let error flags
		// take precedence, including on an otherwise metadata-only record.
		if !record.Error && !record.Message.Error {
			switch record.Type {
			case "last-prompt", "mode", "permission-mode", "atis-latch", "ai-title", "tools-used", "api-request-blob",
				"attachment", "api-request-shape", "api-request", "session-owner":
				continue
			case "system":
				if record.Subtype == "stop_hook_summary" || record.Subtype == "turn_duration" {
					continue
				}
			}
		}
		if record.Timestamp.IsZero() || record.Timestamp.Before(id.ProcessStart) || record.Timestamp.After(time.Now()) {
			return "", time.Time{}, false, agent.ErrNoSignal
		}
		lastAt = record.Timestamp
		found = true
		blocked = record.Error || record.Message.Error
		endTurn = record.Type == "assistant" && record.Message.StopReason == "end_turn"
	}
	if e = scanner.Err(); e != nil {
		return "", time.Time{}, false, e
	}
	if !found {
		return "", time.Time{}, false, agent.ErrNoSignal
	}
	if blocked {
		return activity.Blocked, lastAt, false, nil
	}
	if time.Since(lastAt) < 30*time.Second {
		return activity.Active, lastAt, endTurn, nil
	}
	return activity.Ready, lastAt, endTurn, nil
}
