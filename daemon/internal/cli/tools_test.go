package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/IvanRoslov/hopp/internal/agent"
	"github.com/IvanRoslov/hopp/internal/toolcatalog"
)

// toolsHome is a temp HOPP_HOME with no daemon: every tools command must
// work without one (there is no --socket, so a connect would fail).
func toolsHome(t *testing.T) string {
	t.Helper()
	flags = globalFlags{}
	home := t.TempDir()
	t.Setenv("HOPP_HOME", home)
	t.Setenv("HOPP_SESSION_ID", "")
	return home
}

func putTool(t *testing.T, home, folder, yaml, usage string) string {
	t.Helper()
	dir := filepath.Join(home, "tools", folder)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "tool.yaml"), []byte(yaml), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "USAGE.md"), []byte(usage), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

// toolsCatalog: fetcher (command, needs FETCH_KEY), voice (mcp, paid,
// claude-code only), refs (guide, switched off).
func toolsCatalog(t *testing.T) string {
	t.Helper()
	home := toolsHome(t)
	putTool(t, home, "fetcher", "name: fetcher\ndescription: Fetch a page\ncommand: [sh, -c, \"echo hi\"]\nenvironment: [FETCH_KEY]\n", "Run fetcher URL.\n")
	putTool(t, home, "voice", "name: voice\ndescription: Speech and music\nvia: mcp\nmcp_server: elevenvoice\nharnesses: [claude-code]\npaid: true\n", "Use the MCP tools.\n")
	putTool(t, home, "refs", "name: refs\ndescription: Landing page references\nvia: guide\nenabled: false\n", "Browse refs/.\n")
	return home
}

// runTools runs hopp without --socket and with stdin empty.
func runTools(t *testing.T, args ...string) (string, string, int) {
	t.Helper()
	root := NewRootCmd()
	var out, errOut bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&errOut)
	root.SetIn(strings.NewReader(""))
	root.SetArgs(args)
	err := root.Execute()
	code := 0
	if err != nil {
		errOut.WriteString(err.Error())
		code = exitCode(err)
	}
	return out.String(), errOut.String(), code
}

func TestToolsHarnessNamesAreTheAdapters(t *testing.T) {
	var names []string
	for n := range agent.Registry() {
		names = append(names, n)
	}
	sort.Strings(names)
	if !reflect.DeepEqual(names, toolcatalog.Harnesses) {
		t.Errorf("adapters %v, catalog harnesses %v", names, toolcatalog.Harnesses)
	}
}

