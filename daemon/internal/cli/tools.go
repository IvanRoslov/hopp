package cli

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"text/tabwriter"

	"github.com/IvanRoslov/hopp/internal/toolcatalog"
	"github.com/spf13/cobra"
)

// paidNotice opens `hopp tools show` of a paid tool.
const paidNotice = "PAID: ask the human with hopp ask and wait for Go before each call or enumerated batch."

// toolView is the JSON shape of a tool; lists are never null.
type toolView struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Via         string   `json:"via"`
	Command     []string `json:"command"`
	MCPServer   string   `json:"mcp_server"`
	Harnesses   []string `json:"harnesses"`
	Environment []string `json:"environment"`
	Paid        bool     `json:"paid"`
	Enabled     bool     `json:"enabled"`
	Dir         string   `json:"dir"`
	Usage       *string  `json:"usage,omitempty"`
}

func toToolView(t toolcatalog.Tool) toolView {
	list := func(l []string) []string {
		if l == nil {
			return []string{}
		}
		return l
	}
	return toolView{Name: t.Name, Description: t.Description, Via: t.Via, Command: list(t.Command), MCPServer: t.MCPServer,
		Harnesses: list(t.Harnesses), Environment: list(t.Environment), Paid: t.Paid, Enabled: t.Enabled, Dir: t.Dir}
}

// toolsHomeDir is the hopp home of the other commands ($HOPP_HOME or
// ~/.hopp). The tools commands read files there; they never contact the
// daemon.
func toolsHomeDir() (string, error) {
	cfg, err := loadConfig()
	if err != nil {
		return "", err
	}
	return cfg.Home, nil
}

func newToolsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "tools",
		Short: "Read the tool catalog: what tools exist and how to use them (no daemon needed)",
		Long: "The tool catalog is one folder per tool under <hopp home>/tools, with tool.yaml and USAGE.md,\n" +
			"and the human's rules in rules.md. hopp only describes tools: it never runs them, keeps no\n" +
			"secrets and blocks nothing.",
		Args: cobra.NoArgs,
	}
	cmd.AddCommand(newToolsListCmd(), newToolsShowCmd(), newToolsRulesCmd(),
		newToolsSwitchCmd("enable", true), newToolsSwitchCmd("disable", false),
		newToolsPathCmd(), newToolsCheckCmd())
	return cmd
}

// loadTools loads the catalog and names each broken tool on stderr.
func loadTools(cmd *cobra.Command) (string, []toolcatalog.Tool, []toolcatalog.Broken, error) {
	home, err := toolsHomeDir()
	if err != nil {
		return "", nil, nil, err
	}
	tools, broken, err := toolcatalog.Load(home)
	if err != nil {
		return "", nil, nil, err
	}
	for _, b := range broken {
		cmd.PrintErrf("hopp: tool %s is broken: %v\n", b.Name, b.Err)
	}
	return home, tools, broken, nil
}

func checkHarnessFlag(h string) error {
	if h == "" {
		return nil
	}
	for _, k := range toolcatalog.Harnesses {
		if k == h {
			return nil
		}
	}
	return &usageError{message: fmt.Sprintf("unknown harness %q; use one of: %s", h, strings.Join(toolcatalog.Harnesses, ", "))}
}

