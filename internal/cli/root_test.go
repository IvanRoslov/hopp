package cli

import (
	"bytes"
	"testing"

	"github.com/IvanRoslov/hopp/internal/version"
)

func TestVersionFlag(t *testing.T) {
	root := NewRootCmd()
	var out bytes.Buffer
	root.SetOut(&out)
	root.SetArgs([]string{"--version"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	if got, want := out.String(), "hopp "+version.Version+"\n"; got != want {
		t.Errorf("--version = %q, want %q", got, want)
	}
}

func TestConnectNeedsExplicitSocketUnderTest(t *testing.T) {
	flags = globalFlags{}
	if _, _, err := connect(true); err == nil {
		t.Fatal("connect without --socket succeeded under go test")
	}
}
