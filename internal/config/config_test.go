package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadDefaults(t *testing.T) {
	home := filepath.Join(t.TempDir(), "hopp")
	cfg, err := Load(home)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DefaultAgent != "claude-code" {
		t.Errorf("DefaultAgent = %q, want claude-code", cfg.DefaultAgent)
	}
	for name, got := range map[string]string{
		"/hopp.sock":      cfg.SocketPath(),
		"/hopp.db":        cfg.DBPath(),
		"/hoppd.pid":      cfg.PidPath(),
		"/logs/hoppd.log": cfg.LogPath(),
		"/config.yaml":    cfg.ConfigPath(),
	} {
		if !strings.HasSuffix(got, name) || !strings.HasPrefix(got, home) {
			t.Errorf("path %q does not end with %s under %s", got, name, home)
		}
	}
	info, err := os.Stat(home)
	if err != nil {
		t.Fatal(err)
	}
	if !info.IsDir() || info.Mode().Perm() != 0o700 {
		t.Errorf("home mode = %v, want a 0700 directory", info.Mode())
	}
	if info, err := os.Stat(filepath.Join(home, "logs")); err != nil || !info.IsDir() {
		t.Errorf("logs dir: %v", err)
	}
}

func TestLoadReadsYAML(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "config.yaml"), []byte("default_agent: codex\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(home)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DefaultAgent != "codex" {
		t.Errorf("DefaultAgent = %q, want codex", cfg.DefaultAgent)
	}
}

func TestLoadRejectsMalformedYAML(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "config.yaml"), []byte("default_agent: [\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(home); err == nil {
		t.Fatal("malformed config.yaml was accepted")
	}
}

func TestHomeFromEnv(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOPP_HOME", dir)
	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Home != dir {
		t.Errorf("Home = %q, want %q", cfg.Home, dir)
	}
}

func TestHomeDefaultsToDotHopp(t *testing.T) {
	user := t.TempDir()
	t.Setenv("HOPP_HOME", "")
	t.Setenv("HOME", user)
	cfg, err := Load("")
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(user, ".hopp"); cfg.Home != want {
		t.Errorf("Home = %q, want %q", cfg.Home, want)
	}
}

func TestSocketOverride(t *testing.T) {
	cfg, err := Load(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	cfg.SocketOverride = "/tmp/other.sock"
	if got := cfg.SocketPath(); got != "/tmp/other.sock" {
		t.Errorf("SocketPath = %q, want the override", got)
	}
}
