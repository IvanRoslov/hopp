package artifacts

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidName(t *testing.T) {
	for _, n := range []string{"a", "report", "spec.v2", "my_file-1", strings.Repeat("a", 80)} {
		if !ValidName(n) {
			t.Errorf("%q refused", n)
		}
	}
	for _, n := range []string{"", ".hidden", "-x", "_x", "Upper", "a b", "a/b", "é", strings.Repeat("a", 81)} {
		if ValidName(n) {
			t.Errorf("%q accepted", n)
		}
	}
}

func TestValidScope(t *testing.T) {
	for _, s := range []string{"root", "s-1", "-odd", "a.b_c"} {
		if !ValidScope(s) {
			t.Errorf("%q refused", s)
		}
	}
	for _, s := range []string{"", ".", "..", ".incoming", "a/b", "A", strings.Repeat("a", 129)} {
		if ValidScope(s) {
			t.Errorf("%q accepted", s)
		}
	}
}

func TestNameFromFile(t *testing.T) {
	for in, want := range map[string]string{
		"/x/Report.md":                           "report",
		"/x/My Spec v2.tar.gz":                   "my-spec-v2.tar",
		"/x/__init__.py":                         "init",
		"/x/.env":                                "env",
		"/x/Ünïcode.txt":                         "n-code",
		"/x/" + strings.Repeat("B", 100) + ".md": strings.Repeat("b", 80),
		"/x/....":                                "",
	} {
		if got := NameFromFile(in); got != want {
			t.Errorf("NameFromFile(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestIngestCopiesAndHashes(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "notes.md")
	content := []byte("# notes\nsome text\n")
	os.WriteFile(src, content, 0o644)
	incoming := filepath.Join(t.TempDir(), ".incoming")
	st, err := Ingest(src, incoming)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(content)
	if st.SHA256 != hex.EncodeToString(sum[:]) || st.Size != int64(len(content)) || st.Filename != "notes.md" || !strings.HasPrefix(st.Mime, "text/markdown") {
		t.Errorf("in = %+v", st)
	}
	defer st.Discard()
	got, err := os.ReadFile(st.Path)
	if err != nil || string(got) != string(content) {
		t.Errorf("in content %q, %v", got, err)
	}
	// The ingested copy is a separate file: changing the source leaves it alone.
	os.WriteFile(src, []byte("changed"), 0o644)
	if got, _ := os.ReadFile(st.Path); string(got) != string(content) {
		t.Errorf("in copy followed the source: %q", got)
	}
}

func TestIngestRefusesWhatIsNotARegularFile(t *testing.T) {
	dir := t.TempDir()
	sub := filepath.Join(dir, "sub")
	os.Mkdir(sub, 0o755)
	link := filepath.Join(dir, "link")
	os.Symlink(sub, link)
	file := filepath.Join(dir, "f.txt")
	os.WriteFile(file, []byte("x"), 0o644)
	flink := filepath.Join(dir, "flink.txt")
	os.Symlink(file, flink)
	incoming := filepath.Join(t.TempDir(), ".incoming")
	for path, want := range map[string]error{
		sub:                           ErrNotRegular,
		link:                          ErrNotRegular,
		filepath.Join(dir, "missing"): ErrNotFound,
		"relative.txt":                ErrNotAbsolute,
	} {
		if _, err := Ingest(path, incoming); !errors.Is(err, want) {
			t.Errorf("%s: %v, want %v", path, err, want)
		}
	}
	if entries, _ := os.ReadDir(incoming); len(entries) != 0 {
		t.Errorf("a refused ingest left %d files", len(entries))
	}
	// A symlink to a regular file is that file; the stored name is the link's.
	st, err := Ingest(flink, incoming)
	if err != nil || st.Filename != "flink.txt" || st.Size != 1 {
		t.Errorf("symlink to a file: %+v, %v", st, err)
	}
	st.Discard()
	if entries, _ := os.ReadDir(incoming); len(entries) != 0 {
		t.Errorf("Discard left %d entries", len(entries))
	}
}