func TestToolsList(t *testing.T) {
	toolsCatalog(t)
	out, errOut, code := runTools(t, "tools", "list")
	if code != 0 || errOut != "" {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if !strings.Contains(out, "fetcher") || !strings.Contains(out, "voice") || strings.Contains(out, "refs") {
		t.Errorf("list = %q, want enabled tools only", out)
	}
	if line := lineWith(out, "voice"); !strings.Contains(line, "mcp") || !strings.Contains(line, "paid") || !strings.Contains(line, "Speech and music") {
		t.Errorf("voice line = %q", line)
	}
	out, _, _ = runTools(t, "tools", "list", "--all")
	if line := lineWith(out, "refs"); !strings.Contains(line, "off") || !strings.Contains(line, "guide") {
		t.Errorf("--all refs line = %q", line)
	}
	out, _, _ = runTools(t, "tools", "list", "--harness", "codex")
	if strings.Contains(out, "voice") || !strings.Contains(out, "fetcher") {
		t.Errorf("--harness codex = %q", out)
	}
	if _, _, code := runTools(t, "tools", "list", "--harness", "vim"); code != 3 {
		t.Errorf("unknown harness: exit %d, want 3", code)
	}
}

func lineWith(out, word string) string {
	for _, l := range strings.Split(out, "\n") {
		if strings.HasPrefix(l, word+" ") {
			return l
		}
	}
	return ""
}

func TestToolsListJSON(t *testing.T) {
	home := toolsCatalog(t)
	putTool(t, home, "broken", "name: broken\nnope: 1\n", "u")
	out, errOut, code := runTools(t, "--json", "tools", "list", "--all")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	var got struct {
		Tools []struct {
			Name, Description, Via string
			Command                []string
			MCPServer              string `json:"mcp_server"`
			Harnesses, Environment []string
			Paid, Enabled          bool
			Dir                    string
		} `json:"tools"`
		Broken []struct{ Name, Error string } `json:"broken"`
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if len(got.Tools) != 3 || len(got.Broken) != 1 || got.Broken[0].Name != "broken" || got.Broken[0].Error == "" {
		t.Fatalf("json = %+v", got)
	}
	v := got.Tools[2]
	if v.Name != "voice" || v.MCPServer != "elevenvoice" || !v.Paid || !v.Enabled || v.Dir != filepath.Join(home, "tools", "voice") {
		t.Errorf("voice = %+v", v)
	}
	if !strings.Contains(out, `"harnesses": []`) || !strings.Contains(out, `"command": []`) {
		t.Errorf("empty lists should be [] in %s", out)
	}
}

// Review Focus 1: a broken tool is named on stderr; the rest still work.
func TestToolsBrokenToolDoesNotHideOthers(t *testing.T) {
	home := toolsCatalog(t)
	putTool(t, home, "broken", "name: broken\ndescription: d\ncommand: [x]\ncolour: red\n", "u")
	out, errOut, code := runTools(t, "tools", "list")
	if code != 0 || !strings.Contains(out, "fetcher") || !strings.Contains(errOut, "broken") || strings.Contains(out, "broken") {
		t.Errorf("list: exit %d, out %q, err %q", code, out, errOut)
	}
	if out, _, code := runTools(t, "tools", "show", "fetcher"); code != 0 || !strings.Contains(out, "Run fetcher URL.") {
		t.Errorf("show fetcher: exit %d, %q", code, out)
	}
	if _, errOut, code := runTools(t, "tools", "show", "broken"); code == 0 || !strings.Contains(errOut, "colour") {
		t.Errorf("show broken: exit %d, %q", code, errOut)
	}
}

func TestToolsShow(t *testing.T) {
	home := toolsCatalog(t)
	out, errOut, code := runTools(t, "tools", "show", "voice")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if !strings.HasPrefix(out, "PAID: ask the human with hopp ask and wait for Go before each call or enumerated batch.\n") {
		t.Errorf("paid notice not first: %q", out)
	}
	for _, want := range []string{"Speech and music", "elevenvoice", "claude-code", "Use the MCP tools."} {
		if !strings.Contains(out, want) {
			t.Errorf("show voice lacks %q: %q", want, out)
		}
	}
	out, _, _ = runTools(t, "tools", "show", "fetcher")
	for _, want := range []string{"Fetch a page", "sh -c 'echo hi'", "FETCH_KEY", filepath.Join(home, "tools", "fetcher"), "Run fetcher URL."} {
		if !strings.Contains(out, want) {
			t.Errorf("show fetcher lacks %q: %q", want, out)
		}
	}
	if strings.Contains(out, "PAID") || strings.Contains(out, "harnesses") {
		t.Errorf("show fetcher: %q", out)
	}
	if _, errOut, code := runTools(t, "tools", "show", "refs"); code == 0 || !strings.Contains(errOut, "tool refs is switched off by the human") {
		t.Errorf("show disabled: exit %d, %q", code, errOut)
	}
	if out, _, code := runTools(t, "tools", "show", "refs", "--all"); code != 0 || !strings.Contains(out, "Browse refs/.") {
		t.Errorf("show disabled --all: exit %d, %q", code, out)
	}
	if _, errOut, code := runTools(t, "tools", "show", "nope"); code == 0 || !strings.Contains(errOut, "nope") {
		t.Errorf("show unknown: exit %d, %q", code, errOut)
	}
	out, _, _ = runTools(t, "--json", "tools", "show", "fetcher")
	var j map[string]any
	if err := json.Unmarshal([]byte(out), &j); err != nil || j["usage"] != "Run fetcher URL.\n" || j["name"] != "fetcher" {
		t.Errorf("--json show = %v (%v)", j, err)
	}
}

func TestToolsRules(t *testing.T) {
	home := toolsHome(t)
	if out, errOut, code := runTools(t, "tools", "rules"); code != 0 || out != "" {
		t.Errorf("missing rules: exit %d, %q %q", code, out, errOut)
	}
	out, _, _ := runTools(t, "--json", "tools", "rules")
	if !strings.Contains(out, `"modified_at": 0`) || !strings.Contains(out, `"text": ""`) {
		t.Errorf("--json missing rules = %s", out)
	}
	os.MkdirAll(filepath.Join(home, "tools"), 0o755)
	os.WriteFile(filepath.Join(home, "tools", "rules.md"), []byte("Video: use X.\n"), 0o644)
	if out, _, _ := runTools(t, "tools", "rules"); out != "Video: use X.\n" {
		t.Errorf("rules = %q", out)
	}
	out, _, _ = runTools(t, "--json", "tools", "rules")
	var j struct {
		Text       string `json:"text"`
		ModifiedAt int64  `json:"modified_at"`
	}
	if err := json.Unmarshal([]byte(out), &j); err != nil || j.Text != "Video: use X.\n" || j.ModifiedAt == 0 {
		t.Errorf("--json rules = %+v (%v)", j, err)
	}
}

func TestToolsEnableDisable(t *testing.T) {
	home := toolsCatalog(t)
	out, errOut, code := runTools(t, "tools", "disable", "fetcher", "voice")
	if code != 0 || strings.Fields(out)[0] != "fetcher" || strings.Fields(out)[1] != "voice" {
		t.Fatalf("disable: exit %d, %q %q", code, out, errOut)
	}
	if tl, _ := toolcatalog.Get(home, "voice"); tl.Enabled || !tl.Paid {
		t.Errorf("voice after disable = %+v", tl)
	}
	if out, _, code := runTools(t, "tools", "enable", "refs"); code != 0 || strings.TrimSpace(out) != "refs" {
		t.Errorf("enable refs: %d %q", code, out)
	}
	before, _ := os.ReadFile(filepath.Join(home, "tools", "voice", "tool.yaml"))
	if _, errOut, code := runTools(t, "tools", "enable", "voice", "ghost"); code == 0 || !strings.Contains(errOut, "ghost") {
		t.Errorf("enable with unknown: exit %d, %q", code, errOut)
	}
	after, _ := os.ReadFile(filepath.Join(home, "tools", "voice", "tool.yaml"))
	if !bytes.Equal(before, after) {
		t.Error("an unknown name still changed another tool")
	}
	if _, _, code := runTools(t, "tools", "enable"); code != 3 {
		t.Errorf("enable without names: exit %d, want 3", code)
	}
}

func TestToolsPath(t *testing.T) {
	home := toolsHome(t)
	if out, _, code := runTools(t, "tools", "path"); code != 0 || strings.TrimSpace(out) != filepath.Join(home, "tools") {
		t.Errorf("path = %d %q", code, out)
	}
	if out, _, code := runTools(t, "tools", "path", "new-tool"); code != 0 || strings.TrimSpace(out) != filepath.Join(home, "tools", "new-tool") {
		t.Errorf("path new-tool = %d %q", code, out)
	}
	if _, _, code := runTools(t, "tools", "path", "../etc"); code != 3 {
		t.Errorf("path ../etc: exit %d, want 3", code)
	}
	if _, err := os.Stat(filepath.Join(home, "tools")); err == nil {
		t.Error("path created the catalog folder")
	}
}

func TestToolsCheck(t *testing.T) {
	home := toolsCatalog(t)
	t.Setenv("FETCH_KEY", "set")
	if out, errOut, code := runTools(t, "tools", "check"); code != 0 {
		t.Fatalf("clean catalog: exit %d, %q %q", code, out, errOut)
	}
	t.Setenv("FETCH_KEY", "")
	os.Unsetenv("FETCH_KEY")
	putTool(t, home, "gone", "name: gone\ndescription: d\ncommand: [/nonexistent/bin/gone]\n", "u")
	putTool(t, home, "missing", "name: missing\ndescription: d\ncommand: [no-such-command-hopp-test]\n", "u")
	notExec := filepath.Join(t.TempDir(), "plain")
	os.WriteFile(notExec, []byte("x"), 0o644)
	putTool(t, home, "plain", "name: plain\ndescription: d\ncommand: ["+notExec+"]\n", "u")
	putTool(t, home, "broken", "name: broken\ndescription: d\n", "u")
	out, errOut, code := runTools(t, "tools", "check")
	if code == 0 {
		t.Fatalf("check with problems exited 0: %q", out)
	}
	for _, want := range []string{"fetcher: environment variable FETCH_KEY is not set", "gone:", "missing:", "plain:", "broken:"} {
		if !strings.Contains(out, want) {
			t.Errorf("check output lacks %q: %q (stderr %q)", want, out, errOut)
		}
	}
	if strings.Contains(out, "voice") || strings.Contains(out, "refs") {
		t.Errorf("check reported a sound tool: %q", out)
	}
	t.Setenv("FETCH_KEY", "set")
	if _, _, code := runTools(t, "tools", "check", "fetcher"); code != 0 {
		t.Errorf("check fetcher: exit %d", code)
	}
	if out, _, code := runTools(t, "tools", "check", "broken"); code == 0 || !strings.Contains(out, "broken:") {
		t.Errorf("check broken: %d %q", code, out)
	}
	if _, _, code := runTools(t, "tools", "check", "ghost"); code == 0 {
		t.Error("check ghost exited 0")
	}
}

// Review Focus 5 on the command line.
func TestToolsPrompt(t *testing.T) {
	toolsCatalog(t)
	out, errOut, code := runTools(t, "tools", "prompt", "--harness", "codex")
	if code != 0 || !strings.HasPrefix(out, "## Tools\n") || strings.Contains(out, "voice") || strings.Contains(out, "refs") ||
		!strings.Contains(out, "- fetcher — Fetch a page") {
		t.Errorf("codex: exit %d, %q %q", code, out, errOut)
	}
	out, _, _ = runTools(t, "tools", "prompt", "--harness", "claude-code")
	if !strings.Contains(out, "- voice — Speech and music (paid) (MCP server elevenvoice)") {
		t.Errorf("claude-code prompt = %q", out)
	}
	if _, _, code := runTools(t, "tools", "prompt"); code != 3 {
		t.Errorf("without --harness: exit %d, want 3", code)
	}
	if _, _, code := runTools(t, "tools", "prompt", "--harness", "vim"); code != 3 {
		t.Errorf("unknown harness: exit %d, want 3", code)
	}
}

func TestToolsPromptEmptyCatalog(t *testing.T) {
	home := toolsHome(t)
	if out, errOut, code := runTools(t, "tools", "prompt", "--harness", "pi"); code != 0 || out != "" || errOut != "" {
		t.Errorf("missing catalog: exit %d, %q %q", code, out, errOut)
	}
	os.MkdirAll(filepath.Join(home, "tools"), 0o755)
	if out, _, code := runTools(t, "tools", "prompt", "--harness", "pi"); code != 0 || out != "" {
		t.Errorf("empty catalog: exit %d, %q", code, out)
	}
}

func TestToolsGuide(t *testing.T) {
	toolsHome(t)
	out, _, code := runTools(t, "tools", "guide")
	if code != 0 || !strings.Contains(out, "hopp tools check") {
		t.Errorf("guide: exit %d, %q", code, out)
	}
}

func TestToolsImport(t *testing.T) {
	home := toolsHome(t)
	reg := filepath.Join(t.TempDir(), "registry.yaml")
	data := []byte("tools:\n  - name: pdfx\n    description: Extract text\n    command: [pdfx]\n    usage: pdfx FILE\n")
	os.WriteFile(reg, data, 0o644)
	out, errOut, code := runTools(t, "tools", "import", reg)
	if code != 0 || !strings.Contains(out, "created pdfx") {
		t.Fatalf("import: exit %d, %q %q", code, out, errOut)
	}
	if _, err := toolcatalog.Get(home, "pdfx"); err != nil {
		t.Errorf("imported tool: %v", err)
	}
	_, errOut, code = runTools(t, "tools", "import", reg)
	if code != 0 || !strings.Contains(errOut, "pdfx") {
		t.Errorf("second import: exit %d, stderr %q", code, errOut)
	}
	out, _, code = runTools(t, "tools", "import", reg, "--update")
	if code != 0 || !strings.Contains(out, "updated pdfx") {
		t.Errorf("--update: exit %d, %q", code, out)
	}
	if after, _ := os.ReadFile(reg); !bytes.Equal(after, data) {
		t.Error("import changed its source file")
	}
	if _, _, code := runTools(t, "tools", "import", filepath.Join(t.TempDir(), "none.yaml")); code == 0 {
		t.Error("import of a missing file exited 0")
	}
}
