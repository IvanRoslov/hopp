package cli

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"text/tabwriter"

	"github.com/IvanRoslov/hopp/internal/artifacts"
	"github.com/IvanRoslov/hopp/internal/client"
	"github.com/spf13/cobra"
)

// artifactView mirrors internal/api.artifactResponse.
type artifactView struct {
	ID        int64             `json:"id"`
	Scope     string            `json:"scope"`
	Name      string            `json:"name"`
	Version   int64             `json:"version"`
	Filename  string            `json:"filename"`
	Mime      string            `json:"mime"`
	Size      int64             `json:"size"`
	SHA256    string            `json:"sha256"`
	Path      string            `json:"path"`
	From      string            `json:"from"`
	Labels    map[string]string `json:"labels"`
	CreatedAt int64             `json:"created_at"`
	Unchanged bool              `json:"unchanged,omitempty"`
}

// newArtifactCmd is `hopp artifact`: publish a file as an artifact version
// and find a stored version.
func newArtifactCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "artifact",
		Short: "Publish a file as an immutable artifact version, or find one",
		Long: "An artifact is a named file the daemon keeps in immutable versions. It belongs to a scope: by\n" +
			"default the root of $HOPP_SESSION_ID's tree of sessions, so a tree shares its artifacts.",
	}
	cmd.AddCommand(newArtifactPublishCmd(), newArtifactGetCmd())
	return cmd
}

func newArtifactPublishCmd() *cobra.Command {
	var name, scope string
	var labels []string
	cmd := &cobra.Command{
		Use:   "publish <file>",
		Short: "Store a copy of a file as the next version of an artifact",
		Long: "Copies <file> into the daemon as the next version of the artifact and prints name@version. The\n" +
			"name defaults to the file name without its extension, lowercased, other characters made hyphens.\n" +
			"A file equal to the latest version stores nothing and prints that version. Inside a session the\n" +
			"version carries that session's labels; --label adds or overrides labels. Outside a session give\n" +
			"--scope.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			path, err := filepath.Abs(args[0])
			if err != nil {
				return err
			}
			if name == "" {
				if name = artifacts.NameFromFile(path); name == "" {
					return &usageError{message: fmt.Sprintf("no artifact name can be made from %q: give --name", filepath.Base(path))}
				}
			}
			if !artifacts.ValidName(name) {
				return &usageError{message: fmt.Sprintf("--name must match ^[a-z0-9][a-z0-9._-]*$ with at most %d characters, got %q", artifacts.MaxNameLen, name)}
			}
			lbl, err := parsePairs("label", labels)
			if err != nil {
				return err
			}
			from := os.Getenv("HOPP_SESSION_ID")
			if from == "" && scope == "" {
				return &usageError{message: "no scope: run inside a session or give --scope"}
			}
			req := map[string]any{"name": name, "path": path}
			if from != "" {
				req["from"] = from
			}
			if scope != "" {
				req["scope"] = scope
			}
			if lbl != nil {
				req["labels"] = lbl
			}
			c, _, err := connect(true)
			if err != nil {
				return err
			}
			var a artifactView
			if err := c.Post("/v1/artifacts", req, &a); err != nil {
				return err
			}
			if flags.JSON {
				return printJSON(cmd, a)
			}
			cmd.Printf("%s@%d\n", a.Name, a.Version)
			if a.Unchanged {
				cmd.PrintErrf("unchanged: the file equals %s@%d, nothing stored\n", a.Name, a.Version)
			}
			return nil
		},
	}
	f := cmd.Flags()
	f.StringVar(&name, "name", "", "artifact name (default: from the file name)")
	f.StringArrayVar(&labels, "label", nil, "label key=value (repeatable)")
	f.StringVar(&scope, "scope", "", "scope (default: the root session of $HOPP_SESSION_ID)")
	return cmd
}

