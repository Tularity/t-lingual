package store

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
)

func translationFixture(t *testing.T) (*Store, domain.InterpretationSession, domain.Segment, domain.User) {
	t.Helper()
	database, _ := newTestStore(t)
	owner := testUser("usr_translation_owner", "translation-owner", domain.RoleUser)
	mustCreateUser(t, database, owner)
	session := domain.InterpretationSession{ID: "session_translation", UserID: owner.ID, Title: "Meeting",
		SourceLanguage: "en", TargetLanguage: "zh-Hans", Status: domain.InterpretationCompleted,
		CreatedAt: testNow, UpdatedAt: testNow}
	if err := database.CreateInterpretationSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	segment := domain.Segment{ID: "segment_translation", SessionID: session.ID, UserID: owner.ID,
		Sequence: 1, SourceText: "Hello", TranslationStatus: domain.TranslationNotRequested,
		Final: true, StartMS: 0, EndMS: 900, CreatedAt: testNow.Add(time.Second)}
	if err := database.AppendSegment(context.Background(), owner.ID, segment); err != nil {
		t.Fatal(err)
	}
	return database, session, segment, owner
}

func TestTranslationCacheDeduplicatesTargetLanguageAcrossConcurrentViewers(t *testing.T) {
	database, session, segment, owner := translationFixture(t)
	ctx := context.Background()
	const callers = 16
	var wait sync.WaitGroup
	wait.Add(callers)
	results := make(chan bool, callers)
	errorsSeen := make(chan error, callers)
	for range callers {
		go func() {
			defer wait.Done()
			_, claimed, err := database.ClaimTranslation(ctx, owner.ID, session.ID, segment.ID, "zh-CN", testNow.Add(time.Minute))
			results <- claimed
			errorsSeen <- err
		}()
	}
	wait.Wait()
	close(results)
	close(errorsSeen)
	claimedCount := 0
	for claimed := range results {
		if claimed {
			claimedCount++
		}
	}
	for err := range errorsSeen {
		if err != nil {
			t.Fatal(err)
		}
	}
	if claimedCount != 1 {
		t.Fatalf("claimed %d times, want once", claimedCount)
	}
	result, err := database.FinishTranslation(ctx, owner.ID, session.ID, segment.ID, "zh-Hans",
		domain.TranslationSucceeded, "你好", "", "request1", testNow.Add(2*time.Minute))
	if err != nil || result.TargetLanguage != "zh-Hans" {
		t.Fatalf("finish = %#v, %v", result, err)
	}
	if _, err := database.FinishTranslation(ctx, owner.ID, session.ID, segment.ID, "zh-Hans",
		domain.TranslationFailed, "", "late", "", testNow.Add(3*time.Minute)); !errors.Is(err, ErrConflict) {
		t.Fatalf("late result = %v, want conflict", err)
	}
	_, claimed, err := database.ClaimTranslation(ctx, owner.ID, session.ID, segment.ID, "ja", testNow.Add(time.Minute))
	if err != nil || !claimed {
		t.Fatalf("different language claim = %t, %v", claimed, err)
	}
	page, err := database.PresentSegments(ctx, owner.ID, session.ID, "zh-Hans", []domain.Segment{segment})
	if err != nil || page[0].Translation != "你好" {
		t.Fatalf("Chinese view = %#v, %v", page, err)
	}
	page, err = database.PresentSegments(ctx, owner.ID, session.ID, "ja", []domain.Segment{segment})
	if err != nil || page[0].TranslationStatus != domain.TranslationPending || page[0].Translation != "" {
		t.Fatalf("Japanese view = %#v, %v", page, err)
	}
}

func TestTranslationCacheEnforcesSegmentOwnershipAndTerminalFailure(t *testing.T) {
	database, session, segment, owner := translationFixture(t)
	other := testUser("usr_translation_other", "translation-other", domain.RoleUser)
	mustCreateUser(t, database, other)
	ctx := context.Background()
	if _, _, err := database.ClaimTranslation(ctx, other.ID, session.ID, segment.ID, "fr", testNow); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign claim = %v", err)
	}
	if _, err := database.PresentSegments(ctx, other.ID, session.ID, "fr", []domain.Segment{segment}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign projection = %v", err)
	}
	if _, _, err := database.ClaimTranslation(ctx, owner.ID, session.ID, segment.ID, "fr", testNow); err != nil {
		t.Fatal(err)
	}
	if _, err := database.FailTranslation(ctx, owner.ID, session.ID, segment.ID, "fr", "translator_unavailable", testNow.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	page, err := database.PresentSegments(ctx, owner.ID, session.ID, "fr", []domain.Segment{segment})
	if err != nil || page[0].TranslationStatus != domain.TranslationFailed || page[0].TranslationError != "translator_unavailable" {
		t.Fatalf("failure projection = %#v, %v", page, err)
	}
}

func TestLateSpeakerAssignmentStaysWithinOwnerAndRecordingWindow(t *testing.T) {
	database, session, segment, owner := translationFixture(t)
	ctx := context.Background()
	if err := database.SetSegmentSpeaker(ctx, "another_user", session.ID, segment.ID, "speaker_1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign speaker update = %v", err)
	}
	if err := database.SetSegmentSpeaker(ctx, owner.ID, session.ID, segment.ID, "speaker_1"); err != nil {
		t.Fatal(err)
	}
	late := domain.Segment{ID: "segment_late_speaker", SessionID: session.ID, UserID: owner.ID,
		Sequence: 2, SourceText: "Next turn", TranslationStatus: domain.TranslationNotRequested,
		Final: true, StartMS: 1000, EndMS: 1800, Wall0MS: 1000, Wall1MS: 1800,
		CreatedAt: testNow.Add(2 * time.Second)}
	if err := database.AppendSegment(ctx, owner.ID, late); err != nil {
		t.Fatal(err)
	}
	candidates, err := database.SpeakerCandidatesForWallRange(ctx, owner.ID, session.ID, 2, 900, 2000)
	if err != nil || len(candidates) != 1 || candidates[0].ID != late.ID {
		t.Fatalf("range candidates = %#v, %v", candidates, err)
	}
	foreign, err := database.SpeakerCandidatesForWallRange(ctx, "another_user", session.ID, 2, 900, 2000)
	if err != nil || len(foreign) != 0 {
		t.Fatalf("foreign candidates = %#v, %v", foreign, err)
	}
	previousRun, err := database.SpeakerCandidatesForWallRange(ctx, owner.ID, session.ID, 3, 900, 2000)
	if err != nil || len(previousRun) != 0 {
		t.Fatalf("generation bound = %#v, %v", previousRun, err)
	}
	if err := database.SetSegmentSpeaker(ctx, owner.ID, session.ID, late.ID, "speaker_2"); err != nil {
		t.Fatal(err)
	}
	segments, err := database.ListSegments(ctx, owner.ID, session.ID)
	if err != nil || segments[0].SpeakerID != "speaker_1" || segments[1].SpeakerID != "speaker_2" {
		t.Fatalf("speaker persistence = %#v, %v", segments, err)
	}
}
