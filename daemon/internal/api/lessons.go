package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/IvanRoslov/hopp/internal/store"
)

// lessonResponse is the JSON shape of a lesson.
type lessonResponse struct {
	ID        int64             `json:"id"`
	From      string            `json:"from"`
	Labels    map[string]string `json:"labels"`
	Body      string            `json:"body"`
	Status    string            `json:"status"`
	CreatedAt int64             `json:"created_at"`
	ClosedAt  int64             `json:"closed_at"`
}

func toLessonResponse(l store.Lesson) lessonResponse {
	labels := l.Labels
	if labels == nil {
		labels = map[string]string{}
	}
	return lessonResponse{ID: l.ID, From: l.FromSession, Labels: labels, Body: l.Body, Status: l.Status,
		CreatedAt: l.CreatedAt, ClosedAt: l.ClosedAt}
}

// registerLessonRoutes serves lessons: notes about what would make the
// harness better. The daemon stores and lists them; it never acts on them.
func registerLessonRoutes(mux *http.ServeMux, d Deps) {
	mux.HandleFunc("POST /v1/lessons", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			From   string            `json:"from"`
			Body   string            `json:"body"`
			Labels map[string]string `json:"labels"`
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
		id, err := d.Store.AddLesson(store.Lesson{FromSession: req.From, Labels: labels, Body: req.Body})
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		l, err := d.Store.GetLesson(id)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if d.Bus != nil {
			d.Bus.Publish("lesson.added", l.FromSession, map[string]any{"id": l.ID})
		}
		writeJSON(w, http.StatusCreated, toLessonResponse(l))
	})

	mux.HandleFunc("GET /v1/lessons", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		f := store.LessonFilter{Status: q.Get("status"), From: q.Get("from")}
		switch f.Status {
		case "", "all", store.LessonNew, store.LessonClosed:
		default:
			writeErr(w, http.StatusBadRequest, "invalid_status", "status must be new, closed or all")
			return
		}
		labels, ok := parseLabelFilter(q["label"])
		if !ok {
			writeErr(w, http.StatusBadRequest, "bad_request", "label wants k=v")
			return
		}
		f.Labels = labels
		list, err := d.Store.ListLessons(f)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out := make([]lessonResponse, 0, len(list))
		for _, l := range list {
			out = append(out, toLessonResponse(l))
		}
		writeJSON(w, http.StatusOK, map[string]any{"lessons": out})
	})

	mux.HandleFunc("POST /v1/lessons/{id}/close", func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err == nil {
			err = d.Store.CloseLesson(id)
		} else {
			err = store.ErrNotFound
		}
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "lesson_not_found", "lesson not found: "+r.PathValue("id"))
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		l, err := d.Store.GetLesson(id)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, toLessonResponse(l))
	})
}
