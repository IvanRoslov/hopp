package toolcatalog

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

const registry = `tools:
  - name: obscura
    description: Headless browser in one binary
    command: [/opt/obscura/bin/obscura]
    usage: |
      obscura fetch URL
    environment: [OBSCURA_TOKEN]
  - name: pdfx
    description: Extract text from PDF
    command: [pdfx, --plain]
    usage: pdfx FILE
`

func TestImportCreatesSkipsAndUpdates(t *testing.T) {
	home := t.TempDir()
	res, err := Import(home, []byte(registry), false)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(res.Created, []string{"obscura", "pdfx"}) || len(res.Updated)+len(res.Skipped) != 0 {
		t.Fatalf("first import = %+v", res)
	}
	tl, err := Get(home, "obscura")
	if err != nil {
		t.Fatal(err)
	}
	if tl.Via != ViaCommand || !reflect.DeepEqual(tl.Command, []string{"/opt/obscura/bin/obscura"}) || tl.Usage != "obscura fetch URL\n" ||
		!reflect.DeepEqual(tl.Environment, []string{"OBSCURA_TOKEN"}) || !tl.Enabled || tl.Paid {
		t.Errorf("imported = %+v", tl)
	}
	// A file of the tool's own and a hand switch survive a skip and an update.
	own := filepath.Join(tl.Dir, "bin", "own")
	os.MkdirAll(filepath.Dir(own), 0o755)
	os.WriteFile(own, []byte("mine"), 0o755)
	changed := []byte("tools:\n  - name: pdfx\n    description: New text\n    command: [pdfx]\n    usage: new usage\n")
	res, err = Import(home, changed, false)
	if err != nil || !reflect.DeepEqual(res.Skipped, []string{"pdfx"}) || len(res.Created)+len(res.Updated) != 0 {
		t.Fatalf("second import = %+v, %v", res, err)
	}
	if p, _ := Get(home, "pdfx"); p.Description != "Extract text from PDF" {
		t.Errorf("a skip changed the tool: %+v", p)
	}
	res, err = Import(home, changed, true)
	if err != nil || !reflect.DeepEqual(res.Updated, []string{"pdfx"}) {
		t.Fatalf("update = %+v, %v", res, err)
	}
	if p, _ := Get(home, "pdfx"); p.Description != "New text" || p.Usage != "new usage" {
		t.Errorf("after update: %+v", p)
	}
	if b, err := os.ReadFile(own); err != nil || string(b) != "mine" {
		t.Errorf("update touched the tool's own file: %q %v", b, err)
	}
}

func TestImportRejectsBadRegistryAndWritesNothing(t *testing.T) {
	for name, data := range map[string]string{
		"unknown field": "tools:\n  - name: a\n    description: d\n    command: [a]\n    usage: u\n    price: 3\n",
		"no usage":      "tools:\n  - name: a\n    description: d\n    command: [a]\n",
		"bad second":    "tools:\n  - name: a\n    description: d\n    command: [a]\n    usage: u\n  - name: B\n    description: d\n    command: [b]\n    usage: u\n",
		"duplicate":     "tools:\n  - name: a\n    description: d\n    command: [a]\n    usage: u\n  - name: a\n    description: d\n    command: [a]\n    usage: u\n",
	} {
		home := t.TempDir()
		if _, err := Import(home, []byte(data), false); err == nil {
			t.Errorf("%s: no error", name)
		}
		if _, err := os.Stat(Dir(home)); err == nil {
			t.Errorf("%s: something was written", name)
		}
	}
}
