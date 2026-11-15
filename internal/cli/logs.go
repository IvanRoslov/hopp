package cli

import (
	"bufio"
	"io"
	"os"

	"github.com/spf13/cobra"
)

func newLogsCmd() *cobra.Command {
	var n int

	cmd := &cobra.Command{
		Use:   "logs",
		Short: "Show the daemon log (does not start the daemon)",
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) != 0 {
				return &usageError{message: "usage: hopp logs [-n N]"}
			}

			// This command deliberately does not autostart (or even
			// contact) the daemon: it reads the log file straight off
			// disk, so it works even when hoppd isn't running.
			cfg, err := loadConfig()
			if err != nil {
				return err
			}

			logPath := cfg.LogPath()
			w := cmd.OutOrStdout()

			_, err = tailFile(logPath, n, w)
			return err
		},
	}

	cmd.Flags().IntVarP(&n, "lines", "n", 100, "number of last lines")
	return cmd
}

// tailFile prints the last n lines of the file at path to w, and returns
// the file's size at the time it was read (rocket's --follow started from
// it; hopp has no --follow yet). A missing file is treated as empty, not an
// error.
func tailFile(path string, n int, w io.Writer) (int64, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil {
		return 0, err
	}

	lines, err := lastNLines(f, n)
	if err != nil {
		return 0, err
	}
	for _, line := range lines {
		_, _ = io.WriteString(w, line+"\n")
	}
	return fi.Size(), nil
}

// lastNLines returns the last n lines of r. n <= 0 means "no lines".
func lastNLines(r io.Reader, n int) ([]string, error) {
	if n <= 0 {
		return nil, nil
	}
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	buf := make([]string, 0, n)
	for scanner.Scan() {
		buf = append(buf, scanner.Text())
		if len(buf) > n {
			buf = buf[1:]
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return buf, nil
}
