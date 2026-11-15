package cli

import (
	"encoding/json"
	"fmt"
	"text/tabwriter"

	"github.com/spf13/cobra"
)

func newMailboxCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "mailbox",
		Short: "Named mailboxes: hold mail for a session id while no session of that id is running",
	}
	cmd.AddCommand(&cobra.Command{
		Use:   "add <name>",
		Short: "Register a mailbox",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, _, err := connect(true)
			if err != nil {
				return err
			}
			var ignored json.RawMessage
			if err := c.Post("/v1/mailboxes", map[string]string{"name": args[0]}, &ignored); err != nil {
				return err
			}
			cmd.Printf("mailbox %s added\n", args[0])
			return nil
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "rm <name>",
		Short: "Remove a mailbox and its mail",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, _, err := connect(true)
			if err != nil {
				return err
			}
			var ignored json.RawMessage
			if err := c.Delete(apiPath("v1", "mailboxes", args[0]), nil, &ignored); err != nil {
				return err
			}
			cmd.Printf("mailbox %s removed\n", args[0])
			return nil
		},
	})
	cmd.AddCommand(&cobra.Command{
		Use:   "ls",
		Short: "List mailboxes with their unread and total counts",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			c, _, err := connect(true)
			if err != nil {
				return err
			}
			var raw json.RawMessage
			if err := c.Get("/v1/mailboxes", nil, &raw); err != nil {
				return err
			}
			if flags.JSON {
				return printRaw(cmd, raw)
			}
			var resp struct {
				Mailboxes []struct {
					Name          string `json:"name"`
					Unread, Total int
				} `json:"mailboxes"`
			}
			if err := json.Unmarshal(raw, &resp); err != nil {
				return err
			}
			tw := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
			fmt.Fprintln(tw, "NAME\tUNREAD\tTOTAL")
			for _, b := range resp.Mailboxes {
				fmt.Fprintf(tw, "%s\t%d\t%d\n", b.Name, b.Unread, b.Total)
			}
			return tw.Flush()
		},
	})
	return cmd
}
