package store

import (
	"errors"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// addUsageTestSession adds a session with defaults for the fields the usage
// tests do not care about.
func addUsageTestSession(t *testing.T, s *Store, sess Session) {
	t.Helper()
	if sess.Agent == "" {
		sess.Agent = "claude-code"
	}
	if sess.WorktreePath == "" {
		sess.WorktreePath = "/tmp/" + sess.ID
	}
	if sess.TmuxName == "" {
		sess.TmuxName = sess.ID
	}
	if err := s.AddSession(sess); err != nil {
		t.Fatal(err)
	}
}

func TestReplaceSessionUsageReplacesModelsAndStats(t *testing.T) {
	s := openTestStore(t)
	addUsageTestSession(t, s, Session{ID: "s", State: "done"})
	first := SessionStats{SessionID: "s", Status: "ok", Final: false, StartedAt: 100, CollectedAt: 200}
	if err := s.ReplaceSessionUsage(first, []ModelUsage{
		{Model: "old", Tokens: UsageTokens{Input: 9}},
		{Model: "keep", Tokens: UsageTokens{Input: 2}},
	}); err != nil {
		t.Fatal(err)
	}
	end := int64(300)
	second := SessionStats{SessionID: "s", Status: "ok", Final: true, StartedAt: 100, EndedAt: &end, CollectedAt: 301}
	models := []ModelUsage{{Model: "keep", Tokens: UsageTokens{Input: 3, CacheWrite: 4, CacheRead: 5, Output: 6, Reasoning: 2, Messages: 7}}}
	if err := s.ReplaceSessionUsage(second, models); err != nil {
		t.Fatal(err)
	}
	got, gotModels, err := s.GetSessionStats("s")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, second) || !reflect.DeepEqual(gotModels, models) {
		t.Fatalf("replacement got stats=%+v models=%+v, want %+v %+v", got, gotModels, second, models)
	}
	if err := s.ReplaceSessionUsage(first, []ModelUsage{{Model: "dup"}, {Model: "dup"}}); err == nil {
		t.Fatal("duplicate model replacement unexpectedly succeeded")
	}
	got, gotModels, err = s.GetSessionStats("s")
	if err != nil || !reflect.DeepEqual(got, second) || !reflect.DeepEqual(gotModels, models) {
		t.Fatalf("failed replacement changed committed rows: stats=%+v models=%+v err=%v", got, gotModels, err)
	}
	if _, _, err := s.GetSessionStats("absent"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("GetSessionStats(absent) = %v, want ErrNotFound", err)
	}
}

func TestSessionsNeedingUsageSelection(t *testing.T) {
	s := openTestStore(t)
	for _, id := range []string{"none", "snapshot", "missing", "ok", "retry", "fresh-error", "exhausted", "live"} {
		state := "done"
		if id == "live" {
			state = "running"
		}
		addUsageTestSession(t, s, Session{ID: id, State: state})
	}
	for _, tc := range []struct {
		id       string
		status   string
		final    bool
		attempts int
		at       int64
	}{
		{"snapshot", "ok", false, 0, 9900},
		{"missing", "missing", true, 0, 100},
		{"ok", "ok", true, 0, 100},
		{"retry", "error", true, 2, 6300},
		{"fresh-error", "error", true, 1, 6401},
		{"exhausted", "error", true, 3, 100},
	} {
		if err := s.ReplaceSessionUsage(SessionStats{SessionID: tc.id, Status: tc.status, Final: tc.final, StartedAt: 1, CollectedAt: tc.at, Attempts: tc.attempts}, nil); err != nil {
			t.Fatal(err)
		}
	}
	got, err := s.SessionsNeedingUsage(10, 10000)
	if err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 0, len(got))
	for _, sess := range got {
		ids = append(ids, sess.ID)
	}
	sort.Strings(ids)
	if !reflect.DeepEqual(ids, []string{"none", "retry", "snapshot"}) {
		t.Fatalf("SessionsNeedingUsage IDs = %v", ids)
	}
	limited, err := s.SessionsNeedingUsage(2, 10000)
	if err != nil || len(limited) != 2 {
		t.Fatalf("limit returned %d rows, err=%v", len(limited), err)
	}
}

