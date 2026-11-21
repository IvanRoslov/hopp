package agy

import (
	"context"
	"strings"
	"time"

	"github.com/IvanRoslov/hopp/internal/agent"
)

var _ agent.DeliveryConfirmer = (*Agy)(nil)

// ConfirmDelivered implements agent.DeliveryConfirmer: the conversation's
// journal holds a USER_INPUT record, stamped at or after since, whose text
// (whitespace-normalized) equals text — or a run of whose whole lines does:
// agy joins messages that waited in its queue into one record with "\n".
//
// agy stamps records to the second, so a record written right after the
// paste may carry the same second as since. since is therefore compared by
// the second.
func (a *Agy) ConfirmDelivered(ctx context.Context, ref agent.ActivityRef, text string, since time.Time) (bool, time.Time, error) {
	want := normalizeSpace(text)
	if want == "" {
		return false, time.Time{}, nil
	}
	path, _, err := findTranscript(ref.WorktreePath, ref.Since)
	if err != nil {
		return false, time.Time{}, agent.ErrNoSignal
	}
	from := since.Truncate(time.Second)
	var at time.Time
	found := false
	if err := scan(path, func(rec record) bool {
		if rec.Type == typeUserInput && !rec.at().Before(from) && holdsLines(rec.userText(), want) {
			at, found = rec.at(), true
			return false // oldest first: this is the earliest match
		}
		return ctx.Err() == nil
	}); err != nil {
		return false, time.Time{}, agent.ErrNoSignal
	}
	if err := ctx.Err(); err != nil {
		return false, time.Time{}, err
	}
	return found, at, nil
}

// holdsLines reports whether recorded, or a run of its whole lines, equals
// want once whitespace is normalized (same rule as the codex adapter).
func holdsLines(recorded, want string) bool {
	if !strings.Contains(normalizeSpace(recorded), want) {
		return false
	}
	lines := strings.Split(recorded, "\n")
	for i := range lines {
		for j := i + 1; j <= len(lines); j++ {
			got := normalizeSpace(strings.Join(lines[i:j], "\n"))
			if got == want {
				return true
			}
			if len(got) > len(want) {
				break
			}
		}
	}
	return false
}

// normalizeSpace collapses every run of whitespace to one space and trims.
func normalizeSpace(s string) string {
	return strings.Join(strings.Fields(s), " ")
}
