package bus

import (
	"path/filepath"
	"testing"

	"github.com/IvanRoslov/hopp/internal/store"
)

func openLabelStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	if err := st.AddSession(store.Session{ID: "s1", WorktreePath: "/wt", TmuxName: "s1", Agent: "codex", State: "running",
		Labels: map[string]string{"scenario": "dev"}}); err != nil {
		t.Fatal(err)
	}
	return st
}

func lastEventData(t *testing.T, st *store.Store) map[string]any {
	t.Helper()
	events, err := st.ListEventsTail(1, "")
	if err != nil || len(events) != 1 {
		t.Fatalf("events = %v, %v", events, err)
	}
	return events[0].Data
}

func TestPublishAddsSessionLabels(t *testing.T) {
	st := openLabelStore(t)
	New(st).Publish("x", "s1", nil)
	labels, ok := lastEventData(t, st)["labels"].(map[string]any)
	if !ok || labels["scenario"] != "dev" {
		t.Fatalf("labels = %#v, want scenario=dev", lastEventData(t, st)["labels"])
	}
}

func TestPublishKeepsCallerLabels(t *testing.T) {
	st := openLabelStore(t)
	New(st).Publish("x", "s1", map[string]any{"labels": "mine", "k": "v"})
	data := lastEventData(t, st)
	if data["labels"] != "mine" || data["k"] != "v" {
		t.Fatalf("data = %#v, want the caller's labels kept", data)
	}
}

func TestPublishWithoutLabelsAddsNothing(t *testing.T) {
	st := openLabelStore(t)
	if err := st.AddSession(store.Session{ID: "bare", WorktreePath: "/wt", TmuxName: "bare", Agent: "codex", State: "running"}); err != nil {
		t.Fatal(err)
	}
	b := New(st)
	b.Publish("x", "bare", map[string]any{"k": "v"})
	if _, ok := lastEventData(t, st)["labels"]; ok {
		t.Fatal("labels added for a session without labels")
	}
	b.Publish("x", "", nil)
	b.Publish("x", "missing", nil)
}
