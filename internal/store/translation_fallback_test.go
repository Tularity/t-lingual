package store

import (
	"context"
	"errors"
	"testing"

	"github.com/Tularity/t-lingual/internal/domain"
)

func TestPendingTranslationCanReachTerminalFailureAfterQuotaRejection(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	user := testUser("usr_translation_quota", "translation_quota", domain.RoleUser)
	mustCreateUser(t, database, user)
	session := domain.InterpretationSession{
		ID: "ses_translation_quota", UserID: user.ID, Title: "Quota",
		SourceLanguage: "en-US", TargetLanguage: "fr-FR",
		Status: domain.InterpretationCreated, CreatedAt: testNow, UpdatedAt: testNow,
	}
	if err := database.CreateInterpretationSession(ctx, session); err != nil {
		t.Fatal(err)
	}
	segment := domain.Segment{
		ID: "seg_translation_quota", SessionID: session.ID, UserID: user.ID,
		Sequence: 1, SourceText: "hello", TranslationStatus: domain.TranslationPending,
		Final: true, EndMS: 100, CreatedAt: testNow,
	}
	if err := database.AppendSegment(ctx, user.ID, segment); err != nil {
		t.Fatal(err)
	}
	if _, err := database.db.ExecContext(ctx, `
		UPDATE interpretation_sessions SET transcript_bytes = ? WHERE id = ?`,
		maxTranscriptBytesPerSession, session.ID,
	); err != nil {
		t.Fatal(err)
	}
	if err := database.UpdateSegmentTranslation(
		ctx, user.ID, session.ID, segment.ID, domain.TranslationSucceeded,
		"bonjour", "", "provider-request", testNow,
	); !errors.Is(err, ErrCapacity) {
		t.Fatalf("expected quota rejection, got %v", err)
	}
	if err := database.FailPendingSegmentTranslation(
		ctx, user.ID, session.ID, segment.ID, "storage_limit", testNow,
	); err != nil {
		t.Fatal(err)
	}
	items, err := database.ListSegments(ctx, user.ID, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].TranslationStatus != domain.TranslationFailed ||
		items[0].Translation != "" || items[0].TranslationError != "storage_limit" {
		t.Fatalf("pending translation did not reach a safe terminal state: %#v", items)
	}
	if err := database.FailPendingSegmentTranslation(
		ctx, user.ID, session.ID, segment.ID, "storage_limit", testNow,
	); !errors.Is(err, ErrConflict) {
		t.Fatalf("expected a terminal translation to reject fallback replay, got %v", err)
	}
}

func TestPendingSegmentCannotCarryUnaccountedTranslation(t *testing.T) {
	database, _ := newTestStore(t)
	user := testUser("usr_pending_shape", "pending_shape", domain.RoleUser)
	mustCreateUser(t, database, user)
	session := domain.InterpretationSession{
		ID: "ses_pending_shape", UserID: user.ID, Title: "Pending",
		SourceLanguage: "en-US", TargetLanguage: "de-DE",
		Status: domain.InterpretationCreated, CreatedAt: testNow, UpdatedAt: testNow,
	}
	if err := database.CreateInterpretationSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	err := database.AppendSegment(context.Background(), user.ID, domain.Segment{
		ID: "seg_pending_shape", SessionID: session.ID, UserID: user.ID,
		Sequence: 1, SourceText: "hello", Translation: "must not be hidden",
		TranslationStatus: domain.TranslationPending, Final: true, EndMS: 100,
		CreatedAt: testNow,
	})
	if err == nil {
		t.Fatal("accepted a pending segment with unaccounted translated text")
	}
}
