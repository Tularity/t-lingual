package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
)

func TestInterpretationAndSegmentOwnershipIsolation(t *testing.T) {
	store, _ := newTestStore(t)
	ctx := context.Background()
	alice := testUser("usr_owner_alice", "owner-alice", domain.RoleUser)
	bob := testUser("usr_owner_bob", "owner-bob", domain.RoleUser)
	mustCreateUser(t, store, alice)
	mustCreateUser(t, store, bob)

	session := domain.InterpretationSession{
		ID: "session_private", UserID: alice.ID, Title: "Private meeting",
		SourceLanguage: "en", TargetLanguage: "ja", Status: domain.InterpretationCreated,
		CreatedAt: testNow, UpdatedAt: testNow,
	}
	if err := store.CreateInterpretationSession(ctx, session); err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetInterpretationSession(ctx, bob.ID, session.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-owner session lookup = %v, want not found", err)
	}
	bobSessions, err := store.ListInterpretationSessions(ctx, bob.ID, nil, 100, 0)
	if err != nil || len(bobSessions) != 0 {
		t.Fatalf("Bob session list = %#v, %v", bobSessions, err)
	}

	segment := domain.Segment{
		ID: "segment_one", SessionID: session.ID, UserID: alice.ID,
		Sequence: 0, SourceText: "Hello", Translation: "こんにちは", Final: true,
		StartMS: 0, EndMS: 850, CreatedAt: testNow.Add(time.Second),
	}
	if err := store.AppendSegment(ctx, bob.ID, segment); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-owner append = %v, want not found", err)
	}
	if err := store.AppendSegment(ctx, alice.ID, segment); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ListSegments(ctx, bob.ID, session.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-owner segment list = %v, want not found", err)
	}
	segments, err := store.ListSegments(ctx, alice.ID, session.ID)
	if err != nil || len(segments) != 1 || segments[0].Translation != segment.Translation {
		t.Fatalf("owner segments = %#v, %v", segments, err)
	}

	started := testNow.Add(time.Minute)
	if _, err := store.ClaimInterpretationSessionLive(ctx, bob.ID, session.ID, started); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-owner live claim = %v, want not found", err)
	}
	claimed, err := store.ClaimInterpretationSessionLive(ctx, alice.ID, session.ID, started)
	if err != nil {
		t.Fatal(err)
	}
	if claimed.SourceLanguage != session.SourceLanguage || claimed.TargetLanguage != session.TargetLanguage ||
		claimed.Status != domain.InterpretationLive || claimed.StartedAt == nil || !claimed.StartedAt.Equal(started) {
		t.Fatalf("claimed session = %#v", claimed)
	}
	live := domain.InterpretationLive
	sessions, err := store.ListInterpretationSessions(ctx, alice.ID, &live, 10, 0)
	if err != nil || len(sessions) != 1 || sessions[0].StartedAt == nil || !sessions[0].StartedAt.Equal(started) {
		t.Fatalf("live sessions = %#v, %v", sessions, err)
	}

	if err := store.DeleteInterpretationSession(ctx, bob.ID, session.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-owner delete = %v, want not found", err)
	}
	if err := store.DeleteInterpretationSession(ctx, alice.ID, session.ID); err != nil {
		t.Fatal(err)
	}
	var segmentCount int
	if err := store.db.QueryRowContext(ctx,
		"SELECT count(*) FROM segments WHERE session_id = ?", session.ID,
	).Scan(&segmentCount); err != nil {
		t.Fatal(err)
	}
	if segmentCount != 0 {
		t.Fatalf("segments were not cascaded: %d remain", segmentCount)
	}
}

