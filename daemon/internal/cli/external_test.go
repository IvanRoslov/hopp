package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type execCall struct {
	path string
	argv []string
	env  []string
}

// fakeExec records what would replace the process.
func fakeExec(t *testing.T) *[]execCall {
	t.Helper()
	calls := &[]execCall{}
	old := execProgram
	execProgram = func(path string, argv []string, env []string) error {
		*calls = append(*calls, execCall{path, argv, env})
		return nil
	}
	t.Cleanup(func() { execProgram = old })
	return calls
}

func writeProgram(t *testing.T, dir, name string, mode os.FileMode) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("#!/bin/sh\nexit 0\n"), mode); err != nil {
		t.Fatal(err)
	}
	return p
}

// externalEnv: a temp HOPP_HOME and a PATH of one temp folder.
func externalEnv(t *testing.T) (bin, pathDir string) {
	t.Helper()
	home := t.TempDir()
	pathDir = t.TempDir()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("HOPP_HOME", home)
	t.Setenv("PATH", pathDir)
	return filepath.Join(home, "bin"), pathDir
}

func TestExternalRunsProgramFromHoppHomeBin(t *testing.T) {
	bin, pathDir := externalEnv(t)
	want := writeProgram(t, bin, "hopp-task", 0o755)
	writeProgram(t, pathDir, "hopp-task", 0o755) // HOPP_HOME/bin comes first
	calls := fakeExec(t)
	var stderr bytes.Buffer
	code, handled := runExternal(NewRootCmd(), []string{"task", "new", "--brief", "два\nслова"}, &stderr)
	if !handled || code != 0 || len(*calls) != 1 {
		t.Fatalf("handled=%v code=%d calls=%v stderr=%q", handled, code, *calls, stderr.String())
	}
	c := (*calls)[0]
	if c.path != want {
		t.Errorf("ran %s, want %s", c.path, want)
	}
	if got := strings.Join(c.argv, "|"); got != "hopp-task|new|--brief|два\nслова" {
		t.Errorf("argv = %q", got)
	}
	var hasBin, hasHome bool
	for _, e := range c.env {
		hasBin = hasBin || strings.HasPrefix(e, "HOPP_BIN=")
		hasHome = hasHome || strings.HasPrefix(e, "HOPP_HOME=")
	}
	if !hasBin || !hasHome {
		t.Errorf("env lacks HOPP_BIN or HOPP_HOME: bin=%v home=%v", hasBin, hasHome)
	}
}

func TestExternalFoundOnPath(t *testing.T) {
	_, pathDir := externalEnv(t)
	want := writeProgram(t, pathDir, "hopp-deploy", 0o755)
	calls := fakeExec(t)
	if _, handled := runExternal(NewRootCmd(), []string{"deploy"}, &bytes.Buffer{}); !handled || len(*calls) != 1 || (*calls)[0].path != want {
		t.Fatalf("handled=%v calls=%v", handled, *calls)
	}
}

func TestExternalNeverShadowsBuiltin(t *testing.T) {
	bin, pathDir := externalEnv(t)
	for _, w := range []string{"ls", "send", "help", "completion", "daemon"} {
		writeProgram(t, bin, "hopp-"+w, 0o755)
		writeProgram(t, pathDir, "hopp-"+w, 0o755)
	}
	calls := fakeExec(t)
	for _, args := range [][]string{{"ls"}, {"send", "x", "y"}, {"help"}, {"completion"}, {"daemon", "status"}, {"--json", "ls"}, {}} {
		if _, handled := runExternal(NewRootCmd(), args, &bytes.Buffer{}); handled {
			t.Errorf("%v was handled as external", args)
		}
	}
	if len(*calls) != 0 {
		t.Errorf("ran %v", *calls)
	}
}

