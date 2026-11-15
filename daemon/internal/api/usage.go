package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/IvanRoslov/hopp/internal/store"
)

// UsageCollector is the slice of usage.Collector the API drives.
type UsageCollector interface {
	// CollectNow reads one session's usage now: a live session gets a
	// snapshot (final=0), an ended one its final collection.
	CollectNow(ctx context.Context, sessionID string, eventAt int64) error
	// EnqueueTerminal queues ended sessions for the collector's goroutine.
	EnqueueTerminal(includeCollected, includeMissing bool) (int, error)
}

// usageRowResponse is one session and model of GET /v1/usage.
type usageRowResponse struct {
	Session     string            `json:"session"`
	Parent      string            `json:"parent"`
	Labels      map[string]string `json:"labels"`
	Agent       string            `json:"agent"`
	State       string            `json:"state"`
	Status      string            `json:"status"`
	Error       string            `json:"error,omitempty"`
	Final       bool              `json:"final"`
	StartedAt   int64             `json:"started_at"`
	EndedAt     *int64            `json:"ended_at,omitempty"`
	CollectedAt int64             `json:"collected_at"`
	Model       string            `json:"model"`
	Input       int64             `json:"input"`
	CacheWrite  int64             `json:"cache_write"`
	CacheRead   int64             `json:"cache_read"`
	Output      int64             `json:"output"`
	Reasoning   int64             `json:"reasoning"`
	Messages    int64             `json:"messages"`
}

func registerUsageRoutes(mux *http.ServeMux, d Deps) {
	// GET /v1/usage?session=&parent=&label=k=v&from=&to= → {"rows":[...]}.
	mux.HandleFunc("GET /v1/usage", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		f := store.UsageFilter{Session: q.Get("session"), Parent: q.Get("parent")}
		labels, ok := parseLabelFilter(q["label"])
		if !ok {
			writeErr(w, http.StatusBadRequest, "bad_request", "label wants k=v")
			return
		}
		f.Labels = labels
		for name, dst := range map[string]*int64{"from": &f.From, "to": &f.To} {
			if v := q.Get(name); v != "" {
				n, err := strconv.ParseInt(v, 10, 64)
				if err != nil {
					writeErr(w, http.StatusBadRequest, "bad_request", name+" wants unix seconds")
					return
				}
				*dst = n
			}
		}
		rows, err := d.Store.UsageRows(f)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out := make([]usageRowResponse, len(rows))
		for i, r := range rows {
			t := r.Tokens
			out[i] = usageRowResponse{Session: r.SessionID, Parent: r.Parent, Labels: r.Labels, Agent: r.Agent, State: r.State,
				Status: r.Status, Error: r.Error, Final: r.Final, StartedAt: r.StartedAt, EndedAt: r.EndedAt, CollectedAt: r.CollectedAt,
				Model: r.Model, Input: t.Input, CacheWrite: t.CacheWrite, CacheRead: t.CacheRead, Output: t.Output,
				Reasoning: t.Reasoning, Messages: t.Messages}
		}
		writeJSON(w, http.StatusOK, map[string]any{"rows": out})
	})

	// POST /v1/usage/collect {"session": id} collects that session now;
	// {"all": true} collects every live session now and queues every ended
	// one not yet collected. → {"collected": n, "queued": m}.
	mux.HandleFunc("POST /v1/usage/collect", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Session string `json:"session"`
			All     bool   `json:"all"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}
		if (req.Session == "") == !req.All {
			writeErr(w, http.StatusBadRequest, "bad_request", "pass either session or all")
			return
		}
		if d.Usage == nil {
			writeErr(w, http.StatusServiceUnavailable, "unavailable", "usage collector is not running")
			return
		}
		ids := []string{req.Session}
		if req.Session != "" {
			if _, err := d.Store.GetSession(req.Session); err != nil {
				if errors.Is(err, store.ErrNotFound) {
					writeErr(w, http.StatusNotFound, "session_not_found", "session not found: "+req.Session)
					return
				}
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
		} else {
			live, err := d.Store.ListSessions(store.SessionFilter{})
			if err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			ids = ids[:0]
			for _, s := range live {
				ids = append(ids, s.ID)
			}
		}
		var failed []string
		for _, id := range ids {
			if err := d.Usage.CollectNow(r.Context(), id, 0); err != nil {
				failed = append(failed, id+": "+err.Error())
			}
		}
		queued := 0
		if req.All {
			n, err := d.Usage.EnqueueTerminal(true, false)
			if err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			queued = n
		}
		if len(failed) > 0 {
			writeErr(w, http.StatusInternalServerError, "internal_error", "collect failed: "+strings.Join(failed, "; "))
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"collected": len(ids), "queued": queued})
	})
}
