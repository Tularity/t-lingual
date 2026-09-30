package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
)

// GetLimitOverrides reads how one account is set apart from the default
// limits; an account never set apart has no overrides.
func (s *Store) GetLimitOverrides(ctx context.Context, userID string) (domain.LimitOverrides, error) {
	return scanLimitOverrides(s.db.QueryRowContext(ctx, `SELECT concurrent_recordings, monthly_recording_minutes,
		storage_mb, workspaces, guest_links FROM user_limits WHERE user_id = ?`, userID))
}

func scanLimitOverrides(row rowScanner) (domain.LimitOverrides, error) {
	var concurrent, minutes, storage, workspaces, guests sql.NullInt64
	if err := row.Scan(&concurrent, &minutes, &storage, &workspaces, &guests); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return domain.LimitOverrides{}, nil
		}
		return domain.LimitOverrides{}, fmt.Errorf("store: read limits: %w", err)
	}
	number := func(value sql.NullInt64) *int {
		if !value.Valid {
			return nil
		}
		result := int(value.Int64)
		return &result
	}
	overrides := domain.LimitOverrides{ConcurrentRecordings: number(concurrent), MonthlyRecordingMinutes: number(minutes),
		StorageMB: number(storage), Workspaces: number(workspaces)}
	if guests.Valid {
		allowed := guests.Int64 == 1
		overrides.GuestLinks = &allowed
	}
	return overrides, nil
}

// DefaultLimits are the limits of every account not set apart: as an
// administrator last set them, or the built-in ones until then.
func (s *Store) DefaultLimits(ctx context.Context) (domain.UserLimits, error) {
	var limits domain.UserLimits
	var guests int
	err := s.db.QueryRowContext(ctx, `SELECT concurrent_recordings, monthly_recording_minutes, storage_mb,
		workspaces, guest_links FROM default_limits WHERE id = 1`).Scan(&limits.ConcurrentRecordings,
		&limits.MonthlyRecordingMinutes, &limits.StorageMB, &limits.Workspaces, &guests)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.DefaultUserLimits, nil
	}
	if err != nil {
		return domain.UserLimits{}, fmt.Errorf("store: read default limits: %w", err)
	}
	limits.GuestLinks = guests == 1
	return limits, nil
}

