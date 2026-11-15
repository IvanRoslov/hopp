package api

import (
	"net/http"
	"os"

	"github.com/IvanRoslov/hopp/internal/version"
)

// registerHealthRoutes serves GET /v1/health and POST /v1/shutdown.
func registerHealthRoutes(mux *http.ServeMux, d Deps) {
	mux.HandleFunc("GET /v1/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"status":     "ok",
			"pid":        os.Getpid(),
			"version":    version.Version,
			"started_at": d.StartedAt.Unix(),
		})
	})

	mux.HandleFunc("POST /v1/shutdown", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{
			"status": "shutting_down",
		})
		// Run asynchronously so the response above has a chance to flush
		// before the server (and process) starts shutting down.
		go d.Shutdown()
	})
}
