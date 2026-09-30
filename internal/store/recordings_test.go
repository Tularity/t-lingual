package store

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/Tularity/t-lingual/internal/domain"
)

func TestRecordedAudioStopsAtTheSessionAndOwnerCeilings(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	owner := testUser("usr_audio_ceiling", "audio-ceiling", domain.RoleUser)
	mustCreateUser(t, database, owner)
	part := func(session string, index int) RecordingPart {
		return RecordingPart{ID: fmt.Sprintf("aud_%s_%d", session, index), SessionID: session, RunID: "run_" + session,
			Index: index, SampleRate: 48000, CreatedAt: testNow}
	}
	newSession := func(id string) {
		t.Helper()
		if err := database.CreateInterpretationSession(ctx, archiveTestSession(id, owner.ID, testNow, domain.InterpretationCompleted)); err != nil {
			t.Fatal(err)
		}
	}

	// One session holds up to its ceiling, and not a frame more.
	newSession("ses_ceiling_0")
	first := part("ses_ceiling_0", 0)
	if err := database.CreateRecordingPart(ctx, owner.ID, first.SessionID, first); err != nil {
		t.Fatal(err)
	}
	if err := database.AdvanceRecordingPart(ctx, owner.ID, first.SessionID, first.ID, maxSessionAudioBytes-4); err != nil {
		t.Fatalf("session below its ceiling: %v", err)
	}
	second := part("ses_ceiling_0", 1)
	if err := database.CreateRecordingPart(ctx, owner.ID, second.SessionID, second); err != nil {
		t.Fatal(err)
	}
	if err := database.AdvanceRecordingPart(ctx, owner.ID, second.SessionID, second.ID, 4); err != nil {
		t.Fatalf("session at its ceiling: %v", err)
	}
	if err := database.AdvanceRecordingPart(ctx, owner.ID, second.SessionID, second.ID, 8); !errors.Is(err, ErrCapacity) {
		t.Fatalf("session past its ceiling = %v, want capacity", err)
	}

	// The owner's sessions together stop at the owner's ceiling.
	sessions := int(maxOwnerAudioBytes / maxSessionAudioBytes)
	for index := 1; index < sessions; index++ {
		id := fmt.Sprintf("ses_ceiling_%d", index)
		newSession(id)
		full := part(id, 0)
		if err := database.CreateRecordingPart(ctx, owner.ID, id, full); err != nil {
			t.Fatal(err)
		}
		if err := database.AdvanceRecordingPart(ctx, owner.ID, id, full.ID, maxSessionAudioBytes); err != nil {
			t.Fatalf("owner below its ceiling at session %d: %v", index, err)
		}
	}
	newSession("ses_ceiling_over")
	over := part("ses_ceiling_over", 0)
	if err := database.CreateRecordingPart(ctx, owner.ID, over.SessionID, over); err != nil {
		t.Fatal(err)
	}
	if err := database.AdvanceRecordingPart(ctx, owner.ID, over.SessionID, over.ID, 4); !errors.Is(err, ErrCapacity) {
		t.Fatalf("owner past its ceiling = %v, want capacity", err)
	}
}
