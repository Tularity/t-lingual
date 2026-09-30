package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/Tularity/t-lingual/internal/domain"
)

const (
	maxInterpretationSessionsPerUser = 1000
	maxSegmentsPerInterpretation     = 25_000
	maxTranscriptBytesPerSession     = 16 << 20
	maxTranscriptBytesPerUser        = 256 << 20
	maxSegmentTextBytes              = 64 << 10
)

func (s *Store) CreateInterpretationSession(
	ctx context.Context,
	session domain.InterpretationSession,
) error {
	// Every session is kept in a workspace: without one named, the owner's
	// most recently used.
	if session.WorkspaceID == "" && session.UserID != "" {
		recent, err := s.recentWorkspaceID(ctx, session.UserID, session.CreatedAt)
		if err != nil {
			return err
		}
		session.WorkspaceID = recent
	}
	if err := validateInterpretationSession(session); err != nil {
		return err
	}
	if session.WorkspaceID == "" {
		return errors.New("store: interpretation session workspace is required")
	}
	recognition, err := json.Marshal(nonNilLanguages(session.RecognitionLanguages))
	if err != nil {
		return fmt.Errorf("store: encode recognition languages: %w", err)
	}
	result, err := s.db.ExecContext(ctx, `
		INSERT INTO interpretation_sessions(
			id, user_id, title, source_language, target_language, status,
			created_at, updated_at, started_at, ended_at,
			recognition_languages_json, diarization, workspace_id
		)
		SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		WHERE (SELECT COUNT(*) FROM interpretation_sessions WHERE user_id = ?) < ?
			AND EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND user_id = ?)`,
		session.ID, session.UserID, session.Title, session.SourceLanguage,
		session.TargetLanguage, session.Status, encodeTime(session.CreatedAt),
		encodeTime(session.UpdatedAt), encodeOptionalTime(session.StartedAt),
		encodeOptionalTime(session.EndedAt), string(recognition), boolInt(session.Diarization),
		session.WorkspaceID, session.UserID, maxInterpretationSessionsPerUser,
		session.WorkspaceID, session.UserID,
	)
	if err != nil {
		return fmt.Errorf("store: create interpretation session: %w", mapSQLError(err))
	}
	count, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("store: inspect interpretation session creation: %w", err)
	}
	if count == 0 {
		// Either the owner is at capacity, or the workspace is not theirs.
		var owned int
		if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM workspaces WHERE id = ? AND user_id = ?`, session.WorkspaceID, session.UserID).Scan(&owned); err != nil {
			return fmt.Errorf("store: inspect interpretation session workspace: %w", err)
		}
		if owned == 0 {
			return ErrNotFound
		}
		return ErrCapacity
	}
	return nil
}

func nonNilLanguages(languages []string) []string {
	if languages == nil {
		return []string{}
	}
	return languages
}

func validInterpretationStatus(status domain.InterpretationStatus) bool {
	return status == domain.InterpretationCreated ||
		status == domain.InterpretationLive ||
		status == domain.InterpretationCompleted ||
		status == domain.InterpretationFailed
}

func validateInterpretationSession(session domain.InterpretationSession) error {
	if session.ID == "" || session.UserID == "" {
		return errors.New("store: interpretation session id and owner are required")
	}
	if session.SourceLanguage == "" || session.TargetLanguage == "" {
		return errors.New("store: interpretation languages are required")
	}
	if !validInterpretationStatus(session.Status) {
		return fmt.Errorf("store: invalid interpretation status %q", session.Status)
	}
	if session.CreatedAt.IsZero() || session.UpdatedAt.IsZero() {
		return errors.New("store: interpretation timestamps are required")
	}
	return nil
}

func (s *Store) GetInterpretationSession(
	ctx context.Context,
	ownerID string,
	sessionID string,
) (domain.InterpretationSession, error) {
	return scanInterpretationSession(s.db.QueryRowContext(ctx, `
		SELECT id, user_id, title, source_language, target_language, status,
			created_at, updated_at, started_at, ended_at, archived_at, archive_reason,
			recognition_languages_json, diarization, COALESCE(workspace_id, '')
		FROM interpretation_sessions WHERE id = ? AND user_id = ?`,
		sessionID, ownerID,
	))
}

func scanInterpretationSession(row rowScanner) (domain.InterpretationSession, error) {
	var session domain.InterpretationSession
	var status string
	var createdAt, updatedAt int64
	var startedAt, endedAt, archivedAt sql.NullInt64
	var recognitionJSON string
	var diarization int
	if err := row.Scan(
		&session.ID, &session.UserID, &session.Title, &session.SourceLanguage,
		&session.TargetLanguage, &status, &createdAt, &updatedAt,
		&startedAt, &endedAt, &archivedAt, &session.ArchiveReason,
		&recognitionJSON, &diarization, &session.WorkspaceID,
	); err != nil {
		return domain.InterpretationSession{}, mapSQLError(err)
	}
	session.Status = domain.InterpretationStatus(status)
	session.CreatedAt = decodeTime(createdAt)
	session.UpdatedAt = decodeTime(updatedAt)
	session.StartedAt = decodeOptionalTime(startedAt)
	session.EndedAt = decodeOptionalTime(endedAt)
	session.ArchivedAt = decodeOptionalTime(archivedAt)
	if err := json.Unmarshal([]byte(recognitionJSON), &session.RecognitionLanguages); err != nil {
		return domain.InterpretationSession{}, fmt.Errorf("store: decode recognition languages: %w", err)
	}
	session.RecognitionLanguages = nonNilLanguages(session.RecognitionLanguages)
	session.Diarization = diarization != 0
	return session, nil
}

// ListInterpretationSessions lists only ownerID's sessions. A nil status means
// all statuses.
func (s *Store) ListInterpretationSessions(
	ctx context.Context,
	ownerID string,
	status *domain.InterpretationStatus,
	limit int,
	offset int,
) ([]domain.InterpretationSession, error) {
	limit, offset = pagination(limit, offset)
	query := `
		SELECT id, user_id, title, source_language, target_language, status,
			created_at, updated_at, started_at, ended_at, archived_at, archive_reason,
			recognition_languages_json, diarization, COALESCE(workspace_id, '')
		FROM interpretation_sessions WHERE user_id = ?`
	args := []any{ownerID}
	if status != nil {
		if !validInterpretationStatus(*status) {
			return nil, fmt.Errorf("store: invalid interpretation status %q", *status)
		}
		query += " AND status = ?"
		args = append(args, *status)
	}
	query += " ORDER BY updated_at DESC, id LIMIT ? OFFSET ?"
	args = append(args, limit, offset)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("store: list interpretation sessions: %w", err)
	}
	defer rows.Close()
	sessions := make([]domain.InterpretationSession, 0)
	for rows.Next() {
		session, err := scanInterpretationSession(rows)
		if err != nil {
			return nil, fmt.Errorf("store: list interpretation sessions: %w", err)
		}
		sessions = append(sessions, session)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list interpretation sessions: %w", err)
	}
	return sessions, nil
}

func (s *Store) UpdateInterpretationSession(
	ctx context.Context,
	ownerID string,
	session domain.InterpretationSession,
) error {
	if err := validateInterpretationSession(session); err != nil {
		return err
	}
	recognition, err := json.Marshal(nonNilLanguages(session.RecognitionLanguages))
	if err != nil {
		return fmt.Errorf("store: encode recognition languages: %w", err)
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE interpretation_sessions
		SET title = ?, source_language = ?, target_language = ?, status = ?,
			updated_at = ?, started_at = ?, ended_at = ?,
			recognition_languages_json = ?, diarization = ?
		WHERE id = ? AND user_id = ? AND archived_at IS NULL`,
		session.Title, session.SourceLanguage, session.TargetLanguage, session.Status,
		encodeTime(session.UpdatedAt), encodeOptionalTime(session.StartedAt),
		encodeOptionalTime(session.EndedAt), string(recognition), boolInt(session.Diarization), session.ID, ownerID,
	)
	if err := requireAffected(result, err, "update interpretation session"); errors.Is(err, ErrNotFound) {
		return s.interpretationMutationMiss(ctx, ownerID, session.ID)
	} else {
		return err
	}
}

