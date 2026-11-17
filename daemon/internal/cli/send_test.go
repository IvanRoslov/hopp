package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/IvanRoslov/hopp/internal/client"
	"github.com/spf13/cobra"
)

// containsSubstring checks if haystack contains needle as a substring.
func containsSubstring(haystack, needle string) bool {
	for i := 0; i <= len(haystack)-len(needle); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}

// TestSendUsageErrors verifies that every way of violating `send`'s
// argument shape (missing body, too few/many args, or both a positional
// body and --file) is reported as a usage error (exit code 3), and — the
// finding this guards against — that `hopp send <session>` with neither
// text nor --file is included (previously this exited 1).
func TestSendUsageErrors(t *testing.T) {
	tmpDir := t.TempDir()
	testFile := filepath.Join(tmpDir, "test.txt")
	if err := os.WriteFile(testFile, []byte("file content"), 0644); err != nil {
		t.Fatalf("write test file: %v", err)
	}

	cases := []struct {
		name string
		args []string
	}{
		{"no args", []string{}},
		{"no text, no file", []string{"my-session"}},
		{"too many args", []string{"my-session", "text", "extra"}},
		{"both text and --file", []string{"my-session", "text", "--file", testFile}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cmd := newSendCmd()
			cmd.SilenceUsage = true
			cmd.SetArgs(tc.args)
			err := cmd.Execute()
			if err == nil {
				t.Fatal("expected error, got nil")
			}
			if exitCode(err) != 3 {
				t.Fatalf("exitCode = %d, want 3 (err=%v)", exitCode(err), err)
			}
		})
	}
}

// newUnixSocketTestServer starts an http.Server listening on a fresh unix
// socket at a short path (avoiding sun_path length limits that t.TempDir()
// can exceed) and returns a *client.Client bound to it plus a cleanup func.
func newUnixSocketTestServer(t *testing.T, handler http.Handler) *client.Client {
	t.Helper()

	sockPath := filepath.Join(os.TempDir(), fmt.Sprintf("hopp-send-test-%d.sock", time.Now().UnixNano()))
	t.Cleanup(func() { os.Remove(sockPath) })

	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatalf("listen unix %s: %v", sockPath, err)
	}

	srv := &http.Server{Handler: handler}
	go srv.Serve(ln)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	})

	return client.New(sockPath)
}

// TestWaitForMessageDeliveringThenDelivered scripts a
// queued -> delivering -> delivered sequence and asserts waitForMessage
// returns nil once "delivered" is reached, without erroring on the
// intermediate "delivering" status (the bug this guards against: the old
// switch had no case for "delivering" and fell into `default`, which
// errored).
func TestWaitForMessageDeliveringThenDelivered(t *testing.T) {
	restore := setPollIntervalForTest(t, 10*time.Millisecond)
	defer restore()

	statuses := []string{"queued", "delivering", "delivered"}
	var seq int32

	mux := http.NewServeMux()
	mux.HandleFunc("/v1/messages/42", func(w http.ResponseWriter, r *http.Request) {
		i := atomic.AddInt32(&seq, 1) - 1
		status := statuses[len(statuses)-1]
		if int(i) < len(statuses) {
			status = statuses[i]
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(msgResp{ID: 42, Status: status})
	})

	c := newUnixSocketTestServer(t, mux)

	cmd := &cobra.Command{}
	if err := waitForMessage(cmd, c, 42); err != nil {
		t.Fatalf("waitForMessage: unexpected error: %v", err)
	}
	if got := atomic.LoadInt32(&seq); got < int32(len(statuses)) {
		t.Fatalf("server only polled %d times, expected at least %d (delivering must not short-circuit the loop)", got, len(statuses))
	}
}

// TestWaitForMessageFailed asserts a "failed" status is reported as an
// error, and that the failure reason returned by the server is printed in
// the CLI's stderr output.
func TestWaitForMessageFailed(t *testing.T) {
	restore := setPollIntervalForTest(t, 10*time.Millisecond)
	defer restore()

	mux := http.NewServeMux()
	mux.HandleFunc("/v1/messages/7", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(msgResp{ID: 7, Status: "failed", Reason: "recipient gone"})
	})

	c := newUnixSocketTestServer(t, mux)

	cmd := &cobra.Command{}
	var errBuf bytes.Buffer
	cmd.SetErr(&errBuf)

	err := waitForMessage(cmd, c, 7)
	if err == nil {
		t.Fatal("expected error for failed status, got nil")
	}

	if !strings.Contains(errBuf.String(), "recipient gone") {
		t.Errorf("stderr output = %q, want it to contain the failure reason %q", errBuf.String(), "recipient gone")
	}
}

