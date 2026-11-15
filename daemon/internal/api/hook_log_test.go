package api

import (
	"bytes"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"testing"
)

// syncBuffer is a bytes.Buffer safe for the server goroutine and the test.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// captureLog sends slog's default logger to a buffer at Debug level for the
// test.
func captureLog(t *testing.T) *syncBuffer {
	t.Helper()
	buf := &syncBuffer{}
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return buf
}

func postRaw(t *testing.T, url, body string) {
	t.Helper()
	resp, err := http.Post(url, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
}

// Every activity hook post logs one line with its outcome; a rejection
// names its reason at Info, and no message body is logged.
func TestActivityHookPostLogsOutcome(t *testing.T) {
	claude := `"claude":{"session_id":"u","hook_event_name":"Stop","launch_generation":"g","producer_pid":4242,"producer_start":"2026-11-15T10:00:00Z","at":1794700000000000000}`
	for _, tc := range []struct {
		name, body, level, reason string
		noMonitor                 bool
	}{
		{"bad body", `{"session":`, "INFO", "reason=\"bad body\"", false},
		{"invalid state", `{"session":"sess1","state":"sleepy"}`, "INFO", "reason=\"invalid state\"", false},
		{"unknown session", `{"session":"nobody","state":"ready"}`, "INFO", "reason=\"unknown session\"", false},
		{"monitor unavailable", `{"session":"sess1","state":"ready"}`, "INFO", "reason=\"monitor unavailable\"", true},
		{"claude rejected", `{"session":"sess1","state":"ready",` + claude + `}`, "INFO", "reason=\"not a Claude session\"", false},
		{"plain accepted", `{"session":"sess1","state":"ready"}`, "DEBUG", "hook accepted", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := activityTestDeps(t)
			if tc.noMonitor {
				d.Monitor = nil
			}
			seedActivitySession(t, d.Store, "sess1")
			srv := newTestServer(t, d)
			buf := captureLog(t)
			postRaw(t, srv.URL+"/v1/internal/activity", tc.body)
			out := buf.String()
			if strings.Count(out, "msg=\"hook ") != 1 {
				t.Fatalf("want exactly one hook line, got:\n%s", out)
			}
			if !strings.Contains(out, "level="+tc.level) || !strings.Contains(out, tc.reason) || !strings.Contains(out, "route=activity") {
				t.Fatalf("log = %q, want level %s and %s", out, tc.level, tc.reason)
			}
		})
	}
}

func TestQuizHookPostLogsOutcome(t *testing.T) {
	for _, tc := range []struct {
		name, body, level, reason string
	}{
		{"bad body", `{"session":`, "INFO", "reason=\"bad body\""},
		{"invalid phase", `{"session":"sess1","phase":"later","payload":{}}`, "INFO", "reason=\"invalid phase\""},
		{"unknown session", `{"session":"nobody","phase":"resolved","payload":{}}`, "INFO", "reason=\"unknown session\""},
		{"no tool_input", `{"session":"sess1","phase":"pending","payload":{"x":1}}`, "INFO", "reason=\"payload missing tool_input\""},
		{"no questions", `{"session":"sess1","phase":"pending","payload":{"tool_input":{"x":1}}}`, "INFO", "reason=\"tool_input missing questions\""},
		{"pending accepted", `{"session":"sess1","phase":"pending","payload":` + quizPendingPayload + `}`, "DEBUG", "hook accepted"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := quizTestDeps(t)
			seedActivitySession(t, d.Store, "sess1")
			srv := newTestServer(t, d)
			buf := captureLog(t)
			postRaw(t, srv.URL+"/v1/internal/quiz", tc.body)
			out := buf.String()
			if strings.Count(out, "msg=\"hook ") != 1 {
				t.Fatalf("want exactly one hook line, got:\n%s", out)
			}
			if !strings.Contains(out, "level="+tc.level) || !strings.Contains(out, tc.reason) || !strings.Contains(out, "route=quiz") {
				t.Fatalf("log = %q, want level %s and %s", out, tc.level, tc.reason)
			}
			if strings.Contains(out, "Tea") || strings.Contains(out, "question") && tc.level == "DEBUG" && strings.Contains(out, "options") {
				t.Fatalf("log carries the quiz body: %s", out)
			}
		})
	}
}
