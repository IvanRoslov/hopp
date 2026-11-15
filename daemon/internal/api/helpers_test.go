package api

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/IvanRoslov/hopp/internal/config"
	"github.com/IvanRoslov/hopp/internal/store"
)

// storeDeps builds Deps with a real store on a temp SQLite db and a config
// whose default agent is claude-code.
func storeDeps(t *testing.T) Deps {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "hopp.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return Deps{Store: st, Cfg: &config.Config{DefaultAgent: "claude-code", Home: t.TempDir()},
		Shutdown: func() {}, StartedAt: time.Now()}
}

// newTestServer serves NewHandler(d) on an httptest server closed with t.
func newTestServer(t *testing.T, d Deps) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(NewHandler(d))
	t.Cleanup(srv.Close)
	return srv
}

// errCode returns the error code of a decoded error body.
func errCode(body map[string]any) string {
	e, _ := body["error"].(map[string]any)
	c, _ := e["code"].(string)
	return c
}

// testDeps is rocket's minimal Deps for handler tests.
func testDeps(t *testing.T, shutdown func()) Deps {
	t.Helper()
	if shutdown == nil {
		shutdown = func() {}
	}
	return Deps{
		Cfg:       &config.Config{},
		Shutdown:  shutdown,
		StartedAt: time.Now().Add(-42 * time.Second),
	}
}

// postJSON posts payload as JSON to url.
func postJSON(t *testing.T, url string, payload any) *http.Response {
	t.Helper()
	b, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	resp, err := http.Post(url, "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatalf("POST %s: %v", url, err)
	}
	return resp
}

func bytesReader(b []byte) io.Reader {
	return bytes.NewReader(b)
}

// decodeErr decodes the error body of resp and closes it.
func decodeErr(t *testing.T, resp *http.Response) errBody {
	t.Helper()
	defer resp.Body.Close()
	var body errBody
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	return body
}

// getJSON is rocket's GET helper from its tasks_test.go (the tasks tests are
// not ported; the chat tests use the helper).
func getJSON(t *testing.T, url string) *http.Response {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	return resp
}
