package bus

import (
	"log/slog"
	"sync"
	"time"

	"github.com/IvanRoslov/hopp/internal/store"
)

// Bus is an append-only event bus that persists to store and fans out to subscribers.
type Bus struct {
	st *store.Store

	mu          sync.RWMutex
	subscribers map[int64]chan store.Event
	nextID      int64
}

// New creates a new Bus backed by the given store.
func New(st *store.Store) *Bus {
	return &Bus{
		st:          st,
		subscribers: make(map[int64]chan store.Event),
	}
}

// Publish appends an event to the store and fans it out to all subscribers.
// If the store fails, the error is logged and fan-out is skipped.
// Slow subscribers (those whose channel buffer is full) lose events.
// Publish never blocks.
//
// When sessionID names a session with labels, they are added to data under
// "labels", unless the caller already set that key, so a subscriber can pick
// its sessions without asking the store again.
func (b *Bus) Publish(typ, sessionID string, data map[string]any) {
	data = b.withLabels(sessionID, data)
	e := store.Event{
		Type:      typ,
		SessionID: sessionID,
		Data:      data,
	}

	// Set TS before appending to store (so we know the exact value)
	if e.TS == 0 {
		e.TS = time.Now().Unix()
	}

	// Append to store and get the assigned ID
	id, err := b.st.AppendEvent(e)
	if err != nil {
		slog.Default().Error("failed to append event to store", "error", err)
		return // skip fan-out if store fails
	}

	// Populate ID from store
	e.ID = id

	// Fan out to subscribers with non-blocking send
	b.mu.RLock()
	defer b.mu.RUnlock()

	for _, ch := range b.subscribers {
		select {
		case ch <- e:
			// Event sent
		default:
			// Channel buffer is full, drop the event for this subscriber
		}
	}
}

// Subscribe returns a receive-only channel and a cancel function.
// The channel is buffered with capacity 64.
// The cancel function unsubscribes and closes the channel; it is idempotent.
func (b *Bus) Subscribe() (ch <-chan store.Event, cancel func()) {
	eventCh := make(chan store.Event, 64)

	b.mu.Lock()
	b.nextID++
	id := b.nextID
	b.subscribers[id] = eventCh
	b.mu.Unlock()

	var once sync.Once
	cancel = func() {
		once.Do(func() {
			b.mu.Lock()
			if ch, exists := b.subscribers[id]; exists {
				delete(b.subscribers, id)
				close(ch)
			}
			b.mu.Unlock()
		})
	}

	return eventCh, cancel
}

// withLabels returns data with the session's labels under "labels". It
// copies data rather than writing into the caller's map.
func (b *Bus) withLabels(sessionID string, data map[string]any) map[string]any {
	if sessionID == "" {
		return data
	}
	if _, set := data["labels"]; set {
		return data
	}
	sess, err := b.st.GetSession(sessionID)
	if err != nil || len(sess.Labels) == 0 {
		return data
	}
	out := make(map[string]any, len(data)+1)
	for k, v := range data {
		out[k] = v
	}
	labels := make(map[string]any, len(sess.Labels))
	for k, v := range sess.Labels {
		labels[k] = v
	}
	out["labels"] = labels
	return out
}
