package agent

import (
	"os"
	"reflect"
	"testing"
)

func TestLaunchSpecHasNoScenarioFields(t *testing.T) {
	typ := reflect.TypeOf(LaunchSpec{})
	for _, name := range []string{"Creative", "Kind", "ProjectID", "RepoID", "Feature", "BrainstormSkill"} {
		if _, ok := typ.FieldByName(name); ok {
			t.Errorf("LaunchSpec still has scenario field %s", name)
		}
	}
	if _, ok := typ.FieldByName("ParentID"); !ok {
		t.Error("LaunchSpec lost ParentID")
	}
}

func TestExcludeFromGitOutsideARepoDoesNothing(t *testing.T) {
	dir := t.TempDir()
	ExcludeFromGit(dir, []string{".hopp/", ".hopp-prompt.md"})
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 {
		t.Errorf("non-git folder was written to: %v", entries)
	}
}
