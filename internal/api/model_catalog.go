package api

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/IvanRoslov/hopp/internal/agent"
)

// modelCatalogTTL is how long the daemon trusts a fetched catalog before asking
// the agent adapter again (spec: 10 minutes; refresh=1 skips it).
const modelCatalogTTL = 10 * time.Minute

// catalogFetcher returns agentName's catalog.
type catalogFetcher func(ctx context.Context, agentName string) (agent.Catalog, error)

// fetchAgentCatalog is the production fetcher: the registered adapter's
// Catalog. A var so the package's tests never touch the real agents.
var fetchAgentCatalog catalogFetcher = func(ctx context.Context, name string) (agent.Catalog, error) {
	a, err := agent.Get(name)
	if err != nil {
		return agent.Catalog{}, err
	}
	return a.Catalog(ctx)
}

// CatalogCache keeps each agent's model catalog in memory for modelCatalogTTL.
// Its lock is never held while fetching, so a slow `codex debug models`
// does not stall reads of another agent's catalog; concurrent cold reads of
// one agent share a single fetch.
type CatalogCache struct {
	fetch catalogFetcher
	now   func() time.Time

	mu       sync.Mutex
	entries  map[string]catalogEntry
	inflight map[string]*catalogCall
}

// catalogCall is a fetch in progress; done closes when cat is set.
type catalogCall struct {
	done chan struct{}
	cat  agent.Catalog
}

type catalogEntry struct {
	cat agent.Catalog
	at  time.Time
}

// NewCatalogCache returns an empty cache in front of fetch.
func NewCatalogCache(fetch catalogFetcher) *CatalogCache {
	return &CatalogCache{fetch: fetch, now: time.Now, entries: map[string]catalogEntry{},
		inflight: map[string]*catalogCall{}}
}

// Get returns agentName's catalog, fetching it when absent, older than
// modelCatalogTTL, or refresh is set. A fetch error is not passed on: the
// result is an empty builtin catalog whose Warning carries the error.
func (c *CatalogCache) Get(ctx context.Context, agentName string, refresh bool) agent.Catalog {
	c.mu.Lock()
	if e, ok := c.entries[agentName]; ok && !refresh && c.now().Sub(e.at) < modelCatalogTTL {
		c.mu.Unlock()
		return e.cat
	}
	if call, ok := c.inflight[agentName]; ok {
		c.mu.Unlock()
		select {
		case <-call.done:
			return call.cat
		case <-ctx.Done():
			return agent.Catalog{Source: agent.CatalogSourceBuiltin,
				Warning: "model catalog not ready: " + ctx.Err().Error()}
		}
	}
	call := &catalogCall{done: make(chan struct{})}
	c.inflight[agentName] = call
	c.mu.Unlock()

	// The slot is released whatever happens in the adapter, a panic
	// included, so later Gets never wait on a dead fetch.
	defer func() {
		c.mu.Lock()
		c.entries[agentName] = catalogEntry{cat: call.cat, at: c.now()}
		delete(c.inflight, agentName)
		c.mu.Unlock()
		close(call.done)
	}()
	call.cat = c.safeFetch(ctx, agentName)
	return call.cat
}

// safeFetch runs the fetcher detached from the caller — a client that
// disconnects mid-fetch must not leave a fallback catalog cached for the
// whole TTL; the adapters bound their own work (codex: catalogTimeout) —
// and turns an error or a panic into an empty builtin catalog with a
// warning.
func (c *CatalogCache) safeFetch(ctx context.Context, agentName string) (cat agent.Catalog) {
	defer func() {
		if p := recover(); p != nil {
			slog.Error("model catalog adapter panicked", "agent", agentName, "panic", p)
			cat = agent.Catalog{Source: agent.CatalogSourceBuiltin,
				Warning: fmt.Sprintf("model catalog unavailable: adapter panicked: %v", p)}
		}
	}()
	cat, err := c.fetch(context.WithoutCancel(ctx), agentName)
	if err != nil {
		cat = agent.Catalog{Source: agent.CatalogSourceBuiltin, Warning: "model catalog unavailable: " + err.Error()}
	}
	return cat
}

// catalogModelJSON is one model as GET /v1/model-catalog returns it.
type catalogModelJSON struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Description   string   `json:"description"`
	Main          bool     `json:"main"`
	Efforts       []string `json:"efforts"` // never null
	DefaultEffort string   `json:"default_effort"`
}

// agentCatalogJSON is one agent's catalog; FetchedAt is null for builtin.
type agentCatalogJSON struct {
	Agent     string             `json:"agent"`
	Source    string             `json:"source"`
	FetchedAt *time.Time         `json:"fetched_at"`
	Warning   string             `json:"warning"`
	Models    []catalogModelJSON `json:"models"`
}

func toAgentCatalogJSON(name string, cat agent.Catalog) agentCatalogJSON {
	out := agentCatalogJSON{Agent: name, Source: cat.Source, Warning: cat.Warning, Models: []catalogModelJSON{}}
	if !cat.FetchedAt.IsZero() {
		t := cat.FetchedAt.UTC()
		out.FetchedAt = &t
	}
	for _, m := range cat.Models {
		efforts := m.Efforts
		if efforts == nil {
			efforts = []string{}
		}
		out.Models = append(out.Models, catalogModelJSON{ID: m.ID, Name: m.Name, Description: m.Description,
			Main: m.Main, Efforts: efforts, DefaultEffort: m.DefaultEffort})
	}
	return out
}

// catalogAgentNames returns the agents a request covers: just name when
// set (false if it is not registered), else every registered agent sorted.
func catalogAgentNames(name string) ([]string, bool) {
	if name != "" {
		if _, err := agent.Get(name); err != nil {
			return nil, false
		}
		return []string{name}, true
	}
	var names []string
	for n := range agent.Registry() {
		names = append(names, n)
	}
	sort.Strings(names)
	return names, true
}

// registerModelCatalogRoutes wires GET /v1/model-catalog and POST
// /v1/model-profiles/import-catalog onto mux.
func registerModelCatalogRoutes(mux *http.ServeMux, d Deps) {
	mux.HandleFunc("GET /v1/model-catalog", func(w http.ResponseWriter, r *http.Request) {
		handleGetModelCatalog(w, r, d)
	})
}

// handleGetModelCatalog serves every agent's catalog (or ?agent=A's).
// Read-only, so agent sessions may call it too.
func handleGetModelCatalog(w http.ResponseWriter, r *http.Request, d Deps) {
	q := r.URL.Query()
	names, ok := catalogAgentNames(q.Get("agent"))
	if !ok {
		writeErr(w, http.StatusBadRequest, "agent_unavailable", "unknown agent "+q.Get("agent"))
		return
	}
	refresh := q.Get("refresh") == "1" || q.Get("refresh") == "true"
	out := make([]agentCatalogJSON, 0, len(names))
	for _, n := range names {
		out = append(out, toAgentCatalogJSON(n, d.Catalogs.Get(r.Context(), n, refresh)))
	}
	writeJSON(w, http.StatusOK, map[string]any{"agents": out})
}
