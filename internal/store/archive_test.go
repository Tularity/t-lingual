package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
)

func archiveTestSession(id, ownerID string, updatedAt time.Time, status domain.InterpretationStatus) domain.InterpretationSession {
	return domain.InterpretationSession{
		ID: id, UserID: ownerID, Title: "Archive test", SourceLanguage: "en", TargetLanguage: "fr",
		Status: status, CreatedAt: testNow, UpdatedAt: updatedAt,
	}
}

func TestArchiveLifecycleOwnershipAndInactivity(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	alice := testUser("usr_archive_alice", "archive-alice", domain.RoleUser)
	bob := testUser("usr_archive_bob", "archive-bob", domain.RoleUser)
	mustCreateUser(t, database, alice)
	mustCreateUser(t, database, bob)
	old := archiveTestSession("session_archive_old", alice.ID, testNow, domain.InterpretationCompleted)
	recent := archiveTestSession("session_archive_recent", alice.ID, testNow.Add(23*time.Hour), domain.InterpretationFailed)
	live := archiveTestSession("session_archive_live", alice.ID, testNow, domain.InterpretationLive)
	never := archiveTestSession("session_archive_never", bob.ID, testNow, domain.InterpretationCreated)
	for _, session := range []domain.InterpretationSession{old, recent, live, never} {
		if err := database.CreateInterpretationSession(ctx, session); err != nil {
			t.Fatal(err)
		}
	}
	settings := domain.DefaultUserSettings(bob.ID)
	settings.AutoArchiveHours = 0
	if err := database.UpsertUserSettings(ctx, settings); err != nil {
		t.Fatal(err)
	}
	now := testNow.Add(25 * time.Hour)
	count, err := database.ArchiveInactiveInterpretations(ctx, now)
	if err != nil || count != 1 {
		t.Fatalf("default 24-hour sweep = %d, %v; want one", count, err)
	}
	archived, err := database.GetInterpretationSession(ctx, alice.ID, old.ID)
	if err != nil || archived.ArchivedAt == nil || !archived.ArchivedAt.Equal(now.UTC()) || archived.ArchiveReason != "inactivity" || archived.Status != old.Status {
		t.Fatalf("inactivity archive = %#v, %v", archived, err)
	}
	for _, session := range []domain.InterpretationSession{recent, live, never} {
		got, err := database.GetInterpretationSession(ctx, session.UserID, session.ID)
		if err != nil || got.ArchivedAt != nil {
			t.Fatalf("session %s archived unexpectedly: %#v, %v", session.ID, got, err)
		}
	}
	settings.AutoArchiveHours = 2
	if err := database.UpsertUserSettings(ctx, settings); err != nil {
		t.Fatal(err)
	}
	if count, err := database.ArchiveInactiveInterpretations(ctx, now); err != nil || count != 1 {
		t.Fatalf("custom two-hour sweep = %d, %v; want Bob's session", count, err)
	}
	bobArchived, err := database.GetInterpretationSession(ctx, bob.ID, never.ID)
	if err != nil || bobArchived.ArchivedAt == nil || bobArchived.ArchiveReason != "inactivity" {
		t.Fatalf("custom preference did not archive Bob's session: %#v, %v", bobArchived, err)
	}
	if _, err := database.UpdateInterpretationSessionMetadata(ctx, alice.ID, old.ID, "Changed", "de", "fr", now); !errors.Is(err, ErrArchived) {
		t.Fatalf("archived metadata edit = %v, want archived conflict", err)
	}
	if _, err := database.ClaimInterpretationSessionLive(ctx, alice.ID, old.ID, now); !errors.Is(err, ErrArchived) || !errors.Is(err, ErrConflict) {
		t.Fatalf("archived live claim = %v, want archived conflict", err)
	}
	if err := database.AppendSegment(ctx, alice.ID, domain.Segment{
		ID: "segment_archived_rejected", SessionID: old.ID, UserID: alice.ID,
		Sequence: 1, SourceText: "should not be added", Final: true,
		StartMS: 0, EndMS: 100, CreatedAt: now,
	}); !errors.Is(err, ErrArchived) {
		t.Fatalf("archived append = %v, want archived conflict", err)
	}
	if _, err := database.ArchiveInterpretationSession(ctx, alice.ID, live.ID, now); !errors.Is(err, ErrConflict) {
		t.Fatalf("live archive = %v, want conflict", err)
	}
	if _, err := database.ArchiveInterpretationSession(ctx, bob.ID, old.ID, now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-owner archive = %v, want not found", err)
	}
	if _, err := database.UnarchiveInterpretationSession(ctx, bob.ID, old.ID, now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-owner unarchive = %v, want not found", err)
	}

	reopenedAt := now.Add(time.Minute)
	reopened, err := database.UnarchiveInterpretationSession(ctx, alice.ID, old.ID, reopenedAt)
	if err != nil || reopened.ArchivedAt != nil || reopened.ArchiveReason != "" || !reopened.UpdatedAt.Equal(reopenedAt.UTC()) {
		t.Fatalf("unarchive = %#v, %v", reopened, err)
	}
	if count, err := database.ArchiveInactiveInterpretations(ctx, reopenedAt.Add(23*time.Hour)); err != nil || count != 1 {
		// The remaining recent failed session has crossed its default deadline.
		t.Fatalf("unarchive grace sweep = %d, %v; want recent session only", count, err)
	}
	got, err := database.GetInterpretationSession(ctx, alice.ID, old.ID)
	if err != nil || got.ArchivedAt != nil {
		t.Fatalf("unarchived session lost its fresh inactivity grace: %#v, %v", got, err)
	}
	if count, err := database.ArchiveInactiveInterpretations(ctx, reopenedAt.Add(24*time.Hour)); err != nil || count != 1 {
		t.Fatalf("expiry after unarchive = %d, %v; want one", count, err)
	}
}

