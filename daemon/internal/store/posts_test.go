package store

import (
	"errors"
	"reflect"
	"sync"
	"testing"
)

func postIDs(p []Post) []int64 {
	out := []int64{}
	for _, x := range p {
		out = append(out, x.ID)
	}
	return out
}

func TestPostAddGet(t *testing.T) {
	s := openTestStore(t)
	id, err := s.AddPost(Post{FromSession: "s1", Labels: map[string]string{"k": "v"}, Body: "done\nsee file",
		Attachments: []string{"/tmp/a.md", "https://x.example/y", "report@2"}, CreatedAt: 10})
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.GetPost(id)
	if err != nil {
		t.Fatal(err)
	}
	want := Post{ID: id, FromSession: "s1", Labels: map[string]string{"k": "v"}, Body: "done\nsee file",
		Attachments: []string{"/tmp/a.md", "https://x.example/y", "report@2"}, CreatedAt: 10}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v, want %+v", got, want)
	}
	h, _ := s.AddPost(Post{Body: "the human's note"})
	hp, _ := s.GetPost(h)
	if hp.FromSession != "" || hp.Labels == nil || hp.Attachments == nil || hp.CreatedAt == 0 {
		t.Errorf("human post = %+v", hp)
	}
	if _, err := s.GetPost(id + 100); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown: %v, want ErrNotFound", err)
	}
}

func TestPostListFiltersCursorAndLimit(t *testing.T) {
	s := openTestStore(t)
	a, _ := s.AddPost(Post{FromSession: "s1", Labels: map[string]string{"team": "x"}, Body: "a"})
	b, _ := s.AddPost(Post{FromSession: "s2", Labels: map[string]string{"team": "y"}, Body: "b"})
	c, _ := s.AddPost(Post{Body: "c", Labels: map[string]string{"team": "x"}})
	d, _ := s.AddPost(Post{FromSession: "s1", Labels: map[string]string{"team": "x"}, Body: "d"})
	for name, tc := range map[string]struct {
		f    PostFilter
		want []int64
	}{
		"all":            {PostFilter{}, []int64{a, b, c, d}},
		"label":          {PostFilter{Labels: map[string]string{"team": "x"}}, []int64{a, c, d}},
		"from":           {PostFilter{From: "s1"}, []int64{a, d}},
		"after":          {PostFilter{After: b}, []int64{c, d}},
		"limit":          {PostFilter{Limit: 2}, []int64{a, b}},
		"label+limit":    {PostFilter{Labels: map[string]string{"team": "x"}, Limit: 2}, []int64{a, c}},
		"after+label":    {PostFilter{After: a, Labels: map[string]string{"team": "x"}, Limit: 1}, []int64{c}},
		"after the last": {PostFilter{After: d}, []int64{}},
	} {
		got, err := s.ListPosts(tc.f)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(postIDs(got), tc.want) {
			t.Errorf("%s: %v, want %v", name, postIDs(got), tc.want)
		}
	}
}

func TestPostSurvivesSessionRemoval(t *testing.T) {
	s := openTestStore(t)
	mustAddSession(t, s, "gone")
	id, err := s.AddPost(Post{FromSession: "gone", Labels: map[string]string{"k": "v"}, Body: "keep me"})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.RemoveSessions([]string{"gone"}); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetPost(id)
	if err != nil {
		t.Fatalf("post gone after RemoveSessions: %v", err)
	}
	if got.FromSession != "gone" || got.Labels["k"] != "v" {
		t.Errorf("post = %+v", got)
	}
}

// TestPostCursorSkipsNothingUnderConcurrentWrites reads with After as a
// cursor while writers add posts; every post is seen exactly once, in order.
func TestPostCursorSkipsNothingUnderConcurrentWrites(t *testing.T) {
	s := openTestStore(t)
	const writers, each = 4, 50
	var wg sync.WaitGroup
	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < each; i++ {
				if _, err := s.AddPost(Post{Body: "x"}); err != nil {
					t.Error(err)
					return
				}
			}
		}()
	}
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	var seen []int64
	var cursor int64
	read := func() {
		got, err := s.ListPosts(PostFilter{After: cursor, Limit: 7})
		if err != nil {
			t.Fatal(err)
		}
		for _, p := range got {
			seen = append(seen, p.ID)
			cursor = p.ID
		}
	}
	for finished := false; !finished; {
		select {
		case <-done:
			finished = true
		default:
		}
		read()
	}
	for before := -1; before != len(seen); {
		before = len(seen)
		read()
	}
	all, err := s.ListPosts(PostFilter{Limit: writers * each * 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != writers*each || !reflect.DeepEqual(seen, postIDs(all)) {
		t.Errorf("cursor saw %d posts, the table has %d; equal lists: %v", len(seen), len(all), reflect.DeepEqual(seen, postIDs(all)))
	}
}
