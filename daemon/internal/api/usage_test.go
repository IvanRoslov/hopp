package api

import (
	"context"
	"net/http"
	"testing"

	"github.com/IvanRoslov/hopp/internal/store"
)

type fakeUsage struct {
	collected []string
	queued    int
}

func (f *fakeUsage) CollectNow(_ context.Context, id string, _ int64) error {
	f.collected = append(f.collected, id)
	return nil
}
func (f *fakeUsage) EnqueueTerminal(collected, missing bool) (int, error) {
	if collected && !missing {
		return f.queued, nil
	}
	return 0, nil
}

func TestGetUsageRows(t *testing.T) {
	e := newAPIEnv(t)
	e.create(t, map[string]any{"dir": t.TempDir(), "id": "p", "labels": map[string]string{"team": "a"}})
	e.create(t, map[string]any{"dir": t.TempDir(), "id": "c", "parent": "p", "labels": map[string]string{"team": ""}})
	end := int64(500)
	e.st.ReplaceSessionUsage(store.SessionStats{SessionID: "c", Status: "ok", Final: true, StartedAt: 1, EndedAt: &end, CollectedAt: 501},
		[]store.ModelUsage{{Model: "m1", Tokens: store.UsageTokens{Input: 5, CacheWrite: 1, CacheRead: 2, Output: 3, Reasoning: 1, Messages: 2}}})
	var body struct {
		Rows []map[string]any `json:"rows"`
	}
	if code := e.call(t, "GET", "/v1/usage?parent=p", nil, &body); code != 200 || len(body.Rows) != 1 {
		t.Fatalf("parent: %d %+v", code, body)
	}
	r := body.Rows[0]
	if r["session"] != "c" || r["parent"] != "p" || r["model"] != "m1" || r["input"] != float64(5) || r["output"] != float64(3) ||
		r["status"] != "ok" || r["final"] != true || r["ended_at"] != float64(500) {
		t.Errorf("row %v", r)
	}
	body.Rows = nil
	if code := e.call(t, "GET", "/v1/usage?label=team=a", nil, &body); code != 200 || len(body.Rows) != 1 || body.Rows[0]["session"] != "p" || body.Rows[0]["model"] != "" {
		t.Fatalf("label: %d %+v", code, body.Rows)
	}
	if code := e.call(t, "GET", "/v1/usage?label=bad", nil, nil); code != 400 {
		t.Errorf("bad label: %d, want 400", code)
	}
	if code := e.call(t, "GET", "/v1/usage?from=x", nil, nil); code != 400 {
		t.Errorf("bad from: %d, want 400", code)
	}
}

func TestPostUsageCollect(t *testing.T) {
	e := newAPIEnv(t)
	var errBody map[string]any
	if code := e.call(t, "POST", "/v1/usage/collect", map[string]any{"all": true}, &errBody); code != 503 || errCode(errBody) != "unavailable" {
		t.Fatalf("without a collector: %d %v", code, errBody)
	}
	fu := &fakeUsage{queued: 2}
	e = newAPIEnvWithUsage(t, fu)
	e.create(t, map[string]any{"dir": t.TempDir(), "id": "live"})
	e.create(t, map[string]any{"dir": t.TempDir(), "id": "ended"})
	e.call(t, "POST", "/v1/sessions/ended/kill", map[string]any{}, nil)

	var out struct {
		Collected int `json:"collected"`
		Queued    int `json:"queued"`
	}
	if code := e.call(t, "POST", "/v1/usage/collect", map[string]any{"session": "ended"}, &out); code != 200 || out.Collected != 1 || len(fu.collected) != 1 || fu.collected[0] != "ended" {
		t.Fatalf("session: %d %+v %v", code, out, fu.collected)
	}
	fu.collected = nil
	if code := e.call(t, "POST", "/v1/usage/collect", map[string]any{"all": true}, &out); code != 200 || out.Collected != 1 || out.Queued != 2 || fu.collected[0] != "live" {
		t.Fatalf("all: %d %+v %v", code, out, fu.collected)
	}
	for _, bad := range []map[string]any{{}, {"session": "live", "all": true}} {
		errBody = nil
		if code := e.call(t, "POST", "/v1/usage/collect", bad, &errBody); code != http.StatusBadRequest {
			t.Errorf("%v: %d", bad, code)
		}
	}
	if code := e.call(t, "POST", "/v1/usage/collect", map[string]any{"session": "nosuch"}, nil); code != 404 {
		t.Errorf("unknown session: %d", code)
	}
}
