package agy

import (
	"context"
	"time"

	"github.com/IvanRoslov/hopp/internal/activity"
	"github.com/IvanRoslov/hopp/internal/agent"
)

// Activity implements agent.Agent from the last record of the conversation's
// journal: a model reply without tool calls ends a turn (Ready); anything
// else — the user's input, a reply that calls tools, a tool result, a notice
// from agy — means the model is still to answer (Active). No journal yet is
// ErrNoSignal.
//
// A turn the human cancelled with Esc leaves its last tool call as the last
// record, so such a session reads Active until its next turn.
func (a *Agy) Activity(ctx context.Context, ref agent.ActivityRef) (activity.State, time.Time, error) {
	path, info, err := findTranscript(ref.WorktreePath, ref.Since)
	if err != nil {
		return "", time.Time{}, agent.ErrNoSignal
	}
	var last record
	found := false
	if err := scan(path, func(rec record) bool {
		last, found = rec, true
		return ctx.Err() == nil
	}); err != nil {
		return "", time.Time{}, agent.ErrNoSignal
	}
	if err := ctx.Err(); err != nil {
		return "", time.Time{}, err
	}
	if !found {
		return "", time.Time{}, agent.ErrNoSignal
	}
	if last.Type == typePlannerResponse && len(last.ToolCalls) == 0 {
		return activity.Ready, info.ModTime(), nil
	}
	return activity.Active, info.ModTime(), nil
}