func TestSettingsDefaultsUpsertAndAuditAdminBoundary(t *testing.T) {
	store, _ := newTestStore(t)
	ctx := context.Background()
	admin := testUser("usr_admin", "admin", domain.RoleAdmin)
	user := testUser("usr_regular", "regular", domain.RoleUser)
	mustCreateUser(t, store, admin)
	mustCreateUser(t, store, user)

	settings, err := store.GetUserSettings(ctx, user.ID)
	if err != nil || settings != domain.DefaultUserSettings(user.ID) {
		t.Fatalf("default settings = %#v, %v", settings, err)
	}
	if _, err := store.GetUserSettings(ctx, "usr_missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing user settings = %v, want not found", err)
	}
	settings.DefaultSourceLanguage = "fr"
	settings.DefaultTargetLanguage = "de"
	settings.AutoStartMicrophone = true
	settings.CompactTranscriptLayout = true
	if err := store.UpsertUserSettings(ctx, settings); err != nil {
		t.Fatal(err)
	}
	got, err := store.GetUserSettings(ctx, user.ID)
	if err != nil || got != settings {
		t.Fatalf("upserted settings = %#v, %v", got, err)
	}
	missingSettings := settings
	missingSettings.UserID = "usr_missing"
	if err := store.UpsertUserSettings(ctx, missingSettings); !errors.Is(err, ErrNotFound) {
		t.Fatalf("settings foreign key = %v, want not found", err)
	}

	event := AuditEvent{
		ID: "audit_one", ActorUserID: &admin.ID, Action: "invitation.create",
		TargetType: "invitation", TargetID: "inv_one",
		Metadata: json.RawMessage(`{"source":"web"}`), CreatedAt: testNow,
	}
	if err := store.AppendAuditEvent(ctx, event); err != nil {
		t.Fatal(err)
	}
	adminSession := testBrowserSession("bs_settings_admin", admin.ID)
	userSession := testBrowserSession("bs_settings_user", user.ID)
	if err := store.CreateBrowserSession(ctx, adminSession, "settings-admin-token-with-entropy"); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateBrowserSession(ctx, userSession, "settings-user-token-with-entropy"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ListAuditEventsAsAdmin(ctx, user.ID, userSession.ID, testNow, 100, 0); !errors.Is(err, ErrActiveAdminRequired) {
		t.Fatalf("non-admin audit list = %v, want forbidden", err)
	}
	events, err := store.ListAuditEventsAsAdmin(ctx, admin.ID, adminSession.ID, testNow, 100, 0)
	if err != nil || len(events) != 1 || events[0].ID != event.ID ||
		string(events[0].Metadata) != string(event.Metadata) {
		t.Fatalf("admin audit list = %#v, %v", events, err)
	}
	if err := store.UpdateUserRole(ctx, user.ID, domain.RoleAdmin, testNow.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := store.UpdateUserStatus(ctx, admin.ID, domain.UserDisabled, testNow.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ListAuditEventsAsAdmin(ctx, admin.ID, adminSession.ID, testNow, 100, 0); !errors.Is(err, ErrActiveAdminRequired) {
		t.Fatalf("disabled admin audit list = %v, want forbidden", err)
	}
}

func TestTranslationResultAndInterruptedRecovery(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	user := testUser("usr_recovery", "recovery", domain.RoleUser)
	mustCreateUser(t, database, user)
	started := testNow.Add(time.Minute)
	session := domain.InterpretationSession{
		ID: "session_recovery", UserID: user.ID, Title: "Interrupted",
		SourceLanguage: "en", TargetLanguage: "fr", Status: domain.InterpretationLive,
		CreatedAt: testNow, UpdatedAt: started, StartedAt: &started,
	}
	if err := database.CreateInterpretationSession(ctx, session); err != nil {
		t.Fatal(err)
	}
	segment := domain.Segment{
		ID: "segment_pending", SessionID: session.ID, UserID: user.ID,
		Sequence: 1, SourceText: "hello", TranslationStatus: domain.TranslationPending,
		Final: true, CreatedAt: started,
	}
	if err := database.AppendSegment(ctx, user.ID, segment); err != nil {
		t.Fatal(err)
	}

	recoveredAt := started.Add(time.Minute)
	sessions, segments, err := database.RecoverInterruptedInterpretations(ctx, recoveredAt)
	if err != nil || sessions != 1 || segments != 1 {
		t.Fatalf("recovery = %d sessions, %d segments, %v", sessions, segments, err)
	}
	gotSession, err := database.GetInterpretationSession(ctx, user.ID, session.ID)
	if err != nil || gotSession.Status != domain.InterpretationFailed || gotSession.EndedAt == nil || !gotSession.EndedAt.Equal(recoveredAt) {
		t.Fatalf("recovered session = %#v, %v", gotSession, err)
	}
	gotSegments, err := database.ListSegments(ctx, user.ID, session.ID)
	if err != nil || len(gotSegments) != 1 || gotSegments[0].TranslationStatus != domain.TranslationFailed || gotSegments[0].TranslationError != "interrupted" {
		t.Fatalf("recovered segments = %#v, %v", gotSegments, err)
	}

	if err := database.UpdateSegmentTranslation(ctx, user.ID, session.ID, segment.ID, domain.TranslationSucceeded, "bonjour", "", "req_one", recoveredAt); err != nil {
		t.Fatal(err)
	}
	gotSegments, err = database.ListSegments(ctx, user.ID, session.ID)
	if err != nil || gotSegments[0].Translation != "bonjour" || gotSegments[0].TranslatorRequestID != "req_one" {
		t.Fatalf("translation update = %#v, %v", gotSegments, err)
	}
	if err := database.UpdateSegmentTranslation(ctx, "usr_other", session.ID, segment.ID, domain.TranslationFailed, "", "denied", "", recoveredAt); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-owner translation update = %v, want not found", err)
	}
}

func TestEditableSessionMutationCannotRacePastLiveTransition(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	user := testUser("usr_mutation_race", "mutation-race", domain.RoleUser)
	mustCreateUser(t, database, user)

	for iteration := range 64 {
		session := domain.InterpretationSession{
			ID: fmt.Sprintf("session_mutation_%d", iteration), UserID: user.ID,
			Title: "Before", SourceLanguage: "en", TargetLanguage: "fr",
			Status: domain.InterpretationCreated, CreatedAt: testNow, UpdatedAt: testNow,
		}
		if err := database.CreateInterpretationSession(ctx, session); err != nil {
			t.Fatal(err)
		}
		started := testNow.Add(time.Duration(iteration+1) * time.Second)
		start := make(chan struct{})
		var claimErr, editErr error
		var claimed domain.InterpretationSession
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			claimed, claimErr = database.ClaimInterpretationSessionLive(ctx, user.ID, session.ID, started)
		}()
		go func() {
			defer wg.Done()
			<-start
			_, editErr = database.UpdateInterpretationSessionMetadata(
				ctx, user.ID, session.ID, "After", "de", "it", started,
			)
		}()
		close(start)
		wg.Wait()
		if claimErr != nil {
			t.Fatalf("iteration %d live claim: %v", iteration, claimErr)
		}
		if editErr != nil && !errors.Is(editErr, ErrConflict) {
			t.Fatalf("iteration %d metadata edit: %v", iteration, editErr)
		}
		stored, err := database.GetInterpretationSession(ctx, user.ID, session.ID)
		if err != nil || stored.Status != domain.InterpretationLive || stored.StartedAt == nil {
			t.Fatalf("iteration %d stale edit overwrote live state: %#v, %v", iteration, stored, err)
		}
		if claimed.Status != domain.InterpretationLive || claimed.Title != stored.Title ||
			claimed.SourceLanguage != stored.SourceLanguage || claimed.TargetLanguage != stored.TargetLanguage {
			t.Fatalf("iteration %d claim/store metadata diverged: claimed=%#v stored=%#v", iteration, claimed, stored)
		}
		if err := database.DeleteInterpretationSessionIfNotLive(ctx, user.ID, session.ID); !errors.Is(err, ErrConflict) {
			t.Fatalf("iteration %d deleted live session: %v", iteration, err)
		}
	}
}

