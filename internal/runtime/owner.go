package runtime

import (
	"context"
	"errors"
	"os/exec"
	"strings"
)

// SessionEnv reads key from the environment of the tmux session name, as
// `tmux show-environment -t =<name> <key>` reports it. ok is false when the
// session has no such variable or does not exist; err is set only when tmux
// could not be run at all. The session manager uses it to check that a tmux
// session is its own before destroying it.
func SessionEnv(ctx context.Context, name, key string) (value string, ok bool, err error) {
	out, _, err := runTmux(ctx, "show-environment", "-t", sessionTarget(name), key)
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			// Unknown variable, unknown session or no tmux server.
			return "", false, nil
		}
		return "", false, err
	}
	line := strings.TrimRight(out, "\n")
	// A variable removed from the session environment prints as "-KEY".
	v, found := strings.CutPrefix(line, key+"=")
	if !found {
		return "", false, nil
	}
	return v, true, nil
}
