package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

// TestDeliveryDefaults carries the delivery and activity cases of rocket's
// TestLoadDefaults.
func TestDeliveryDefaults(t *testing.T) {
	cfg, err := Load(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if cfg.HeartbeatInterval != 5*time.Minute {
		t.Errorf("expected HeartbeatInterval 5m, got %v", cfg.HeartbeatInterval)
	}
	if cfg.ActivityPollInterval != 5*time.Second {
		t.Errorf("expected ActivityPollInterval 5s, got %v", cfg.ActivityPollInterval)
	}
	if cfg.ReadyToIdle != 5*time.Minute {
		t.Errorf("expected ReadyToIdle 5m, got %v", cfg.ReadyToIdle)
	}
	if cfg.QueueTimeout != 30*time.Minute {
		t.Errorf("expected QueueTimeout 30m, got %v", cfg.QueueTimeout)
	}
	if cfg.LargeMessageThreshold != 2048 {
		t.Errorf("expected LargeMessageThreshold 2048, got %d", cfg.LargeMessageThreshold)
	}
	if !cfg.SocketDelivery {
		t.Error("expected SocketDelivery to default to true")
	}
	if cfg.InputStallThreshold != 10*time.Minute {
		t.Errorf("expected InputStallThreshold 10m, got %v", cfg.InputStallThreshold)
	}
	if cfg.ComposerBusyDeadline != DefaultComposerBusyDeadline {
		t.Errorf("expected ComposerBusyDeadline %v, got %v", DefaultComposerBusyDeadline, cfg.ComposerBusyDeadline)
	}
	if cfg.ChildStallThreshold != 15*time.Minute {
		t.Errorf("expected ChildStallThreshold 15m, got %v", cfg.ChildStallThreshold)
	}
}

// TestDeliveryKeysFromYAML carries the delivery and activity cases of
// rocket's TestLoadWithConfig.
func TestDeliveryKeysFromYAML(t *testing.T) {
	home := t.TempDir()
	content := `heartbeat_interval: 10m
activity_poll_interval: 10s
ready_to_idle: 10m
queue_timeout: 1h
large_message_threshold: 4096
socket_delivery: false
input_stall_threshold: 3m
composer_busy_deadline: 2m
child_stall_threshold: 20m
`
	if err := os.WriteFile(filepath.Join(home, "config.yaml"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(home)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.HeartbeatInterval != 10*time.Minute || cfg.ActivityPollInterval != 10*time.Second ||
		cfg.ReadyToIdle != 10*time.Minute || cfg.QueueTimeout != time.Hour || cfg.LargeMessageThreshold != 4096 ||
		cfg.SocketDelivery || cfg.InputStallThreshold != 3*time.Minute || cfg.ComposerBusyDeadline != 2*time.Minute ||
		cfg.ChildStallThreshold != 20*time.Minute {
		t.Errorf("config = %+v", cfg)
	}
}
