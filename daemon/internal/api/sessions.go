package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/IvanRoslov/hopp/internal/session"
	"github.com/IvanRoslov/hopp/internal/store"
)

// sessionView is the JSON shape of a session. The folder is "dir".
type sessionView struct {
	ID        string            `json:"id"`
	Parent    string            `json:"parent"`
	Dir       string            `json:"dir"`
	Labels    map[string]string `json:"labels"`
	Agent     string            `json:"agent"`
	Profile   string            `json:"profile"`
	Model     string            `json:"model"`
	Effort    string            `json:"effort"`
	State     string            `json:"state"`
	Activity  string            `json:"activity"`
	CreatedAt int64             `json:"created_at"`
	UpdatedAt int64             `json:"updated_at"`
	Children  []string          `json:"children,omitempty"`
}

func toSessionView(s store.Session) sessionView {
	labels := s.Labels
	if labels == nil {
		labels = map[string]string{}
	}
	return sessionView{
		ID: s.ID, Parent: s.ParentID, Dir: s.WorktreePath, Labels: labels,
		Agent: s.Agent, Profile: s.Profile, Model: s.Model, Effort: s.Effort,
		State: s.State, Activity: s.Activity, CreatedAt: s.CreatedAt, UpdatedAt: s.UpdatedAt,
	}
}

type createSessionReq struct {
	Dir            string            `json:"dir"`
	ID             string            `json:"id"`
	Parent         string            `json:"parent"`
	Labels         map[string]string `json:"labels"`
	Profile        string            `json:"profile"`
	Agent          string            `json:"agent"`
	Model          string            `json:"model"`
	Effort         string            `json:"effort"`
	SystemPrompt   string            `json:"system_prompt"`
	Message        string            `json:"message"`
	PermissionMode string            `json:"permission_mode"`
	Env            map[string]string `json:"env"`
}

// decodeBody decodes an optional JSON body into v. An empty body leaves v
// as it is.
func decodeBody(r *http.Request, v any) error {
	err := json.NewDecoder(r.Body).Decode(v)
	if err == nil || errors.Is(err, io.EOF) {
		return nil
	}
	return newAPIError(http.StatusBadRequest, "bad_request", "invalid JSON body")
}

func registerSessionRoutes(mux *http.ServeMux, d Deps) {
	mux.HandleFunc("POST /v1/sessions", func(w http.ResponseWriter, r *http.Request) {
		var req createSessionReq
		if err := decodeBody(r, &req); err != nil {
			writeManagerErr(w, err)
			return
		}
		if req.Dir == "" {
			writeErr(w, http.StatusBadRequest, "bad_request", "dir is required")
			return
		}
		prof, err := resolveProfile(d.Store, d.Cfg, req.Profile, req.Agent, req.Model, req.Effort)
		if err != nil {
			writeManagerErr(w, err)
			return
		}
		sess, err := d.Manager.Spawn(r.Context(), session.SpawnReq{
			ID: req.ID, ParentID: req.Parent, Dir: req.Dir, Labels: req.Labels, Profile: prof,
			SystemPrompt: req.SystemPrompt, FirstMessage: req.Message,
			PermissionMode: req.PermissionMode, Env: req.Env,
		})
		if err != nil {
			writeManagerErr(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, toSessionView(sess))
	})

	mux.HandleFunc("GET /v1/sessions", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		f := store.SessionFilter{Parent: q.Get("parent"), State: q.Get("state"), All: q.Get("all") == "1"}
		for _, l := range q["label"] {
			k, v, ok := strings.Cut(l, "=")
			if !ok || k == "" {
				writeErr(w, http.StatusBadRequest, "bad_request", "label must be key=value: "+l)
				return
			}
			if f.Labels == nil {
				f.Labels = map[string]string{}
			}
			f.Labels[k] = v
		}
		list, err := d.Store.ListSessions(f)
		if err != nil {
			writeManagerErr(w, err)
			return
		}
		out := make([]sessionView, 0, len(list))
		for _, s := range list {
			out = append(out, toSessionView(s))
		}
		writeJSON(w, http.StatusOK, map[string]any{"sessions": out})
	})

	mux.HandleFunc("GET /v1/sessions/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		sess, err := d.Store.GetSession(id)
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "session_not_found", "session not found: "+id)
			return
		}
		if err != nil {
			writeManagerErr(w, err)
			return
		}
		kids, err := d.Manager.Children(id)
		if err != nil {
			writeManagerErr(w, err)
			return
		}
		view := toSessionView(sess)
		view.Children = []string{}
		for _, k := range kids {
			view.Children = append(view.Children, k.ID)
		}
		writeJSON(w, http.StatusOK, view)
	})

	mux.HandleFunc("POST /v1/sessions/{id}/kill", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Final string `json:"final"`
		}
		if err := decodeBody(r, &req); err != nil {
			writeManagerErr(w, err)
			return
		}
		if req.Final == "" {
			req.Final = "killed"
		}
		id := r.PathValue("id")
		if err := d.Manager.Kill(r.Context(), id, req.Final); err != nil {
			writeManagerErr(w, err)
			return
		}
		writeSession(w, d, id)
	})

	mux.HandleFunc("POST /v1/sessions/{id}/restore", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Force bool `json:"force"`
		}
		if err := decodeBody(r, &req); err != nil {
			writeManagerErr(w, err)
			return
		}
		id := r.PathValue("id")
		if err := d.Manager.Restore(r.Context(), id, session.RestoreOpts{Force: req.Force}); err != nil {
			writeManagerErr(w, err)
			return
		}
		writeSession(w, d, id)
	})

	mux.HandleFunc("GET /v1/sessions/{id}/attach", func(w http.ResponseWriter, r *http.Request) {
		argv, err := d.Manager.AttachCommand(r.PathValue("id"))
		if err != nil {
			writeManagerErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"command": argv})
	})

	mux.HandleFunc("GET /v1/sessions/{id}/output", func(w http.ResponseWriter, r *http.Request) {
		lines := 200
		if s := r.URL.Query().Get("lines"); s != "" {
			n, err := strconv.Atoi(s)
			if err != nil || n <= 0 {
				writeErr(w, http.StatusBadRequest, "bad_request", "lines must be a positive integer")
				return
			}
			lines = n
		}
		out, err := d.Manager.Output(r.Context(), r.PathValue("id"), lines)
		if err != nil {
			writeManagerErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"output": out})
	})
}

// writeSession writes the stored session id with status 200.
func writeSession(w http.ResponseWriter, d Deps, id string) {
	sess, err := d.Store.GetSession(id)
	if err != nil {
		writeManagerErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, toSessionView(sess))
}
