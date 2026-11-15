// Package api serves hopp's HTTP+JSON API on the daemon's unix socket.
package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/IvanRoslov/hopp/internal/bus"
	"github.com/IvanRoslov/hopp/internal/config"
	"github.com/IvanRoslov/hopp/internal/monitor"
	"github.com/IvanRoslov/hopp/internal/queue"
	"github.com/IvanRoslov/hopp/internal/session"
	"github.com/IvanRoslov/hopp/internal/store"
)

// shutdownTimeout bounds the graceful shutdown of the server.
const shutdownTimeout = 5 * time.Second

// Deps are the daemon's parts the handlers use.
type Deps struct {
	Store     *store.Store
	Bus       *bus.Bus
	Cfg       *config.Config
	Manager   *session.Manager
	Shutdown  func()
	StartedAt time.Time
	// Catalogs caches each agent's model catalog; NewHandler builds one in
	// front of the real adapters when it is nil.
	Catalogs *CatalogCache
	// Monitor receives the activity the agents' hooks report.
	Monitor *monitor.Monitor
	// Queue delivers messages; its Wake is called when a message is added.
	Queue *queue.Queue
	// Usage collects token usage; nil when the daemon runs without a
	// collector (POST /v1/usage/collect then answers 503).
	Usage UsageCollector
}

// NewHandler builds the routed http.Handler for hopp's API.
func NewHandler(d Deps) http.Handler {
	if d.Catalogs == nil {
		d.Catalogs = NewCatalogCache(fetchAgentCatalog)
	}
	mux := http.NewServeMux()

	registerHealthRoutes(mux, d)
	registerSessionRoutes(mux, d)
	registerModelProfileRoutes(mux, d)
	registerModelCatalogRoutes(mux, d)
	registerEventsRoutes(mux, d)
	registerSSERoutes(mux, d)
	registerMessageRoutes(mux, d)
	registerChatRoutes(mux, d)
	registerQuizRoutes(mux, d)
	registerUsageRoutes(mux, d)
	registerInternalActivityRoutes(mux, d)
	registerInternalQuizRoutes(mux, d)

	// Any path not matched by a more specific route above is a 404,
	// rendered in the standard error JSON shape. This is a prefix pattern,
	// so it's less specific than the exact "GET /v1/health" etc. routes
	// registered above and only catches the leftovers.
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeErr(w, http.StatusNotFound, "not_found", "resource not found")
	})

	return mux
}

// Serve listens on d.Cfg.SocketPath() (a unix socket, mode 0600) and serves
// the API there; there is no TCP listener. It blocks until ctx is
// cancelled, at which point it gracefully shuts the server down, unlinks
// the socket file it created, and returns nil. If the listener fails to
// start, or the server exits with a fatal error before ctx is cancelled,
// Serve returns that error.
//
// The unix socket doubles as the singleton claim: if a live daemon is
// already answering on the socket path, Serve returns ErrSocketInUse and
// leaves everything on disk untouched. See listenUnixSingleton.
func Serve(ctx context.Context, d Deps) error {
	sockPath := d.Cfg.SocketPath()

	// The unix socket IS the singleton claim: listenUnixSingleton refuses
	// (ErrSocketInUse) when a live daemon is already answering on this path
	// and unlinks only a socket it proved dead. The pid file guard in
	// daemon.Run does not cover this, because the socket path can be set
	// independently of HOPP_HOME (--socket / $HOPP_SOCKET), so two
	// daemons with different pid files can aim at the same socket.
	unixLn, err := listenUnixSingleton(sockPath)
	if err != nil {
		return err
	}
	// From here on the socket file is ours: closing unixLn unlinks it (Go
	// unlinks unix sockets it created on Close), so no code path below may
	// os.Remove a path it merely found.

	unixSrv := &http.Server{Handler: NewHandler(d)}
	errCh := make(chan error, 1)
	go func() {
		if err := unixSrv.Serve(unixLn); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- fmt.Errorf("unix server: %w", err)
		}
	}()

	var fatalErr error
	select {
	case <-ctx.Done():
		// graceful path below
	case fatalErr = <-errCh:
		// the server died unexpectedly; still shut down cleanly.
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	_ = unixSrv.Shutdown(shutdownCtx)
	// Closing our own unix listener unlinks the socket file it created;
	// unixSrv.Shutdown above normally does it already, this is the belt to
	// that suspenders. Deliberately not an os.Remove(sockPath): by the time
	// we get here the path may already belong to a successor daemon.
	_ = unixLn.Close()

	return fatalErr
}
