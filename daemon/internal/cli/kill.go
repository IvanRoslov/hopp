package cli

import (
	"encoding/json"

	"github.com/spf13/cobra"
)

func newKillCmd() *cobra.Command {
	var done bool
	cmd := &cobra.Command{
		Use:   "kill <id>",
		Short: "Stop a session and its live children",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			final := "killed"
			if done {
				final = "done"
			}
			return postSessionAction(cmd, args[0], "kill", map[string]any{"final": final})
		},
	}
	cmd.Flags().BoolVar(&done, "done", false, "mark the session done instead of killed")
	return cmd
}

// postSessionAction posts body to /v1/sessions/<id>/<action> and prints the
// session it returns as "<id> <state>", or the JSON with --json.
func postSessionAction(cmd *cobra.Command, id, action string, body map[string]any) error {
	c, _, err := connect(true)
	if err != nil {
		return err
	}
	var raw json.RawMessage
	if err := c.Post(apiPath("v1", "sessions", id, action), body, &raw); err != nil {
		return err
	}
	if flags.JSON {
		return printRaw(cmd, raw)
	}
	var sess struct {
		ID    string `json:"id"`
		State string `json:"state"`
	}
	if err := json.Unmarshal(raw, &sess); err != nil {
		return err
	}
	cmd.Println(sess.ID + " " + sess.State)
	return nil
}
