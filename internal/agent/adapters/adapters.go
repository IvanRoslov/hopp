// Package adapters registers every harness adapter with the agent registry.
// Import it once for the side effect to get the full registry.
package adapters

import (
	_ "github.com/IvanRoslov/hopp/internal/agent/claudecode"
	_ "github.com/IvanRoslov/hopp/internal/agent/codex"
	_ "github.com/IvanRoslov/hopp/internal/agent/deepseek"
	_ "github.com/IvanRoslov/hopp/internal/agent/kimicode"
	_ "github.com/IvanRoslov/hopp/internal/agent/pi"
)
