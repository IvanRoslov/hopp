package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/IvanRoslov/hopp/internal/store"
)

// askResponse is the JSON shape of an ask.
type askResponse struct {
	ID          int64             `json:"id"`
	From        string            `json:"from"`
	Labels      map[string]string `json:"labels"`
	Body        string            `json:"body"`
	Options     []string          `json:"options"`
	Attachments []string          `json:"attachments"`
	Status      string            `json:"status"`
	Choice      string            `json:"choice,omitempty"`
	Answer      string            `json:"answer,omitempty"`
	Reason      string            `json:"reason,omitempty"`
	CreatedAt   int64             `json:"created_at"`
	ClosedAt    int64             `json:"closed_at,omitempty"`
}

func toAskResponse(a store.Ask) askResponse {
	return askResponse{ID: a.ID, From: a.FromSession, Labels: a.Labels, Body: a.Body, Options: a.Options, Attachments: a.Attachments,
		Status: a.Status, Choice: a.Choice, Answer: a.Answer, Reason: a.Reason, CreatedAt: a.CreatedAt, ClosedAt: a.ClosedAt}
}

// publishAsk publishes an ask event under the asking session (so the bus adds
// that session's labels), with the ask's own labels under ask_labels.
func publishAsk(d Deps, typ string, a store.Ask) {
	if d.Bus == nil {
		return
	}
	data := map[string]any{"id": a.ID, "ask_labels": a.Labels}
	if a.Reason != "" {
		data["reason"] = a.Reason
	}
	d.Bus.Publish(typ, a.FromSession, data)
}