func TestArchiveAndLiveClaimAreAtomic(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	user := testUser("usr_archive_race", "archive-race", domain.RoleUser)
	mustCreateUser(t, database, user)
	for index := range 40 {
		session := archiveTestSession(fmt.Sprintf("session_archive_race_%d", index), user.ID, testNow, domain.InterpretationCompleted)
		if err := database.CreateInterpretationSession(ctx, session); err != nil {
			t.Fatal(err)
		}
		start := make(chan struct{})
		var archiveErr, claimErr error
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			_, archiveErr = database.ArchiveInterpretationSession(ctx, user.ID, session.ID, testNow.Add(time.Hour))
		}()
		go func() {
			defer wg.Done()
			<-start
			_, claimErr = database.ClaimInterpretationSessionLive(ctx, user.ID, session.ID, testNow.Add(time.Hour))
		}()
		close(start)
		wg.Wait()
		stored, err := database.GetInterpretationSession(ctx, user.ID, session.ID)
		if err != nil {
			t.Fatal(err)
		}
		if archiveErr == nil {
			if !errors.Is(claimErr, ErrArchived) || stored.ArchivedAt == nil || stored.Status == domain.InterpretationLive {
				t.Fatalf("archive won with inconsistent claim/store: %v %#v", claimErr, stored)
			}
		} else if claimErr == nil {
			if !errors.Is(archiveErr, ErrConflict) || stored.ArchivedAt != nil || stored.Status != domain.InterpretationLive {
				t.Fatalf("claim won with inconsistent archive/store: %v %#v", archiveErr, stored)
			}
		} else {
			t.Fatalf("both archive and claim failed: %v, %v", archiveErr, claimErr)
		}
	}
}

