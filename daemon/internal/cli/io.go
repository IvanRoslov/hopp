package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/spf13/cobra"
)

// printJSON writes v as indented JSON on stdout.
func printJSON(cmd *cobra.Command, v any) error {
	enc := json.NewEncoder(cmd.OutOrStdout())
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

// printRaw writes a JSON body the API returned, indented, on stdout.
func printRaw(cmd *cobra.Command, raw json.RawMessage) error {
	var buf bytes.Buffer
	if err := json.Indent(&buf, raw, "", "  "); err != nil {
		return err
	}
	buf.WriteByte('\n')
	_, err := cmd.OutOrStdout().Write(buf.Bytes())
	return err
}

// parsePairs parses repeated key=value flag values. A value without "=" or
// with an empty key is a usage error naming the flag.
func parsePairs(flag string, values []string) (map[string]string, error) {
	if len(values) == 0 {
		return nil, nil
	}
	out := make(map[string]string, len(values))
	for _, v := range values {
		k, val, ok := strings.Cut(v, "=")
		if !ok || k == "" {
			return nil, &usageError{message: fmt.Sprintf("--%s wants key=value, got %q", flag, v)}
		}
		out[k] = val
	}
	return out, nil
}

// readFileFlag reads the file a flag names; "" means the flag was not given.
func readFileFlag(path string) (string, error) {
	if path == "" {
		return "", nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// dash renders an empty table cell as "-".
func dash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// stdinMarker is the conventional --file value meaning "read the body from
// stdin". It exists because the shell is the enemy here: a markdown body
// passed as a positional argument gets its backticks run as command
// substitution and its $words expanded, so an agent trying to send a code
// block loses exactly the content it was quoting. A pipe (or a file) never
// reaches the shell's parser.
const stdinMarker = "-"

// readTextInput reads a text body from path, treating stdinMarker as the
// command's stdin. Content is returned verbatim — no trimming — because
// trailing newlines are part of markdown and the caller may be sending a
// whole document.
func readTextInput(cmd *cobra.Command, path string) (string, error) {
	if path == stdinMarker {
		data, err := io.ReadAll(cmd.InOrStdin())
		if err != nil {
			return "", fmt.Errorf("read stdin: %w", err)
		}
		return string(data), nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(data), nil
}
