package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
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
