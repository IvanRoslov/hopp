package store

import (
	"errors"
	"reflect"
	"sort"
	"testing"
)

func sessionIDs(sessions []Session) []string {
	out := make([]string, 0, len(sessions))
	for _, s := range sessions {
		out = append(out, s.ID)
	}
	return out
}

func TestAddGetSessionRoundTrip(t *testing.T) {
	s := openTestStore(t)
	mustAddSession(t, s, "parent")
	want := Session{
		ID: "child", ParentID: "parent", WorktreePath: "/work/child", TmuxName: "child",
		Labels: map[string]string{"team": "a", "step": "2"},
		Agent:  "codex", Profile: "codex-high", Model: "gpt-5", Effort: "high",
		State: "running", Activity: "idle", ActivityTS: 1700000000,
		Prompt: "first message", SystemPrompt: "be brief", PermissionMode: "plan",
		Env:               map[string]string{"FOO": "bar"},
		PendingQuiz:       `{"q":1}`,
		DeliveryTransport: "pi-uds-v1", DeliveryInstance: "inst", DeliveryEndpoint: "/tmp/ep",
		CreatedAt: 100, UpdatedAt: 200,
	}
	if err := s.AddSession(want); err != nil {
		t.Fatalf("AddSession: %v", err)
	}
	got, err := s.GetSession("child")
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("round trip:\n got %+v\nwant %+v", got, want)
	}
}

func TestAddSessionStampsTimesAndEmptyMaps(t *testing.T) {
	s := openTestStore(t)
	mustAddSession(t, s, "s1")
	got, err := s.GetSession("s1")
	if err != nil {
		t.Fatal(err)
	}
	if got.CreatedAt == 0 || got.UpdatedAt != got.CreatedAt {
		t.Errorf("times = %d/%d, want created_at set and updated_at equal to it", got.CreatedAt, got.UpdatedAt)
	}
	if got.Labels == nil || len(got.Labels) != 0 || got.Env == nil || len(got.Env) != 0 {
		t.Errorf("Labels = %#v, Env = %#v, want empty non-nil maps", got.Labels, got.Env)
	}
}

func TestAddSessionDuplicateIsErrExists(t *testing.T) {
	s := openTestStore(t)
	mustAddSession(t, s, "s1")
	err := s.AddSession(Session{ID: "s1", WorktreePath: "/x", TmuxName: "s1", Agent: "codex", State: "running"})
	if !errors.Is(err, ErrExists) {
		t.Fatalf("duplicate AddSession = %v, want ErrExists", err)
	}
}

func TestGetSessionMissingIsErrNotFound(t *testing.T) {
	s := openTestStore(t)
	if _, err := s.GetSession("missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("GetSession missing = %v, want ErrNotFound", err)
	}
}