func TestExternalMissingSaysHowToInstall(t *testing.T) {
	bin, pathDir := externalEnv(t)
	writeProgram(t, pathDir, "hopp-task", 0o644) // not executable: not a command
	calls := fakeExec(t)
	var stderr bytes.Buffer
	code, handled := runExternal(NewRootCmd(), []string{"task", "ls"}, &stderr)
	if !handled || code != 3 || len(*calls) != 0 {
		t.Fatalf("handled=%v code=%d calls=%v", handled, code, *calls)
	}
	msg := stderr.String()
	for _, want := range []string{`unknown command "task"`, "hopp-task", bin, "start the hopp app once", "make app-install-mac"} {
		if !strings.Contains(msg, want) {
			t.Errorf("message lacks %q:\n%s", want, msg)
		}
	}
}

func TestExternalOddWordsGoToCobra(t *testing.T) {
	externalEnv(t)
	calls := fakeExec(t)
	for _, w := range []string{"Task", "../x", "a/b", "-x"} {
		if _, handled := runExternal(NewRootCmd(), []string{w}, &bytes.Buffer{}); handled {
			t.Errorf("%q was handled", w)
		}
	}
	if len(*calls) != 0 {
		t.Errorf("ran %v", *calls)
	}
}

func TestHelpListsExternalCommands(t *testing.T) {
	bin, pathDir := externalEnv(t)
	p := writeProgram(t, bin, "hopp-task", 0o755)
	writeProgram(t, pathDir, "hopp-task", 0o755) // shadowed by HOPP_HOME/bin
	writeProgram(t, pathDir, "hopp-project", 0o755)
	writeProgram(t, pathDir, "hopp-ls", 0o755) // a built-in: not listed
	root := NewRootCmd()
	var out bytes.Buffer
	root.SetOut(&out)
	root.SetArgs([]string{"--help"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	s := out.String()
	i := strings.Index(s, "External commands")
	if i < 0 {
		t.Fatalf("no external commands in help:\n%s", s)
	}
	ext := s[i:]
	if !strings.Contains(ext, "task") || !strings.Contains(ext, p) || !strings.Contains(ext, "project") {
		t.Errorf("external section:\n%s", ext)
	}
	if strings.Contains(ext, "hopp-ls") || strings.Contains(ext, "  ls ") {
		t.Errorf("a built-in is listed as external:\n%s", ext)
	}
}

func TestDoctorListsExternalCommandsAndFlagsBrokenOnes(t *testing.T) {
	f := newFakeAPI(t) // first: it sets a HOPP_HOME of its own
	bin, pathDir := externalEnv(t)
	target := writeProgram(t, t.TempDir(), "runtime", 0o755)
	ok := filepath.Join(bin, "hopp-task")
	os.MkdirAll(bin, 0o755)
	os.WriteFile(ok, []byte("#!/bin/sh\nexec '"+target+"' task \"$@\"\n"), 0o755)
	broken := filepath.Join(pathDir, "hopp-project")
	os.WriteFile(broken, []byte("#!/bin/sh\nexec '/nonexistent/app/hopp' '/nonexistent/app/bundle.cjs' project \"$@\"\n"), 0o755)
	out, _, _ := runCLI(t, f, "doctor")
	if !strings.Contains(out, "external:task: "+ok) {
		t.Errorf("no ok line for hopp-task:\n%s", out)
	}
	if !strings.Contains(out, "external:project: "+broken+" runs /nonexistent/app/hopp, /nonexistent/app/bundle.cjs, which does not exist") {
		t.Errorf("no warning for the broken hopp-project:\n%s", out)
	}
}

func TestDoctorSaysWhenThereAreNoExternalCommands(t *testing.T) {
	f := newFakeAPI(t)
	bin, _ := externalEnv(t)
	out, _, _ := runCLI(t, f, "doctor")
	if !strings.Contains(out, "external: no hopp-<name> commands in "+bin+" or on PATH") {
		t.Errorf("doctor output:\n%s", out)
	}
}
