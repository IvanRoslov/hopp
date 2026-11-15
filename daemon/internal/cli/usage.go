package cli

import (
	"encoding/json"
	"fmt"
	"net/url"
	"text/tabwriter"

	"github.com/spf13/cobra"
)

// usageRow mirrors internal/api.usageRowResponse.
type usageRow struct {
	Session    string `json:"session"`
	Parent     string `json:"parent"`
	Status     string `json:"status"`
	Final      bool   `json:"final"`
	Model      string `json:"model"`
	Input      int64  `json:"input"`
	CacheWrite int64  `json:"cache_write"`
	CacheRead  int64  `json:"cache_read"`
	Output     int64  `json:"output"`
	Reasoning  int64  `json:"reasoning"`
	Messages   int64  `json:"messages"`
}

func newUsageCmd() *cobra.Command {
	var session, tree string
	var labels []string
	var collect bool
	cmd := &cobra.Command{
		Use:   "usage",
		Short: "Show token usage per session and model",
		Long: "Shows the tokens each session's agent used, per model, with a total. --tree sums a session and all its\n" +
			"descendants. --collect reads live sessions (or the --session) first instead of the last collection.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if session != "" && tree != "" {
				return &usageError{message: "--session and --tree exclude each other"}
			}
			if _, err := parsePairs("label", labels); err != nil {
				return err
			}
			c, _, err := connect(true)
			if err != nil {
				return err
			}
			if collect {
				body := map[string]any{"all": true}
				if session != "" {
					body = map[string]any{"session": session}
				}
				var ignored json.RawMessage
				if err := c.Post("/v1/usage/collect", body, &ignored); err != nil {
					return err
				}
			}
			q := url.Values{}
			if session != "" {
				q.Set("session", session)
			}
			for _, l := range labels {
				q.Add("label", l)
			}
			path := "/v1/usage"
			if enc := q.Encode(); enc != "" {
				path += "?" + enc
			}
			var raw json.RawMessage
			if err := c.Get(path, nil, &raw); err != nil {
				return err
			}
			var resp struct {
				Rows []usageRow `json:"rows"`
			}
			if err := json.Unmarshal(raw, &resp); err != nil {
				return err
			}
			rows := resp.Rows
			if tree != "" {
				rows = subtreeRows(rows, tree)
			}
			if flags.JSON {
				return printJSON(cmd, map[string]any{"rows": rows})
			}
			printUsage(cmd, rows)
			return nil
		},
	}
	cmd.Flags().StringVar(&session, "session", "", "only this session")
	cmd.Flags().StringVar(&tree, "tree", "", "this session and all its descendants, with their total")
	cmd.Flags().StringArrayVar(&labels, "label", nil, "only sessions with label key=value (repeatable)")
	cmd.Flags().BoolVar(&collect, "collect", false, "collect live sessions (or --session) first")
	return cmd
}

// subtreeRows keeps the rows of root and every session below it.
func subtreeRows(rows []usageRow, root string) []usageRow {
	parent := map[string]string{}
	for _, r := range rows {
		parent[r.Session] = r.Parent
	}
	in := func(id string) bool {
		for seen := 0; id != "" && seen <= len(parent); seen++ {
			if id == root {
				return true
			}
			id = parent[id]
		}
		return false
	}
	var out []usageRow
	for _, r := range rows {
		if in(r.Session) {
			out = append(out, r)
		}
	}
	return out
}

// printUsage prints one line per session and model and a TOTAL line. A
// session without counted tokens shows its collection status instead.
func printUsage(cmd *cobra.Command, rows []usageRow) {
	tw := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "SESSION\tMODEL\tINPUT\tCACHE_W\tCACHE_R\tOUTPUT\tREASON\tMSGS\tSTATUS")
	var total usageRow
	for _, r := range rows {
		status := r.Status
		if status == "" {
			status = "not collected"
		}
		if r.Final {
			status += " final"
		}
		fmt.Fprintf(tw, "%s\t%s\t%d\t%d\t%d\t%d\t%d\t%d\t%s\n", r.Session, dash(r.Model),
			r.Input, r.CacheWrite, r.CacheRead, r.Output, r.Reasoning, r.Messages, status)
		total.Input += r.Input
		total.CacheWrite += r.CacheWrite
		total.CacheRead += r.CacheRead
		total.Output += r.Output
		total.Reasoning += r.Reasoning
		total.Messages += r.Messages
	}
	fmt.Fprintf(tw, "TOTAL\t\t%d\t%d\t%d\t%d\t%d\t%d\t\n", total.Input, total.CacheWrite, total.CacheRead, total.Output, total.Reasoning, total.Messages)
	tw.Flush()
}