func TestSegmentCursorPaginationAndMaxSequence(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	user := testUser("usr_segment_cursor", "segment-cursor", domain.RoleUser)
	mustCreateUser(t, database, user)
	session := domain.InterpretationSession{
		ID: "session_segment_cursor", UserID: user.ID, Title: "Long transcript",
		SourceLanguage: "en", TargetLanguage: "fr", Status: domain.InterpretationCompleted,
		CreatedAt: testNow, UpdatedAt: testNow,
	}
	if err := database.CreateInterpretationSession(ctx, session); err != nil {
		t.Fatal(err)
	}
	if _, err := database.db.ExecContext(ctx, `
		WITH RECURSIVE sequence(number) AS (
			SELECT 1
			UNION ALL
			SELECT number + 1 FROM sequence WHERE number < 205
		)
		INSERT INTO segments(
			id, session_id, user_id, sequence, source_text, translation,
			final, start_ms, end_ms, created_at, translation_status,
			translation_error, translator_request_id
		)
		SELECT printf('segment_cursor_%03d', number), ?, ?, number,
			printf('source-%03d', number), '', 1, number * 10, number * 10 + 5,
			?, 'not_requested', '', ''
		FROM sequence`, session.ID, user.ID, encodeTime(testNow)); err != nil {
		t.Fatal(err)
	}
	if _, err := database.db.ExecContext(ctx, `
		UPDATE interpretation_sessions
		SET segment_count = 205,
			transcript_bytes = (
				SELECT SUM(length(CAST(source_text AS BLOB)) + length(CAST(translation AS BLOB)))
				FROM segments WHERE session_id = ?
			)
		WHERE id = ?`, session.ID, session.ID); err != nil {
		t.Fatal(err)
	}

	after := int64(0)
	wantPageSizes := []int{100, 100, 5}
	for pageIndex, wantSize := range wantPageSizes {
		page, err := database.ListSegmentsPage(ctx, user.ID, session.ID, after, 100)
		if err != nil {
			t.Fatalf("page %d: %v", pageIndex, err)
		}
		if len(page.Items) != wantSize {
			t.Fatalf("page %d contains %d segments, want %d", pageIndex, len(page.Items), wantSize)
		}
		wantFirst := int64(pageIndex*100 + 1)
		wantLast := wantFirst + int64(wantSize) - 1
		if page.Items[0].Sequence != wantFirst || page.Items[len(page.Items)-1].Sequence != wantLast {
			t.Fatalf("page %d sequence range = %d..%d, want %d..%d",
				pageIndex, page.Items[0].Sequence, page.Items[len(page.Items)-1].Sequence,
				wantFirst, wantLast,
			)
		}
		wantMore := pageIndex < len(wantPageSizes)-1
		if page.HasMore != wantMore || page.NextAfter != wantLast {
			t.Fatalf("page %d cursor = (%d, %v), want (%d, %v)",
				pageIndex, page.NextAfter, page.HasMore, wantLast, wantMore,
			)
		}
		after = page.NextAfter
	}
	maxSequence, err := database.MaxSegmentSequence(ctx, user.ID, session.ID)
	if err != nil || maxSequence != 205 {
		t.Fatalf("max sequence = %d, %v; want 205", maxSequence, err)
	}
	if _, err := database.ListSegmentsPage(ctx, "usr_other", session.ID, 0, 100); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-owner cursor page = %v, want not found", err)
	}
	if _, err := database.MaxSegmentSequence(ctx, "usr_other", session.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-owner max sequence = %v, want not found", err)
	}
}

