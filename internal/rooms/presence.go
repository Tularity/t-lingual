package rooms

import (
	"crypto/sha256"
	"encoding/hex"
	"slices"
	"strings"

	"github.com/Tularity/t-lingual/internal/domain"
)

// maxPresence bounds how many faces one presence list carries; a crowd
// beyond it is reported by count alone.
const maxPresence = 48

// Presence is one person with a session open, as the others see them: a
// name and, for someone signed in, a picture. Guests are only "a guest".
type Presence struct {
	// Key tells people apart without naming the account or guest behind them.
	Key           string `json:"key"`
	Name          string `json:"name"`
	Kind          string `json:"kind"`
	UserID        string `json:"userId,omitempty"`
	AvatarVersion int64  `json:"avatarVersion,omitempty"`
	IsMe          bool   `json:"isMe"`
	Recording     bool   `json:"recording,omitempty"`
}

// PresenceList is who has a session open, and how many in all.
type PresenceList struct {
	People []Presence `json:"people"`
	Total  int        `json:"total"`
}

func presenceKey(sessionID, viewerID string) string {
	sum := sha256.Sum256([]byte(sessionID + "\x00" + viewerID))
	return hex.EncodeToString(sum[:8])
}

func presenceOf(sessionID string, viewer, me domain.Viewer) Presence {
	entry := Presence{Key: presenceKey(sessionID, viewer.ID), Name: viewer.DisplayName, Kind: "guest", IsMe: viewer.ID == me.ID}
	if strings.HasPrefix(viewer.ID, "user:") && viewer.UserID != "" {
		entry.Kind, entry.UserID, entry.AvatarVersion = "user", viewer.UserID, viewer.AvatarVersion
	}
	return entry
}

// presenceLocked lists the recorder first, then everyone watching in the
// order they arrived; a person with the session open twice is listed once.
func (s *Service) presenceLocked(sessionID string, me domain.Viewer) PresenceList {
	list := PresenceList{People: make([]Presence, 0)}
	current := s.rooms[sessionID]
	if current == nil {
		return list
	}
	seen := make(map[string]int)
	add := func(viewer domain.Viewer, recording bool) {
		if index, ok := seen[viewer.ID]; ok {
			if index >= 0 && recording {
				list.People[index].Recording = true
			}
			return
		}
		list.Total++
		if len(list.People) >= maxPresence {
			seen[viewer.ID] = -1
			return
		}
		seen[viewer.ID] = len(list.People)
		entry := presenceOf(sessionID, viewer, me)
		entry.Recording = recording
		list.People = append(list.People, entry)
	}
	if current.recorder != nil {
		add(current.recorder.viewer, true)
	}
	watches := make([]*watcher, 0, len(current.watches))
	for _, watch := range current.watches {
		watches = append(watches, watch)
	}
	slices.SortFunc(watches, func(a, b *watcher) int {
		switch {
		case a.id < b.id:
			return -1
		case a.id > b.id:
			return 1
		}
		return 0
	})
	for _, watch := range watches {
		add(watch.viewer, false)
	}
	return list
}

// Presence is who has a session open right now, as the given viewer sees it.
func (s *Service) Presence(sessionID string, me domain.Viewer) PresenceList {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.presenceLocked(sessionID, me)
}

// broadcastPresenceLocked tells everyone watching that who is there has
// changed. The signal holds at most one pending change per watcher, so a
// crowd arriving at once is one update, read fresh when it is sent, and never
// fills the queue that carries the transcript.
func (s *Service) broadcastPresenceLocked(sessionID string) {
	current := s.rooms[sessionID]
	if current == nil {
		return
	}
	for _, watch := range current.watches {
		select {
		case watch.presence <- struct{}{}:
		default:
		}
	}
}
