package agy

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/IvanRoslov/hopp/internal/agent"
)

// catalogTimeout bounds `agy models`, which asks Google for the list.
const catalogTimeout = 20 * time.Second

// listModels runs `agy models`. A var so tests never start the real CLI.
var listModels = func(ctx context.Context) ([]byte, error) {
	bin, err := resolveBinary()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, catalogTimeout)
	defer cancel()
	return exec.CommandContext(ctx, bin, "models").Output()
}

// parseModels reads the output of `agy models`: one «<id>\t<name>» line per
// model the signed-in account may use. Other lines («Fetching available
// models...») carry no tab and are skipped.
func parseModels(out []byte) []agent.CatalogModel {
	var models []agent.CatalogModel
	for _, line := range strings.Split(string(out), "\n") {
		id, name, ok := strings.Cut(strings.TrimRight(line, "\r"), "\t")
		id, name = strings.TrimSpace(id), strings.TrimSpace(name)
		if !ok || id == "" || strings.ContainsAny(id, " \t") {
			continue
		}
		if name == "" {
			name = id
		}
		models = append(models, agent.CatalogModel{ID: id, Name: name, Main: true})
	}
	return models
}

// Catalog implements agent.Agent: the models `agy models` lists for the
// signed-in account, else a builtin snapshot with the reason in Warning.
func (a *Agy) Catalog(ctx context.Context) (agent.Catalog, error) {
	out, err := listModels(ctx)
	if err == nil {
		if models := parseModels(out); len(models) > 0 {
			return agent.Catalog{Source: agent.CatalogSourceCLI, FetchedAt: time.Now(), Models: models}, nil
		}
		err = fmt.Errorf("no models in its output")
	}
	return agent.Catalog{Source: agent.CatalogSourceBuiltin,
		Warning: fmt.Sprintf("agy models: %v", err), Models: builtinCatalog()}, nil
}

// builtinCatalog is what `agy models` printed with agy 1.5.14 for a Google AI
// Ultra account on 2026-11-21.
func builtinCatalog() []agent.CatalogModel {
	rows := [][2]string{
		{"gemini-4-neon-high", "Gemini 4 Neon (High)"},
		{"gemini-4-neon-xhigh", "Gemini 4 Neon (XHigh)"},
		{"gemini-4-neon-medium", "Gemini 4 Neon (Medium)"},
		{"gemini-4-neon-low", "Gemini 4 Neon (Low)"},
		{"gemini-4-carbon-medium", "Gemini 4 Carbon (Medium)"},
		{"gemini-4-carbon-high", "Gemini 4 Carbon (High)"},
		{"gemini-4-carbon-low", "Gemini 4 Carbon (Low)"},
		{"gemini-4-argon-medium", "Gemini 4 Argon (Medium)"},
		{"gemini-4-argon-high", "Gemini 4 Argon (High)"},
		{"gemini-4-argon-low", "Gemini 4 Argon (Low)"},
		{"gemini-4-hydrogen-high", "Gemini 4 Hydrogen (High)"},
		{"gemini-4-hydrogen-xhigh", "Gemini 4 Hydrogen (XHigh)"},
		{"gemini-4-hydrogen-medium", "Gemini 4 Hydrogen (Medium)"},
		{"gemini-4-hydrogen-low", "Gemini 4 Hydrogen (Low)"},
		{"gemini-pro-orchestrator-neon", "Orchestrator (Neon)"},
		{"gemini-pro-orchestrator", "Orchestrator (Carbon)"},
		{"gemini-pro-orchestrator-argon", "Orchestrator (Argon)"},
		{"gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"},
		{"gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"},
		{"gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"},
		{"claude-opus-5-5-low", "Claude Opus 5.5 (Low)"},
		{"claude-opus-5-5-medium", "Claude Opus 5.5 (Medium)"},
		{"claude-opus-5-5-high", "Claude Opus 5.5 (High)"},
		{"claude-sonnet-5-5-low", "Claude Sonnet 5.5 (Low)"},
		{"claude-sonnet-5-5-medium", "Claude Sonnet 5.5 (Medium)"},
		{"claude-sonnet-5-5-high", "Claude Sonnet 5.5 (High)"},
		{"gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"},
	}
	models := make([]agent.CatalogModel, 0, len(rows))
	for _, row := range rows {
		models = append(models, agent.CatalogModel{ID: row[0], Name: row[1], Main: true})
	}
	return models
}