func TestInterpretationSessionQuotaIsAtomic(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	user := testUser("usr_session_quota", "session-quota", domain.RoleUser)
	mustCreateUser(t, database, user)
	if _, err := database.db.ExecContext(ctx, `
		WITH RECURSIVE sequence(number) AS (
			SELECT 1
			UNION ALL
			SELECT number + 1 FROM sequence WHERE number < ?
		)
		INSERT INTO interpretation_sessions(
			id, user_id, title, source_language, target_language, status,
			created_at, updated_at
		)
		SELECT printf('session_quota_seed_%04d', number), ?, 'Seed', 'en', 'fr',
			'completed', ?, ? FROM sequence`,
		maxInterpretationSessionsPerUser-1, user.ID, encodeTime(testNow), encodeTime(testNow),
	); err != nil {
		t.Fatal(err)
	}

	const contenders = 16
	start := make(chan struct{})
	results := make(chan error, contenders)
	var wait sync.WaitGroup
	for index := range contenders {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			results <- database.CreateInterpretationSession(ctx, domain.InterpretationSession{
				ID: fmt.Sprintf("session_quota_contender_%02d", index), UserID: user.ID,
				Title: "Contender", SourceLanguage: "en", TargetLanguage: "de",
				Status: domain.InterpretationCreated, CreatedAt: testNow, UpdatedAt: testNow,
			})
		}()
	}
	close(start)
	wait.Wait()
	close(results)
	succeeded, rejected := 0, 0
	for err := range results {
		switch {
		case err == nil:
			succeeded++
		case errors.Is(err, ErrCapacity):
			rejected++
		default:
			t.Fatalf("unexpected session quota result: %v", err)
		}
	}
	if succeeded != 1 || rejected != contenders-1 {
		t.Fatalf("session quota successes=%d rejections=%d", succeeded, rejected)
	}
	var count int
	if err := database.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM interpretation_sessions WHERE user_id = ?", user.ID,
	).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != maxInterpretationSessionsPerUser {
		t.Fatalf("stored sessions = %d, want %d", count, maxInterpretationSessionsPerUser)
	}
}

