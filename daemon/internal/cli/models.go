package cli

import (
	"encoding/json"
	"fmt"
	"net/url"
	"text/tabwriter"

	"github.com/spf13/cobra"
)

// modelProfileRow is a profile as GET /v1/model-profiles returns it.
type modelProfileRow struct {
	Name        string `json:"name"`
	Agent       string `json:"agent"`
	Model       string `json:"model"`
	Effort      string `json:"effort"`
	Description string `json:"description"`
	Enabled     bool   `json:"enabled"`
	Position    int    `json:"position"`
}

func newModelsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "models",
		Short: "Model profiles: which agent, model and effort a launch gets",
	}
	cmd.AddCommand(newModelsLsCmd(), newModelsAddCmd(), newModelsSetCmd(), newModelsRmCmd(),
		newModelsDefaultCmd(), newModelsCatalogCmd())
	return cmd
}

func newModelsLsCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "ls",
		Short: "List the profiles; the default is marked with *",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			c, _, err := connect(true)
			if err != nil {
				return err
			}
			var raw json.RawMessage
			if err := c.Get("/v1/model-profiles", nil, &raw); err != nil {
				return err
			}
			if flags.JSON {
				return printRaw(cmd, raw)
			}
			var reg struct {
				Profiles []modelProfileRow `json:"profiles"`
				Default  string            `json:"default"`
			}
			if err := json.Unmarshal(raw, &reg); err != nil {
				return err
			}
			tw := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
			fmt.Fprintln(tw, "NAME\tAGENT\tMODEL\tEFFORT\tENABLED\tDESCRIPTION")
			for _, p := range reg.Profiles {
				name := p.Name
				if p.Name == reg.Default {
					name += " *"
				}
				enabled := "no"
				if p.Enabled {
					enabled = "yes"
				}
				fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\n", name, p.Agent, dash(p.Model), dash(p.Effort), enabled, p.Description)
			}
			return tw.Flush()
		},
	}
}

// printProfileReply prints a profile the API returned, or its JSON.
func printProfileReply(cmd *cobra.Command, raw json.RawMessage) error {
	if flags.JSON {
		return printRaw(cmd, raw)
	}
	var p modelProfileRow
	if err := json.Unmarshal(raw, &p); err != nil {
		return err
	}
	cmd.Println(p.Name)
	return nil
}

func newModelsAddCmd() *cobra.Command {
	var agentName, model, effort, description string
	cmd := &cobra.Command{
		Use:   "add <name>",
		Short: "Add a profile",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if agentName == "" {
				return &usageError{message: "usage: hopp models add <name> --agent <agent> [--model] [--effort] [--description]"}
			}
			c, _, err := connect(true)
			if err != nil {
				return err
			}
			body := map[string]any{"name": args[0], "agent": agentName, "model": model, "effort": effort, "description": description}
			var raw json.RawMessage
			if err := c.Post("/v1/model-profiles", body, &raw); err != nil {
				return err
			}
			return printProfileReply(cmd, raw)
		},
	}
	f := cmd.Flags()
	f.StringVar(&agentName, "agent", "", "harness the profile launches")
	f.StringVar(&model, "model", "", "model (empty: the agent's default)")
	f.StringVar(&effort, "effort", "", "reasoning effort (empty: the agent's default)")
	f.StringVar(&description, "description", "", "what the profile is good for")
	return cmd
}

func newModelsSetCmd() *cobra.Command {
	var model, effort, description string
	var enable, disable bool
	cmd := &cobra.Command{
		Use:   "set <name>",
		Short: "Change a profile",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if enable && disable {
				return &usageError{message: "--enable and --disable exclude each other"}
			}
			body := map[string]any{}
			f := cmd.Flags()
			if f.Changed("model") {
				body["model"] = model
			}
			if f.Changed("effort") {
				body["effort"] = effort
			}
			if f.Changed("description") {
				body["description"] = description
			}
			if enable {
				body["enabled"] = true
			}
			if disable {
				body["enabled"] = false
			}
			if len(body) == 0 {
				return &usageError{message: "usage: hopp models set <name> [--model] [--effort] [--description] [--enable|--disable]"}
			}
			c, _, err := connect(true)
			if err != nil {
				return err
			}
			var raw json.RawMessage
			if err := c.Patch(apiPath("v1", "model-profiles", args[0]), body, &raw); err != nil {
				return err
			}
			return printProfileReply(cmd, raw)
		},
	}
	f := cmd.Flags()
	f.StringVar(&model, "model", "", "model")
	f.StringVar(&effort, "effort", "", "reasoning effort")
	f.StringVar(&description, "description", "", "what the profile is good for")
	f.BoolVar(&enable, "enable", false, "allow launches with this profile")
	f.BoolVar(&disable, "disable", false, "refuse launches with this profile")
	return cmd
}

func newModelsRmCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "rm <name>",
		Short: "Delete a profile",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, _, err := connect(true)
			if err != nil {
				return err
			}
			if err := c.Delete(apiPath("v1", "model-profiles", args[0]), nil, nil); err != nil {
				return err
			}
			if flags.JSON {
				return printJSON(cmd, map[string]string{"deleted": args[0]})
			}
			cmd.Println("deleted " + args[0])
			return nil
		},
	}
}

func newModelsDefaultCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "default <name>",
		Short: "Make a profile the default for launches that name none",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, _, err := connect(true)
			if err != nil {
				return err
			}
			var raw json.RawMessage
			if err := c.Put("/v1/model-profiles/default", map[string]string{"name": args[0]}, &raw); err != nil {
				return err
			}
			if flags.JSON {
				return printRaw(cmd, raw)
			}
			cmd.Println("default " + args[0])
			return nil
		},
	}
}

func newModelsCatalogCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "catalog <agent>",
		Short: "Show the models an agent offers",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, _, err := connect(true)
			if err != nil {
				return err
			}
			var raw json.RawMessage
			if err := c.Get("/v1/model-catalog?agent="+url.QueryEscape(args[0]), nil, &raw); err != nil {
				return err
			}
			if flags.JSON {
				return printRaw(cmd, raw)
			}
			var resp struct {
				Agents []struct {
					Agent   string `json:"agent"`
					Source  string `json:"source"`
					Warning string `json:"warning"`
					Models  []struct {
						ID            string   `json:"id"`
						Name          string   `json:"name"`
						Efforts       []string `json:"efforts"`
						DefaultEffort string   `json:"default_effort"`
					} `json:"models"`
				} `json:"agents"`
			}
			if err := json.Unmarshal(raw, &resp); err != nil {
				return err
			}
			w := cmd.OutOrStdout()
			for _, a := range resp.Agents {
				fmt.Fprintf(w, "%s (source: %s)\n", a.Agent, a.Source)
				if a.Warning != "" {
					fmt.Fprintf(w, "warning: %s\n", a.Warning)
				}
				tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
				fmt.Fprintln(tw, "MODEL\tNAME\tEFFORTS\tDEFAULT")
				for _, m := range a.Models {
					efforts := "-"
					if len(m.Efforts) > 0 {
						efforts = fmt.Sprint(m.Efforts)
					}
					fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", m.ID, dash(m.Name), efforts, dash(m.DefaultEffort))
				}
				if err := tw.Flush(); err != nil {
					return err
				}
			}
			return nil
		},
	}
}
