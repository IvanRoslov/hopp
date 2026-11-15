package cli

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"text/tabwriter"

	"github.com/spf13/cobra"
)

type sessionRow struct {
	ID       string `json:"id"`
	Parent   string `json:"parent"`
	Dir      string `json:"dir"`
	Agent    string `json:"agent"`
	Model    string `json:"model"`
	State    string `json:"state"`
	Activity string `json:"activity"`
}

func newLsCmd() *cobra.Command {
	var (
		all, mine bool
		parent    string
		labels    []string
	)
	cmd := &cobra.Command{
		Use:   "ls",
		Short: "List sessions (live ones unless --all)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			q := url.Values{}
			if all {
				q.Set("all", "1")
			}
			if mine {
				me := os.Getenv("HOPP_SESSION_ID")
				if me == "" {
					return &usageError{message: "--mine needs $HOPP_SESSION_ID (run it from inside a session)"}
				}
				if parent != "" {
					return &usageError{message: "--mine and --parent exclude each other"}
				}
				parent = me
			}
			if parent != "" {
				q.Set("parent", parent)
			}
			if _, err := parsePairs("label", labels); err != nil {
				return err
			}
			for _, l := range labels {
				q.Add("label", l)
			}
			path := "/v1/sessions"
			if enc := q.Encode(); enc != "" {
				path += "?" + enc
			}

			c, _, err := connect(true)
			if err != nil {
				return err
			}
			var raw json.RawMessage
			if err := c.Get(path, nil, &raw); err != nil {
				return err
			}
			if flags.JSON {
				return printRaw(cmd, raw)
			}
			var resp struct {
				Sessions []sessionRow `json:"sessions"`
			}
			if err := json.Unmarshal(raw, &resp); err != nil {
				return err
			}
			tw := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
			fmt.Fprintln(tw, "ID\tPARENT\tAGENT\tMODEL\tSTATE\tACTIVITY\tDIR")
			for _, s := range resp.Sessions {
				fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
					s.ID, dash(s.Parent), dash(s.Agent), dash(s.Model), s.State, dash(s.Activity), s.Dir)
			}
			return tw.Flush()
		},
	}
	f := cmd.Flags()
	f.BoolVar(&all, "all", false, "include stopped sessions")
	f.StringVar(&parent, "parent", "", "only children of this session")
	f.StringArrayVar(&labels, "label", nil, "only sessions with label key=value (repeatable)")
	f.BoolVar(&mine, "mine", false, "only children of $HOPP_SESSION_ID")
	return cmd
}