// SetDefaultLimitsAsAdmin replaces the default limits, recording who did it
// in the same transaction. Every account without its own value for a limit
// follows the new default from then on.
func (s *Store) SetDefaultLimitsAsAdmin(ctx context.Context, actorUserID, browserSessionID string, checkedAt time.Time,
	limits domain.UserLimits, event AuditEvent, now time.Time) error {
	if !limits.Valid() || now.IsZero() {
		return errors.New("store: invalid default limits")
	}
	authority, err := webAdminMutationAuthority(actorUserID, browserSessionID, checkedAt)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: begin default limits update: %w", err)
	}
	defer tx.Rollback()
	if err := requireAdminMutationAuthority(ctx, tx, authority); err != nil {
		return err
	}
	guests := 0
	if limits.GuestLinks {
		guests = 1
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO default_limits(id, concurrent_recordings, monthly_recording_minutes,
		storage_mb, workspaces, guest_links, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET concurrent_recordings = excluded.concurrent_recordings,
		monthly_recording_minutes = excluded.monthly_recording_minutes, storage_mb = excluded.storage_mb,
		workspaces = excluded.workspaces, guest_links = excluded.guest_links, updated_at = excluded.updated_at`,
		limits.ConcurrentRecordings, limits.MonthlyRecordingMinutes, limits.StorageMB, limits.Workspaces, guests,
		encodeTime(now)); err != nil {
		return fmt.Errorf("store: save default limits: %w", mapSQLError(err))
	}
	if err := appendAuditEventTx(ctx, tx, event); err != nil {
		return err
	}
	return tx.Commit()
}

// EffectiveLimits are the limits one account is held to now.
func (s *Store) EffectiveLimits(ctx context.Context, userID string) (domain.UserLimits, error) {
	overrides, err := s.GetLimitOverrides(ctx, userID)
	if err != nil {
		return domain.UserLimits{}, err
	}
	defaults, err := s.DefaultLimits(ctx)
	if err != nil {
		return domain.UserLimits{}, err
	}
	return overrides.Apply(defaults), nil
}

// RequireActiveAdmin rechecks, from the durable records rather than anything
// cached by authentication, that the actor is still an active administrator
// signed in with this browser session.
func (s *Store) RequireActiveAdmin(ctx context.Context, actorUserID, browserSessionID string, checkedAt time.Time) error {
	authority, err := webAdminMutationAuthority(actorUserID, browserSessionID, checkedAt)
	if err != nil {
		return err
	}
	tx, err := s.beginAuthorizedAdminRead(ctx, authority)
	if err != nil {
		return err
	}
	return tx.Rollback()
}

// SetLimitOverridesAsAdmin replaces one account's overrides, recording who
// did it in the same transaction. Overrides that are all unset return the
// account to the defaults.
func (s *Store) SetLimitOverridesAsAdmin(ctx context.Context, actorUserID, browserSessionID string, checkedAt time.Time,
	userID string, overrides domain.LimitOverrides, event AuditEvent, now time.Time) error {
	if userID == "" || !overrides.Valid() || now.IsZero() {
		return errors.New("store: invalid limits")
	}
	authority, err := webAdminMutationAuthority(actorUserID, browserSessionID, checkedAt)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: begin limits update: %w", err)
	}
	defer tx.Rollback()
	if err := requireAdminMutationAuthority(ctx, tx, authority); err != nil {
		return err
	}
	var exists int
	if err := tx.QueryRowContext(ctx, `SELECT 1 FROM users WHERE id = ?`, userID).Scan(&exists); err != nil {
		return fmt.Errorf("store: find limited user: %w", mapSQLError(err))
	}
	optional := func(value *int) any {
		if value == nil {
			return nil
		}
		return *value
	}
	var guests any
	if overrides.GuestLinks != nil {
		guests = 0
		if *overrides.GuestLinks {
			guests = 1
		}
	}
	if overrides == (domain.LimitOverrides{}) {
		_, err = tx.ExecContext(ctx, `DELETE FROM user_limits WHERE user_id = ?`, userID)
	} else {
		_, err = tx.ExecContext(ctx, `INSERT INTO user_limits(user_id, concurrent_recordings, monthly_recording_minutes,
			storage_mb, workspaces, guest_links, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(user_id) DO UPDATE SET concurrent_recordings = excluded.concurrent_recordings,
			monthly_recording_minutes = excluded.monthly_recording_minutes, storage_mb = excluded.storage_mb,
			workspaces = excluded.workspaces, guest_links = excluded.guest_links, updated_at = excluded.updated_at`,
			userID, optional(overrides.ConcurrentRecordings), optional(overrides.MonthlyRecordingMinutes),
			optional(overrides.StorageMB), optional(overrides.Workspaces), guests, encodeTime(now))
	}
	if err != nil {
		return fmt.Errorf("store: save limits: %w", mapSQLError(err))
	}
	if err := appendAuditEventTx(ctx, tx, event); err != nil {
		return err
	}
	return commitAdminMutation(ctx, tx, "limits update")
}

// RecordedMillisecondsSince is how much audio the account's own sessions
// have recorded since a moment, whoever recorded it.
func (s *Store) RecordedMillisecondsSince(ctx context.Context, userID string, since time.Time) (int64, error) {
	var total sql.NullFloat64
	if err := s.db.QueryRowContext(ctx, `SELECT SUM(frames * 1000.0 / sample_rate) FROM recording_parts
		WHERE user_id = ? AND created_at >= ?`, userID, encodeTime(since)).Scan(&total); err != nil {
		return 0, fmt.Errorf("store: sum recorded audio: %w", err)
	}
	return int64(total.Float64), nil
}

// StorageBytes is what the account keeps: its recorded audio and transcripts.
func (s *Store) StorageBytes(ctx context.Context, userID string) (int64, error) {
	var audio, transcripts sql.NullInt64
	if err := s.db.QueryRowContext(ctx, `SELECT
		(SELECT SUM(bytes) FROM recording_parts WHERE user_id = ?),
		(SELECT SUM(transcript_bytes) FROM interpretation_sessions WHERE user_id = ?)`, userID, userID).Scan(&audio, &transcripts); err != nil {
		return 0, fmt.Errorf("store: sum storage: %w", err)
	}
	return audio.Int64 + transcripts.Int64, nil
}

// AccountStorage is what one account keeps on disk, and in what.
type AccountStorage struct {
	AudioBytes        int64
	TranscriptBytes   int64
	Sessions          int
	ArchivedSessions  int
	SessionsWithAudio int
	Workspaces        int
}

// AccountStorageOf reads what one account keeps: its recorded audio, its
// transcripts and translations, and the sessions and workspaces holding them.
func (s *Store) AccountStorageOf(ctx context.Context, userID string) (AccountStorage, error) {
	var audio, transcripts sql.NullInt64
	var storage AccountStorage
	if err := s.db.QueryRowContext(ctx, `SELECT
		(SELECT SUM(bytes) FROM recording_parts WHERE user_id = ?),
		(SELECT SUM(transcript_bytes) FROM interpretation_sessions WHERE user_id = ?),
		(SELECT COUNT(*) FROM interpretation_sessions WHERE user_id = ?),
		(SELECT COUNT(*) FROM interpretation_sessions WHERE user_id = ? AND archived_at IS NOT NULL),
		(SELECT COUNT(DISTINCT session_id) FROM recording_parts WHERE user_id = ? AND bytes > 0),
		(SELECT COUNT(*) FROM workspaces WHERE user_id = ?)`,
		userID, userID, userID, userID, userID, userID).Scan(&audio, &transcripts, &storage.Sessions,
		&storage.ArchivedSessions, &storage.SessionsWithAudio, &storage.Workspaces); err != nil {
		return AccountStorage{}, fmt.Errorf("store: read account storage: %w", err)
	}
	storage.AudioBytes, storage.TranscriptBytes = audio.Int64, transcripts.Int64
	return storage, nil
}

// MonthStart is the first moment of the calendar month (UTC) holding now.
func MonthStart(now time.Time) time.Time {
	now = now.UTC()
	return time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
}

// AccountCounts is what one account holds: sessions and workspaces, and when
// it was last seen in any browser.
func (s *Store) AccountCounts(ctx context.Context, userID string) (sessions, workspaces int, lastSeen *time.Time, err error) {
	var seen sql.NullInt64
	err = s.db.QueryRowContext(ctx, `SELECT
		(SELECT COUNT(*) FROM interpretation_sessions WHERE user_id = ?),
		(SELECT COUNT(*) FROM workspaces WHERE user_id = ?),
		(SELECT MAX(last_seen) FROM browser_sessions WHERE user_id = ?)`, userID, userID, userID).Scan(&sessions, &workspaces, &seen)
	if err != nil {
		return 0, 0, nil, fmt.Errorf("store: count account: %w", err)
	}
	return sessions, workspaces, decodeOptionalTime(seen), nil
}
