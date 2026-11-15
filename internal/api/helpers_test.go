package api

import (
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
