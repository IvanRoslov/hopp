package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"

	"github.com/IvanRoslov/hopp/internal/artifacts"
	"github.com/IvanRoslov/hopp/internal/store"
)

// artifactResponse is the JSON shape of an artifact version.
type artifactResponse struct {
	ID        int64             `json:"id"`
	Scope     string            `json:"scope"`
	Name      string            `json:"name"`
	Version   int64             `json:"version"`
	Filename  string            `json:"filename"`
	Mime      string            `json:"mime"`
	Size      int64             `json:"size"`
	SHA256    string            `json:"sha256"`
	Path      string            `json:"path"`
	From      string            `json:"from"`
	Labels    map[string]string `json:"labels"`
	CreatedAt int64             `json:"created_at"`
	Unchanged bool              `json:"unchanged,omitempty"`
}

func toArtifactResponse(a store.ArtifactVersion) artifactResponse {
	return artifactResponse{ID: a.ID, Scope: a.Scope, Name: a.Name, Version: a.Version, Filename: a.Filename, Mime: a.Mime,
		Size: a.Size, SHA256: a.SHA256, Path: a.Path, From: a.FromSession, Labels: a.Labels, CreatedAt: a.CreatedAt}
}

// artifactsDir is where the daemon keeps artifact files:
// <home>/artifacts/<scope>/<name>/v<n>/<filename>, with an incoming area in
// <home>/artifacts/.incoming (no scope starts with a dot).
func artifactsDir(d Deps) string {
	return filepath.Join(d.Cfg.Home, "artifacts")
}

// registerArtifactRoutes serves artifacts: named files the daemon keeps in
// immutable versions, per scope.
func registerArtifactRoutes(mux *http.ServeMux, d Deps) {
	mux.HandleFunc("POST /v1/artifacts", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			From   string            `json:"from"`
			Scope  string            `json:"scope"`
			Name   string            `json:"name"`
			Path   string            `json:"path"`
			Labels map[string]string `json:"labels"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
			return
		}
		if !artifacts.ValidName(req.Name) {
			writeErr(w, http.StatusBadRequest, "invalid_name",
				fmt.Sprintf("name must match ^[a-z0-9][a-z0-9._-]*$ and have at most %d characters, got %q", artifacts.MaxNameLen, req.Name))
			return
		}
		labels, err := writerLabels(d, req.From, req.Labels)
		if errors.Is(err, errFromUnknown) {
			writeErr(w, http.StatusBadRequest, "from_unknown", "from session not found: "+req.From)
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		scope := req.Scope
		if scope == "" && req.From == "" {
			writeErr(w, http.StatusBadRequest, "scope_required", "scope is required without a from session")
			return
		}
		if scope == "" {
			if scope, err = d.Store.RootSession(req.From); err != nil {
				writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
				return
			}
		}
		if !artifacts.ValidScope(scope) {
			writeErr(w, http.StatusBadRequest, "invalid_scope", fmt.Sprintf("scope must match ^[a-z0-9-][a-z0-9._-]*$, got %q", scope))
			return
		}
		root := artifactsDir(d)
		copied, err := artifacts.Ingest(req.Path, filepath.Join(root, ".incoming"))
		switch {
		case errors.Is(err, artifacts.ErrNotAbsolute):
			writeErr(w, http.StatusBadRequest, "path_not_absolute", fmt.Sprintf("path must be absolute, got %q", req.Path))
			return
		case errors.Is(err, artifacts.ErrNotFound):
			writeErr(w, http.StatusBadRequest, "file_not_found", "no file at "+req.Path)
			return
		case errors.Is(err, artifacts.ErrNotRegular):
			writeErr(w, http.StatusBadRequest, "not_regular_file", req.Path+" is not a regular file")
			return
		case errors.Is(err, os.ErrPermission):
			writeErr(w, http.StatusBadRequest, "file_unreadable", "the daemon may not read "+req.Path)
			return
		case err != nil:
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		// Whatever happens below, nothing stays in the incoming area: placing
		// renames the file away, and Discard removes what is left.
		defer copied.Discard()
		place := func(version int64) (string, func(), error) {
			dir := filepath.Join(root, scope, req.Name, "v"+strconv.FormatInt(version, 10))
			// A directory for a version with no row is left from a publish
			// that died before its commit; it holds nothing anyone can see.
			if err := os.RemoveAll(dir); err != nil {
				return "", nil, err
			}
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return "", nil, err
			}
			undo := func() { os.RemoveAll(dir) }
			final := filepath.Join(dir, copied.Filename)
			if err := os.Rename(copied.Path, final); err != nil {
				undo()
				return "", nil, err
			}
			if err := os.Chmod(final, 0o444); err != nil {
				undo()
				return "", nil, err
			}
			return final, undo, nil
		}
		a, unchanged, err := d.Store.PublishArtifact(store.ArtifactVersion{Scope: scope, Name: req.Name, Filename: copied.Filename,
			Mime: copied.Mime, Size: copied.Size, SHA256: copied.SHA256, FromSession: req.From, Labels: labels}, place)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		resp := toArtifactResponse(a)
		if unchanged {
			resp.Unchanged = true
			writeJSON(w, http.StatusOK, resp)
			return
		}
		if d.Bus != nil {
			d.Bus.Publish("artifact.published", a.FromSession, map[string]any{"id": a.ID, "scope": a.Scope, "name": a.Name,
				"version": a.Version, "artifact_labels": a.Labels})
		}
		writeJSON(w, http.StatusCreated, resp)
	})

	mux.HandleFunc("GET /v1/artifacts", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		labels, ok := parseLabelFilter(q["label"])
		if !ok {
			writeErr(w, http.StatusBadRequest, "bad_request", "label wants k=v")
			return
		}
		list, err := d.Store.ListArtifacts(store.ArtifactFilter{Scope: q.Get("scope"), Name: q.Get("name"), Labels: labels,
			AllVersions: q.Get("versions") == "1"})
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		out := make([]artifactResponse, 0, len(list))
		for _, a := range list {
			out = append(out, toArtifactResponse(a))
		}
		writeJSON(w, http.StatusOK, map[string]any{"artifacts": out})
	})

	mux.HandleFunc("GET /v1/artifacts/{id}", func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		var a store.ArtifactVersion
		if err == nil {
			a, err = d.Store.GetArtifact(id)
		} else {
			err = store.ErrNotFound
		}
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "artifact_not_found", "artifact not found: "+r.PathValue("id"))
			return
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, toArtifactResponse(a))
	})
}
