package store

import (
	"context"
	"errors"
	"testing"

	"github.com/Tularity/t-lingual/internal/domain"
)

func TestReplaceSegmentSourceOnlyChangesTheExpectedFinalLineOfItsOwner(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	owner := testUser("usr_source_owner", "source-owner", domain.RoleUser)
	other := testUser("usr_source_other", "source-other", domain.RoleUser)
	mustCreateUser(t, database, owner)
	mustCreateUser(t, database, other)
	session := archiveTestSession("ses_source", owner.ID, testNow, domain.InterpretationCompleted)
	if err := database.CreateInterpretationSession(ctx, session); err != nil {
		t.Fatal(err)
	}
	for _, segment := range []domain.Segment{
		{ID: "seg_source_final", Sequence: 1, SourceText: "你就看我那个吧", Final: true},
		{ID: "seg_source_draft", Sequence: 2, SourceText: "还在说", Final: false},
	} {
		segment.SessionID, segment.UserID, segment.CreatedAt, segment.EndMS = session.ID, owner.ID, testNow, 10
		if err := database.AppendSegment(ctx, owner.ID, segment); err != nil {
			t.Fatal(err)
		}
	}
	before, _ := database.AccountStorageOf(ctx, owner.ID)

	for name, attempt := range map[string]func() error{
		"stale text": func() error {
			return database.ReplaceSegmentSource(ctx, owner.ID, session.ID, "seg_source_final", "别的", "别的。")
		},
		"other owner": func() error {
			return database.ReplaceSegmentSource(ctx, other.ID, session.ID, "seg_source_final", "你就看我那个吧", "你就看我那个吧。")
		},
		"draft line": func() error {
			return database.ReplaceSegmentSource(ctx, owner.ID, session.ID, "seg_source_draft", "还在说", "还在说。")
		},
		"missing line": func() error { return database.ReplaceSegmentSource(ctx, owner.ID, session.ID, "seg_nope", "x", "x。") },
	} {
		if err := attempt(); !errors.Is(err, ErrNotFound) {
			t.Fatalf("%s = %v, want not found", name, err)
		}
	}
	if err := database.ReplaceSegmentSource(ctx, owner.ID, session.ID, "seg_source_final", "你就看我那个吧", "   "); err == nil {
		t.Fatal("blank replacement accepted")
	}
	if err := database.ReplaceSegmentSource(ctx, owner.ID, session.ID, "seg_source_final", "你就看我那个吧", "你就看我那个吧。"); err != nil {
		t.Fatal(err)
	}
	saved, err := database.GetSegmentByID(ctx, owner.ID, session.ID, "seg_source_final")
	if err != nil || saved.SourceText != "你就看我那个吧。" {
		t.Fatalf("changed line = %#v, %v", saved, err)
	}
	after, _ := database.AccountStorageOf(ctx, owner.ID)
	if after.TranscriptBytes != before.TranscriptBytes+int64(len("。")) {
		t.Fatalf("transcript size %d after %d", after.TranscriptBytes, before.TranscriptBytes)
	}
}
