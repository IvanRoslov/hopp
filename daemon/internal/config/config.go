// Package config loads the hopp daemon configuration from <home>/config.yaml.
package config

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"gopkg.in/yaml.v3"
)

// DefaultInputStallThreshold is the built-in value of
// Config.InputStallThreshold — how long a session may sit on interactive
// input before it counts as stalled.
const DefaultInputStallThreshold = 10 * time.Minute

// DefaultComposerBusyDeadline is the built-in value of
// Config.ComposerBusyDeadline — how long a recipient's composer may keep
// holding an unsent draft before a queued message is delivered anyway,
// erasing it.
const DefaultComposerBusyDeadline = 10 * time.Minute

// Config represents the hopp daemon configuration.
type Config struct {
	DefaultAgent string `yaml:"default_agent"`

	HeartbeatInterval    time.Duration `yaml:"heartbeat_interval"`
	ActivityPollInterval time.Duration `yaml:"activity_poll_interval"`
	ReadyToIdle          time.Duration `yaml:"ready_to_idle"`
	QueueTimeout         time.Duration `yaml:"queue_timeout"`
	// LargeMessageThreshold is the body-size cutoff (in bytes) above which
	// deliver() writes the full message to a file in the recipient's
	// folder inbox and injects a short pointer instead of the full body
	// (see internal/queue's deliver doc comment for why: injecting large
	// pastes directly into the TUI intermittently loses them). Messages to
	// recipients without a folder always inject the full body.
	LargeMessageThreshold int `yaml:"large_message_threshold"`
	// SocketDelivery enables delivering queued messages to Claude Code
	// recipients over their cross-session UDS inbox instead of injecting text
	// into their tmux pane (see internal/queue/socket.go). Socket delivery
	// never sends C-u and never touches the recipient's composer, so it is
	// the only path that can deliver while a human is mid-draft — the draft
	// guard defers the tmux path in exactly that case.
	//
	// Any failure on the socket path falls back to tmux injection within the
	// same attempt, so turning this off costs the draft-preserving property,
	// never delivery itself. It is the escape hatch if the (reverse
	// engineered) Claude Code protocol shifts under us.
	SocketDelivery bool `yaml:"socket_delivery"`
	// ChildStallThreshold is rocket's worker_stall_threshold under a neutral
	// name: how long a child session may look stuck before its parent hears.
	ChildStallThreshold time.Duration `yaml:"child_stall_threshold"`
	// InputStallThreshold is how long a session may sit on interactive input
	// — a pending AskUserQuestion quiz, or activity "waiting_input" — before
	// it is flagged as waiting at a terminal. A zero value means "unset":
	// consumers outside a loaded config fall back to
	// DefaultInputStallThreshold.
	InputStallThreshold time.Duration `yaml:"input_stall_threshold"`
	// ComposerBusyDeadline is how long delivery to one recipient is
	// deferred while its composer holds what looks like an unsent human
	// draft (see runtime.LooksLikeUserDraft). Until it passes, the message
	// stays queued and burns no retry attempts — nothing is typed into a
	// pane someone is typing into. Once it passes, delivery proceeds the
	// old way (C-u clears the composer first), so a draft that was
	// abandoned — or a false positive of the heuristic — cannot block that
	// recipient's queue indefinitely. The global queue_timeout still
	// applies on top and eventually fails the message. A zero value means
	// "unset": consumers outside a loaded config fall back to
	// DefaultComposerBusyDeadline.
	ComposerBusyDeadline time.Duration `yaml:"composer_busy_deadline"`

	// Home is the state directory. It is not read from config.yaml.
	Home string `yaml:"-"`
	// SocketOverride replaces <home>/hopp.sock when set. It is not read
	// from config.yaml.
	SocketOverride string `yaml:"-"`
}

// Load loads the configuration from <home>/config.yaml.
// If home is empty, uses $HOPP_HOME or ~/.hopp.
// Missing config.yaml is not an error; malformed yaml is.
func Load(home string) (*Config, error) {
	// Determine home directory
	if home == "" {
		home = os.Getenv("HOPP_HOME")
		if home == "" {
			userHome, err := os.UserHomeDir()
			if err != nil {
				return nil, fmt.Errorf("failed to get user home: %w", err)
			}
			home = filepath.Join(userHome, ".hopp")
		}
	}

	// Create home directory with 0700 perms if it doesn't exist
	if err := os.MkdirAll(home, 0700); err != nil {
		return nil, fmt.Errorf("failed to create home directory: %w", err)
	}

	// Create logs directory with 0700 perms if it doesn't exist
	logsDir := filepath.Join(home, "logs")
	if err := os.MkdirAll(logsDir, 0700); err != nil {
		return nil, fmt.Errorf("failed to create logs directory: %w", err)
	}

	// Set defaults
	cfg := &Config{
		DefaultAgent:          "claude-code",
		HeartbeatInterval:     5 * time.Minute,
		ActivityPollInterval:  5 * time.Second,
		ReadyToIdle:           5 * time.Minute,
		QueueTimeout:          30 * time.Minute,
		LargeMessageThreshold: 2048,
		SocketDelivery:        true,
		ChildStallThreshold:   15 * time.Minute,
		InputStallThreshold:   DefaultInputStallThreshold,
		ComposerBusyDeadline:  DefaultComposerBusyDeadline,
		Home:                  home,
	}

	configPath := filepath.Join(home, "config.yaml")
	data, err := os.ReadFile(configPath)
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil
		}
		return nil, fmt.Errorf("failed to read config file: %w", err)
	}

	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("failed to parse config file: %w", err)
	}

	cfg.Home = home

	return cfg, nil
}

func (c *Config) SocketPath() string {
	if c.SocketOverride != "" {
		return c.SocketOverride
	}
	return filepath.Join(c.Home, "hopp.sock")
}

func (c *Config) DBPath() string {
	return filepath.Join(c.Home, "hopp.db")
}

func (c *Config) PidPath() string {
	return filepath.Join(c.Home, "hoppd.pid")
}

func (c *Config) LogPath() string {
	return filepath.Join(c.Home, "logs", "hoppd.log")
}

func (c *Config) ConfigPath() string {
	return filepath.Join(c.Home, "config.yaml")
}
