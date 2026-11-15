package api

import (
	"errors"
	"net/http"

	"github.com/IvanRoslov/hopp/internal/config"
	"github.com/IvanRoslov/hopp/internal/session"
	"github.com/IvanRoslov/hopp/internal/store"
)

// resolveProfile turns a launch request's profile, agent, model and effort
// into the profile the session runs with:
//   - a named profile must exist and be enabled; naming an agent that
//     differs from the profile's, or a model or effort of its own, is a bad
//     request;
//   - without a profile, an agent is used as given with model and effort;
//   - with neither, the default_profile setting; when that is unset or names
//     a profile that is gone or disabled, cfg.DefaultAgent with the agent's
//     own model and effort.
func resolveProfile(st *store.Store, cfg *config.Config, profile, agent, model, effort string) (session.LaunchProfile, error) {
	if profile != "" {
		p, err := st.GetModelProfile(profile)
		if errors.Is(err, store.ErrNotFound) {
			return session.LaunchProfile{}, newAPIError(http.StatusNotFound, "profile_not_found", "model profile not found: "+profile)
		}
		if err != nil {
			return session.LaunchProfile{}, err
		}
		if !p.Enabled {
			return session.LaunchProfile{}, newAPIError(http.StatusBadRequest, "profile_disabled", "model profile is disabled: "+profile)
		}
		if agent != "" && agent != p.Agent {
			return session.LaunchProfile{}, newAPIError(http.StatusBadRequest, "bad_request",
				"profile "+profile+" runs agent "+p.Agent+", not "+agent)
		}
		if model != "" || effort != "" {
			return session.LaunchProfile{}, newAPIError(http.StatusBadRequest, "bad_request",
				"model and effort come from the profile; name an agent instead to set them")
		}
		return session.LaunchProfile{Name: p.Name, Agent: p.Agent, Model: p.Model, Effort: p.Effort}, nil
	}
	if agent != "" {
		return session.LaunchProfile{Agent: agent, Model: model, Effort: effort}, nil
	}
	if model != "" || effort != "" {
		return session.LaunchProfile{}, newAPIError(http.StatusBadRequest, "bad_request",
			"model and effort need an agent or a profile")
	}
	if name, err := st.GetSetting(store.SettingDefaultProfile); err == nil {
		if p, err := st.GetModelProfile(name); err == nil && p.Enabled {
			return session.LaunchProfile{Name: p.Name, Agent: p.Agent, Model: p.Model, Effort: p.Effort}, nil
		} else if err != nil && !errors.Is(err, store.ErrNotFound) {
			return session.LaunchProfile{}, err
		}
	} else if !errors.Is(err, store.ErrNotFound) {
		return session.LaunchProfile{}, err
	}
	return session.LaunchProfile{Agent: cfg.DefaultAgent}, nil
}
