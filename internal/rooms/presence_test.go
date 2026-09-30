package rooms

import (
	"testing"

	"github.com/Tularity/t-lingual/internal/domain"
)

func TestPresenceListsEachPersonOnceAndGuestsWithoutAnAccount(t *testing.T) {
	svc, _, _, session, viewers := roomFixture(t, nil)
	guest := domain.Viewer{ID: "guest:gst_one", GuestID: "gst_one", DisplayName: "Guest"}
	owner := viewers[0]
	owner.AvatarVersion = 42
	watch := func(id uint64, viewer domain.Viewer) *watcher {
		current := &watcher{id: id, viewer: viewer, presence: make(chan struct{}, 1), cancel: func() {}}
		if _, err := svc.registerWatch(session.ID, current); err != nil {
			t.Fatal(err)
		}
		return current
	}
	first := watch(1, owner)
	watch(2, viewers[1])
	watch(3, owner) // the owner again, in a second tab
	last := watch(4, guest)
	select {
	case <-first.presence:
	default:
		t.Fatal("an arrival did not tell the others")
	}

	list := svc.Presence(session.ID, viewers[1])
	if list.Total != 3 || len(list.People) != 3 {
		t.Fatalf("presence = %#v", list)
	}
	ownerEntry, bobEntry, guestEntry := list.People[0], list.People[1], list.People[2]
	if ownerEntry.Kind != "user" || ownerEntry.UserID != owner.UserID || ownerEntry.AvatarVersion != 42 || ownerEntry.IsMe {
		t.Fatalf("owner entry = %#v", ownerEntry)
	}
	if !bobEntry.IsMe || bobEntry.Name != viewers[1].DisplayName {
		t.Fatalf("own entry = %#v", bobEntry)
	}
	// A guest is shown as a guest: no account, and a key that names neither.
	if guestEntry.Kind != "guest" || guestEntry.UserID != "" || guestEntry.Key == "gst_one" || guestEntry.Key == guest.ID {
		t.Fatalf("guest entry = %#v", guestEntry)
	}
	if other := svc.Presence("session_other", viewers[1]); other.Total != 0 || other.People == nil {
		t.Fatalf("another session's presence = %#v", other)
	}

	svc.releaseWatch(session.ID, last)
	select {
	case <-first.presence:
	default:
		t.Fatal("a departure did not tell the others")
	}
	if list := svc.Presence(session.ID, owner); list.Total != 2 || !list.People[0].IsMe {
		t.Fatalf("presence after the guest left = %#v", list)
	}
}
