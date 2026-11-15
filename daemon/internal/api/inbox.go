package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strconv"

	"github.com/IvanRoslov/hopp/internal/store"
)

// mailboxNamePattern is the session id rule: a mailbox is reached by the id
// of the session that reads it.
var mailboxNamePattern = regexp.MustCompile(`^[a-z0-9-]{1,63}$`)

// inboxMessageResponse is one message of a mailbox.
type inboxMessageResponse struct {
	ID        int64  `json:"id"`
	Mailbox   string `json:"mailbox"`
	From      string `json:"from"`
	Body      string `json:"body"`
	Status    string `json:"status"`
	CreatedAt int64  `json:"created_at"`
	ReadAt    int64  `json:"read_at,omitempty"`
}

func toInboxMessageResponse(m store.InboxMessage) inboxMessageResponse {
	return inboxMessageResponse{ID: m.ID, Mailbox: m.Mailbox, From: m.From, Body: m.Body, Status: m.Status, CreatedAt: m.CreatedAt, ReadAt: m.ReadAt}
}

func registerInboxRoutes(mux *http.ServeMux, d Deps) {
	mux.HandleFunc("GET /v1/mailboxes", func(w http.ResponseWriter, r *http.Request) {
		boxes, err := d.Store.ListMailboxes()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out := make([]map[string]any, 0, len(boxes))
		for _, b := range boxes {
			out = append(out, map[string]any{"name": b.Name, "created_at": b.CreatedAt, "unread": b.Unread, "total": b.Total})
		}
		writeJSON(w, http.StatusOK, map[string]any{"mailboxes": out})
	})
	mux.HandleFunc("POST /v1/mailboxes", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Name string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}
		if !mailboxNamePattern.MatchString(req.Name) {
			writeErr(w, http.StatusBadRequest, "invalid_name", "a mailbox name is a session id: [a-z0-9-], at most 63 characters")
			return
		}
		if err := d.Store.AddMailbox(req.Name); err != nil {
			if errors.Is(err, store.ErrExists) {
				writeErr(w, http.StatusConflict, "mailbox_exists", "mailbox exists: "+req.Name)
				return
			}
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"name": req.Name})
	})
	mux.HandleFunc("DELETE /v1/mailboxes/{name}", func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		if err := d.Store.RemoveMailbox(name); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				writeErr(w, http.StatusNotFound, "mailbox_not_found", "mailbox not found: "+name)
				return
			}
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"removed": name})
	})
	mux.HandleFunc("GET /v1/mailboxes/{name}/inbox", func(w http.ResponseWriter, r *http.Request) {
		name, ok := lookupMailbox(w, r, d)
		if !ok {
			return
		}
		q := r.URL.Query()
		status := q.Get("status")
		switch status {
		case "", store.InboxUnread:
			status = store.InboxUnread
		case "all":
			status = ""
		case store.InboxRead:
		default:
			writeErr(w, http.StatusBadRequest, "invalid_status", "status must be unread, read or all")
			return
		}
		limit := 0
		if v := q.Get("limit"); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				limit = n
			}
		}
		msgs, err := d.Store.ListInboxMessages(name, status, limit)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out := make([]inboxMessageResponse, 0, len(msgs))
		for _, m := range msgs {
			out = append(out, toInboxMessageResponse(m))
		}
		writeJSON(w, http.StatusOK, map[string]any{"messages": out})
	})
	// POST .../inbox/next hands out the oldest unread message and marks it
	// read — the pull half of the mailbox. 204 means it is drained.
	mux.HandleFunc("POST /v1/mailboxes/{name}/inbox/next", func(w http.ResponseWriter, r *http.Request) {
		name, ok := lookupMailbox(w, r, d)
		if !ok {
			return
		}
		m, found, err := d.Store.NextUnreadInboxMessage(name)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		if !found {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		writeJSON(w, http.StatusOK, toInboxMessageResponse(m))
	})
	// GET .../inbox/{id} reads one message without marking it read (peek).
	mux.HandleFunc("GET /v1/mailboxes/{name}/inbox/{id}", func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil {
			writeErr(w, http.StatusNotFound, "message_not_found", "message not found")
			return
		}
		m, err := d.Store.GetInboxMessage(id)
		if err != nil || m.Mailbox != name {
			if err == nil || errors.Is(err, store.ErrNotFound) {
				writeErr(w, http.StatusNotFound, "message_not_found", "message not found")
				return
			}
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, toInboxMessageResponse(m))
	})
}

func lookupMailbox(w http.ResponseWriter, r *http.Request, d Deps) (string, bool) {
	name := r.PathValue("name")
	ok, err := d.Store.HasMailbox(name)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return "", false
	}
	if !ok {
		writeErr(w, http.StatusNotFound, "mailbox_not_found", "mailbox not found: "+name)
		return "", false
	}
	return name, true
}
