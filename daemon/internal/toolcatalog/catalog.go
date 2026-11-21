// Package toolcatalog reads the catalog of tools under <hopp home>/tools:
// one folder per tool, each with a tool.yaml and a USAGE.md, plus a free-form
// rules.md. It only describes tools: it never runs them, keeps no secrets and
// blocks nothing. No daemon is involved; the hopp program reads the files.
package toolcatalog

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// ErrNotFound: there is no tool folder with a tool.yaml under that name.
var ErrNotFound = errors.New("tool not found")

// Ways a tool is reached.
const (
	ViaCommand = "command" // a command the agent runs
	ViaMCP     = "mcp"     // an MCP server the human connected by hand
	ViaGuide   = "guide"   // instructions only (references, a set of techniques)
)

// Harnesses are the harness names a tool may be limited to: the adapters'
// Name() values.
var Harnesses = []string{"agy", "claude-code", "codex", "deepseek", "kimi-code", "pi"}

// Tool is one catalog entry. Dir is its folder and Usage the content of its
// USAGE.md.
type Tool struct {
	Name        string
	Description string
	Via         string
	Command     []string
	MCPServer   string
	Harnesses   []string
	Environment []string
	Paid        bool
	Enabled     bool
	Dir         string
	Usage       string
}

// Broken is a tool folder whose tool.yaml or USAGE.md does not validate.
type Broken struct {
	Name string
	Err  error
}

// file is tool.yaml as written on disk.
type file struct {
	Name        string   `yaml:"name"`
	Description string   `yaml:"description"`
	Via         string   `yaml:"via"`
	Command     []string `yaml:"command"`
	MCPServer   string   `yaml:"mcp_server"`
	Harnesses   []string `yaml:"harnesses"`
	Environment []string `yaml:"environment"`
	Paid        bool     `yaml:"paid"`
	Enabled     *bool    `yaml:"enabled"`
}

const (
	toolFile  = "tool.yaml"
	usageFile = "USAGE.md"
	rulesFile = "rules.md"
)

var namePattern = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)

// ValidName reports whether name may name a tool (and its folder).
func ValidName(name string) bool { return namePattern.MatchString(name) }

// Dir is the catalog folder of a hopp home.
func Dir(home string) string { return filepath.Join(home, "tools") }

// Load reads every tool, sorted by name. A folder that does not validate is
// returned in broken and does not hide the others; a dotfile, a plain file
// and a folder without tool.yaml are not tools and are skipped. err is only
// for a catalog folder that cannot be read; a missing one is an empty
// catalog.
func Load(home string) (tools []Tool, broken []Broken, err error) {
	entries, err := os.ReadDir(Dir(home))
	if errors.Is(err, os.ErrNotExist) {
		return []Tool{}, nil, nil
	}
	if err != nil {
		return nil, nil, fmt.Errorf("read tool catalog: %w", err)
	}
	tools = []Tool{}
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, ".") || !e.IsDir() {
			continue
		}
		t, err := Get(home, name)
		if errors.Is(err, ErrNotFound) {
			continue
		}
		if err != nil {
			broken = append(broken, Broken{Name: name, Err: err})
			continue
		}
		tools = append(tools, t)
	}
	sort.Slice(tools, func(i, j int) bool { return tools[i].Name < tools[j].Name })
	return tools, broken, nil
}

