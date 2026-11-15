// Command hopp is the hopp daemon and its client.
package main

import (
	"os"

	"github.com/IvanRoslov/hopp/internal/cli"
)

func main() {
	os.Exit(cli.Execute())
}
