// Package config loads the hopp daemon configuration from <home>/config.yaml.
package config

import (
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

// Config represents the hopp daemon configuration.
type Config struct {
	DefaultAgent string `yaml:"default_agent"`

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
		DefaultAgent: "claude-code",
		Home:         home,
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