func newToolsListCmd() *cobra.Command {
	var all bool
	var harness string
	cmd := &cobra.Command{
		Use:   "list",
		Short: "List switched-on tools (--all: every tool)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := checkHarnessFlag(harness); err != nil {
				return err
			}
			_, tools, broken, err := loadTools(cmd)
			if err != nil {
				return err
			}
			var shown []toolcatalog.Tool
			for _, t := range tools {
				if (all || t.Enabled) && (harness == "" || t.AvailableIn(harness)) {
					shown = append(shown, t)
				}
			}
			if flags.JSON {
				out := struct {
					Tools  []toolView          `json:"tools"`
					Broken []map[string]string `json:"broken"`
				}{Tools: []toolView{}, Broken: []map[string]string{}}
				for _, t := range shown {
					out.Tools = append(out.Tools, toToolView(t))
				}
				for _, b := range broken {
					out.Broken = append(out.Broken, map[string]string{"name": b.Name, "error": b.Err.Error()})
				}
				return printJSON(cmd, out)
			}
			tw := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
			fmt.Fprintln(tw, "NAME\tVIA\tFLAGS\tDESCRIPTION")
			for _, t := range shown {
				var fl []string
				if t.Paid {
					fl = append(fl, "paid")
				}
				if !t.Enabled {
					fl = append(fl, "off")
				}
				fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", t.Name, t.Via, dash(strings.Join(fl, ",")), t.Description)
			}
			return tw.Flush()
		},
	}
	cmd.Flags().BoolVar(&all, "all", false, "include tools the human switched off")
	cmd.Flags().StringVar(&harness, "harness", "", "only tools available in this harness")
	return cmd
}

// getTool reads one tool and turns a missing one into a readable error.
func getTool(home, name string) (toolcatalog.Tool, error) {
	t, err := toolcatalog.Get(home, name)
	if errors.Is(err, toolcatalog.ErrNotFound) {
		return t, fmt.Errorf("no tool %s in the catalog %s", name, toolcatalog.Dir(home))
	}
	if err != nil {
		return t, fmt.Errorf("tool %s is broken: %w", name, err)
	}
	return t, nil
}

func newToolsShowCmd() *cobra.Command {
	var all bool
	cmd := &cobra.Command{
		Use:   "show <name>",
		Short: "Show a tool's card and its USAGE.md",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			home, err := toolsHomeDir()
			if err != nil {
				return err
			}
			t, err := getTool(home, args[0])
			if err != nil {
				return err
			}
			if !t.Enabled && !all {
				return fmt.Errorf("tool %s is switched off by the human", t.Name)
			}
			if flags.JSON {
				v := toToolView(t)
				v.Usage = &t.Usage
				return printJSON(cmd, v)
			}
			if t.Paid {
				cmd.Println(paidNotice)
			}
			cmd.Printf("%s — %s\n", t.Name, t.Description)
			switch t.Via {
			case toolcatalog.ViaCommand:
				cmd.Printf("via: command: %s\n", quoteArgs(t.Command))
			case toolcatalog.ViaMCP:
				cmd.Printf("via: MCP server %s (connected by the human; hopp does not connect it)\n", t.MCPServer)
			default:
				cmd.Println("via: guide (instructions only)")
			}
			if len(t.Harnesses) > 0 {
				cmd.Printf("harnesses: %s\n", strings.Join(t.Harnesses, ", "))
			}
			if len(t.Environment) > 0 {
				cmd.Printf("environment: %s\n", strings.Join(t.Environment, ", "))
			}
			if !t.Enabled {
				cmd.Println("switched off by the human")
			}
			cmd.Printf("folder: %s\n\n", t.Dir)
			cmd.Print(t.Usage)
			if !strings.HasSuffix(t.Usage, "\n") {
				cmd.Println()
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&all, "all", false, "show a tool even when the human switched it off")
	return cmd
}

// quoteArgs renders argv for a human: words with spaces or quotes are put
// in single quotes.
func quoteArgs(argv []string) string {
	out := make([]string, len(argv))
	for i, a := range argv {
		if a == "" || strings.ContainsAny(a, " \t\n'\"\\$`*?;&|<>()") {
			a = "'" + strings.ReplaceAll(a, "'", `'\''`) + "'"
		}
		out[i] = a
	}
	return strings.Join(out, " ")
}

func newToolsRulesCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "rules",
		Short: "Print the human's rules for choosing tools (rules.md)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			home, err := toolsHomeDir()
			if err != nil {
				return err
			}
			text, mod, err := toolcatalog.Rules(home)
			if err != nil {
				return err
			}
			if flags.JSON {
				var ts int64
				if !mod.IsZero() {
					ts = mod.Unix()
				}
				return printJSON(cmd, map[string]any{"text": text, "modified_at": ts})
			}
			cmd.Print(text)
			return nil
		},
	}
}