// UpdateInterpretationSessionMetadata changes only editable fields and makes
// the not-live condition part of the same SQL statement. It can therefore
// never write a stale status back over a concurrent live transition.
func (s *Store) UpdateInterpretationSessionMetadata(
	ctx context.Context,
	ownerID string,
	sessionID string,
	title string,
	sourceLanguage string,
	targetLanguage string,
	updatedAt time.Time,
) (domain.InterpretationSession, error) {
	if ownerID == "" || sessionID == "" || title == "" || sourceLanguage == "" || targetLanguage == "" || updatedAt.IsZero() {
		return domain.InterpretationSession{}, errors.New("store: editable interpretation fields are required")
	}
	session, err := scanInterpretationSession(s.db.QueryRowContext(ctx, `
		UPDATE interpretation_sessions
		SET title = ?, source_language = ?, target_language = ?, updated_at = ?
		WHERE id = ? AND user_id = ? AND status <> 'live' AND archived_at IS NULL
		RETURNING id, user_id, title, source_language, target_language, status,
			created_at, updated_at, started_at, ended_at, archived_at, archive_reason,
			recognition_languages_json, diarization, COALESCE(workspace_id, '')`,
		title, sourceLanguage, targetLanguage, encodeTime(updatedAt), sessionID, ownerID,
	))
	if errors.Is(err, ErrNotFound) {
		return domain.InterpretationSession{}, s.interpretationMutationMiss(ctx, ownerID, sessionID)
	}
	if err != nil {
		return domain.InterpretationSession{}, fmt.Errorf("store: update interpretation metadata: %w", err)
	}
	return session, nil
}