// Get reads and validates one tool. ErrNotFound when there is no such folder
// or it has no tool.yaml; the validation error when it is broken.
func Get(home, name string) (Tool, error) {
	if name == "" || strings.ContainsAny(name, `/\`) || strings.HasPrefix(name, ".") {
		return Tool{}, fmt.Errorf("%w: %q is not a tool name", ErrNotFound, name)
	}
	dir := filepath.Join(Dir(home), name)
	data, err := os.ReadFile(filepath.Join(dir, toolFile))
	if errors.Is(err, os.ErrNotExist) {
		return Tool{}, fmt.Errorf("%w: %s", ErrNotFound, name)
	}
	if err != nil {
		return Tool{}, err
	}
	var f file
	if err := decodeStrict(data, &f); err != nil {
		return Tool{}, fmt.Errorf("%s: %w", toolFile, err)
	}
	t := Tool{Name: f.Name, Description: f.Description, Via: f.Via, Command: f.Command, MCPServer: f.MCPServer,
		Harnesses: f.Harnesses, Environment: f.Environment, Paid: f.Paid, Enabled: f.Enabled == nil || *f.Enabled, Dir: dir}
	if t.Via == "" && len(t.Command) > 0 {
		t.Via = ViaCommand
	}
	if err := validate(t, name); err != nil {
		return Tool{}, err
	}
	usage, err := os.ReadFile(filepath.Join(dir, usageFile))
	if err != nil || strings.TrimSpace(string(usage)) == "" {
		return Tool{}, fmt.Errorf("%s is missing or empty", usageFile)
	}
	t.Usage = string(usage)
	return t, nil
}

func validate(t Tool, folder string) error {
	if !namePattern.MatchString(t.Name) {
		return fmt.Errorf("name %q must match %s", t.Name, namePattern)
	}
	if t.Name != folder {
		return fmt.Errorf("name %q differs from its folder %q", t.Name, folder)
	}
	if strings.TrimSpace(t.Description) == "" {
		return errors.New("description is required")
	}
	if strings.ContainsAny(t.Description, "\r\n") {
		return errors.New("description must be one line")
	}
	switch t.Via {
	case ViaCommand:
		if len(t.Command) == 0 || strings.TrimSpace(t.Command[0]) == "" {
			return errors.New("via: command needs a non-empty command")
		}
		for _, a := range t.Command {
			if strings.ContainsRune(a, 0) {
				return errors.New("command contains NUL")
			}
		}
		if t.MCPServer != "" {
			return errors.New("via: command takes no mcp_server")
		}
	case ViaMCP:
		if strings.TrimSpace(t.MCPServer) == "" {
			return errors.New("via: mcp needs mcp_server")
		}
		if len(t.Command) > 0 {
			return errors.New("via: mcp takes no command")
		}
	case ViaGuide:
		if len(t.Command) > 0 {
			return errors.New("via: guide takes no command")
		}
		if t.MCPServer != "" {
			return errors.New("via: guide takes no mcp_server")
		}
	case "":
		return errors.New("via is missing and there is no command")
	default:
		return fmt.Errorf("via %q must be command, mcp or guide", t.Via)
	}
	for _, h := range t.Harnesses {
		if !knownHarness(h) {
			return fmt.Errorf("unknown harness %q; use one of: %s", h, strings.Join(Harnesses, ", "))
		}
	}
	return nil
}

func knownHarness(h string) bool {
	for _, k := range Harnesses {
		if k == h {
			return true
		}
	}
	return false
}

// decodeStrict decodes exactly one YAML document and refuses unknown fields.
func decodeStrict(data []byte, out any) error {
	d := yaml.NewDecoder(bytes.NewReader(data))
	d.KnownFields(true)
	if err := d.Decode(out); err != nil {
		if errors.Is(err, io.EOF) {
			return errors.New("the file is empty")
		}
		return errors.New(oneLine(err.Error()))
	}
	var extra any
	if err := d.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("expected one YAML document")
	}
	return nil
}

// oneLine turns a YAML decoder error into one readable line: "line 3:
// field colour not found; line 4: field size not found".
func oneLine(msg string) string {
	msg = strings.ReplaceAll(msg, "unmarshal errors:\n", "")
	msg = regexp.MustCompile(` in type [A-Za-z0-9_.]+`).ReplaceAllString(msg, "")
	parts := strings.Split(msg, "\n")
	space := regexp.MustCompile(`\s+`)
	for i := range parts {
		parts[i] = space.ReplaceAllString(strings.TrimSpace(parts[i]), " ")
	}
	msg = strings.Join(parts, "; ")
	msg = strings.TrimPrefix(msg, "yaml: ")
	return strings.TrimPrefix(msg, "; ")
}

// AvailableIn reports whether the tool can be used in harness: true when it
// is not limited to some harnesses, or harness is one of them.
func (t Tool) AvailableIn(harness string) bool {
	if len(t.Harnesses) == 0 {
		return true
	}
	for _, h := range t.Harnesses {
		if h == harness {
			return true
		}
	}
	return false
}

// Rules returns rules.md and when it last changed; a missing file is empty
// text and zero time.
func Rules(home string) (string, time.Time, error) {
	p := filepath.Join(Dir(home), rulesFile)
	data, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return "", time.Time{}, nil
	}
	if err != nil {
		return "", time.Time{}, err
	}
	info, err := os.Stat(p)
	if err != nil {
		return "", time.Time{}, err
	}
	return string(data), info.ModTime(), nil
}

// SetEnabled rewrites only the enabled field of a tool's tool.yaml, keeping
// every other field, its order and comments, and replaces the file
// atomically. The tool must validate before and after.
func SetEnabled(home, name string, enabled bool) error {
	if _, err := Get(home, name); err != nil {
		return err
	}
	p := filepath.Join(Dir(home), name, toolFile)
	data, err := os.ReadFile(p)
	if err != nil {
		return err
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return err
	}
	if doc.Kind != yaml.DocumentNode || len(doc.Content) != 1 || doc.Content[0].Kind != yaml.MappingNode {
		return fmt.Errorf("%s: not a mapping", toolFile)
	}
	m := doc.Content[0]
	value := "false"
	if enabled {
		value = "true"
	}
	set := false
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == "enabled" {
			m.Content[i+1].Kind, m.Content[i+1].Tag, m.Content[i+1].Value, m.Content[i+1].Style = yaml.ScalarNode, "!!bool", value, 0
			set = true
		}
	}
	if !set {
		m.Content = append(m.Content,
			&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "enabled"},
			&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: value})
	}
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(&doc); err != nil {
		return err
	}
	if err := enc.Close(); err != nil {
		return err
	}
	var check file
	if err := decodeStrict(buf.Bytes(), &check); err != nil {
		return fmt.Errorf("rewritten %s does not decode: %w", toolFile, err)
	}
	return writeAtomic(p, buf.Bytes())
}

// writeAtomic writes data to a temp file next to p and renames it over p.
func writeAtomic(p string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(p), "."+filepath.Base(p)+"-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Chmod(0o644); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), p)
}
