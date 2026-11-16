package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/IvanRoslov/hopp/internal/store"
)

// postResponse is the JSON shape of a post.
type postResponse struct {
	ID          int64             `json:"id"`
	From        string            `json:"from"`
	Labels      map[string]string `json:"labels"`
	Body        string            `json:"body"`
	Attachments []string          `json:"attachments"`
	CreatedAt   int64             `json:"created_at"`
}

func toPostResponse(p store.Post) postResponse {
	return postResponse{ID: p.ID, From: p.FromSession, Labels: p.Labels, Body: p.Body, Attachments: p.Attachments, CreatedAt: p.CreatedAt}
}

// registerPostRoutes serves posts: notes that wait for no answer, from a
// session to the human or the human's own. The daemon stores and lists them.
func registerPostRoutes(mux *http.ServeMux, d Deps) {
	mux.HandleFunc("POST /v1/posts", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			From        string            `json:"from"`
			Body        string            `json:"body"`
			Labels      map[string]string `json:"labels"`
			Attachments []string          `json:"attachments"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}
		if strings.TrimSpace(req.Body) == "" {
			writeErr(w, http.StatusBadRequest, "bad_request", "body must not be empty")
			return
		}
		labels, err := writerLabels(d, req.From, req.Labels)
		if errors.Is(err, errFromUnknown) {
			writeErr(w, http.StatusBadRequest, "bad_request", "from session not found: "+req.From)
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		id, err := d.Store.AddPost(store.Post{FromSession: req.From, Labels: labels, Body: req.Body, Attachments: req.Attachments})
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		p, err := d.Store.GetPost(id)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		// The post's own labels ride along, so a subscriber can filter the
		// human's posts too (they have no session whose labels the bus adds).
		if d.Bus != nil {
			d.Bus.Publish("post.added", p.FromSession, map[string]any{"id": p.ID, "post_labels": p.Labels})
		}
		writeJSON(w, http.StatusCreated, toPostResponse(p))
	})

	mux.HandleFunc("GET /v1/posts", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		f := store.PostFilter{From: q.Get("from")}
		labels, ok := parseLabelFilter(q["label"])
		if !ok {
			writeErr(w, http.StatusBadRequest, "bad_request", "label wants k=v")
			return
		}
		f.Labels = labels
		if s := q.Get("after"); s != "" {
			n, err := strconv.ParseInt(s, 10, 64)
			if err != nil || n < 0 {
				writeErr(w, http.StatusBadRequest, "bad_request", "after wants a post id")
				return
			}
			f.After = n
		}
		if s := q.Get("limit"); s != "" {
			n, err := strconv.Atoi(s)
			if err != nil || n < 1 {
				writeErr(w, http.StatusBadRequest, "bad_request", "limit wants a positive number")
				return
			}
			f.Limit = n
		}
		list, err := d.Store.ListPosts(f)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out := make([]postResponse, 0, len(list))
		for _, p := range list {
			out = append(out, toPostResponse(p))
		}
		writeJSON(w, http.StatusOK, map[string]any{"posts": out})
	})

	mux.HandleFunc("GET /v1/posts/{id}", func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		var p store.Post
		if err == nil {
			p, err = d.Store.GetPost(id)
		} else {
			err = store.ErrNotFound
		}
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "post_not_found", "post not found: "+r.PathValue("id"))
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, toPostResponse(p))
	})
}
