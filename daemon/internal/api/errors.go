package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/IvanRoslov/hopp/internal/session"
)

// errBody is the JSON shape for error responses: {"error":{"code":"...","message":"..."}}.
type errBody struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// writeErr writes a JSON error response with the given HTTP status, machine
// code, and human-readable message.
func writeErr(w http.ResponseWriter, status int, code, msg string) {
	var body errBody
	body.Error.Code = code
	body.Error.Message = msg
	writeJSON(w, status, body)
}

// writeJSON writes v as a JSON response body with the given HTTP status.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// apiError is a request-shaped failure raised inside the api package (bad
// input, an unknown or disabled profile), carrying its HTTP status.
type apiError struct {
	status int
	code   string
	msg    string
}

func (e *apiError) Error() string { return e.code + ": " + e.msg }

func newAPIError(status int, code, msg string) *apiError {
	return &apiError{status: status, code: code, msg: msg}
}

func asAPIError(err error, target **apiError) bool {
	return errors.As(err, target)
}

// writeManagerErr writes err as an API error: an apiError with its own
// status, a session.ValidationError mapped by code (400 by default; 404 for
// the not-found codes; 409 for a taken id), anything else as 500.
func writeManagerErr(w http.ResponseWriter, err error) {
	var ae *apiError
	if errors.As(err, &ae) {
		writeErr(w, ae.status, ae.code, ae.msg)
		return
	}
	var verr *session.ValidationError
	if errors.As(err, &verr) {
		status := http.StatusBadRequest
		switch verr.Code {
		case "session_not_found", "parent_not_found", "profile_not_found":
			status = http.StatusNotFound
		case "session_exists", "no_pending_quiz", "quiz_answer_in_flight", "prompt_changed",
			"session_live", "session_has_children", "session_delivery_pending":
			status = http.StatusConflict
		}
		writeErr(w, status, verr.Code, verr.Message)
		return
	}
	writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
}
