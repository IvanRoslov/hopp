// Package artifacts keeps the files of published artifacts: a named file
// stored by the daemon in immutable versions. It checks names and scopes,
// and copies a source file into an incoming file (a copy-on-write clone where
// the file system can) whose size and sha256 are those of the stored bytes.
package artifacts

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// MaxNameLen is the longest artifact name.
const MaxNameLen = 80

var (
	namePattern  = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*$`)
	scopePattern = regexp.MustCompile(`^[a-z0-9-][a-z0-9._-]{0,127}$`)
	badNameRune  = regexp.MustCompile(`[^a-z0-9._-]+`)
)

// textTypes are the mime types of text files that the system's mime table
// may not know, so they do not depend on the machine.
var textTypes = map[string]string{
	".md":       "text/markdown; charset=utf-8",
	".markdown": "text/markdown; charset=utf-8",
	".yaml":     "application/yaml",
	".yml":      "application/yaml",
}

// Errors of Ingest.
var (
	ErrNotAbsolute = errors.New("path is not absolute")
	ErrNotFound    = errors.New("file not found")
	ErrNotRegular  = errors.New("not a regular file")
)

// ValidName reports whether name may name an artifact.
func ValidName(name string) bool {
	return len(name) <= MaxNameLen && namePattern.MatchString(name)
}

// ValidScope reports whether scope may name a scope: it becomes a directory
// name, so it never starts with a dot.
func ValidScope(scope string) bool {
	return scopePattern.MatchString(scope)
}

// NameFromFile derives an artifact name from a file path: the file name
// without its last extension, lowercased, each run of other characters made
// one hyphen, cut to MaxNameLen and trimmed to start with a letter or digit.
// It is "" when nothing usable is left.
func NameFromFile(path string) string {
	base := filepath.Base(path)
	if ext := filepath.Ext(base); ext != base {
		base = strings.TrimSuffix(base, ext)
	}
	name := badNameRune.ReplaceAllString(strings.ToLower(base), "-")
	name = strings.TrimLeft(name, "._-")
	if len(name) > MaxNameLen {
		name = name[:MaxNameLen]
	}
	name = strings.TrimRight(name, "._-")
	if !ValidName(name) {
		return ""
	}
	return name
}

// Ingested is a source file copied into the incoming directory.
type Ingested struct {
	Path     string // the incoming file, alone in a directory of its own
	Filename string // the source's file name
	Mime     string
	Size     int64
	SHA256   string
}

// Ingest copies the regular file at the absolute path src (a symlink is
// followed) into a new file in incomingDir and measures the copy. A missing
// file is ErrNotFound, a directory or other non-regular file ErrNotRegular;
// on any error nothing is left in incomingDir.
func Ingest(src, incomingDir string) (Ingested, error) {
	if !filepath.IsAbs(src) {
		return Ingested{}, ErrNotAbsolute
	}
	in, err := os.Open(src)
	if errors.Is(err, fs.ErrNotExist) {
		return Ingested{}, ErrNotFound
	}
	if err != nil {
		return Ingested{}, err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return Ingested{}, err
	}
	if !info.Mode().IsRegular() {
		return Ingested{}, ErrNotRegular
	}
	if err := os.MkdirAll(incomingDir, 0o755); err != nil {
		return Ingested{}, err
	}
	// Each ingest has a directory of its own, so concurrent ingests never
	// meet on one name.
	tmpDir, err := os.MkdirTemp(incomingDir, "in-*")
	if err != nil {
		return Ingested{}, err
	}
	dst := filepath.Join(tmpDir, "file")
	ok := false
	defer func() {
		if !ok {
			os.RemoveAll(tmpDir)
		}
	}()
	if err := copyFile(in, dst); err != nil {
		return Ingested{}, fmt.Errorf("copy %s: %w", src, err)
	}
	// What was cloned or copied must still be one regular file.
	if li, err := os.Lstat(dst); err != nil || !li.Mode().IsRegular() {
		if err == nil {
			err = ErrNotRegular
		}
		return Ingested{}, err
	}
	st := Ingested{Path: dst, Filename: filepath.Base(src)}
	if err := measure(&st); err != nil {
		return Ingested{}, err
	}
	ok = true
	return st, nil
}

// Discard removes the incoming file and its directory; after the file was
// moved away it removes only the directory.
func (st Ingested) Discard() {
	os.RemoveAll(filepath.Dir(st.Path))
}

// measure fills the size, sha256 and mime type of st from the in bytes.
func measure(st *Ingested) error {
	f, err := os.Open(st.Path)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	head := make([]byte, 512)
	n, _ := io.ReadFull(f, head)
	h.Write(head[:n])
	rest, err := io.Copy(h, f)
	if err != nil {
		return err
	}
	st.Size = int64(n) + rest
	st.SHA256 = hex.EncodeToString(h.Sum(nil))
	ext := strings.ToLower(filepath.Ext(st.Filename))
	st.Mime = textTypes[ext]
	if st.Mime == "" {
		st.Mime = mime.TypeByExtension(ext)
	}
	if st.Mime == "" {
		st.Mime = http.DetectContentType(head[:n])
	}
	return nil
}

// plainCopy copies in to a new file dst.
func plainCopy(in *os.File, dst string) error {
	if _, err := in.Seek(0, io.SeekStart); err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
