package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"slices"
	"strings"

	"github.com/IvanRoslov/hopp/internal/agent"
	"github.com/IvanRoslov/hopp/internal/store"
)

// profileNameRe is the model profile name format.
var profileNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,39}$`)

// modelProfileResponse is a registry entry as GET/POST/PATCH
// /v1/model-profiles return it.
type modelProfileResponse struct {
	Name        string `json:"name"`
	Agent       string `json:"agent"`
	Model       string `json:"model"`
	Effort      string `json:"effort"`
	Description string `json:"description"`
	Enabled     bool   `json:"enabled"`
	Position    int    `json:"position"`
}

func toModelProfileResponse(p store.ModelProfile) modelProfileResponse {
	return modelProfileResponse{Name: p.Name, Agent: p.Agent, Model: p.Model, Effort: p.Effort,
		Description: p.Description, Enabled: p.Enabled, Position: p.Position}
}

// registerModelProfileRoutes wires the /v1/model-profiles routes onto mux.
func registerModelProfileRoutes(mux *http.ServeMux, d Deps) {
	mux.HandleFunc("GET /v1/model-profiles", func(w http.ResponseWriter, r *http.Request) {
		handleListModelProfiles(w, d)
	})
	mux.HandleFunc("POST /v1/model-profiles", func(w http.ResponseWriter, r *http.Request) {
		handlePostModelProfile(w, r, d)
	})
	mux.HandleFunc("PATCH /v1/model-profiles/{name}", func(w http.ResponseWriter, r *http.Request) {
		handlePatchModelProfile(w, r, d)
	})
	mux.HandleFunc("DELETE /v1/model-profiles/{name}", func(w http.ResponseWriter, r *http.Request) {
		handleDeleteModelProfile(w, r, d)
	})
	mux.HandleFunc("PUT /v1/model-profiles/default", func(w http.ResponseWriter, r *http.Request) {
		handlePutDefaultProfile(w, r, d)
	})
}

func handleListModelProfiles(w http.ResponseWriter, d Deps) {
	ps, err := d.Store.ListModelProfiles()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	out := make([]modelProfileResponse, 0, len(ps))
	for _, p := range ps {
		out = append(out, toModelProfileResponse(p))
	}
	def, err := optionalSetting(d.Store, store.SettingDefaultProfile)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"profiles": out, "default": def})
}

// optionalSetting reads key, mapping "unset" to "".
func optionalSetting(st *store.Store, key string) (string, error) {
	v, err := st.GetSetting(key)
	if errors.Is(err, store.ErrNotFound) {
		return "", nil
	}
	return v, err
}

// modelProfileRequest is the POST/PATCH body; nil fields are absent (PATCH
// leaves them unchanged, POST uses defaults).
type modelProfileRequest struct {
	Name        *string `json:"name"`
	Agent       *string `json:"agent"`
	Model       *string `json:"model"`
	Effort      *string `json:"effort"`
	Description *string `json:"description"`
	Enabled     *bool   `json:"enabled"`
	Position    *int    `json:"position"`
}

// apply overlays the present fields of req onto p.
func (req modelProfileRequest) apply(p *store.ModelProfile) {
	if req.Agent != nil {
		p.Agent = *req.Agent
	}
	if req.Model != nil {
		p.Model = *req.Model
	}
	if req.Effort != nil {
		p.Effort = *req.Effort
	}
	if req.Description != nil {
		p.Description = *req.Description
	}
	if req.Enabled != nil {
		p.Enabled = *req.Enabled
	}
	if req.Position != nil {
		p.Position = *req.Position
	}
}

// validateProfileAgent checks that p's agent is registered and its effort
// fits its model: a model found in the agent's catalog allows exactly its
// own levels (none when it has no effort knob); any other model — an alias
// like "opus", a custom id, or none — allows the agent's Efforts(). The
// catalog is consulted only when both model and effort are set. Returns
// true if it wrote a response.
func validateProfileAgent(w http.ResponseWriter, r *http.Request, d Deps, p store.ModelProfile) bool {
	ag, err := agent.Get(p.Agent)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "agent_unavailable", "unknown agent "+p.Agent)
		return true
	}
	if p.Effort == "" {
		return false
	}
	if p.Model != "" {
		for _, m := range d.Catalogs.Get(r.Context(), p.Agent, false).Models {
			if m.ID != p.Model {
				continue
			}
			if len(m.Efforts) == 0 {
				writeErr(w, http.StatusBadRequest, "bad_effort",
					"model "+p.Model+" has no effort setting; leave effort empty")
				return true
			}
			if !slices.Contains(m.Efforts, p.Effort) {
				writeErr(w, http.StatusBadRequest, "bad_effort",
					"effort "+p.Effort+" is not one of model "+p.Model+"'s: "+strings.Join(m.Efforts, ", "))
				return true
			}
			return false
		}
	}
	if !slices.Contains(ag.Efforts(), p.Effort) {
		writeErr(w, http.StatusBadRequest, "bad_effort",
			"effort "+p.Effort+" is not one of "+p.Agent+"'s: "+strings.Join(ag.Efforts(), ", "))
		return true
	}
	return false
}

func handlePostModelProfile(w http.ResponseWriter, r *http.Request, d Deps) {
	var req modelProfileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
		return
	}
	if req.Name == nil || !profileNameRe.MatchString(*req.Name) {
		writeErr(w, http.StatusBadRequest, "bad_request",
			"name must match "+profileNameRe.String())
		return
	}
	p := store.ModelProfile{Name: *req.Name, Enabled: true}
	if req.Position == nil {
		existing, err := d.Store.ListModelProfiles()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
			return
		}
		for _, e := range existing {
			p.Position = max(p.Position, e.Position+1)
		}
	}
	req.apply(&p)
	if validateProfileAgent(w, r, d, p) {
		return
	}
	if err := d.Store.CreateModelProfile(p); err != nil {
		if errors.Is(err, store.ErrExists) {
			writeErr(w, http.StatusConflict, "profile_exists", "profile "+p.Name+" already exists")
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, toModelProfileResponse(p))
}

func handlePatchModelProfile(w http.ResponseWriter, r *http.Request, d Deps) {
	name := r.PathValue("name")
	p, err := d.Store.GetModelProfile(name)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "profile_not_found", "no profile "+name)
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	var req modelProfileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
		return
	}
	if req.Name != nil && *req.Name != name {
		writeErr(w, http.StatusBadRequest, "bad_request", "a profile cannot be renamed")
		return
	}
	req.apply(&p)
	// Only a change to what launches is re-validated: toggling, moving or
	// re-describing a profile must work even if its effort predates the
	// current catalog (a v1 profile, or a level the agent since dropped).
	if req.Agent != nil || req.Model != nil || req.Effort != nil {
		if validateProfileAgent(w, r, d, p) {
			return
		}
	}
	if err := d.Store.UpdateModelProfile(p); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, toModelProfileResponse(p))
}

func handleDeleteModelProfile(w http.ResponseWriter, r *http.Request, d Deps) {
	name := r.PathValue("name")
	if err := d.Store.DeleteModelProfile(name); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "profile_not_found", "no profile "+name)
			return
		}
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	// A deleted default stops being the default: launches without a
	// profile fall back to the configured default agent.
	def, err := optionalSetting(d.Store, store.SettingDefaultProfile)
	if err == nil && def == name {
		err = d.Store.DeleteSetting(store.SettingDefaultProfile)
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handlePutDefaultProfile makes the named profile the one a launch gets
// when it names none. The profile must exist and be enabled.
func handlePutDefaultProfile(w http.ResponseWriter, r *http.Request, d Deps) {
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Name == "" {
		writeErr(w, http.StatusBadRequest, "bad_request", `body must be {"name": "<profile>"}`)
		return
	}
	p, err := d.Store.GetModelProfile(req.Name)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "profile_not_found", "no profile "+req.Name)
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	if !p.Enabled {
		writeErr(w, http.StatusBadRequest, "profile_disabled", "profile "+req.Name+" is disabled")
		return
	}
	if err := d.Store.SetSetting(store.SettingDefaultProfile, req.Name); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"default": req.Name})
}
