package cli

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/IvanRoslov/hopp/internal/client"
	"github.com/spf13/cobra"
)

func newRmCmd() *cobra.Command {
	var recursive, ended bool
	var olderThan time.Duration
	cmd := &cobra.Command{
		Use:   "rm <session> | rm --ended [--older-than 24h]",
		Short: "Remove the record of an ended session, so its id can be used again",
		Long: "Removes an ended session (done, killed or errored) and its messages and events. A session with descendants\n" +
			"needs --recursive, and every descendant must have ended too. --ended removes every ended session whose whole\n" +
			"subtree has ended (before --older-than, when given).",
		RunE: func(cmd *cobra.Command, args []string) error {
			if ended == (len(args) == 1) || len(args) > 1 || (!ended && olderThan != 0) {
				return &usageError{message: "usage: hopp rm <session> [--recursive] | hopp rm --ended [--older-than <duration>]"}
			}
			c, _, err := connect(true)
			if err != nil {
				return err
			}
			if !ended {
				return removeOne(cmd, c, args[0], recursive)
			}
			return removeEnded(cmd, c, olderThan)
		},
	}
	cmd.Flags().BoolVar(&recursive, "recursive", false, "remove the session's ended descendants with it")
	cmd.Flags().BoolVar(&ended, "ended", false, "remove every ended session whose subtree has ended")
	cmd.Flags().DurationVar(&olderThan, "older-than", 0, "with --ended: only sessions that ended at least this long ago")
	return cmd
}

func removeOne(cmd *cobra.Command, c *client.Client, id string, recursive bool) error {
	path := apiPath("v1", "sessions", id)
	if recursive {
		path += "?recursive=1"
	}
	var resp struct {
		Removed []string `json:"removed"`
	}
	if err := c.Delete(path, nil, &resp); err != nil {
		return err
	}
	if flags.JSON {
		return printJSON(cmd, resp)
	}
	for _, r := range resp.Removed {
		cmd.Printf("removed %s\n", r)
	}
	return nil
}

// removeEnded removes, recursively, each top-most ended session whose whole
// subtree has ended (and ended before the cutoff). A subtree with a live
// session or a recent end is skipped; its ended parts that qualify on their
// own are removed as their own top-most sessions.
func removeEnded(cmd *cobra.Command, c *client.Client, olderThan time.Duration) error {
	var raw json.RawMessage
	if err := c.Get("/v1/sessions?all=1", nil, &raw); err != nil {
		return err
	}
	var resp struct {
		Sessions []struct {
			ID        string `json:"id"`
			Parent    string `json:"parent"`
			State     string `json:"state"`
			UpdatedAt int64  `json:"updated_at"`
		} `json:"sessions"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return err
	}
	cutoff := time.Now().Add(-olderThan).Unix()
	children := map[string][]string{}
	okSelf := map[string]bool{}
	parent := map[string]string{}
	for _, s := range resp.Sessions {
		children[s.Parent] = append(children[s.Parent], s.ID)
		parent[s.ID] = s.Parent
		terminal := s.State == "done" || s.State == "killed" || s.State == "errored"
		okSelf[s.ID] = terminal && (olderThan == 0 || s.UpdatedAt <= cutoff)
	}
	memo := map[string]bool{}
	var okTree func(id string) bool
	okTree = func(id string) bool {
		if v, seen := memo[id]; seen {
			return v
		}
		v := okSelf[id]
		for _, k := range children[id] {
			if !okTree(k) {
				v = false
			}
		}
		memo[id] = v
		return v
	}
	var failed int
	for _, s := range resp.Sessions {
		if !okTree(s.ID) || (s.Parent != "" && okTree(s.Parent)) {
			continue
		}
		if err := removeOne(cmd, c, s.ID, true); err != nil {
			cmd.PrintErrf("hopp: %s not removed: %v\n", s.ID, err)
			failed++
		}
	}
	if failed > 0 {
		return fmt.Errorf("%d session(s) not removed", failed)
	}
	return nil
}