func newToolsSwitchCmd(use string, enabled bool) *cobra.Command {
	short := "Switch tools on"
	if !enabled {
		short = "Switch tools off"
	}
	return &cobra.Command{
		Use:   use + " <name>...",
		Short: short,
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) == 0 {
				return &usageError{message: "name at least one tool"}
			}
			home, err := toolsHomeDir()
			if err != nil {
				return err
			}
			// Every name must be a sound tool before anything changes.
			var change []string
			for _, n := range args {
				t, err := getTool(home, n)
				if err != nil {
					return err
				}
				if t.Enabled != enabled {
					change = append(change, n)
				}
			}
			for _, n := range change {
				if err := toolcatalog.SetEnabled(home, n, enabled); err != nil {
					return err
				}
				cmd.Println(n)
			}
			return nil
		},
	}
}

func newToolsPathCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "path [name]",
		Short: "Print the catalog folder, or the folder a tool has (or would have)",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			home, err := toolsHomeDir()
			if err != nil {
				return err
			}
			if len(args) == 0 {
				cmd.Println(toolcatalog.Dir(home))
				return nil
			}
			if !toolcatalog.ValidName(args[0]) {
				return &usageError{message: fmt.Sprintf("%q is not a tool name: use lowercase letters, digits and dashes, starting with a letter", args[0])}
			}
			cmd.Println(filepath.Join(toolcatalog.Dir(home), args[0]))
			return nil
		},
	}
}

func newToolsCheckCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "check [name]",
		Short: "Check tools: their files, that the command exists, that the environment is set",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			home, err := toolsHomeDir()
			if err != nil {
				return err
			}
			var tools []toolcatalog.Tool
			var problems []string
			if len(args) == 1 {
				t, err := toolcatalog.Get(home, args[0])
				switch {
				case errors.Is(err, toolcatalog.ErrNotFound):
					return fmt.Errorf("no tool %s in the catalog %s", args[0], toolcatalog.Dir(home))
				case err != nil:
					problems = append(problems, fmt.Sprintf("%s: %v", args[0], err))
				default:
					tools = append(tools, t)
				}
			} else {
				all, broken, err := toolcatalog.Load(home)
				if err != nil {
					return err
				}
				tools = all
				for _, b := range broken {
					problems = append(problems, fmt.Sprintf("%s: %v", b.Name, b.Err))
				}
			}
			for _, t := range tools {
				problems = append(problems, toolProblems(t)...)
			}
			for _, p := range problems {
				cmd.Println(p)
			}
			if len(problems) > 0 {
				return fmt.Errorf("%d problem(s) found", len(problems))
			}
			cmd.Printf("ok: %d tool(s)\n", len(tools))
			return nil
		},
	}
}

// toolProblems checks what validation cannot: that a command's program
// exists and that the named environment variables are set.
func toolProblems(t toolcatalog.Tool) []string {
	var out []string
	if t.Via == toolcatalog.ViaCommand {
		prog := t.Command[0]
		switch {
		case filepath.IsAbs(prog):
			if info, err := os.Stat(prog); err != nil {
				out = append(out, fmt.Sprintf("%s: command %s does not exist", t.Name, prog))
			} else if info.IsDir() || info.Mode()&0o111 == 0 {
				out = append(out, fmt.Sprintf("%s: command %s is not executable", t.Name, prog))
			}
		case strings.ContainsRune(prog, filepath.Separator):
			out = append(out, fmt.Sprintf("%s: command %s is a relative path; use an absolute path or a name on PATH", t.Name, prog))
		default:
			if _, err := exec.LookPath(prog); err != nil {
				out = append(out, fmt.Sprintf("%s: command %s is not on PATH", t.Name, prog))
			}
		}
	}
	for _, e := range t.Environment {
		if os.Getenv(e) == "" {
			out = append(out, fmt.Sprintf("%s: environment variable %s is not set", t.Name, e))
		}
	}
	return out
}