func TestTerminalSessionIDsForManualRecollect(t *testing.T) {
	s := openTestStore(t)
	for _, id := range []string{"none", "ok", "missing", "error", "live"} {
		state := "killed"
		if id == "live" {
			state = "running"
		}
		addUsageTestSession(t, s, Session{ID: id, State: state})
	}
	for id, status := range map[string]string{"ok": "ok", "missing": "missing", "error": "error"} {
		if err := s.ReplaceSessionUsage(SessionStats{SessionID: id, Status: status, Final: true, StartedAt: 1, CollectedAt: 1, Attempts: 3}, nil); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		collected, missing bool
		want               []string
	}{
		{true, false, []string{"error", "none", "ok"}},
		{true, true, []string{"error", "missing", "none", "ok"}},
		{false, true, []string{"missing"}},
		{false, false, nil},
	} {
		got, err := s.TerminalSessionIDs(tc.collected, tc.missing)
		if err != nil {
			t.Fatal(err)
		}
		sort.Strings(got)
		if !reflect.DeepEqual(got, tc.want) {
			t.Errorf("TerminalSessionIDs(%v,%v) = %v, want %v", tc.collected, tc.missing, got, tc.want)
		}
	}
}

// TestUsageRowsByParentAndLabels: one row per session and model, narrowed by
// session, parent, labels and the time window; a session without collected
// usage still has one row without a model.
func TestUsageRowsByParentAndLabels(t *testing.T) {
	s := openTestStore(t)
	addUsageTestSession(t, s, Session{ID: "p", State: "running", Labels: map[string]string{"team": "a"}})
	addUsageTestSession(t, s, Session{ID: "c", ParentID: "p", State: "done", Labels: map[string]string{"team": "a"}})
	addUsageTestSession(t, s, Session{ID: "other", State: "done", Labels: map[string]string{"team": "b"}})
	end := int64(500)
	s.ReplaceSessionUsage(SessionStats{SessionID: "c", Status: "ok", Final: true, StartedAt: 100, EndedAt: &end, CollectedAt: 501},
		[]ModelUsage{{Model: "m1", Tokens: UsageTokens{Input: 1, Output: 2}}, {Model: "m2", Tokens: UsageTokens{Input: 3}}})
	s.ReplaceSessionUsage(SessionStats{SessionID: "other", Status: "ok", Final: true, StartedAt: 100, EndedAt: &end, CollectedAt: 501},
		[]ModelUsage{{Model: "m1", Tokens: UsageTokens{Input: 9}}})

	ids := func(rows []UsageRow) string {
		var out []string
		for _, r := range rows {
			out = append(out, r.SessionID+"/"+r.Model)
		}
		sort.Strings(out)
		return strings.Join(out, ",")
	}
	all, err := s.UsageRows(UsageFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if got := ids(all); got != "c/m1,c/m2,other/m1,p/" {
		t.Errorf("all = %s", got)
	}
	for _, r := range all {
		if r.SessionID == "c" && r.Model == "m1" && (r.Parent != "p" || r.Labels["team"] != "a" || r.Status != "ok" || !r.Final || r.Tokens.Output != 2) {
			t.Errorf("row %+v", r)
		}
	}
	if rows, _ := s.UsageRows(UsageFilter{Parent: "p"}); ids(rows) != "c/m1,c/m2" {
		t.Errorf("parent = %s", ids(rows))
	}
	if rows, _ := s.UsageRows(UsageFilter{Labels: map[string]string{"team": "a"}}); ids(rows) != "c/m1,c/m2,p/" {
		t.Errorf("labels = %s", ids(rows))
	}
	if rows, _ := s.UsageRows(UsageFilter{Session: "other"}); ids(rows) != "other/m1" {
		t.Errorf("session = %s", ids(rows))
	}
	if rows, _ := s.UsageRows(UsageFilter{From: 600}); ids(rows) != "p/" {
		t.Errorf("from 600 = %s", ids(rows))
	}
}

func TestRemoveSessionsDeletesUsage(t *testing.T) {
	s := openTestStore(t)
	addUsageTestSession(t, s, Session{ID: "gone", State: "killed"})
	end := int64(5)
	s.ReplaceSessionUsage(SessionStats{SessionID: "gone", Status: "ok", Final: true, StartedAt: 1, EndedAt: &end, CollectedAt: 6},
		[]ModelUsage{{Model: "m", Tokens: UsageTokens{Input: 1}}})
	if err := s.RemoveSessions([]string{"gone"}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.GetSessionStats("gone"); !errors.Is(err, ErrNotFound) {
		t.Errorf("stats of a removed session: %v, want ErrNotFound", err)
	}
	if n := count(t, s, `SELECT count(*) FROM session_usage WHERE session_id='gone'`); n != 0 {
		t.Errorf("usage rows left: %d", n)
	}
}
