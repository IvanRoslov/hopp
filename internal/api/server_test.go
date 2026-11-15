package api

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/IvanRoslov/hopp/internal/config"
	"github.com/IvanRoslov/hopp/internal/version"
)

func TestHealth(t *testing.T) {
	started := time.Unix(1700000000, 0)
	srv := httptest.NewServer(NewHandler(Deps{StartedAt: started, Shutdown: func() {}}))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/v1/health")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	var body struct {
		Status    string `json:"status"`
		Pid       int    `json:"pid"`
		Version   string `json:"version"`
		StartedAt int64  `json:"started_at"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Status != "ok" || body.Pid != os.Getpid() || body.Version != version.Version || body.StartedAt != started.Unix() {
		t.Errorf("health = %+v", body)
	}
}

func TestUnknownRouteIs404WithErrorBody(t *testing.T) {
	srv := httptest.NewServer(NewHandler(Deps{StartedAt: time.Now(), Shutdown: func() {}}))
	defer srv.Close()

	for _, path := range []string{"/v1/no-such-thing", "/elsewhere"} {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		var body errBody
		err = json.NewDecoder(resp.Body).Decode(&body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound || err != nil || body.Error.Code != "not_found" {
			t.Errorf("%s: status %d, body %+v, err %v", path, resp.StatusCode, body, err)
		}
	}
}

func TestShutdownEndpointCallsShutdown(t *testing.T) {
	called := make(chan struct{}, 1)
	srv := httptest.NewServer(NewHandler(Deps{StartedAt: time.Now(), Shutdown: func() { called <- struct{}{} }}))
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/v1/shutdown", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	select {
	case <-called:
	case <-time.After(2 * time.Second):
		t.Fatal("Shutdown was not called")
	}
}

func TestSocketFileMode0600(t *testing.T) {
	cfg := &config.Config{Home: shortDir(t)}
	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() { errCh <- Serve(ctx, Deps{Cfg: cfg, Shutdown: func() {}, StartedAt: time.Now()}) }()
	waitForSocket(t, cfg.SocketPath())

	fi, err := os.Stat(cfg.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("socket mode = %v, want 0600", fi.Mode().Perm())
	}

	client := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", cfg.SocketPath())
		},
	}}
	resp, err := client.Get("http://hopp/v1/health")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()

	cancel()
	if err := <-errCh; err != nil {
		t.Fatalf("Serve returned %v", err)
	}
	if _, err := os.Stat(cfg.SocketPath()); !os.IsNotExist(err) {
		t.Errorf("socket file left after shutdown: %v", err)
	}
}