func TestSegmentAndTranscriptQuotasAreAtomicAndRollback(t *testing.T) {
	t.Run("segment count concurrency", func(t *testing.T) {
		database, _ := newTestStore(t)
		ctx := context.Background()
		user, session := createQuotaTestSession(t, database, "segment_count")
		if _, err := database.db.ExecContext(ctx, `
			UPDATE interpretation_sessions SET segment_count = ? WHERE id = ?`,
			maxSegmentsPerInterpretation-1, session.ID,
		); err != nil {
			t.Fatal(err)
		}

		const contenders = 16
		start := make(chan struct{})
		results := make(chan error, contenders)
		var wait sync.WaitGroup
		for index := range contenders {
			wait.Add(1)
			go func() {
				defer wait.Done()
				<-start
				results <- database.AppendSegment(ctx, user.ID, domain.Segment{
					ID: fmt.Sprintf("segment_count_%02d", index), SessionID: session.ID,
					Sequence: int64(index + 1), SourceText: "x", Final: true,
					CreatedAt: testNow.Add(time.Duration(index) * time.Second),
				})
			}()
		}
		close(start)
		wait.Wait()
		close(results)
		assertQuotaResults(t, results, 1, contenders-1)
		assertInterpretationUsage(t, database, session.ID, maxSegmentsPerInterpretation, 1, 1)
	})

	t.Run("transcript concurrency", func(t *testing.T) {
		database, _ := newTestStore(t)
		ctx := context.Background()
		user, session := createQuotaTestSession(t, database, "transcript_concurrency")
		if _, err := database.db.ExecContext(ctx, `
			UPDATE interpretation_sessions SET transcript_bytes = ? WHERE id = ?`,
			maxTranscriptBytesPerSession-10, session.ID,
		); err != nil {
			t.Fatal(err)
		}

		const contenders = 20
		start := make(chan struct{})
		results := make(chan error, contenders)
		var wait sync.WaitGroup
		for index := range contenders {
			wait.Add(1)
			go func() {
				defer wait.Done()
				<-start
				results <- database.AppendSegment(ctx, user.ID, domain.Segment{
					ID: fmt.Sprintf("segment_transcript_%02d", index), SessionID: session.ID,
					Sequence: int64(index + 1), SourceText: "x", Final: true,
					CreatedAt: testNow.Add(time.Duration(index) * time.Second),
				})
			}()
		}
		close(start)
		wait.Wait()
		close(results)
		assertQuotaResults(t, results, 10, contenders-10)
		assertInterpretationUsage(t, database, session.ID, 10, maxTranscriptBytesPerSession, 10)
	})

	t.Run("failed insert rolls back reservation", func(t *testing.T) {
		database, _ := newTestStore(t)
		ctx := context.Background()
		user, session := createQuotaTestSession(t, database, "insert_rollback")
		first := domain.Segment{
			ID: "segment_inserted", SessionID: session.ID, Sequence: 1,
			SourceText: "first", Final: true, CreatedAt: testNow,
		}
		if err := database.AppendSegment(ctx, user.ID, first); err != nil {
			t.Fatal(err)
		}
		duplicateSequence := first
		duplicateSequence.ID = "segment_duplicate_sequence"
		duplicateSequence.SourceText = "reservation-must-rollback"
		if err := database.AppendSegment(ctx, user.ID, duplicateSequence); !errors.Is(err, ErrConflict) {
			t.Fatalf("duplicate sequence append = %v, want conflict", err)
		}
		assertInterpretationUsage(t, database, session.ID, 1, int64(len(first.SourceText)), 1)
	})

	t.Run("user transcript cap", func(t *testing.T) {
		database, _ := newTestStore(t)
		ctx := context.Background()
		user := testUser("usr_user_transcript_quota", "user-transcript-quota", domain.RoleUser)
		mustCreateUser(t, database, user)
		for index := range maxTranscriptBytesPerUser / maxTranscriptBytesPerSession {
			session := quotaTestSession(user.ID, fmt.Sprintf("user_usage_%02d", index))
			if err := database.CreateInterpretationSession(ctx, session); err != nil {
				t.Fatal(err)
			}
			if _, err := database.db.ExecContext(ctx,
				"UPDATE interpretation_sessions SET transcript_bytes = ? WHERE id = ?",
				maxTranscriptBytesPerSession, session.ID,
			); err != nil {
				t.Fatal(err)
			}
		}
		target := quotaTestSession(user.ID, "user_usage_target")
		if err := database.CreateInterpretationSession(ctx, target); err != nil {
			t.Fatal(err)
		}
		if err := database.AppendSegment(ctx, user.ID, domain.Segment{
			ID: "segment_over_user_quota", SessionID: target.ID, Sequence: 1,
			SourceText: "x", Final: true, CreatedAt: testNow,
		}); !errors.Is(err, ErrCapacity) {
			t.Fatalf("append over user transcript quota = %v, want capacity", err)
		}
		assertInterpretationUsage(t, database, target.ID, 0, 0, 0)
	})

	t.Run("translation update rollback", func(t *testing.T) {
		database, _ := newTestStore(t)
		ctx := context.Background()
		user, session := createQuotaTestSession(t, database, "translation_rollback")
		segment := domain.Segment{
			ID: "segment_translation_rollback", SessionID: session.ID, Sequence: 1,
			SourceText: "x", TranslationStatus: domain.TranslationPending,
			Final: true, CreatedAt: testNow,
		}
		if err := database.AppendSegment(ctx, user.ID, segment); err != nil {
			t.Fatal(err)
		}
		if _, err := database.db.ExecContext(ctx,
			"UPDATE interpretation_sessions SET transcript_bytes = ? WHERE id = ?",
			maxTranscriptBytesPerSession, session.ID,
		); err != nil {
			t.Fatal(err)
		}
		if err := database.UpdateSegmentTranslation(
			ctx, user.ID, session.ID, segment.ID, domain.TranslationSucceeded,
			"y", "", "request-over-quota", testNow.Add(time.Minute),
		); !errors.Is(err, ErrCapacity) {
			t.Fatalf("translation over transcript quota = %v, want capacity", err)
		}
		stored, err := database.ListSegments(ctx, user.ID, session.ID)
		if err != nil || len(stored) != 1 || stored[0].Translation != "" ||
			stored[0].TranslationStatus != domain.TranslationPending {
			t.Fatalf("failed translation update mutated segment: %#v, %v", stored, err)
		}
		assertInterpretationUsage(t, database, session.ID, 1, maxTranscriptBytesPerSession, 1)

		if _, err := database.db.ExecContext(ctx,
			"UPDATE interpretation_sessions SET transcript_bytes = ? WHERE id = ?",
			maxTranscriptBytesPerSession-1, session.ID,
		); err != nil {
			t.Fatal(err)
		}
		if err := database.UpdateSegmentTranslation(
			ctx, user.ID, session.ID, segment.ID, domain.TranslationSucceeded,
			"y", "", "request-fits-quota", testNow.Add(2*time.Minute),
		); err != nil {
			t.Fatalf("translation fitting transcript quota: %v", err)
		}
		assertInterpretationUsage(t, database, session.ID, 1, maxTranscriptBytesPerSession, 1)
	})
}

