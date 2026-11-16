package cli

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"
)

func newRunCmd() *cobra.Command {
	var (
		name, profile, agent, model, effort    string
		labels, env, spawnDirs                 []string
		systemPromptFile, message, messageFile string
		permissionMode, parent                 string
		noParent, attach                       bool
	)
	cmd := &cobra.Command{
		Use:   "run [dir]",
		Short: "Launch an agent in dir (default: the current directory)",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			dir := "."
			if len(args) == 1 {
				dir = args[0]
			}
			abs, err := filepath.Abs(dir)
			if err != nil {
				return err
			}
			if noParent && parent != "" {
				return &usageError{message: "--no-parent and --parent exclude each other"}
			}
			if message != "" && messageFile != "" {
				return &usageError{message: "-m/--message and --message-file exclude each other"}
			}
			labelMap, err := parsePairs("label", labels)
			if err != nil {
				return err
			}
			envMap, err := parsePairs("env", env)
			if err != nil {
				return err
			}
			systemPrompt, err := readFileFlag(systemPromptFile)
			if err != nil {
				return err
			}
			if messageFile != "" {
				if message, err = readFileFlag(messageFile); err != nil {
					return err
				}
			}
			// Called from inside a session, the caller becomes the parent.
			// The caller is sent apart from the parent, whatever --parent or
			// --no-parent say, so the daemon applies the caller's folder limit.
			caller := os.Getenv("HOPP_SESSION_ID")
			if parent == "" && !noParent {
				parent = caller
			}
			var absDirs []string
			for _, d := range spawnDirs {
				a, err := filepath.Abs(d)
				if err != nil {
					return err
				}
				absDirs = append(absDirs, a)
			}

			body := map[string]any{"dir": abs}
			for k, v := range map[string]string{
				"id": name, "parent": parent, "caller": caller, "profile": profile, "agent": agent, "model": model, "effort": effort,
				"system_prompt": systemPrompt, "message": message, "permission_mode": permissionMode,
			} {
				if v != "" {
					body[k] = v
				}
			}
			if labelMap != nil {
				body["labels"] = labelMap
			}
			if envMap != nil {
				body["env"] = envMap
			}
			if absDirs != nil {
				body["spawn_dirs"] = absDirs
			}

			c, _, err := connect(true)
			if err != nil {
				return err
			}
			var raw json.RawMessage
			if err := c.Post("/v1/sessions", body, &raw); err != nil {
				return err
			}
			if flags.JSON {
				if err := printRaw(cmd, raw); err != nil {
					return err
				}
			} else {
				var sess struct {
					ID string `json:"id"`
				}
				if err := json.Unmarshal(raw, &sess); err != nil {
					return err
				}
				cmd.Println(sess.ID)
			}
			if attach {
				var sess struct {
					ID string `json:"id"`
				}
				if err := json.Unmarshal(raw, &sess); err != nil {
					return err
				}
				return attachTo(cmd, c, sess.ID)
			}
			return nil
		},
	}
	f := cmd.Flags()
	f.StringVar(&name, "name", "", "session id (default: derived from dir)")
	f.StringVar(&profile, "profile", "", "model profile to launch with")
	f.StringVar(&agent, "agent", "", "harness to launch (without a profile)")
	f.StringVar(&model, "model", "", "model (with --agent)")
	f.StringVar(&effort, "effort", "", "reasoning effort (with --agent)")
	f.StringArrayVar(&labels, "label", nil, "label key=value (repeatable)")
	f.StringVar(&systemPromptFile, "system-prompt-file", "", "file with the system prompt")
	f.StringVarP(&message, "message", "m", "", "first message")
	f.StringVar(&messageFile, "message-file", "", "file with the first message")
	f.StringVar(&permissionMode, "permission-mode", "", "permission mode for the harness")
	f.StringArrayVar(&env, "env", nil, "extra environment K=V (repeatable)")
	f.StringArrayVar(&spawnDirs, "spawn-dir", nil, "folder the new session may launch sessions in (repeatable; default: the caller's limit)")
	f.StringVar(&parent, "parent", "", "parent session (default: $HOPP_SESSION_ID)")
	f.BoolVar(&noParent, "no-parent", false, "launch without a parent even inside a session")
	f.BoolVar(&attach, "attach", false, "attach to the session after launch")
	return cmd
}
