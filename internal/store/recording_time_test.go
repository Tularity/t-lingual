package store

import (
	"context"
	"errors"
	"testing"

	"github.com/Tularity/t-lingual/internal/domain"
)

func TestMaxSegmentEndMSIsOwnerScopedIncludingEmptySession(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	owner := testUser("usr_end_owner", "end-owner", domain.RoleUser)
	mustCreateUser(t, database, owner)
	session := archiveTestSession("session_end_offset", owner.ID, testNow, domain.InterpretationCompleted)
	if err := database.CreateInterpretationSession(ctx, session); err != nil {
		t.Fatal(err)
	}
	if got, err := database.MaxSegmentEndMS(ctx, owner.ID, session.ID); err != nil || got != 0 {
		t.Fatalf("empty offset = %d, %v", got, err)
	}
	for _, item := range []struct {
		id              string
		sequence, endMS int64
	}{
		{"segment_end_one", 1, 1200}, {"segment_end_two", 2, 900}, {"segment_end_three", 3, 2400},
	} {
		if err := database.AppendSegment(ctx, owner.ID, domain.Segment{
			ID: item.id, SessionID: session.ID, UserID: owner.ID,
			Sequence: item.sequence, SourceText: "speech", Final: true,
			StartMS: 0, EndMS: item.endMS, CreatedAt: testNow,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if got, err := database.MaxSegmentEndMS(ctx, owner.ID, session.ID); err != nil || got != 2400 {
		t.Fatalf("max offset = %d, %v; want 2400", got, err)
	}
	for _, requester := range []string{"usr_other", ""} {
		if _, err := database.MaxSegmentEndMS(ctx, requester, session.ID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("foreign offset = %v, want not found", err)
		}
	}
}
