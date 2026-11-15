package store

import (
	"reflect"
	"testing"
)

func TestAppendListEvents(t *testing.T) {
	s := openTestStore(t)
	mustAddSession(t, s, "s1")
	mustAddSession(t, s, "s2")

	var lastID int64
	for i := 0; i < 3; i++ {
		id, err := s.AppendEvent(Event{Type: "session.started", SessionID: "s1", Data: map[string]any{"n": float64(i)}})
		if err != nil {
			t.Fatalf("AppendEvent: %v", err)
		}
		lastID = id
	}
	if _, err := s.AppendEvent(Event{Type: "session.started", SessionID: "s2", Data: map[string]any{"x": "y"}}); err != nil {
		t.Fatalf("AppendEvent s2: %v", err)
	}
	if lastID == 0 {
		t.Fatalf("lastID not assigned")
	}

	all, err := s.ListEvents(0, 0, "")
	if err != nil {
		t.Fatalf("ListEvents all: %v", err)
	}
	if len(all) != 4 {
		t.Fatalf("ListEvents all len = %d, want 4", len(all))
	}
	if !reflect.DeepEqual(all[0].Data, map[string]any{"n": float64(0)}) {
		t.Fatalf("Data round-trip = %v", all[0].Data)
	}

	since, err := s.ListEvents(all[0].ID, 0, "")
	if err != nil {
		t.Fatalf("ListEvents since: %v", err)
	}
	if len(since) != 3 {
		t.Fatalf("ListEvents since len = %d, want 3", len(since))
	}

	limited, err := s.ListEvents(0, 2, "")
	if err != nil {
		t.Fatalf("ListEvents limited: %v", err)
	}
	if len(limited) != 2 {
		t.Fatalf("ListEvents limited len = %d, want 2", len(limited))
	}

	bySession, err := s.ListEvents(0, 0, "s2")
	if err != nil {
		t.Fatalf("ListEvents by session: %v", err)
	}
	if len(bySession) != 1 || bySession[0].SessionID != "s2" {
		t.Fatalf("ListEvents by session = %+v", bySession)
	}

	tail, err := s.ListEventsTail(2, "")
	if err != nil {
		t.Fatalf("ListEventsTail: %v", err)
	}
	if len(tail) != 2 {
		t.Fatalf("ListEventsTail len = %d, want 2", len(tail))
	}
	// Must be the last 2 events, in ascending order.
	if tail[0].ID >= tail[1].ID {
		t.Fatalf("ListEventsTail not ascending: %+v", tail)
	}
	if tail[1].ID != all[len(all)-1].ID {
		t.Fatalf("ListEventsTail last id = %d, want %d", tail[1].ID, all[len(all)-1].ID)
	}

	tailAll, err := s.ListEventsTail(0, "")
	if err != nil {
		t.Fatalf("ListEventsTail(0): %v", err)
	}
	if len(tailAll) != len(all) {
		t.Fatalf("ListEventsTail(0) len = %d, want %d", len(tailAll), len(all))
	}

	tailBySession, err := s.ListEventsTail(10, "s2")
	if err != nil {
		t.Fatalf("ListEventsTail by session: %v", err)
	}
	if len(tailBySession) != 1 || tailBySession[0].SessionID != "s2" {
		t.Fatalf("ListEventsTail by session = %+v", tailBySession)
	}
}

func TestLastSessionEventTS(t *testing.T) {
	s := openTestStore(t)
	if _, ok, err := s.LastSessionEventTS("sess1", "session.restored"); err != nil || ok {
		t.Fatalf("empty: ok=%v err=%v, want none", ok, err)
	}
	for _, e := range []Event{
		{TS: 100, Type: "session.restored", SessionID: "sess1"},
		{TS: 200, Type: "session.restored", SessionID: "sess1"},
		{TS: 300, Type: "session.activity_changed", SessionID: "sess1"},
		{TS: 400, Type: "session.restored", SessionID: "other"},
	} {
		if _, err := s.AppendEvent(e); err != nil {
			t.Fatal(err)
		}
	}
	ts, ok, err := s.LastSessionEventTS("sess1", "session.restored")
	if err != nil || !ok || ts != 200 {
		t.Errorf("LastSessionEventTS = %d, %v, %v; want 200, true, nil", ts, ok, err)
	}
}

func TestLastSessionEventData(t *testing.T) {
	s := openTestStore(t)
	if _, ok, err := s.LastSessionEventData("sess1", "session.turn_failed"); err != nil || ok {
		t.Fatalf("empty: ok=%v err=%v, want none", ok, err)
	}
	for _, e := range []Event{
		{TS: 100, Type: "session.turn_failed", SessionID: "sess1", Data: map[string]any{"turn": "a"}},
		{TS: 200, Type: "session.turn_failed", SessionID: "sess1", Data: map[string]any{"turn": "b"}},
		{TS: 300, Type: "session.turn_failed", SessionID: "other", Data: map[string]any{"turn": "c"}},
	} {
		if _, err := s.AppendEvent(e); err != nil {
			t.Fatal(err)
		}
	}
	data, ok, err := s.LastSessionEventData("sess1", "session.turn_failed")
	if err != nil || !ok || data["turn"] != "b" {
		t.Errorf("LastSessionEventData = %v, %v, %v; want turn b", data, ok, err)
	}
}

func TestLastLaunchTSCoversSpawnAndRestore(t *testing.T) {
	s := openTestStore(t)
	if _, ok, err := s.LastLaunchTS("sess1"); err != nil || ok {
		t.Fatalf("empty: ok=%v err=%v, want none", ok, err)
	}
	if _, err := s.AppendEvent(Event{TS: 100, Type: "session.spawned", SessionID: "sess1"}); err != nil {
		t.Fatal(err)
	}
	if ts, ok, err := s.LastLaunchTS("sess1"); err != nil || !ok || ts != 100 {
		t.Fatalf("after spawn = %d, %v, %v; want 100", ts, ok, err)
	}
	for _, e := range []Event{
		{TS: 300, Type: "session.restored", SessionID: "sess1"},
		{TS: 400, Type: "session.activity_changed", SessionID: "sess1"},
	} {
		if _, err := s.AppendEvent(e); err != nil {
			t.Fatal(err)
		}
	}
	if ts, ok, err := s.LastLaunchTS("sess1"); err != nil || !ok || ts != 300 {
		t.Errorf("after restore = %d, %v, %v; want 300", ts, ok, err)
	}
}