func createQuotaTestSession(t *testing.T, database *Store, suffix string) (domain.User, domain.InterpretationSession) {
	t.Helper()
	user := testUser("usr_quota_"+suffix, "quota-"+suffix, domain.RoleUser)
	mustCreateUser(t, database, user)
	session := quotaTestSession(user.ID, suffix)
	if err := database.CreateInterpretationSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	return user, session
}

func quotaTestSession(userID, suffix string) domain.InterpretationSession {
	return domain.InterpretationSession{
		ID: "session_" + suffix, UserID: userID, Title: "Quota test",
		SourceLanguage: "en", TargetLanguage: "fr", Status: domain.InterpretationCreated,
		CreatedAt: testNow, UpdatedAt: testNow,
	}
}

func assertQuotaResults(t *testing.T, results <-chan error, wantSucceeded, wantRejected int) {
	t.Helper()
	succeeded, rejected := 0, 0
	for err := range results {
		switch {
		case err == nil:
			succeeded++
		case errors.Is(err, ErrCapacity):
			rejected++
		default:
			t.Fatalf("unexpected quota result: %v", err)
		}
	}
	if succeeded != wantSucceeded || rejected != wantRejected {
		t.Fatalf("quota successes=%d rejections=%d, want %d and %d",
			succeeded, rejected, wantSucceeded, wantRejected,
		)
	}
}

func assertInterpretationUsage(
	t *testing.T,
	database *Store,
	sessionID string,
	wantSegments int,
	wantBytes int64,
	wantRows int,
) {
	t.Helper()
	var segments int
	var transcriptBytes int64
	var rows int
	if err := database.db.QueryRowContext(context.Background(), `
		SELECT session.segment_count, session.transcript_bytes,
			(SELECT COUNT(*) FROM segments WHERE session_id = session.id)
		FROM interpretation_sessions session WHERE session.id = ?`, sessionID,
	).Scan(&segments, &transcriptBytes, &rows); err != nil {
		t.Fatal(err)
	}
	if segments != wantSegments || transcriptBytes != wantBytes || rows != wantRows {
		t.Fatalf("usage = segments %d, bytes %d, rows %d; want %d, %d, %d",
			segments, transcriptBytes, rows, wantSegments, wantBytes, wantRows,
		)
	}
}
