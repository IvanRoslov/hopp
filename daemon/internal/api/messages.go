package api

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/IvanRoslov/hopp/internal/store"
)

// defaultMessagesLimit and maxMessagesLimit bound the "limit" query
// parameter on GET /v1/messages.
const (
	defaultMessagesLimit = 50
	maxMessagesLimit     = 500
)

// messageResponse is the JSON shape of a message as returned by the API.
type messageResponse struct {
	ID          int64  `json:"id"`
	From        string `json:"from,omitempty"`
	To          string `json:"to"`
	Body        string `json:"body"`
	Status      string `json:"status"`
	Attempts    int    `json:"attempts"`
	CreatedAt   int64  `json:"created_at"`
	DeliveredAt int64  `json:"delivered_at,omitempty"`
	Reason      string `json:"reason,omitempty"`
}

func toMessageResponse(m store.Message) messageResponse {
	return messageResponse{
		ID:          m.ID,
		From:        m.FromSession,
		To:          m.ToSession,
		Body:        m.Body,
		Status:      m.Status,
		Attempts:    m.Attempts,
		CreatedAt:   m.CreatedAt,
		DeliveredAt: m.DeliveredAt,
		Reason:      m.Reason,
	}
}

// registerMessageRoutes wires the /v1/messages routes onto mux.
func registerMessageRoutes(mux *http.ServeMux, d Deps) {
	mux.HandleFunc("POST /v1/messages", func(w http.ResponseWriter, r *http.Request) {
		handlePostMessage(w, r, d)
	})
	mux.HandleFunc("GET /v1/messages", func(w http.ResponseWriter, r *http.Request) {
		handleListMessages(w, r, d)
	})
	mux.HandleFunc("GET /v1/messages/{id}", func(w http.ResponseWriter, r *http.Request) {
		handleGetMessage(w, r, d)
	})
}

type postMessageRequest struct {
	From string `json:"from"`
	To   string `json:"to"`
	Body string `json:"body"`
}

// handlePostMessage serves POST /v1/messages {from?, to, body}.
//
// Validation order: body non-empty, then "to" must reference an existing,
// non-terminal session, then "from" (if set) must reference an existing
// session. On success the message is inserted with status "queued", a
// message.queued event is published, and the recipient's delivery worker is
// woken.
func handlePostMessage(w http.ResponseWriter, r *http.Request, d Deps) {
	var req postMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
		return
	}

	if req.Body == "" {
		writeErr(w, http.StatusBadRequest, "empty_body", "body must not be empty")
		return
	}

	toSess, err := d.Store.GetSession(req.To)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if err != nil || (toSess.State != "spawning" && toSess.State != "running") {
		// No live session of that id: a registered mailbox of the name holds
		// the message until a session of that id is up and reads it.
		isBox, boxErr := d.Store.HasMailbox(req.To)
		if boxErr != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", boxErr.Error())
			return
		}
		if isBox {
			postToMailbox(w, d, req)
			return
		}
	}
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "session_not_found", "recipient session not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if toSess.State != "spawning" && toSess.State != "running" {
		writeErr(w, http.StatusConflict, "recipient_terminal", "recipient session is not active")
		return
	}

	if req.From != "" {
		if _, err := d.Store.GetSession(req.From); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				writeErr(w, http.StatusBadRequest, "from_unknown", "sender session not found")
				return
			}
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
	}

	id, err := d.Store.AddMessage(store.Message{
		FromSession: req.From,
		ToSession:   req.To,
		Body:        req.Body,
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	if d.Bus != nil {
		d.Bus.Publish("message.queued", req.To, map[string]any{
			"id":   id,
			"from": req.From,
			"to":   req.To,
		})
	}

	if d.Queue != nil {
		d.Queue.Wake(req.To)
	} else {
		slog.Warn("api: message queued with nil Queue, will not be delivered until daemon restart", "id", id, "to", req.To)
	}

	// Echo the stored body so a client can match it against the transcript.
	writeJSON(w, http.StatusCreated, map[string]any{
		"id":     id,
		"status": "queued",
		"body":   req.Body,
	})
}

// handleListMessages serves GET /v1/messages?session=<id>&limit=N: message
// history involving session (either direction), ascending.
func handleListMessages(w http.ResponseWriter, r *http.Request, d Deps) {
	q := r.URL.Query()

	sessionID := q.Get("session")
	if sessionID == "" {
		writeErr(w, http.StatusBadRequest, "missing_session", "session query parameter is required")
		return
	}

	limit := defaultMessagesLimit
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	if limit > maxMessagesLimit {
		limit = maxMessagesLimit
	}

	msgs, err := d.Store.ListMessages(sessionID, limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}

	out := make([]messageResponse, len(msgs))
	for i, m := range msgs {
		out[i] = toMessageResponse(m)
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": out})
}

// handleGetMessage serves GET /v1/messages/{id}.
func handleGetMessage(w http.ResponseWriter, r *http.Request, d Deps) {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		writeErr(w, http.StatusNotFound, "message_not_found", "message not found")
		return
	}

	m, err := d.Store.GetMessage(id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "message_not_found", "message not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, toMessageResponse(m))
}

// postToMailbox stores a message to a registered mailbox whose session is
// not live, as rocket's deliverToAgent did for an agent that was down: 202
// {"id","to","status":"inbox"} and the event mailbox.received.
func postToMailbox(w http.ResponseWriter, d Deps, req postMessageRequest) {
	if req.From != "" {
		if _, err := d.Store.GetSession(req.From); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				writeErr(w, http.StatusBadRequest, "from_unknown", "sender session not found")
				return
			}
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
	}
	id, err := d.Store.AddInboxMessage(store.InboxMessage{Mailbox: req.To, From: req.From, Body: req.Body})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if d.Bus != nil {
		d.Bus.Publish("mailbox.received", "", map[string]any{"id": id, "mailbox": req.To, "from": req.From})
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"id": id, "to": req.To, "status": "inbox"})
}
