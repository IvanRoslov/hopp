package claudeinstance

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"time"
)

const MaxHookBytes = 16 << 10

type HookEvent struct {
	ClaudeSessionID  string    `json:"session_id"`
	HookEventName    string    `json:"hook_event_name"`
	Reason           string    `json:"reason,omitempty"`
	AgentID          string    `json:"agent_id,omitempty"`
	LaunchGeneration string    `json:"launch_generation"`
	ProducerPID      int       `json:"producer_pid"`
	ProducerStart    time.Time `json:"producer_start"`
	At               int64     `json:"at"`
}

func ParseHook(r io.Reader) (HookEvent, error) {
	raw, err := io.ReadAll(io.LimitReader(r, MaxHookBytes+1))
	if err != nil {
		return HookEvent{}, err
	}
	if len(raw) > MaxHookBytes {
		return HookEvent{}, fmt.Errorf("hook payload too large")
	}
	var event HookEvent
	dec := json.NewDecoder(bytes.NewReader(raw))
	if err = dec.Decode(&event); err != nil {
		return HookEvent{}, fmt.Errorf("invalid hook metadata")
	}
	if dec.Decode(new(any)) != io.EOF {
		return HookEvent{}, fmt.Errorf("trailing hook payload")
	}
	return event, nil
}
func ValidateHook(ctx context.Context, id Identity, event HookEvent, state string, last int64, now time.Time, probe Probe) error {
	invalid := func(check string) error { return fmt.Errorf("unqualified Claude activity: %s", check) }
	switch {
	case event.AgentID != "":
		return invalid("subagent hook")
	case event.ClaudeSessionID != id.ClaudeSessionID:
		return invalid("claude session id differs from the bound one")
	case event.LaunchGeneration != id.LaunchGeneration:
		return invalid("launch generation differs")
	case event.At <= last:
		return invalid("not newer than the last accepted hook")
	case event.At <= 0 || event.At > now.UnixNano() || event.At < id.ProcessStart.UnixNano():
		return invalid("event time outside the process lifetime")
	case event.ProducerPID <= 0 || event.ProducerStart.IsZero():
		return invalid("no producer pid or start")
	case probe == nil:
		return invalid("no process probe")
	}
	expected := map[string]string{"UserPromptSubmit": "active", "PreToolUse": "active", "PostToolUse": "active", "Stop": "ready", "Notification": "waiting_input", "SessionEnd": "exited"}
	if expected[event.HookEventName] != state {
		return invalid(fmt.Sprintf("event %s does not map to state %s", event.HookEventName, state))
	}
	process, exists, err := probe.Process(ctx, event.ProducerPID)
	if err != nil || !exists || !process.Start.Equal(event.ProducerStart) {
		return invalid("producer process missing or restarted")
	}
	seen := map[int]bool{}
	for {
		if seen[process.PID] || len(seen) > 64 {
			return invalid("ancestry loops")
		}
		seen[process.PID] = true
		if process.PID == id.PID {
			if !process.Start.Equal(id.ProcessStart) || filepath.Base(process.Name) != "claude" {
				return invalid("ancestry reaches a restarted root")
			}
			return nil
		}
		if filepath.Base(process.Name) == "claude" || process.PPID <= 1 {
			return invalid("ancestry does not reach the bound Claude process")
		}
		process, exists, err = probe.Process(ctx, process.PPID)
		if err != nil || !exists {
			return invalid("ancestry has a missing process")
		}
	}
}
