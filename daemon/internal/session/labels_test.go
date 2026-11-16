package session

import (
	"context"
	"reflect"
	"testing"
)

func spawnLabelled(t *testing.T, e testEnv, id, parent string, labels map[string]string) map[string]string {
	t.Helper()
	sess, err := e.m.Spawn(context.Background(), SpawnReq{
		ID: id, ParentID: parent, Dir: mkdir(t, id), Labels: labels, Profile: fakeProfile(),
	})
	if err != nil {
		t.Fatalf("Spawn %s: %v", id, err)
	}
	stored, err := e.st.GetSession(sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	return stored.Labels
}

func TestSpawnInheritsParentLabels(t *testing.T) {
	e := testManager(t)
	spawnLabelled(t, e, "parent", "", map[string]string{"a": "1", "b": "2"})
	got := spawnLabelled(t, e, "child", "parent", map[string]string{"b": "3", "c": "4"})
	if want := map[string]string{"a": "1", "b": "3", "c": "4"}; !reflect.DeepEqual(got, want) {
		t.Errorf("child labels = %v, want %v", got, want)
	}
}

func TestSpawnEmptyLabelDropsInherited(t *testing.T) {
	e := testManager(t)
	spawnLabelled(t, e, "parent", "", map[string]string{"a": "1", "keep": "x"})
	got := spawnLabelled(t, e, "child", "parent", map[string]string{"a": ""})
	if want := map[string]string{"keep": "x"}; !reflect.DeepEqual(got, want) {
		t.Errorf("child labels = %v, want %v", got, want)
	}
}

func TestSpawnWithoutParentKeepsRequestLabels(t *testing.T) {
	e := testManager(t)
	got := spawnLabelled(t, e, "solo", "", map[string]string{"a": "1", "b": "2"})
	if want := map[string]string{"a": "1", "b": "2"}; !reflect.DeepEqual(got, want) {
		t.Errorf("labels = %v, want %v", got, want)
	}
}

func TestSpawnChildOfUnlabelledParentKeepsRequestLabels(t *testing.T) {
	e := testManager(t)
	spawnLabelled(t, e, "parent", "", nil)
	got := spawnLabelled(t, e, "child", "parent", map[string]string{"c": "4"})
	if want := map[string]string{"c": "4"}; !reflect.DeepEqual(got, want) {
		t.Errorf("child labels = %v, want %v", got, want)
	}
}

func TestMergeLabelsDoesNotChangeInputs(t *testing.T) {
	parent := map[string]string{"a": "1"}
	req := map[string]string{"a": "", "b": "2"}
	got := mergeLabels(parent, req)
	if want := map[string]string{"b": "2"}; !reflect.DeepEqual(got, want) {
		t.Errorf("merge = %v, want %v", got, want)
	}
	if parent["a"] != "1" || len(req) != 2 {
		t.Errorf("inputs changed: parent %v, req %v", parent, req)
	}
}
