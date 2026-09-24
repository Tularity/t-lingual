package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
)

func TestSegmentWindowAtTimeIsOwnerScopedAcrossSilenceAndBounds(t *testing.T) {
	db, _ := newTestStore(t)
	ctx := context.Background()
	alice := testUser("usr_seek_owner", "seek-owner", domain.RoleUser)
	bob := testUser("usr_seek_foreign", "seek-foreign", domain.RoleUser)
	mustCreateUser(t, db, alice)
	mustCreateUser(t, db, bob)
	session := archiveTestSession("session_seek_private", alice.ID, testNow, domain.InterpretationCompleted)
	if err := db.CreateInterpretationSession(ctx, session); err != nil {
		t.Fatal(err)
	}
	for i, at := range []int64{0, 1000, 5000, 6000} {
		id := []string{"segment_a", "segment_b", "segment_c", "segment_d"}[i]
		if err := db.AppendSegment(ctx, alice.ID, domain.Segment{ID: id, SessionID: session.ID, UserID: alice.ID, Sequence: int64(i + 1), SourceText: id, Final: true, StartMS: at, EndMS: at + 500, CreatedAt: testNow.Add(time.Duration(i) * time.Second)}); err != nil {
			t.Fatal(err)
		}
	}
	page, err := db.SegmentWindowAtTime(ctx, alice.ID, session.ID, 5500, 3)
	if err != nil || len(page.Items) < 2 || page.Items[0].ID != "segment_c" || page.Items[1].ID != "segment_d" {
		t.Fatalf("near seek %#v %v", page.Items, err)
	}
	before, err := db.SegmentWindowAtTime(ctx, alice.ID, session.ID, 0, 2)
	if err != nil || len(before.Items) == 0 || before.Items[0].ID != "segment_a" {
		t.Fatalf("first seek %#v %v", before.Items, err)
	}
	silence, err := db.SegmentWindowAtTime(ctx, alice.ID, session.ID, 3000, 3)
	if err != nil || len(silence.Items) == 0 || silence.Items[0].ID != "segment_b" {
		t.Fatalf("silence seek %#v %v", silence.Items, err)
	}
	if _, err := db.SegmentWindowAtTime(ctx, bob.ID, session.ID, 5500, 3); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign seek %v", err)
	}
	if _, err := db.SegmentWindowAtTime(ctx, alice.ID, session.ID, -1, 3); err == nil {
		t.Fatal("negative position accepted")
	}
}