func TestListSessionsDefaultsToLive(t *testing.T) {
	s := openTestStore(t)
	for i, state := range []string{"running", "spawning", "killed", "errored"} {
		if err := s.AddSession(Session{ID: state, WorktreePath: "/wt", TmuxName: state, Agent: "codex", State: state, CreatedAt: int64(i + 1)}); err != nil {
			t.Fatal(err)
		}
	}
	live, err := s.ListSessions(SessionFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := sessionIDs(live), []string{"running", "spawning"}; !reflect.DeepEqual(got, want) {
		t.Errorf("live = %v, want %v", got, want)
	}
	all, err := s.ListSessions(SessionFilter{All: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 4 {
		t.Errorf("All = %v, want 4 sessions", sessionIDs(all))
	}
	killed, err := s.ListSessions(SessionFilter{All: true, State: "killed"})
	if err != nil {
		t.Fatal(err)
	}
	if got := sessionIDs(killed); !reflect.DeepEqual(got, []string{"killed"}) {
		t.Errorf("State killed = %v", got)
	}
}

func TestListSessionsOrderedByCreatedAtThenID(t *testing.T) {
	s := openTestStore(t)
	for _, sess := range []Session{
		{ID: "b", CreatedAt: 10}, {ID: "a", CreatedAt: 10}, {ID: "c", CreatedAt: 5},
	} {
		sess.WorktreePath, sess.TmuxName, sess.Agent, sess.State = "/wt", sess.ID, "codex", "running"
		if err := s.AddSession(sess); err != nil {
			t.Fatal(err)
		}
	}
	got, err := s.ListSessions(SessionFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if ids := sessionIDs(got); !reflect.DeepEqual(ids, []string{"c", "a", "b"}) {
		t.Errorf("order = %v, want [c a b]", ids)
	}
}

func TestListSessionsByParent(t *testing.T) {
	s := openTestStore(t)
	mustAddSession(t, s, "p")
	for _, id := range []string{"c1", "c2"} {
		if err := s.AddSession(Session{ID: id, ParentID: "p", WorktreePath: "/wt", TmuxName: id, Agent: "codex", State: "running"}); err != nil {
			t.Fatal(err)
		}
	}
	mustAddSession(t, s, "other")
	got, err := s.ListSessions(SessionFilter{Parent: "p"})
	if err != nil {
		t.Fatal(err)
	}
	ids := sessionIDs(got)
	sort.Strings(ids)
	if !reflect.DeepEqual(ids, []string{"c1", "c2"}) {
		t.Errorf("children of p = %v, want [c1 c2]", ids)
	}
}

func TestListSessionsByLabels(t *testing.T) {
	s := openTestStore(t)
	for i, labels := range []map[string]string{{"a": "1", "b": "2"}, {"a": "1"}, {"a": "2"}} {
		id := []string{"first", "second", "third"}[i]
		if err := s.AddSession(Session{ID: id, WorktreePath: "/wt", TmuxName: id, Agent: "codex", State: "running", Labels: labels, CreatedAt: int64(i + 1)}); err != nil {
			t.Fatal(err)
		}
	}
	got, err := s.ListSessions(SessionFilter{Labels: map[string]string{"a": "1"}})
	if err != nil {
		t.Fatal(err)
	}
	if ids := sessionIDs(got); !reflect.DeepEqual(ids, []string{"first", "second"}) {
		t.Errorf("a=1 -> %v, want [first second]", ids)
	}
	got, err = s.ListSessions(SessionFilter{Labels: map[string]string{"a": "1", "b": "2"}})
	if err != nil {
		t.Fatal(err)
	}
	if ids := sessionIDs(got); !reflect.DeepEqual(ids, []string{"first"}) {
		t.Errorf("a=1,b=2 -> %v, want [first]", ids)
	}
}

func TestUpdateSessionRewritesTheRow(t *testing.T) {
	s := openTestStore(t)
	mustAddSession(t, s, "s1")
	sess, err := s.GetSession("s1")
	if err != nil {
		t.Fatal(err)
	}
	sess.State, sess.Model, sess.Labels = "killed", "opus", map[string]string{"x": "y"}
	if err := s.UpdateSession(sess); err != nil {
		t.Fatalf("UpdateSession: %v", err)
	}
	got, err := s.GetSession("s1")
	if err != nil {
		t.Fatal(err)
	}
	if got.State != "killed" || got.Model != "opus" || got.Labels["x"] != "y" {
		t.Errorf("after update: %+v", got)
	}
	if err := s.UpdateSession(Session{ID: "missing"}); !errors.Is(err, ErrNotFound) {
		t.Errorf("UpdateSession missing = %v, want ErrNotFound", err)
	}
}

func TestUpdateSessionStateAndDelivery(t *testing.T) {
	s := openTestStore(t)
	mustAddSession(t, s, "s1")
	if err := s.UpdateSessionState("s1", "errored"); err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateSessionDelivery("s1", "claude-socket", "i1", "/tmp/x.sock"); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetSession("s1")
	if err != nil {
		t.Fatal(err)
	}
	if got.State != "errored" || got.DeliveryTransport != "claude-socket" || got.DeliveryInstance != "i1" || got.DeliveryEndpoint != "/tmp/x.sock" {
		t.Errorf("after updates: %+v", got)
	}
	if err := s.UpdateSessionState("missing", "killed"); !errors.Is(err, ErrNotFound) {
		t.Errorf("UpdateSessionState missing = %v, want ErrNotFound", err)
	}
	if err := s.UpdateSessionDelivery("missing", "", "", ""); !errors.Is(err, ErrNotFound) {
		t.Errorf("UpdateSessionDelivery missing = %v, want ErrNotFound", err)
	}
}

func TestUpdateSessionActivity(t *testing.T) {
	s := openTestStore(t)

	// Add a session
	mustAddSession(t, s, "s1")

	// Verify initial activity state (empty)
	got, err := s.GetSession("s1")
	if err != nil {
		t.Fatalf("GetSession initial: %v", err)
	}
	if got.Activity != "" || got.ActivityTS != 0 {
		t.Fatalf("initial activity/ts should be empty: %+v", got)
	}

	// Update activity
	ts := int64(1234567890)
	if err := s.UpdateSessionActivity("s1", "active", ts); err != nil {
		t.Fatalf("UpdateSessionActivity: %v", err)
	}

	// Verify activity was updated
	got, err = s.GetSession("s1")
	if err != nil {
		t.Fatalf("GetSession after update: %v", err)
	}
	if got.Activity != "active" {
		t.Fatalf("Activity = %q, want 'active'", got.Activity)
	}
	if got.ActivityTS != ts {
		t.Fatalf("ActivityTS = %d, want %d", got.ActivityTS, ts)
	}

	// Update with empty state
	if err := s.UpdateSessionActivity("s1", "", 0); err != nil {
		t.Fatalf("UpdateSessionActivity empty: %v", err)
	}
	got, err = s.GetSession("s1")
	if err != nil {
		t.Fatalf("GetSession after empty update: %v", err)
	}
	if got.Activity != "" {
		t.Fatalf("Activity should be empty after update: %q", got.Activity)
	}
	if got.ActivityTS != 0 {
		t.Fatalf("ActivityTS should be 0 after update: %d", got.ActivityTS)
	}

	// UpdateSessionActivity on missing id should return ErrNotFound
	if err := s.UpdateSessionActivity("missing", "idle", ts); !errors.Is(err, ErrNotFound) {
		t.Fatalf("UpdateSessionActivity missing id: got %v, want ErrNotFound", err)
	}
}

func TestSessionsTableHasNoScenarioColumns(t *testing.T) {
	s := openTestStore(t)
	rows, err := s.db.Query(`PRAGMA table_info(sessions)`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	banned := map[string]bool{"kind": true, "project_id": true, "repo_id": true, "feature_slug": true,
		"branch": true, "task_id": true, "subtask_id": true, "pr_number": true, "pr_state": true, "ci_state": true}
	n := 0
	for rows.Next() {
		var cid, notNull, pk int
		var name, typ string
		var dflt any
		if err := rows.Scan(&cid, &name, &typ, &notNull, &dflt, &pk); err != nil {
			t.Fatal(err)
		}
		n++
		if banned[name] {
			t.Errorf("sessions has scenario column %s", name)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if n == 0 {
		t.Fatal("sessions table has no columns")
	}
}
