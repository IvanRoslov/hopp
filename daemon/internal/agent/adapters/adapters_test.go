package adapters

import (
	"reflect"
	"sort"
	"testing"

	"github.com/IvanRoslov/hopp/internal/agent"
)

func TestAllAdaptersAreRegistered(t *testing.T) {
	got := []string{}
	for name := range agent.Registry() {
		got = append(got, name)
	}
	sort.Strings(got)
	want := []string{"agy", "claude-code", "codex", "deepseek", "kimi-code", "pi"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("registry = %v, want %v", got, want)
	}
}
