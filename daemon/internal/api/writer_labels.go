package api

import (
	"errors"

	"github.com/IvanRoslov/hopp/internal/store"
)

// errFromUnknown: the from session of a note does not exist.
var errFromUnknown = errors.New("from session not found")

// writerLabels returns the labels a stored note keeps: the from session's
// labels at the time of writing, overlaid with the request's, so the note
// keeps them after that session is removed. An empty from has only the
// request's labels; an unknown from is errFromUnknown.
func writerLabels(d Deps, from string, req map[string]string) (map[string]string, error) {
	labels := map[string]string{}
	if from != "" {
		sess, err := d.Store.GetSession(from)
		if errors.Is(err, store.ErrNotFound) {
			return nil, errFromUnknown
		}
		if err != nil {
			return nil, err
		}
		for k, v := range sess.Labels {
			labels[k] = v
		}
	}
	for k, v := range req {
		labels[k] = v
	}
	return labels, nil
}