func newArtifactGetCmd() *cobra.Command {
	var scope string
	cmd := &cobra.Command{
		Use:   "get <name>[@<version>]",
		Short: "Print where the daemon stored an artifact version (the latest by default)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			name, ver, hasVer := strings.Cut(args[0], "@")
			var version int64
			if hasVer {
				n, err := strconv.ParseInt(ver, 10, 64)
				if err != nil || n < 1 {
					return &usageError{message: fmt.Sprintf("a version is a number from 1, got %q", ver)}
				}
				version = n
			}
			if !artifacts.ValidName(name) {
				return &usageError{message: fmt.Sprintf("not an artifact name: %q", name)}
			}
			if scope == "" && os.Getenv("HOPP_SESSION_ID") == "" {
				return &usageError{message: "no scope: run inside a session or give --scope"}
			}
			c, _, err := connect(true)
			if err != nil {
				return err
			}
			if scope == "" {
				if scope, err = rootSession(c, os.Getenv("HOPP_SESSION_ID")); err != nil {
					return err
				}
			}
			q := url.Values{"scope": {scope}, "name": {name}, "versions": {"1"}}
			var resp struct {
				Artifacts []artifactView `json:"artifacts"`
			}
			if err := c.Get("/v1/artifacts?"+q.Encode(), nil, &resp); err != nil {
				return err
			}
			var found *artifactView
			for i, a := range resp.Artifacts {
				if (version == 0 && (found == nil || a.Version > found.Version)) || a.Version == version {
					found = &resp.Artifacts[i]
				}
			}
			if found == nil {
				return fmt.Errorf("no artifact %s in scope %s", args[0], scope)
			}
			if flags.JSON {
				return printJSON(cmd, found)
			}
			cmd.Println(found.Path)
			return nil
		},
	}
	cmd.Flags().StringVar(&scope, "scope", "", "scope (default: the root session of $HOPP_SESSION_ID)")
	return cmd
}

// newArtifactsCmd is `hopp artifacts`: list artifacts, the latest version of
// each name unless --all-versions.
func newArtifactsCmd() *cobra.Command {
	var allVersions bool
	var labels []string
	var scope string
	cmd := &cobra.Command{
		Use:   "artifacts",
		Short: "List artifacts (the latest version of each name unless --all-versions)",
		Long: "Lists the artifacts of a scope: --scope, else the root session of $HOPP_SESSION_ID; outside a\n" +
			"session without --scope, every scope.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if _, err := parsePairs("label", labels); err != nil {
				return err
			}
			c, _, err := connect(true)
			if err != nil {
				return err
			}
			if from := os.Getenv("HOPP_SESSION_ID"); scope == "" && from != "" {
				if scope, err = rootSession(c, from); err != nil {
					return err
				}
			}
			q := url.Values{}
			if scope != "" {
				q.Set("scope", scope)
			}
			if allVersions {
				q.Set("versions", "1")
			}
			for _, l := range labels {
				q.Add("label", l)
			}
			path := "/v1/artifacts"
			if enc := q.Encode(); enc != "" {
				path += "?" + enc
			}
			var raw json.RawMessage
			if err := c.Get(path, nil, &raw); err != nil {
				return err
			}
			if flags.JSON {
				return printRaw(cmd, raw)
			}
			var resp struct {
				Artifacts []artifactView `json:"artifacts"`
			}
			if err := json.Unmarshal(raw, &resp); err != nil {
				return err
			}
			tw := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 4, 2, ' ', 0)
			fmt.Fprintln(tw, "ARTIFACT\tSCOPE\tSIZE\tAGE\tFROM\tFILE")
			for _, a := range resp.Artifacts {
				fmt.Fprintf(tw, "%s@%d\t%s\t%s\t%s\t%s\t%s\n", a.Name, a.Version, a.Scope, sizeText(a.Size), age(a.CreatedAt), dash(a.From), a.Filename)
			}
			return tw.Flush()
		},
	}
	f := cmd.Flags()
	f.BoolVar(&allVersions, "all-versions", false, "list every version, not only the latest")
	f.StringArrayVar(&labels, "label", nil, "only artifacts with label key=value (repeatable)")
	f.StringVar(&scope, "scope", "", "scope (default: the root session of $HOPP_SESSION_ID)")
	return cmd
}

// rootSession follows parent from session id to the root of its tree.
func rootSession(c *client.Client, id string) (string, error) {
	for range 10000 {
		var s struct {
			ID     string `json:"id"`
			Parent string `json:"parent"`
		}
		if err := c.Get(apiPath("v1", "sessions", id), nil, &s); err != nil {
			return "", fmt.Errorf("session %s: %w", id, err)
		}
		if s.Parent == "" {
			return id, nil
		}
		id = s.Parent
	}
	return "", fmt.Errorf("session %s: parent chain does not end", id)
}

// sizeText renders a byte count in B, KiB or MiB.
func sizeText(n int64) string {
	switch {
	case n < 1024:
		return fmt.Sprintf("%dB", n)
	case n < 1024*1024:
		return fmt.Sprintf("%.1fK", float64(n)/1024)
	default:
		return fmt.Sprintf("%.1fM", float64(n)/(1024*1024))
	}
}