func TestCrashRecoveryKeepsLastActivityForStartupArchive(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	user := testUser("usr_recovery_archive", "recovery-archive", domain.RoleUser)
	mustCreateUser(t, database, user)
	now := testNow.Add(72 * time.Hour)
	old := archiveTestSession("session_old_live", user.ID, testNow, domain.InterpretationLive)
	recent := archiveTestSession("session_recent_live", user.ID, testNow, domain.InterpretationLive)
	for _, session := range []domain.InterpretationSession{old, recent} {
		if err := database.CreateInterpretationSession(ctx, session); err != nil {
			t.Fatal(err)
		}
	}
	lastSpeech := now.Add(-time.Hour)
	if err := database.AppendSegment(ctx, user.ID, domain.Segment{
		ID: "segment_recent_speech", SessionID: recent.ID, UserID: user.ID,
		Sequence: 1, SourceText: "Recently spoken", Final: true,
		StartMS: 0, EndMS: 250, CreatedAt: lastSpeech,
	}); err != nil {
		t.Fatal(err)
	}
	if sessions, _, err := database.RecoverInterruptedInterpretations(ctx, now); err != nil || sessions != 2 {
		t.Fatalf("recovery = %d, %v", sessions, err)
	}
	archived, err := database.ArchiveInactiveInterpretations(ctx, now)
	if err != nil || archived != 1 {
		t.Fatalf("startup inactivity sweep = %d, %v; want only old live session", archived, err)
	}
	oldStored, err := database.GetInterpretationSession(ctx, user.ID, old.ID)
	if err != nil || oldStored.Status != domain.InterpretationFailed || oldStored.ArchivedAt == nil || !oldStored.UpdatedAt.Equal(testNow.UTC()) {
		t.Fatalf("old recovered session = %#v, %v", oldStored, err)
	}
	recentStored, err := database.GetInterpretationSession(ctx, user.ID, recent.ID)
	if err != nil || recentStored.ArchivedAt != nil || !recentStored.UpdatedAt.Equal(lastSpeech.UTC()) || recentStored.EndedAt == nil || !recentStored.EndedAt.Equal(now.UTC()) {
		t.Fatalf("recent recovered session = %#v, %v", recentStored, err)
	}
}

func TestArchiveMigrationPreservesVersion10Data(t *testing.T) {
	path := filepath.Join(t.TempDir(), "version10.sqlite")
	legacy, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := legacy.ExecContext(ctx, `CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	for _, migration := range migrations[:len(migrations)-1] {
		if _, err := legacy.ExecContext(ctx, migration.sql); err != nil {
			t.Fatalf("legacy migration %d: %v", migration.version, err)
		}
		if _, err := legacy.ExecContext(ctx, `INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)`, migration.version, encodeTime(testNow)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := legacy.ExecContext(ctx, `INSERT INTO users(id, webauthn_id, username, display_name, role, status, created_at, updated_at)
		VALUES ('usr_legacy', X'010203', 'legacy', 'Legacy', 'user', 'active', ?, ?)`, encodeTime(testNow), encodeTime(testNow)); err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.ExecContext(ctx, `INSERT INTO interpretation_sessions(id, user_id, title, source_language, target_language, status, created_at, updated_at)
		VALUES ('session_legacy', 'usr_legacy', 'Preserved', 'en', 'fr', 'completed', ?, ?)`, encodeTime(testNow), encodeTime(testNow)); err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.ExecContext(ctx, `INSERT INTO segments(id, session_id, user_id, sequence, source_text, translation,
		final, start_ms, end_ms, created_at, translation_status, translation_error, translator_request_id)
		VALUES ('segment_legacy', 'session_legacy', 'usr_legacy', 1, 'Preserved speech', '',
		1, 0, 500, ?, 'not_requested', '', '')`, encodeTime(testNow)); err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.ExecContext(ctx, `INSERT INTO user_settings(user_id, default_source_language, default_target_language, auto_start_microphone, show_partial_transcripts, compact_transcript_layout)
		VALUES ('usr_legacy', 'en', 'fr', 0, 1, 0)`); err != nil {
		t.Fatal(err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}
	database, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	session, err := database.GetInterpretationSession(ctx, "usr_legacy", "session_legacy")
	if err != nil || session.Title != "Preserved" || session.ArchivedAt != nil || session.ArchiveReason != "" ||
		len(session.RecognitionLanguages) != 0 || session.Diarization {
		t.Fatalf("legacy session migration = %#v, %v", session, err)
	}
	segments, err := database.ListSegments(ctx, "usr_legacy", "session_legacy")
	if err != nil || len(segments) != 1 || segments[0].SourceText != "Preserved speech" ||
		segments[0].DetectedLanguage != "" || segments[0].SpeakerID != "" || segments[0].Wall0MS != 0 || segments[0].Wall1MS != 0 {
		t.Fatalf("legacy segment migration = %#v, %v", segments, err)
	}
	settings, err := database.GetUserSettings(ctx, "usr_legacy")
	if err != nil || settings.AutoArchiveHours != 24 {
		t.Fatalf("legacy settings migration = %#v, %v", settings, err)
	}
}
