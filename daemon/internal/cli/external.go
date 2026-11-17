package cli

// External commands, git-style: `hopp <word> …` for a word that is not one
// of hopp's own commands runs the program hopp-<word>, found in
// $HOPP_HOME/bin first and then on PATH, with the rest of the arguments and
// the same environment, plus HOPP_BIN (this hopp binary). hopp knows nothing
// of what such a command does; a built-in command is never shadowed.

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"

	"github.com/spf13/cobra"
)

var externalName = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)

// execProgram replaces this process; tests swap it for a recorder.
var execProgram = syscall.Exec

// externalBin: $HOPP_HOME/bin (~/.hopp/bin by default), or "".
func externalBin() string {
	home := os.Getenv("HOPP_HOME")
	if home == "" {
		u, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		home = filepath.Join(u, ".hopp")
	}
	return filepath.Join(home, "bin")
}

// externalDirs: where hopp-<word> programs are looked for, in order.
func externalDirs() []string {
	var dirs []string
	if b := externalBin(); b != "" {
		dirs = append(dirs, b)
	}
	for _, d := range filepath.SplitList(os.Getenv("PATH")) {
		if d != "" {
			dirs = append(dirs, d)
		}
	}
	return dirs
}

func isExecutable(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.Mode().IsRegular() && st.Mode().Perm()&0o111 != 0
}

// findExternal returns the path of hopp-<word>, or "".
func findExternal(word string) string {
	for _, d := range externalDirs() {
		p := filepath.Join(d, "hopp-"+word)
		if isExecutable(p) {
			return p
		}
	}
	return ""
}

// externalCommands lists the external commands found: name → path of the
// first one (the one `hopp <name>` runs).
func externalCommands(root *cobra.Command) map[string]string {
	out := map[string]string{}
	for _, d := range externalDirs() {
		entries, err := os.ReadDir(d)
		if err != nil {
			continue
		}
		for _, e := range entries {
			name, ok := strings.CutPrefix(e.Name(), "hopp-")
			if !ok || !externalName.MatchString(name) || isBuiltin(root, name) {
				continue
			}
			if _, seen := out[name]; seen {
				continue
			}
			if p := filepath.Join(d, e.Name()); isExecutable(p) {
				out[name] = p
			}
		}
	}
	return out
}

// isBuiltin: word names one of hopp's own commands (or cobra's help and
// completion, which cobra adds when it runs).
func isBuiltin(root *cobra.Command, word string) bool {
	if word == "help" || word == "completion" {
		return true
	}
	for _, c := range root.Commands() {
		if c.Name() == word || c.HasAlias(word) {
			return true
		}
	}
	return false
}

// runExternal handles `hopp <word> …` when word is not a built-in command.
// handled is false when cobra should run the arguments as usual. On success
// it does not return: the external program replaces this process.
func runExternal(root *cobra.Command, args []string, stderr io.Writer) (code int, handled bool) {
	if len(args) == 0 || strings.HasPrefix(args[0], "-") || isBuiltin(root, args[0]) {
		return 0, false
	}
	word := args[0]
	if !externalName.MatchString(word) {
		return 0, false
	}
	path := findExternal(word)
	if path == "" {
		where := "PATH"
		if b := externalBin(); b != "" {
			where = b + " or on PATH"
		}
		fmt.Fprintf(stderr, "hopp: unknown command %q: no program hopp-%s in %s.\n", word, word, where)
		fmt.Fprintf(stderr, "Commands of the hopp desktop app are installed there when the app starts: start the hopp app once (or run `make app-install-mac`, or `make app-cli` in a checkout of hopp). `hopp --help` lists hopp's own commands and the external ones it finds; `hopp doctor` checks them.\n")
		return 3, true
	}
	env := os.Environ()
	if self, err := os.Executable(); err == nil {
		env = append(env, "HOPP_BIN="+self)
	}
	argv := append([]string{"hopp-" + word}, args[1:]...)
	if err := execProgram(path, argv, env); err != nil {
		fmt.Fprintf(stderr, "hopp: cannot run %s: %v\n", path, err)
		return 1, true
	}
	return 0, true
}

// withExternalHelp makes the root's help list the external commands found.
func withExternalHelp(root *cobra.Command) {
	base := root.HelpFunc()
	root.SetHelpFunc(func(c *cobra.Command, args []string) {
		base(c, args)
		if c != root {
			return
		}
		ext := externalCommands(root)
		if len(ext) == 0 {
			return
		}
		names := make([]string, 0, len(ext))
		width := 0
		for n := range ext {
			names = append(names, n)
			width = max(width, len(n))
		}
		sort.Strings(names)
		w := c.OutOrStdout()
		fmt.Fprintln(w, "\nExternal commands (hopp-<name> programs in $HOPP_HOME/bin or on PATH):")
		for _, n := range names {
			fmt.Fprintf(w, "  %-*s  %s\n", width, n, ext[n])
		}
		fmt.Fprintln(w, "\nRun `hopp <name> --help` for an external command's own help.")
	})
}
