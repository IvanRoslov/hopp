package toolcatalog

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// rocketEntry is one tool of rocket's registry.yaml.
type rocketEntry struct {
	Name        string   `yaml:"name"`
	Description string   `yaml:"description"`
	Command     []string `yaml:"command"`
	Usage       string   `yaml:"usage"`
	Environment []string `yaml:"environment"`
}

// importedFile is the tool.yaml an import writes, fields in this order.
type importedFile struct {
	Name        string   `yaml:"name"`
	Description string   `yaml:"description"`
	Via         string   `yaml:"via"`
	Command     []string `yaml:"command,flow"`
	Environment []string `yaml:"environment,omitempty,flow"`
}

// ImportResult names the tools an import created, updated and skipped.
type ImportResult struct {
	Created, Updated, Skipped []string
}

// Import creates one tool folder per entry of a registry in rocket's format
// (`tools: [{name, description, command, usage, environment}]`, decoded
// strictly): `via: command`, with usage as USAGE.md. An existing tool is
// skipped unless update, which rewrites its tool.yaml and USAGE.md and
// leaves its other files alone. The whole registry is checked before
// anything is written.
func Import(home string, data []byte, update bool) (ImportResult, error) {
	var reg struct {
		Tools []rocketEntry `yaml:"tools"`
	}
	if err := decodeStrict(data, &reg); err != nil {
		return ImportResult{}, fmt.Errorf("registry: %w", err)
	}
	seen := map[string]bool{}
	for _, e := range reg.Tools {
		t := Tool{Name: e.Name, Description: e.Description, Via: ViaCommand, Command: e.Command}
		if err := validate(t, e.Name); err != nil {
			return ImportResult{}, fmt.Errorf("registry tool %q: %w", e.Name, err)
		}
		if strings.TrimSpace(e.Usage) == "" {
			return ImportResult{}, fmt.Errorf("registry tool %q: usage is empty", e.Name)
		}
		if seen[e.Name] {
			return ImportResult{}, fmt.Errorf("registry tool %q appears twice", e.Name)
		}
		seen[e.Name] = true
	}
	var res ImportResult
	for _, e := range reg.Tools {
		dir := filepath.Join(Dir(home), e.Name)
		_, err := os.Stat(filepath.Join(dir, toolFile))
		exists := err == nil
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return res, err
		}
		if exists && !update {
			res.Skipped = append(res.Skipped, e.Name)
			continue
		}
		out, err := yaml.Marshal(importedFile{Name: e.Name, Description: e.Description, Via: ViaCommand,
			Command: e.Command, Environment: e.Environment})
		if err != nil {
			return res, err
		}
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return res, err
		}
		if err := writeAtomic(filepath.Join(dir, usageFile), []byte(e.Usage)); err != nil {
			return res, err
		}
		if err := writeAtomic(filepath.Join(dir, toolFile), out); err != nil {
			return res, err
		}
		if exists {
			res.Updated = append(res.Updated, e.Name)
		} else {
			res.Created = append(res.Created, e.Name)
		}
	}
	return res, nil
}
