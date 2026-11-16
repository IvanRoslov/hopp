package toolcatalog

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// writeTool writes <home>/tools/<folder>/tool.yaml and, when usage is not
// "-", USAGE.md.
func writeTool(t *testing.T, home, folder, yaml, usage string) string {
	t.Helper()
	dir := filepath.Join(home, "tools", folder)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "tool.yaml"), []byte(yaml), 0o644); err != nil {
		t.Fatal(err)
	}
	if usage != "-" {
		if err := os.WriteFile(filepath.Join(dir, "USAGE.md"), []byte(usage), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

const (
	cmdYAML   = "name: fetcher\ndescription: Fetch a page\ncommand: [fetcher, --quiet]\nenvironment: [FETCH_KEY]\n"
	mcpYAML   = "name: voice\ndescription: Speech and music\nvia: mcp\nmcp_server: voice\nharnesses: [claude-code]\npaid: true\n"
	guideYAML = "name: refs\ndescription: Landing page references\nvia: guide\nenabled: false\n"
)

func validHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	writeTool(t, home, "fetcher", cmdYAML, "how to fetch\n")
	writeTool(t, home, "voice", mcpYAML, "how to speak\n")
	writeTool(t, home, "refs", guideYAML, "how to browse\n")
	return home
}

func TestLoadValidToolsOfEachVia(t *testing.T) {
	home := validHome(t)
	tools, broken, err := Load(home)
	if err != nil || len(broken) != 0 {
		t.Fatalf("Load: %v, broken %v", err, broken)
	}
	names := []string{}
	for _, tl := range tools {
		names = append(names, tl.Name)
	}
	if !reflect.DeepEqual(names, []string{"fetcher", "refs", "voice"}) {
		t.Fatalf("names = %v, want sorted", names)
	}
	f, r, v := tools[0], tools[1], tools[2]
	if f.Via != "command" || !f.Enabled || f.Paid || !reflect.DeepEqual(f.Command, []string{"fetcher", "--quiet"}) ||
		!reflect.DeepEqual(f.Environment, []string{"FETCH_KEY"}) || f.Usage != "how to fetch\n" ||
		f.Dir != filepath.Join(home, "tools", "fetcher") {
		t.Errorf("command tool = %+v", f)
	}
	if v.Via != "mcp" || v.MCPServer != "voice" || !v.Paid || !v.Enabled || !reflect.DeepEqual(v.Harnesses, []string{"claude-code"}) {
		t.Errorf("mcp tool = %+v", v)
	}
	if r.Via != "guide" || r.Enabled {
		t.Errorf("guide tool = %+v", r)
	}
}

func TestLoadMissingCatalogIsEmpty(t *testing.T) {
	tools, broken, err := Load(t.TempDir())
	if err != nil || len(tools) != 0 || len(broken) != 0 {
		t.Errorf("Load of a missing catalog = %v, %v, %v", tools, broken, err)
	}
}

func TestValidationRules(t *testing.T) {
	for name, tc := range map[string]struct{ folder, yaml, usage, want string }{
		"bad name":          {"Bad", "name: Bad\ndescription: d\ncommand: [x]\n", "u", "name"},
		"name differs":      {"other", "name: fetcher\ndescription: d\ncommand: [x]\n", "u", "folder"},
		"no description":    {"t", "name: t\ncommand: [x]\n", "u", "description"},
		"two-line desc":     {"t", "name: t\ndescription: \"a\\nb\"\ncommand: [x]\n", "u", "one line"},
		"no usage file":     {"t", "name: t\ndescription: d\ncommand: [x]\n", "-", "USAGE.md"},
		"empty usage":       {"t", "name: t\ndescription: d\ncommand: [x]\n", " \n", "USAGE.md"},
		"no via no command": {"t", "name: t\ndescription: d\n", "u", "command"},
		"command empty":     {"t", "name: t\ndescription: d\nvia: command\ncommand: []\n", "u", "command"},
		"command blank":     {"t", "name: t\ndescription: d\ncommand: [\"\"]\n", "u", "command"},
		"mcp no server":     {"t", "name: t\ndescription: d\nvia: mcp\n", "u", "mcp_server"},
		"guide w/ command":  {"t", "name: t\ndescription: d\nvia: guide\ncommand: [x]\n", "u", "command"},
		"guide w/ mcp":      {"t", "name: t\ndescription: d\nvia: guide\nmcp_server: s\n", "u", "mcp_server"},
		"unknown via":       {"t", "name: t\ndescription: d\nvia: shell\ncommand: [x]\n", "u", "via"},
		"unknown field":     {"t", "name: t\ndescription: d\ncommand: [x]\ncolor: red\n", "u", "color"},
		"unknown harness":   {"t", "name: t\ndescription: d\ncommand: [x]\nharnesses: [vim]\n", "u", "vim"},
		"not yaml":          {"t", "name: [\n", "u", "yaml"},
		"two documents":     {"t", "name: t\ndescription: d\ncommand: [x]\n---\nname: u\n", "u", "document"},
	} {
		home := t.TempDir()
		writeTool(t, home, tc.folder, tc.yaml, tc.usage)
		tools, broken, err := Load(home)
		if err != nil || len(tools) != 0 || len(broken) != 1 {
			t.Errorf("%s: tools %v broken %v err %v", name, tools, broken, err)
			continue
		}
		if broken[0].Name != tc.folder || !strings.Contains(strings.ToLower(broken[0].Err.Error()), strings.ToLower(tc.want)) {
			t.Errorf("%s: broken = %s: %v, want it to mention %q", name, broken[0].Name, broken[0].Err, tc.want)
		}
		if _, err := Get(home, tc.folder); err == nil || errors.Is(err, ErrNotFound) {
			t.Errorf("%s: Get = %v, want the validation error", name, err)
		}
	}
}

// Review Focus 1: one broken tool does not hide the others.
func TestBrokenToolDoesNotHideOthers(t *testing.T) {
	home := validHome(t)
	writeTool(t, home, "broken", "name: broken\ndescription: d\nnope: 1\n", "u")
	tools, broken, err := Load(home)
	if err != nil || len(tools) != 3 || len(broken) != 1 || broken[0].Name != "broken" {
		t.Fatalf("tools %d broken %v err %v", len(tools), broken, err)
	}
	if tl, err := Get(home, "fetcher"); err != nil || tl.Name != "fetcher" {
		t.Errorf("Get fetcher = %+v, %v", tl, err)
	}
}

// Review Focus 2: what is not a tool is ignored silently.
func TestNonToolEntriesIgnored(t *testing.T) {
	home := validHome(t)
	tools := filepath.Join(home, "tools")
	os.WriteFile(filepath.Join(tools, "rules.md"), []byte("prefer fetcher"), 0o644)
	os.WriteFile(filepath.Join(tools, "notes.txt"), []byte("x"), 0o644)
	os.MkdirAll(filepath.Join(tools, "empty-folder"), 0o755)
	writeTool(t, home, ".hidden", "garbage: [", "u")
	got, broken, err := Load(home)
	if err != nil || len(got) != 3 || len(broken) != 0 {
		t.Errorf("tools %d broken %v err %v", len(got), broken, err)
	}
	if _, err := Get(home, "empty-folder"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Get of a folder without tool.yaml = %v, want ErrNotFound", err)
	}
	if _, err := Get(home, "missing"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Get missing = %v, want ErrNotFound", err)
	}
	if _, err := Get(home, "../tools"); err == nil {
		t.Error("Get with a path in the name succeeded")
	}
}

func TestLoadUnreadableDirIsError(t *testing.T) {
	home := t.TempDir()
	os.WriteFile(filepath.Join(home, "tools"), []byte("a file, not a folder"), 0o644)
	if _, _, err := Load(home); err == nil {
		t.Error("Load with tools as a file: no error")
	}
}

func TestAvailableIn(t *testing.T) {
	all := Tool{}
	one := Tool{Harnesses: []string{"claude-code"}}
	if !all.AvailableIn("codex") || !one.AvailableIn("claude-code") || one.AvailableIn("codex") {
		t.Error("AvailableIn wrong")
	}
}

func TestRules(t *testing.T) {
	home := t.TempDir()
	text, mod, err := Rules(home)
	if err != nil || text != "" || !mod.IsZero() {
		t.Errorf("missing rules = %q, %v, %v", text, mod, err)
	}
	os.MkdirAll(Dir(home), 0o755)
	os.WriteFile(filepath.Join(Dir(home), "rules.md"), []byte("video: use X\n"), 0o644)
	text, mod, err = Rules(home)
	if err != nil || text != "video: use X\n" || time.Since(mod) > time.Minute {
		t.Errorf("rules = %q, %v, %v", text, mod, err)
	}
	if Dir(home) != filepath.Join(home, "tools") {
		t.Errorf("Dir = %s", Dir(home))
	}
}

// Review Focus 4: switching keeps every other field and its order.
func TestSetEnabledRoundTrip(t *testing.T) {
	home := t.TempDir()
	orig := "# hand written\npaid: true\nname: fetcher\ncommand: [fetcher, \"--a b\"]\ndescription: Fetch a page # why\nenvironment: [K]\n"
	dir := writeTool(t, home, "fetcher", orig, "u")
	if err := SetEnabled(home, "fetcher", false); err != nil {
		t.Fatal(err)
	}
	tl, err := Get(home, "fetcher")
	if err != nil || tl.Enabled {
		t.Fatalf("after disable: %+v, %v", tl, err)
	}
	if !tl.Paid || tl.Description != "Fetch a page" || !reflect.DeepEqual(tl.Command, []string{"fetcher", "--a b"}) ||
		!reflect.DeepEqual(tl.Environment, []string{"K"}) {
		t.Errorf("fields changed: %+v", tl)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "tool.yaml"))
	s := string(raw)
	if !strings.Contains(s, "# hand written") || strings.Index(s, "paid") > strings.Index(s, "name") ||
		strings.Index(s, "name") > strings.Index(s, "command") {
		t.Errorf("order or comment lost:\n%s", s)
	}
	if err := SetEnabled(home, "fetcher", true); err != nil {
		t.Fatal(err)
	}
	if tl, err := Get(home, "fetcher"); err != nil || !tl.Enabled {
		t.Errorf("after enable: %+v, %v", tl, err)
	}
	if err := SetEnabled(home, "fetcher", true); err != nil {
		t.Errorf("enable twice: %v", err)
	}
	if strings.Count(readFile(t, filepath.Join(dir, "tool.yaml")), "enabled") != 1 {
		t.Errorf("enabled written twice:\n%s", readFile(t, filepath.Join(dir, "tool.yaml")))
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.Name() != "tool.yaml" && e.Name() != "USAGE.md" {
			t.Errorf("leftover file %s", e.Name())
		}
	}
	if err := SetEnabled(home, "missing", true); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing: %v", err)
	}
}

func TestSetEnabledOnBrokenToolFails(t *testing.T) {
	home := t.TempDir()
	writeTool(t, home, "b", "name: b\ndescription: d\nnope: 1\n", "u")
	if err := SetEnabled(home, "b", false); err == nil {
		t.Error("SetEnabled on a broken tool succeeded")
	}
}

func readFile(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// A broken tool is reported on one line, without decoder internals.
func TestBrokenErrorIsOneReadableLine(t *testing.T) {
	home := t.TempDir()
	writeTool(t, home, "b", "name: b\ndescription: d\ncolour: red\nsize: 2\n", "u")
	_, broken, _ := Load(home)
	if len(broken) != 1 {
		t.Fatalf("broken = %v", broken)
	}
	msg := broken[0].Err.Error()
	if strings.Contains(msg, "\n") || strings.Contains(msg, "toolcatalog") || strings.Contains(msg, "yaml: yaml") ||
		!strings.Contains(msg, "colour") || !strings.Contains(msg, "size") {
		t.Errorf("message = %q", msg)
	}
}