// setPollIntervalForTest overrides the package-level pollInterval for the
// duration of a test and returns a func to restore it.
func setPollIntervalForTest(t *testing.T, d time.Duration) func() {
	t.Helper()
	old := pollInterval
	pollInterval = d
	return func() { pollInterval = old }
}

// TestWaitForMessageAcceptedPrintedOnce: "accepted" (pasted into a Codex
// recipient, journal confirmation pending) is an intermediate status: it is
// announced once on stdout and polling continues until "delivered".
func TestWaitForMessageAcceptedPrintedOnce(t *testing.T) {
	restore := setPollIntervalForTest(t, 10*time.Millisecond)
	defer restore()

	statuses := []string{"delivering", "accepted", "accepted", "accepted", "delivered"}
	var seq int32
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/messages/9", func(w http.ResponseWriter, r *http.Request) {
		i := atomic.AddInt32(&seq, 1) - 1
		status := statuses[len(statuses)-1]
		if int(i) < len(statuses) {
			status = statuses[i]
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(msgResp{ID: 9, Status: status})
	})
	c := newUnixSocketTestServer(t, mux)

	cmd := &cobra.Command{}
	var out, errBuf bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&errBuf)
	if err := waitForMessage(cmd, c, 9); err != nil {
		t.Fatalf("waitForMessage: %v", err)
	}
	if n := strings.Count(out.String(), "message 9 accepted"); n != 1 {
		t.Fatalf("accepted announced %d times, want 1; stdout=%q", n, out.String())
	}
	if !strings.HasSuffix(strings.TrimSpace(out.String()), "message 9 delivered") {
		t.Fatalf("stdout = %q, want to end with the delivered line", out.String())
	}
	if strings.Contains(errBuf.String(), "unrecognized status") {
		t.Fatalf("accepted treated as unknown: %q", errBuf.String())
	}
}

func TestOrdinaryWaitOutputContract(t *testing.T) {
	restore := setPollIntervalForTest(t, time.Millisecond)
	defer restore()
	oldJSON := flags.JSON
	defer func() { flags.JSON = oldJSON }()
	for _, asJSON := range []bool{false, true} {
		flags.JSON = asJSON
		c := newUnixSocketTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"id":42,"to":"worker","status":"delivered","attempts":1}`))
		}))
		cmd := &cobra.Command{}
		var out bytes.Buffer
		cmd.SetOut(&out)
		if err := waitForMessage(cmd, c, 42); err != nil {
			t.Fatal(err)
		}
		if asJSON {
			var result map[string]any
			if err := json.Unmarshal(out.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if len(result) != 3 || result["id"] != float64(42) || result["status"] != "delivered" || result["attempts"] != float64(1) {
				t.Fatalf("ordinary JSON changed: %s", out.String())
			}
		} else if out.String() != "message 42 delivered\n" {
			t.Fatalf("ordinary output changed: %q", out.String())
		}
	}
}

// TestWaitForMessagePrintsWaitReasonOnce: while the message is queued with a
// wait reason, --wait names it once per change.
func TestWaitForMessagePrintsWaitReasonOnce(t *testing.T) {
	restore := setPollIntervalForTest(t, 5*time.Millisecond)
	defer restore()
	steps := []msgResp{
		{ID: 3, Status: "queued"},
		{ID: 3, Status: "queued", Reason: "claude_prepare:no_socket"},
		{ID: 3, Status: "queued", Reason: "claude_prepare:no_socket"},
		{ID: 3, Status: "queued", Reason: "claude_binding_changed"},
		{ID: 3, Status: "delivering"},
		{ID: 3, Status: "delivered"},
	}
	var seq int32
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/messages/3", func(w http.ResponseWriter, r *http.Request) {
		i := int(atomic.AddInt32(&seq, 1) - 1)
		if i >= len(steps) {
			i = len(steps) - 1
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(steps[i])
	})
	c := newUnixSocketTestServer(t, mux)
	cmd := &cobra.Command{}
	var out, errBuf bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&errBuf)
	if err := waitForMessage(cmd, c, 3); err != nil {
		t.Fatalf("waitForMessage: %v", err)
	}
	want := "message 3 waiting: claude_prepare:no_socket\nmessage 3 waiting: claude_binding_changed\nmessage 3 delivered\n"
	if out.String() != want {
		t.Fatalf("stdout = %q, want %q", out.String(), want)
	}
}