func registerAskRoutes(mux *http.ServeMux, d Deps) {
	mux.HandleFunc("POST /v1/asks", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			From        string            `json:"from"`
			Body        string            `json:"body"`
			Options     []string          `json:"options"`
			Labels      map[string]string `json:"labels"`
			Attachments []string          `json:"attachments"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}
		if strings.TrimSpace(req.Body) == "" {
			writeErr(w, http.StatusBadRequest, "empty_body", "body must not be empty")
			return
		}
		for _, o := range req.Options {
			if strings.TrimSpace(o) == "" {
				writeErr(w, http.StatusBadRequest, "bad_request", "an option must not be empty")
				return
			}
		}
		if req.From != "" {
			sess, err := d.Store.GetSession(req.From)
			if err != nil {
				if errors.Is(err, store.ErrNotFound) {
					writeErr(w, http.StatusBadRequest, "from_unknown", "asking session not found")
					return
				}
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
			if sess.State != "spawning" && sess.State != "running" {
				writeErr(w, http.StatusConflict, "from_terminal", "asking session has ended")
				return
			}
		}
		labels, err := writerLabels(d, req.From, req.Labels)
		if errors.Is(err, errFromUnknown) {
			writeErr(w, http.StatusBadRequest, "from_unknown", "asking session not found")
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		id, err := d.Store.AddAsk(store.Ask{FromSession: req.From, Labels: labels, Body: req.Body, Options: req.Options, Attachments: req.Attachments})
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		a, err := d.Store.GetAsk(id)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		publishAsk(d, "ask.created", a)
		writeJSON(w, http.StatusCreated, toAskResponse(a))
	})

	mux.HandleFunc("GET /v1/asks", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		f := store.AskFilter{Status: q.Get("status"), From: q.Get("from")}
		switch f.Status {
		case "":
			f.Status = store.AskOpen
		case "all":
			f.Status = ""
		case store.AskOpen, store.AskAnswered, store.AskWithdrawn:
		default:
			writeErr(w, http.StatusBadRequest, "invalid_status", "status must be open, answered, withdrawn or all")
			return
		}
		labels, ok := parseLabelFilter(q["label"])
		if !ok {
			writeErr(w, http.StatusBadRequest, "bad_request", "label wants k=v")
			return
		}
		f.Labels = labels
		asks, err := d.Store.ListAsks(f)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"asks": askList(asks)})
	})

	mux.HandleFunc("GET /v1/asks/{id}", func(w http.ResponseWriter, r *http.Request) {
		a, ok := lookupAsk(w, r, d)
		if ok {
			writeJSON(w, http.StatusOK, toAskResponse(a))
		}
	})

	mux.HandleFunc("POST /v1/asks/{id}/answer", func(w http.ResponseWriter, r *http.Request) {
		a, ok := lookupAsk(w, r, d)
		if !ok {
			return
		}
		var req struct {
			Choice string `json:"choice"`
			Answer string `json:"answer"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}
		a, err := d.Store.AnswerAsk(a.ID, req.Choice, req.Answer, time.Now().Unix())
		if !writeAskErr(w, err) {
			return
		}
		publishAsk(d, "ask.answered", a)
		if err := sendAnswerToAsker(d, a); err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", "answer stored, but not sent to the asker: "+err.Error())
			return
		}
		writeJSON(w, http.StatusOK, toAskResponse(a))
	})

	mux.HandleFunc("POST /v1/asks/{id}/withdraw", func(w http.ResponseWriter, r *http.Request) {
		a, ok := lookupAsk(w, r, d)
		if !ok {
			return
		}
		var req struct {
			From   string `json:"from"`
			Reason string `json:"reason"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}
		if a.FromSession != "" && req.From != a.FromSession {
			writeErr(w, http.StatusForbidden, "not_asker", "only the asking session may withdraw this ask")
			return
		}
		if req.Reason == "" {
			req.Reason = "withdrawn"
		}
		a, err := d.Store.WithdrawAsk(a.ID, req.Reason, time.Now().Unix())
		if !writeAskErr(w, err) {
			return
		}
		publishAsk(d, "ask.withdrawn", a)
		writeJSON(w, http.StatusOK, toAskResponse(a))
	})

	// GET /v1/waiting is everything that waits for the human: the open asks
	// and every live session's pending harness question.
	mux.HandleFunc("GET /v1/waiting", func(w http.ResponseWriter, r *http.Request) {
		asks, err := d.Store.ListAsks(store.AskFilter{Status: store.AskOpen})
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		live, err := d.Store.ListSessions(store.SessionFilter{})
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		questions := []map[string]any{}
		for _, s := range live {
			if q := parseQuizResponse(s.PendingQuiz); q != nil {
				questions = append(questions, map[string]any{"session": s.ID, "question": q})
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"asks": askList(asks), "questions": questions})
	})
}

func askList(asks []store.Ask) []askResponse {
	out := make([]askResponse, 0, len(asks))
	for _, a := range asks {
		out = append(out, toAskResponse(a))
	}
	return out
}

func lookupAsk(w http.ResponseWriter, r *http.Request, d Deps) (store.Ask, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusNotFound, "ask_not_found", "ask not found")
		return store.Ask{}, false
	}
	a, err := d.Store.GetAsk(id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "ask_not_found", "ask not found")
			return store.Ask{}, false
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return store.Ask{}, false
	}
	return a, true
}

// writeAskErr answers a store error of AnswerAsk/WithdrawAsk and reports
// whether there was none.
func writeAskErr(w http.ResponseWriter, err error) bool {
	switch {
	case err == nil:
		return true
	case errors.Is(err, store.ErrAskClosed):
		writeErr(w, http.StatusConflict, "ask_closed", "the ask is no longer open")
	case errors.Is(err, store.ErrAskInvalid):
		writeErr(w, http.StatusBadRequest, "ask_invalid", err.Error())
	case errors.Is(err, store.ErrNotFound):
		writeErr(w, http.StatusNotFound, "ask_not_found", "ask not found")
	default:
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
	}
	return false
}

// sendAnswerToAsker routes the answer to the asking session exactly as a
// message to that name: a live session gets one system message through the
// queue, a registered mailbox without a live session holds it, and an ended
// session without a mailbox gets nothing (the answer stays stored).
func sendAnswerToAsker(d Deps, a store.Ask) error {
	if a.FromSession == "" {
		return nil
	}
	body := fmt.Sprintf("[hopp] Answer to ask #%d: ", a.ID)
	switch {
	case a.Choice != "" && a.Answer != "":
		body += a.Choice + "\n" + a.Answer
	case a.Choice != "":
		body += a.Choice
	default:
		body += a.Answer
	}
	sess, err := d.Store.GetSession(a.FromSession)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	if err == nil && (sess.State == "spawning" || sess.State == "running") {
		id, err := d.Store.AddMessage(store.Message{ToSession: a.FromSession, Body: body})
		if err != nil {
			return err
		}
		if d.Bus != nil {
			d.Bus.Publish("message.queued", a.FromSession, map[string]any{"id": id, "from": "", "to": a.FromSession})
		}
		if d.Queue != nil {
			d.Queue.Wake(a.FromSession)
		}
		return nil
	}
	isBox, err := d.Store.HasMailbox(a.FromSession)
	if err != nil || !isBox {
		return err
	}
	id, err := d.Store.AddInboxMessage(store.InboxMessage{Mailbox: a.FromSession, Body: body})
	if err != nil {
		return err
	}
	if d.Bus != nil {
		d.Bus.Publish("mailbox.received", "", map[string]any{"id": id, "mailbox": a.FromSession, "from": ""})
	}
	return nil
}