// UpdateInterpretationSessionConfiguration atomically changes the complete
// editable recording setup while preserving owner/live/archive boundaries.
func (s *Store) UpdateInterpretationSessionConfiguration(
	ctx context.Context, ownerID, sessionID, title, sourceLanguage, targetLanguage string,
	recognitionLanguages []string, diarization bool, updatedAt time.Time,
) (domain.InterpretationSession, error) {
	if ownerID == "" || sessionID == "" || title == "" || sourceLanguage == "" || targetLanguage == "" || updatedAt.IsZero() {
		return domain.InterpretationSession{}, errors.New("store: editable interpretation fields are required")
	}
	recognition, err := json.Marshal(nonNilLanguages(recognitionLanguages))
	if err != nil {
		return domain.InterpretationSession{}, fmt.Errorf("store: encode recognition languages: %w", err)
	}
	session, err := scanInterpretationSession(s.db.QueryRowContext(ctx, `
		UPDATE interpretation_sessions
		SET title = ?, source_language = ?, target_language = ?,
			recognition_languages_json = ?, diarization = ?, updated_at = ?
		WHERE id = ? AND user_id = ? AND status <> 'live' AND archived_at IS NULL
		RETURNING id, user_id, title, source_language, target_language, status,
			created_at, updated_at, started_at, ended_at, archived_at, archive_reason,
			recognition_languages_json, diarization, COALESCE(workspace_id, '')`,
		title, sourceLanguage, targetLanguage, string(recognition), boolInt(diarization), encodeTime(updatedAt), sessionID, ownerID,
	))
	if errors.Is(err, ErrNotFound) {
		return domain.InterpretationSession{}, s.interpretationMutationMiss(ctx, ownerID, sessionID)
	}
	if err != nil {
		return domain.InterpretationSession{}, fmt.Errorf("store: update interpretation configuration: %w", err)
	}
	return session, nil
}

