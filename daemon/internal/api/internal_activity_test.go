package api

import (
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/IvanRoslov/hopp/internal/activity"
	"github.com/IvanRoslov/hopp/internal/agent"
	"github.com/IvanRoslov/hopp/internal/bus"
	"github.com/IvanRoslov/hopp/internal/config"
	"github.com/IvanRoslov/hopp/internal/monitor"
	"github.com/IvanRoslov/hopp/internal/store"
)

// activityTestDeps builds Deps with a real store, bus and monitor
// (constructed on the same store) for tests exercising
// POST /v1/internal/activity. resolveAgent is never invoked by PushUpdate,
// so a stub that always errors is fine.
func activityTestDeps(t *testing.T) Deps {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "rocket.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { st.Close() })

	b := bus.New(st)
	cfg := &config.Config{
		Home:                 dir,
		ActivityPollInterval: time.Minute,
		ReadyToIdle:          5 * time.Minute,
	}
	resolveAgent := func(name string) (agent.Agent, error) {
		return nil, errNotUsedInThisTest
	}
	mon := monitor.New(st, b, nil, cfg, resolveAgent)

	d := testDeps(t, nil)
	d.Store = st
	d.Bus = b
	d.Cfg = cfg
	d.Monitor = mon
	return d
}

var errNotUsedInThisTest = errNotUsed{}

type errNotUsed struct{}

func (errNotUsed) Error() string { return "resolveAgent not used in this test" }

// seedActivitySession inserts a session row so GetSession(id) succeeds.
func seedActivitySession(t *testing.T, st *store.Store, id string) {
	t.Helper()
	if err := st.AddSession(store.Session{
		ID:           id,
		WorktreePath: "/tmp/wt/" + id,
		TmuxName:     id,
		State:        "running",
	}); err != nil {
		t.Fatalf("AddSession: %v", err)
	}
}

func TestPostInternalActivityHappyPath(t *testing.T) {
	d := activityTestDeps(t)
	srv := newTestServer(t, d)

	seedActivitySession(t, d.Store, "sess1")

	resp := postJSON(t, srv.URL+"/v1/internal/activity", map[string]any{
		"session": "sess1",
		"state":   "active",
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", resp.StatusCode)
	}

	sess, err := d.Store.GetSession("sess1")
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	if sess.Activity != string(activity.Active) {
		t.Errorf("session.Activity = %q, want %q", sess.Activity, activity.Active)
	}
	if sess.ActivityTS == 0 {
		t.Errorf("session.ActivityTS = 0, want nonzero")
	}

	if st, ok := d.Monitor.Activity("sess1"); !ok || st != activity.Active {
		t.Errorf("Monitor.Activity(sess1) = (%v, %v), want (active, true)", st, ok)
	}
}

func TestPostInternalActivityExplicitTS(t *testing.T) {
	d := activityTestDeps(t)
	srv := newTestServer(t, d)

	seedActivitySession(t, d.Store, "sess1")

	ts := time.Now().Add(-time.Hour).Unix()
	resp := postJSON(t, srv.URL+"/v1/internal/activity", map[string]any{
		"session": "sess1",
		"state":   "waiting_input",
		"ts":      ts,
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", resp.StatusCode)
	}

	sess, err := d.Store.GetSession("sess1")
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	if sess.ActivityTS != ts {
		t.Errorf("session.ActivityTS = %d, want %d", sess.ActivityTS, ts)
	}
}

func TestPostInternalActivitySessionNotFound(t *testing.T) {
	d := activityTestDeps(t)
	srv := newTestServer(t, d)

	resp := postJSON(t, srv.URL+"/v1/internal/activity", map[string]any{
		"session": "nope",
		"state":   "active",
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", resp.StatusCode)
	}
	eb := decodeErr(t, resp)
	if eb.Error.Code != "session_not_found" {
		t.Errorf("code = %q, want session_not_found", eb.Error.Code)
	}
}

func TestPostInternalActivityInvalidState(t *testing.T) {
	d := activityTestDeps(t)
	srv := newTestServer(t, d)

	seedActivitySession(t, d.Store, "sess1")

	resp := postJSON(t, srv.URL+"/v1/internal/activity", map[string]any{
		"session": "sess1",
		"state":   "bogus",
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
	eb := decodeErr(t, resp)
	if eb.Error.Code != "invalid_state" {
		t.Errorf("code = %q, want invalid_state", eb.Error.Code)
	}
}

func TestPostInternalActivityBadJSON(t *testing.T) {
	d := activityTestDeps(t)
	srv := newTestServer(t, d)

	resp, err := http.Post(srv.URL+"/v1/internal/activity", "application/json", bytesReader([]byte("{not json")))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
	eb := decodeErr(t, resp)
	if eb.Error.Code != "bad_request" {
		t.Errorf("code = %q, want bad_request", eb.Error.Code)
	}
}

func TestPostInternalActivityMonitorUnavailable(t *testing.T) {
	d := activityTestDeps(t)
	d.Monitor = nil
	srv := newTestServer(t, d)

	seedActivitySession(t, d.Store, "sess1")

	resp := postJSON(t, srv.URL+"/v1/internal/activity", map[string]any{
		"session": "sess1",
		"state":   "active",
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", resp.StatusCode)
	}
	eb := decodeErr(t, resp)
	if eb.Error.Code != "monitor_unavailable" {
		t.Errorf("code = %q, want monitor_unavailable", eb.Error.Code)
	}
}

// TestPostInternalActivityHookScriptPayload posts the body the ported
// activity hook script builds (internal/agent/claudecode's activityHookScript:
// session, state, ts and the claude metadata object) and expects it to be
// accepted for a session that exists.
func TestPostInternalActivityHookScriptPayload(t *testing.T) {
	d := activityTestDeps(t)
	srv := newTestServer(t, d)
	seedActivitySession(t, d.Store, "sess1")

	body := `{"session":"sess1","state":"ready","ts":1794700000,"claude":{"session_id":"329baa3b-27eb-40ed-82e1-1d9f3dde01e5","hook_event_name":"Stop","reason":"","agent_id":"","launch_generation":"g1","producer_pid":4242,"producer_start":"2026-11-15T10:00:00Z","at":1794700000000000000}}`
	resp, err := http.Post(srv.URL+"/v1/internal/activity", "application/json", bytesReader([]byte(body)))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		t.Fatalf("status = %d, want 2xx", resp.StatusCode)
	}
}
