package api

import (
	"fmt"
	"net/http"
	"reflect"
	"sync"
	"testing"
)

type postOut struct {
	ID          int64             `json:"id"`
	From        string            `json:"from"`
	Labels      map[string]string `json:"labels"`
	Body        string            `json:"body"`
	Attachments []string          `json:"attachments"`
	CreatedAt   int64             `json:"created_at"`
}

func addPost(t *testing.T, e apiEnv, body map[string]any) postOut {
	t.Helper()
	var out postOut
	if code := e.call(t, "POST", "/v1/posts", body, &out); code != http.StatusCreated {
		t.Errorf("POST /v1/posts %v: %d", body, code)
	}
	return out
}

func listPostIDs(t *testing.T, e apiEnv, query string) []int64 {
	t.Helper()
	var out struct {
		Posts []postOut `json:"posts"`
	}
	if code := e.call(t, "GET", "/v1/posts"+query, nil, &out); code != http.StatusOK {
		t.Fatalf("list %s: %d", query, code)
	}
	ids := []int64{}
	for _, p := range out.Posts {
		ids = append(ids, p.ID)
	}
	return ids
}

func TestPostCreateCopiesSessionLabels(t *testing.T) {
	e := newAPIEnv(t)
	e.create(t, map[string]any{"dir": t.TempDir(), "id": "s1", "labels": map[string]string{"team": "a", "run": "1"}})
	p := addPost(t, e, map[string]any{"from": "s1", "body": "done", "labels": map[string]string{"run": "2"},
		"attachments": []string{"/tmp/x.md", "report@3"}})
	want := map[string]string{"team": "a", "run": "2"}
	if p.From != "s1" || p.Body != "done" || p.CreatedAt == 0 || !reflect.DeepEqual(p.Labels, want) ||
		!reflect.DeepEqual(p.Attachments, []string{"/tmp/x.md", "report@3"}) {
		t.Errorf("post = %+v", p)
	}
	h := addPost(t, e, map[string]any{"body": "the human's note"})
	if h.From != "" || h.Labels == nil || len(h.Labels) != 0 || h.Attachments == nil {
		t.Errorf("human post = %+v", h)
	}
	var got postOut
	if code := e.call(t, "GET", fmt.Sprintf("/v1/posts/%d", p.ID), nil, &got); code != http.StatusOK || !reflect.DeepEqual(got, p) {
		t.Errorf("GET one: %d %+v", code, got)
	}
	for _, path := range []string{"/v1/posts/999", "/v1/posts/abc"} {
		if code, ecode := sessErrCode(t, e, "GET", path, nil); code != http.StatusNotFound || ecode != "post_not_found" {
			t.Errorf("%s: %d %q", path, code, ecode)
		}
	}
}

func TestPostCreateValidation(t *testing.T) {
	e := newAPIEnv(t)
	for _, body := range []map[string]any{{"body": "  \n "}, {"from": "ghost", "body": "x"}} {
		if code, ecode := sessErrCode(t, e, "POST", "/v1/posts", body); code != http.StatusBadRequest || ecode != "bad_request" {
			t.Errorf("%v: %d %q, want 400 bad_request", body, code, ecode)
		}
	}
}

func TestPostListFilters(t *testing.T) {
	e := newAPIEnv(t)
	e.create(t, map[string]any{"dir": t.TempDir(), "id": "s1", "labels": map[string]string{"team": "a"}})
	a := addPost(t, e, map[string]any{"from": "s1", "body": "a"})
	b := addPost(t, e, map[string]any{"body": "b", "labels": map[string]string{"team": "b"}})
	c := addPost(t, e, map[string]any{"body": "c"})
	for q, want := range map[string][]int64{
		"":                             {a.ID, b.ID, c.ID},
		"?label=team=a":                {a.ID},
		"?from=s1":                     {a.ID},
		fmt.Sprintf("?after=%d", a.ID): {b.ID, c.ID},
		"?limit=2":                     {a.ID, b.ID},
		"?label=team=none":             {},
	} {
		if got := listPostIDs(t, e, q); !reflect.DeepEqual(got, want) {
			t.Errorf("%q -> %v, want %v", q, got, want)
		}
	}
	for _, q := range []string{"?label=nokv", "?after=x", "?after=-1", "?limit=0", "?limit=y"} {
		if code := e.call(t, "GET", "/v1/posts"+q, nil, nil); code != http.StatusBadRequest {
			t.Errorf("%s: %d, want 400", q, code)
		}
	}
}