// ClaimInterpretationSessionLive atomically closes the metadata/delete window
// and returns the exact metadata claimed by the live run. A concurrent editor
// therefore either commits before this statement (and its values are returned)
// or observes status=live and is rejected.
func (s *Store) ClaimInterpretationSessionLive(
	ctx context.Context,
	ownerID string,
	sessionID string,
	updatedAt time.Time,
) (domain.InterpretationSession, error) {
	if ownerID == "" || sessionID == "" || updatedAt.IsZero() {
		return domain.InterpretationSession{}, errors.New("store: live interpretation claim identity and timestamp are required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return domain.InterpretationSession{}, fmt.Errorf("store: begin live interpretation claim: %w", err)
	}
	defer tx.Rollback()

	session, err := scanInterpretationSession(tx.QueryRowContext(ctx, `
		UPDATE interpretation_sessions
		SET status = 'live',
			started_at = COALESCE(started_at, ?), ended_at = NULL,
			updated_at = ?
		WHERE id = ? AND user_id = ? AND archived_at IS NULL
		RETURNING id, user_id, title, source_language, target_language, status,
			created_at, updated_at, started_at, ended_at, archived_at, archive_reason,
			recognition_languages_json, diarization, COALESCE(workspace_id, '')`,
		encodeTime(updatedAt), encodeTime(updatedAt), sessionID, ownerID,
	))
	if errors.Is(err, ErrNotFound) {
		_ = tx.Rollback()
		return domain.InterpretationSession{}, s.interpretationMutationMiss(ctx, ownerID, sessionID)
	}
	if err != nil {
		return domain.InterpretationSession{}, fmt.Errorf("store: claim live interpretation: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return domain.InterpretationSession{}, fmt.Errorf("store: commit live interpretation claim: %w", err)
	}
	return session, nil
}

func (s *Store) UpdateInterpretationSessionStatus(
	ctx context.Context,
	ownerID string,
	sessionID string,
	status domain.InterpretationStatus,
	startedAt *time.Time,
	endedAt *time.Time,
	updatedAt time.Time,
) error {
	if !validInterpretationStatus(status) {
		return fmt.Errorf("store: invalid interpretation status %q", status)
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE interpretation_sessions
		SET status = ?, started_at = ?, ended_at = ?, updated_at = ?
		WHERE id = ? AND user_id = ? AND archived_at IS NULL`,
		status, encodeOptionalTime(startedAt), encodeOptionalTime(endedAt),
		encodeTime(updatedAt), sessionID, ownerID,
	)
	if err := requireAffected(result, err, "update interpretation session status"); errors.Is(err, ErrNotFound) {
		return s.interpretationMutationMiss(ctx, ownerID, sessionID)
	} else {
		return err
	}
}

// ArchiveInterpretationSession is idempotent for an already archived session.
// The live and archive predicates share the UPDATE statement with the write,
// so a concurrent live claim can never cross into a newly archived session.
func (s *Store) ArchiveInterpretationSession(ctx context.Context, ownerID, sessionID string, now time.Time) (domain.InterpretationSession, error) {
	if ownerID == "" || sessionID == "" || now.IsZero() {
		return domain.InterpretationSession{}, errors.New("store: archive identity and time are required")
	}
	session, err := scanInterpretationSession(s.db.QueryRowContext(ctx, `
		UPDATE interpretation_sessions
		SET archived_at = ?, archive_reason = 'manual', updated_at = ?
		WHERE id = ? AND user_id = ? AND status <> 'live' AND archived_at IS NULL
		RETURNING id, user_id, title, source_language, target_language, status,
			created_at, updated_at, started_at, ended_at, archived_at, archive_reason,
			recognition_languages_json, diarization, COALESCE(workspace_id, '')`,
		encodeTime(now), encodeTime(now), sessionID, ownerID,
	))
	if errors.Is(err, ErrNotFound) {
		current, lookupErr := s.GetInterpretationSession(ctx, ownerID, sessionID)
		if lookupErr != nil {
			return domain.InterpretationSession{}, lookupErr
		}
		if current.Status == domain.InterpretationLive {
			return domain.InterpretationSession{}, fmt.Errorf("%w: interpretation session is live", ErrConflict)
		}
		return current, nil
	}
	if err != nil {
		return domain.InterpretationSession{}, fmt.Errorf("store: archive interpretation session: %w", err)
	}
	return session, nil
}

// UnarchiveInterpretationSession restarts the inactivity clock only when it
// actually changes the archive state. Repeated requests cannot postpone expiry.
func (s *Store) UnarchiveInterpretationSession(ctx context.Context, ownerID, sessionID string, now time.Time) (domain.InterpretationSession, error) {
	if ownerID == "" || sessionID == "" || now.IsZero() {
		return domain.InterpretationSession{}, errors.New("store: unarchive identity and time are required")
	}
	session, err := scanInterpretationSession(s.db.QueryRowContext(ctx, `
		UPDATE interpretation_sessions
		SET archived_at = NULL, archive_reason = '', updated_at = ?
		WHERE id = ? AND user_id = ? AND archived_at IS NOT NULL
		RETURNING id, user_id, title, source_language, target_language, status,
			created_at, updated_at, started_at, ended_at, archived_at, archive_reason,
			recognition_languages_json, diarization, COALESCE(workspace_id, '')`,
		encodeTime(now), sessionID, ownerID,
	))
	if errors.Is(err, ErrNotFound) {
		return s.GetInterpretationSession(ctx, ownerID, sessionID)
	}
	if err != nil {
		return domain.InterpretationSession{}, fmt.Errorf("store: unarchive interpretation session: %w", err)
	}
	return session, nil
}

// ArchiveInactiveInterpretations uses each owner's preference in the same
// statement as the archive transition. A fresh edit, unarchive, or live claim
// necessarily wins or loses against this single atomic predicate.
func (s *Store) ArchiveInactiveInterpretations(ctx context.Context, now time.Time) (int64, error) {
	if now.IsZero() {
		return 0, errors.New("store: archive time is required")
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE interpretation_sessions AS session
		SET archived_at = ?, archive_reason = 'inactivity'
		WHERE archived_at IS NULL AND status <> 'live'
			AND COALESCE((SELECT auto_archive_hours FROM user_settings WHERE user_id = session.user_id), 24) > 0
			AND updated_at <= ? - COALESCE((SELECT auto_archive_hours FROM user_settings WHERE user_id = session.user_id), 24) * ?`,
		encodeTime(now), encodeTime(now), int64(time.Hour),
	)
	if err != nil {
		return 0, fmt.Errorf("store: archive inactive interpretations: %w", err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("store: inspect archived interpretations: %w", err)
	}
	return count, nil
}

func (s *Store) DeleteInterpretationSession(
	ctx context.Context,
	ownerID string,
	sessionID string,
) error {
	result, err := s.db.ExecContext(ctx,
		"DELETE FROM interpretation_sessions WHERE id = ? AND user_id = ?",
		sessionID, ownerID,
	)
	return requireAffected(result, err, "delete interpretation session")
}

// DeleteInterpretationSessionIfNotLive atomically protects an active stream
// from cascading deletion of its session and segments.
func (s *Store) DeleteInterpretationSessionIfNotLive(
	ctx context.Context,
	ownerID string,
	sessionID string,
) error {
	result, err := s.db.ExecContext(ctx, `
		DELETE FROM interpretation_sessions
		WHERE id = ? AND user_id = ? AND status <> 'live'`, sessionID, ownerID)
	if err != nil {
		return fmt.Errorf("store: delete non-live interpretation session: %w", mapSQLError(err))
	}
	count, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("store: inspect non-live interpretation deletion: %w", err)
	}
	if count == 1 {
		return nil
	}
	return s.interpretationMutationMiss(ctx, ownerID, sessionID)
}

func (s *Store) interpretationMutationMiss(ctx context.Context, ownerID, sessionID string) error {
	var status domain.InterpretationStatus
	var archivedAt sql.NullInt64
	err := s.db.QueryRowContext(ctx, `
		SELECT status, archived_at FROM interpretation_sessions WHERE id = ? AND user_id = ?`,
		sessionID, ownerID,
	).Scan(&status, &archivedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("store: inspect interpretation mutation: %w", err)
	}
	if status == domain.InterpretationLive {
		return fmt.Errorf("%w: interpretation session is live", ErrConflict)
	}
	if archivedAt.Valid {
		return ErrArchived
	}
	return ErrNotFound
}

func (s *Store) AppendSegment(ctx context.Context, ownerID string, segment domain.Segment) error {
	if segment.ID == "" || segment.SessionID == "" || segment.CreatedAt.IsZero() {
		return errors.New("store: segment id, session id, and creation time are required")
	}
	if segment.Sequence < 0 || segment.StartMS < 0 || segment.EndMS < segment.StartMS ||
		segment.Wall0MS < 0 || segment.Wall1MS < 0 ||
		(segment.Wall1MS != 0 && segment.Wall1MS < segment.Wall0MS) {
		return errors.New("store: invalid segment sequence or timing")
	}
	if segment.TranslationStatus == "" {
		if segment.Translation != "" {
			segment.TranslationStatus = domain.TranslationSucceeded
		} else {
			segment.TranslationStatus = domain.TranslationNotRequested
		}
	}
	if !segment.TranslationStatus.Valid() {
		return errors.New("store: invalid translation status")
	}
	if segment.TranslationStatus == domain.TranslationPending && segment.Translation != "" {
		return errors.New("store: pending translation must be empty")
	}
	segmentBytes := int64(len(segment.SourceText) + len(segment.Translation))
	if segmentBytes > maxSegmentTextBytes || len(segment.TranslationError) > 128 || len(segment.TranslatorRequestID) > 256 ||
		len(segment.DetectedLanguage) > 80 || len(segment.SpeakerID) > 128 ||
		!utf8.ValidString(segment.DetectedLanguage) || !utf8.ValidString(segment.SpeakerID) {
		return errors.New("store: segment text or provider metadata is too large")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: begin segment append: %w", err)
	}
	defer tx.Rollback()
	usage, err := tx.ExecContext(ctx, `
		UPDATE interpretation_sessions
		SET segment_count = segment_count + 1,
			transcript_bytes = transcript_bytes + ?,
			updated_at = MAX(updated_at, ?)
		WHERE id = ? AND user_id = ? AND archived_at IS NULL
			AND segment_count < ?
			AND transcript_bytes + ? <= ?
			AND COALESCE((
				SELECT SUM(all_sessions.transcript_bytes)
				FROM interpretation_sessions all_sessions
				WHERE all_sessions.user_id = ?
			), 0) + ? <= ?`,
		segmentBytes, encodeTime(segment.CreatedAt), segment.SessionID, ownerID, maxSegmentsPerInterpretation,
		segmentBytes, maxTranscriptBytesPerSession,
		ownerID, segmentBytes, maxTranscriptBytesPerUser,
	)
	if err != nil {
		return fmt.Errorf("store: reserve segment quota: %w", err)
	}
	reserved, err := usage.RowsAffected()
	if err != nil {
		return fmt.Errorf("store: inspect segment quota reservation: %w", err)
	}
	if reserved == 0 {
		var archivedAt sql.NullInt64
		err := tx.QueryRowContext(ctx, `
			SELECT archived_at FROM interpretation_sessions WHERE id = ? AND user_id = ?`,
			segment.SessionID, ownerID,
		).Scan(&archivedAt)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("store: inspect segment quota miss: %w", err)
		}
		if archivedAt.Valid {
			return ErrArchived
		}
		return ErrCapacity
	}

	result, err := tx.ExecContext(ctx, `
		INSERT INTO segments(
			id, session_id, user_id, sequence, source_text, translation,
			final, start_ms, end_ms, created_at, translation_status,
			translation_error, translator_request_id,
			detected_language, speaker_id, wall0_ms, wall1_ms, language_source
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		segment.ID, segment.SessionID, ownerID, segment.Sequence, segment.SourceText, segment.Translation,
		boolInt(segment.Final), segment.StartMS, segment.EndMS, encodeTime(segment.CreatedAt),
		segment.TranslationStatus, segment.TranslationError, segment.TranslatorRequestID,
		segment.DetectedLanguage, segment.SpeakerID, segment.Wall0MS, segment.Wall1MS, segment.LanguageSource,
	)
	if err := requireAffected(result, err, "append segment"); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: commit segment append: %w", err)
	}
	return nil
}

func (s *Store) ListSegments(
	ctx context.Context,
	ownerID string,
	sessionID string,
) ([]domain.Segment, error) {
	var exists int
	err := s.db.QueryRowContext(ctx, `
		SELECT 1 FROM interpretation_sessions
		WHERE id = ? AND user_id = ?`, sessionID, ownerID).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("store: verify segment owner: %w", err)
	}

	rows, err := s.db.QueryContext(ctx, `
		SELECT id, session_id, user_id, sequence, source_text, translation,
			translation_status, translation_error, translator_request_id,
			final, start_ms, end_ms, created_at,
			detected_language, speaker_id, wall0_ms, wall1_ms, language_source
		FROM segments
		WHERE session_id = ? AND user_id = ?
		ORDER BY sequence, id`, sessionID, ownerID)
	if err != nil {
		return nil, fmt.Errorf("store: list segments: %w", err)
	}
	defer rows.Close()
	segments := make([]domain.Segment, 0)
	for rows.Next() {
		segment, err := scanSegment(rows)
		if err != nil {
			return nil, fmt.Errorf("store: list segments: %w", err)
		}
		segments = append(segments, segment)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list segments: %w", err)
	}
	return segments, nil
}

type SegmentPage struct {
	Items         []domain.Segment
	NextAfter     int64
	HasMore       bool
	HasEarlier    bool
	HasLater      bool
	FirstSequence int64
	LastSequence  int64
}

type SegmentPageMode string

const (
	SegmentPageAfter  SegmentPageMode = "after"
	SegmentPageBefore SegmentPageMode = "before"
	SegmentPageTail   SegmentPageMode = "tail"
)

type SegmentPageQuery struct {
	Mode     SegmentPageMode
	Sequence int64
	Limit    int
	Search   string
}

// ListSegmentsPage uses the durable per-session sequence as a cursor and
// bounds both item count and approximate response payload. A single page can
// therefore never materialize an entire long transcript in memory.
func (s *Store) ListSegmentsPage(
	ctx context.Context,
	ownerID string,
	sessionID string,
	afterSequence int64,
	limit int,
) (SegmentPage, error) {
	return s.ListSegmentsWindow(ctx, ownerID, sessionID, SegmentPageQuery{
		Mode: SegmentPageAfter, Sequence: afterSequence, Limit: limit,
	})
}

// ListSegmentsWindow returns a bounded ascending window. Before and tail
// select the nearest preceding or newest rows in descending order before
// reversing the result; the search string is a literal substring.
func (s *Store) ListSegmentsWindow(
	ctx context.Context,
	ownerID string,
	sessionID string,
	query SegmentPageQuery,
) (SegmentPage, error) {
	if query.Limit < 1 || query.Limit > 200 ||
		(query.Mode != SegmentPageAfter && query.Mode != SegmentPageBefore && query.Mode != SegmentPageTail) ||
		(query.Mode == SegmentPageAfter && query.Sequence < -1) ||
		(query.Mode == SegmentPageBefore && query.Sequence < 0) ||
		(query.Mode == SegmentPageTail && query.Sequence != 0) ||
		!validSegmentSearch(query.Search) {
		return SegmentPage{}, errors.New("store: invalid segment pagination")
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return SegmentPage{}, fmt.Errorf("store: begin segment page: %w", err)
	}
	defer tx.Rollback()
	var exists int
	if err := tx.QueryRowContext(ctx, `
		SELECT 1 FROM interpretation_sessions WHERE id = ? AND user_id = ?`,
		sessionID, ownerID,
	).Scan(&exists); err != nil {
		return SegmentPage{}, fmt.Errorf("store: verify paged segment owner: %w", mapSQLError(err))
	}
	where := " FROM segments WHERE session_id = ? AND user_id = ?"
	args := []any{sessionID, ownerID}
	if query.Search != "" {
		pattern := "%" + escapeSegmentLike(query.Search) + "%"
		where += ` AND (source_text LIKE ? ESCAPE '\' OR translation LIKE ? ESCAPE '\')`
		args = append(args, pattern, pattern)
	}
	pageWhere := where
	pageArgs := append([]any(nil), args...)
	order := " ORDER BY sequence ASC, id ASC LIMIT ?"
	switch query.Mode {
	case SegmentPageAfter:
		pageWhere += " AND sequence > ?"
		pageArgs = append(pageArgs, query.Sequence)
	case SegmentPageBefore:
		pageWhere += " AND sequence < ?"
		pageArgs = append(pageArgs, query.Sequence)
		order = " ORDER BY sequence DESC, id DESC LIMIT ?"
	case SegmentPageTail:
		order = " ORDER BY sequence DESC, id DESC LIMIT ?"
	}
	pageArgs = append(pageArgs, query.Limit+1)
	rows, err := tx.QueryContext(ctx, `
		SELECT id, session_id, user_id, sequence, source_text, translation,
			translation_status, translation_error, translator_request_id,
			final, start_ms, end_ms, created_at,
			detected_language, speaker_id, wall0_ms, wall1_ms, language_source`+pageWhere+order, pageArgs...)
	if err != nil {
		return SegmentPage{}, fmt.Errorf("store: list segment page: %w", err)
	}
	const maxPageBytes = 1 << 20
	page := SegmentPage{Items: make([]domain.Segment, 0, query.Limit)}
	pageBytes := 0
	for rows.Next() {
		segment, err := scanSegment(rows)
		if err != nil {
			rows.Close()
			return SegmentPage{}, fmt.Errorf("store: scan segment page: %w", err)
		}
		size := len(segment.SourceText) + len(segment.Translation) +
			len(segment.TranslationError) + len(segment.TranslatorRequestID) + 512
		if len(page.Items) >= query.Limit || (len(page.Items) > 0 && pageBytes+size > maxPageBytes) {
			break
		}
		page.Items = append(page.Items, segment)
		pageBytes += size
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return SegmentPage{}, fmt.Errorf("store: list segment page: %w", err)
	}
	if err := rows.Close(); err != nil {
		return SegmentPage{}, fmt.Errorf("store: close segment page: %w", err)
	}
	if query.Mode != SegmentPageAfter {
		for left, right := 0, len(page.Items)-1; left < right; left, right = left+1, right-1 {
			page.Items[left], page.Items[right] = page.Items[right], page.Items[left]
		}
	}
	var earliest, latest sql.NullInt64
	if err := tx.QueryRowContext(ctx, "SELECT MIN(sequence), MAX(sequence)"+where, args...).Scan(&earliest, &latest); err != nil {
		return SegmentPage{}, fmt.Errorf("store: inspect segment page bounds: %w", err)
	}
	if len(page.Items) > 0 {
		page.FirstSequence = page.Items[0].Sequence
		page.LastSequence = page.Items[len(page.Items)-1].Sequence
		page.NextAfter = page.LastSequence
		page.HasEarlier = earliest.Valid && earliest.Int64 < page.FirstSequence
		page.HasLater = latest.Valid && latest.Int64 > page.LastSequence
	} else if earliest.Valid {
		if query.Mode == SegmentPageBefore {
			page.HasLater = latest.Int64 >= query.Sequence
		} else if query.Mode == SegmentPageAfter {
			page.HasEarlier = earliest.Int64 <= query.Sequence
		}
	}
	if query.Mode == SegmentPageAfter {
		page.HasMore = page.HasLater
	} else {
		page.HasMore = page.HasEarlier
	}
	if err := tx.Commit(); err != nil {
		return SegmentPage{}, fmt.Errorf("store: commit segment page: %w", err)
	}
	return page, nil
}

func validSegmentSearch(search string) bool {
	if len(search) > 512 || !utf8.ValidString(search) || utf8.RuneCountInString(search) > 120 {
		return false
	}
	for _, character := range search {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}

func escapeSegmentLike(search string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(search)
}

func (s *Store) MaxSegmentSequence(ctx context.Context, ownerID, sessionID string) (int64, error) {
	var sequence int64
	err := s.db.QueryRowContext(ctx, `
		SELECT COALESCE(MAX(segment.sequence), 0)
		FROM interpretation_sessions session
		LEFT JOIN segments segment
			ON segment.session_id = session.id AND segment.user_id = session.user_id
		WHERE session.id = ? AND session.user_id = ?
		GROUP BY session.id`, sessionID, ownerID,
	).Scan(&sequence)
	if err != nil {
		return 0, fmt.Errorf("store: max segment sequence: %w", mapSQLError(err))
	}
	return sequence, nil
}

func scanSegment(row rowScanner) (domain.Segment, error) {
	var segment domain.Segment
	var final int
	var createdAt int64
	if err := row.Scan(
		&segment.ID, &segment.SessionID, &segment.UserID, &segment.Sequence,
		&segment.SourceText, &segment.Translation, &segment.TranslationStatus,
		&segment.TranslationError, &segment.TranslatorRequestID, &final, &segment.StartMS,
		&segment.EndMS, &createdAt,
		&segment.DetectedLanguage, &segment.SpeakerID, &segment.Wall0MS, &segment.Wall1MS, &segment.LanguageSource,
	); err != nil {
		return domain.Segment{}, mapSQLError(err)
	}
	segment.Final = final != 0
	segment.CreatedAt = decodeTime(createdAt)
	return segment, nil
}

func (s *Store) UpdateSegmentTranslation(
	ctx context.Context,
	ownerID string,
	sessionID string,
	segmentID string,
	status domain.TranslationStatus,
	translation string,
	errorCode string,
	requestID string,
	updatedAt time.Time,
) error {
	if !status.Valid() || status == domain.TranslationNotRequested || status == domain.TranslationPending {
		return errors.New("store: translation result status must be succeeded or failed")
	}
	if status == domain.TranslationSucceeded && translation == "" {
		return errors.New("store: successful translation cannot be empty")
	}
	if len(translation) > maxSegmentTextBytes || len(errorCode) > 128 || len(requestID) > 256 {
		return errors.New("store: translation text or provider metadata is too large")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: begin translation update: %w", err)
	}
	defer tx.Rollback()
	var previousBytes int64
	if err := tx.QueryRowContext(ctx, `
		SELECT length(CAST(translation AS BLOB)) FROM segments
		WHERE id = ? AND session_id = ? AND user_id = ?`,
		segmentID, sessionID, ownerID,
	).Scan(&previousBytes); err != nil {
		return fmt.Errorf("store: read previous translation size: %w", mapSQLError(err))
	}
	delta := int64(len(translation)) - previousBytes
	usage, err := tx.ExecContext(ctx, `
		UPDATE interpretation_sessions
		SET transcript_bytes = transcript_bytes + ?, updated_at = ?
		WHERE id = ? AND user_id = ?
			AND transcript_bytes + ? >= 0
			AND transcript_bytes + ? <= ?
			AND (? <= 0 OR COALESCE((
				SELECT SUM(all_sessions.transcript_bytes)
				FROM interpretation_sessions all_sessions
				WHERE all_sessions.user_id = ?
			), 0) + ? <= ?)`,
		delta, encodeTime(updatedAt), sessionID, ownerID,
		delta, delta, maxTranscriptBytesPerSession,
		delta, ownerID, delta, maxTranscriptBytesPerUser,
	)
	if err != nil {
		return fmt.Errorf("store: reserve translation quota: %w", err)
	}
	reserved, err := usage.RowsAffected()
	if err != nil {
		return fmt.Errorf("store: inspect translation quota reservation: %w", err)
	}
	if reserved == 0 {
		return ErrCapacity
	}
	result, err := tx.ExecContext(ctx, `
		UPDATE segments
		SET translation = ?, translation_status = ?, translation_error = ?,
			translator_request_id = ?
		WHERE id = ? AND session_id = ? AND user_id = ?`,
		translation, status, errorCode, requestID, segmentID, sessionID, ownerID,
	)
	if err := requireAffected(result, err, "update segment translation"); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: commit translation update: %w", err)
	}
	return nil
}

// FailPendingSegmentTranslation moves a pending translation to a small,
// quota-independent terminal record. It is the fallback used when a provider
// response cannot be stored (for example because it would exceed the tenant's
// transcript budget), so a segment is never left pending indefinitely.
func (s *Store) FailPendingSegmentTranslation(
	ctx context.Context,
	ownerID string,
	sessionID string,
	segmentID string,
	errorCode string,
	updatedAt time.Time,
) error {
	if ownerID == "" || sessionID == "" || segmentID == "" || updatedAt.IsZero() {
		return errors.New("store: pending translation failure identity and timestamp are required")
	}
	if errorCode == "" || len(errorCode) > 128 {
		return errors.New("store: pending translation failure code is invalid")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: begin pending translation failure: %w", err)
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `
		UPDATE segments
		SET translation = '', translation_status = 'failed',
			translation_error = ?, translator_request_id = ''
		WHERE id = ? AND session_id = ? AND user_id = ?
			AND translation_status = 'pending'`,
		errorCode, segmentID, sessionID, ownerID,
	)
	if err != nil {
		return fmt.Errorf("store: fail pending translation: %w", mapSQLError(err))
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("store: inspect pending translation failure: %w", err)
	}
	if changed == 0 {
		var status domain.TranslationStatus
		err := tx.QueryRowContext(ctx, `
			SELECT translation_status FROM segments
			WHERE id = ? AND session_id = ? AND user_id = ?`,
			segmentID, sessionID, ownerID,
		).Scan(&status)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("store: inspect pending translation state: %w", err)
		}
		return fmt.Errorf("%w: translation is already %s", ErrConflict, status)
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE interpretation_sessions SET updated_at = ?
		WHERE id = ? AND user_id = ?`, encodeTime(updatedAt), sessionID, ownerID); err != nil {
		return fmt.Errorf("store: update session after translation failure: %w", mapSQLError(err))
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: commit pending translation failure: %w", err)
	}
	return nil
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

// RecoverInterruptedInterpretations converts process-local work left behind by
// an unclean shutdown into explicit durable failures. Pending provider work is
// never silently presented as still running after restart.
func (s *Store) RecoverInterruptedInterpretations(ctx context.Context, now time.Time) (int64, int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, fmt.Errorf("store: begin interrupted interpretation recovery: %w", err)
	}
	defer tx.Rollback()

	sessionResult, err := tx.ExecContext(ctx, `
		UPDATE interpretation_sessions
		SET status = 'failed', ended_at = ?
		WHERE status = 'live'`, encodeTime(now))
	if err != nil {
		return 0, 0, fmt.Errorf("store: recover live interpretations: %w", err)
	}
	segmentResult, err := tx.ExecContext(ctx, `
		UPDATE segments
		SET translation_status = 'failed', translation_error = 'interrupted'
		WHERE translation_status = 'pending'`)
	if err != nil {
		return 0, 0, fmt.Errorf("store: recover pending translations: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, 0, fmt.Errorf("store: commit interrupted interpretation recovery: %w", err)
	}
	sessions, err := sessionResult.RowsAffected()
	if err != nil {
		return 0, 0, fmt.Errorf("store: count recovered interpretations: %w", err)
	}
	segments, err := segmentResult.RowsAffected()
	if err != nil {
		return 0, 0, fmt.Errorf("store: count recovered translations: %w", err)
	}
	return sessions, segments, nil
}
