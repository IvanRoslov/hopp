// Command hopp is the hopp daemon and its client.
package main

import (
	"fmt"
	"os"

	"github.com/IvanRoslov/hopp/internal/version"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Printf("hopp %s\n", version.Version)
		return
	}
	fmt.Fprintln(os.Stderr, "hopp: no commands yet")
	os.Exit(2)
}