func TestPostAddedEventCarriesPostLabels(t *testing.T) {
	e := newAPIEnv(t)
	e.create(t, map[string]any{"dir": t.TempDir(), "id": "s1", "labels": map[string]string{"team": "a"}})
	p := addPost(t, e, map[string]any{"from": "s1", "body": "x", "labels": map[string]string{"kind": "note"}})
	h := addPost(t, e, map[string]any{"body": "y", "labels": map[string]string{"kind": "human"}})
	evs, err := e.st.ListEvents(0, 0, "")
	if err != nil {
		t.Fatal(err)
	}
	found := map[int64]map[string]any{}
	for _, ev := range evs {
		if ev.Type == "post.added" {
			id, _ := ev.Data["id"].(float64)
			found[int64(id)] = ev.Data
			if int64(id) == p.ID && ev.SessionID != "s1" {
				t.Errorf("session post event under %q", ev.SessionID)
			}
		}
	}
	pl, _ := found[p.ID]["post_labels"].(map[string]any)
	hl, _ := found[h.ID]["post_labels"].(map[string]any)
	if pl["kind"] != "note" || pl["team"] != "a" || hl["kind"] != "human" {
		t.Errorf("post.added events = %v", found)
	}
}

// TestPostOutlivesRemovedSession: review focus 1.
func TestPostOutlivesRemovedSession(t *testing.T) {
	e := newAPIEnv(t)
	e.create(t, map[string]any{"dir": t.TempDir(), "id": "s1", "labels": map[string]string{"team": "a"}})
	p := addPost(t, e, map[string]any{"from": "s1", "body": "x"})
	if code := e.call(t, "POST", "/v1/sessions/s1/kill", nil, nil); code != http.StatusOK {
		t.Fatalf("kill: %d", code)
	}
	if code := e.call(t, "DELETE", "/v1/sessions/s1", nil, nil); code != http.StatusOK {
		t.Fatalf("remove: %d", code)
	}
	var got postOut
	if code := e.call(t, "GET", fmt.Sprintf("/v1/posts/%d", p.ID), nil, &got); code != http.StatusOK || got.Labels["team"] != "a" || got.From != "s1" {
		t.Errorf("after removal: %d %+v", code, got)
	}
	if ids := listPostIDs(t, e, "?label=team=a"); !reflect.DeepEqual(ids, []int64{p.ID}) {
		t.Errorf("by label after removal: %v", ids)
	}
}

// TestPostCursorUnderConcurrentWrites: review focus 5, through the API.
func TestPostCursorUnderConcurrentWrites(t *testing.T) {
	e := newAPIEnv(t)
	const writers, each = 4, 25
	var wg sync.WaitGroup
	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < each; i++ {
				addPost(t, e, map[string]any{"body": "x"})
			}
		}()
	}
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	var seen []int64
	var cursor int64
	read := func() {
		for _, id := range listPostIDs(t, e, fmt.Sprintf("?after=%d&limit=5", cursor)) {
			seen = append(seen, id)
			cursor = id
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
	all := listPostIDs(t, e, "?limit=1000")
	if len(all) != writers*each || !reflect.DeepEqual(seen, all) {
		t.Errorf("cursor saw %d posts, the table has %d", len(seen), len(all))
	}
}
