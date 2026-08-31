package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

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
	if err := validateInterpretationSession(session); err != nil {
		return err
	}
	result, err := s.db.ExecContext(ctx, `
		INSERT INTO interpretation_sessions(
			id, user_id, title, source_language, target_language, status,
			created_at, updated_at, started_at, ended_at
		)
		SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		WHERE (SELECT COUNT(*) FROM interpretation_sessions WHERE user_id = ?) < ?`,
		session.ID, session.UserID, session.Title, session.SourceLanguage,
		session.TargetLanguage, session.Status, encodeTime(session.CreatedAt),
		encodeTime(session.UpdatedAt), encodeOptionalTime(session.StartedAt),
		encodeOptionalTime(session.EndedAt), session.UserID, maxInterpretationSessionsPerUser,
	)
	if err != nil {
		return fmt.Errorf("store: create interpretation session: %w", mapSQLError(err))
	}
	count, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("store: inspect interpretation session creation: %w", err)
	}
	if count == 0 {
		return ErrCapacity
	}
	return nil
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
			created_at, updated_at, started_at, ended_at
		FROM interpretation_sessions WHERE id = ? AND user_id = ?`,
		sessionID, ownerID,
	))
}

func scanInterpretationSession(row rowScanner) (domain.InterpretationSession, error) {
	var session domain.InterpretationSession
	var status string
	var createdAt, updatedAt int64
	var startedAt, endedAt sql.NullInt64
	if err := row.Scan(
		&session.ID, &session.UserID, &session.Title, &session.SourceLanguage,
		&session.TargetLanguage, &status, &createdAt, &updatedAt,
		&startedAt, &endedAt,
	); err != nil {
		return domain.InterpretationSession{}, mapSQLError(err)
	}
	session.Status = domain.InterpretationStatus(status)
	session.CreatedAt = decodeTime(createdAt)
	session.UpdatedAt = decodeTime(updatedAt)
	session.StartedAt = decodeOptionalTime(startedAt)
	session.EndedAt = decodeOptionalTime(endedAt)
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
			created_at, updated_at, started_at, ended_at
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
	result, err := s.db.ExecContext(ctx, `
		UPDATE interpretation_sessions
		SET title = ?, source_language = ?, target_language = ?, status = ?,
			updated_at = ?, started_at = ?, ended_at = ?
		WHERE id = ? AND user_id = ?`,
		session.Title, session.SourceLanguage, session.TargetLanguage, session.Status,
		encodeTime(session.UpdatedAt), encodeOptionalTime(session.StartedAt),
		encodeOptionalTime(session.EndedAt), session.ID, ownerID,
	)
	return requireAffected(result, err, "update interpretation session")
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
		WHERE id = ? AND user_id = ? AND status <> 'live'
		RETURNING id, user_id, title, source_language, target_language, status,
			created_at, updated_at, started_at, ended_at`,
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
		WHERE id = ? AND user_id = ?
		RETURNING id, user_id, title, source_language, target_language, status,
			created_at, updated_at, started_at, ended_at`,
		encodeTime(updatedAt), encodeTime(updatedAt), sessionID, ownerID,
	))
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
		WHERE id = ? AND user_id = ?`,
		status, encodeOptionalTime(startedAt), encodeOptionalTime(endedAt),
		encodeTime(updatedAt), sessionID, ownerID,
	)
	return requireAffected(result, err, "update interpretation session status")
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
	err := s.db.QueryRowContext(ctx, `
		SELECT status FROM interpretation_sessions WHERE id = ? AND user_id = ?`,
		sessionID, ownerID,
	).Scan(&status)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("store: inspect interpretation mutation: %w", err)
	}
	if status == domain.InterpretationLive {
		return fmt.Errorf("%w: interpretation session is live", ErrConflict)
	}
	return ErrNotFound
}

func (s *Store) AppendSegment(ctx context.Context, ownerID string, segment domain.Segment) error {
	if segment.ID == "" || segment.SessionID == "" || segment.CreatedAt.IsZero() {
		return errors.New("store: segment id, session id, and creation time are required")
	}
	if segment.Sequence < 0 || segment.StartMS < 0 || segment.EndMS < segment.StartMS {
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
	if segmentBytes > maxSegmentTextBytes || len(segment.TranslationError) > 128 || len(segment.TranslatorRequestID) > 256 {
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
			transcript_bytes = transcript_bytes + ?
		WHERE id = ? AND user_id = ?
			AND segment_count < ?
			AND transcript_bytes + ? <= ?
			AND COALESCE((
				SELECT SUM(all_sessions.transcript_bytes)
				FROM interpretation_sessions all_sessions
				WHERE all_sessions.user_id = ?
			), 0) + ? <= ?`,
		segmentBytes, segment.SessionID, ownerID, maxSegmentsPerInterpretation,
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
		var exists int
		err := tx.QueryRowContext(ctx, `
			SELECT 1 FROM interpretation_sessions WHERE id = ? AND user_id = ?`,
			segment.SessionID, ownerID,
		).Scan(&exists)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("store: inspect segment quota miss: %w", err)
		}
		return ErrCapacity
	}

	result, err := tx.ExecContext(ctx, `
		INSERT INTO segments(
			id, session_id, user_id, sequence, source_text, translation,
			final, start_ms, end_ms, created_at, translation_status,
			translation_error, translator_request_id
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		segment.ID, segment.SessionID, ownerID, segment.Sequence, segment.SourceText, segment.Translation,
		boolInt(segment.Final), segment.StartMS, segment.EndMS, encodeTime(segment.CreatedAt),
		segment.TranslationStatus, segment.TranslationError, segment.TranslatorRequestID,
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
			final, start_ms, end_ms, created_at
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
	Items     []domain.Segment
	NextAfter int64
	HasMore   bool
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
	if afterSequence < -1 || limit < 1 || limit > 200 {
		return SegmentPage{}, errors.New("store: invalid segment pagination")
	}
	var exists int
	if err := s.db.QueryRowContext(ctx, `
		SELECT 1 FROM interpretation_sessions WHERE id = ? AND user_id = ?`,
		sessionID, ownerID,
	).Scan(&exists); err != nil {
		return SegmentPage{}, fmt.Errorf("store: verify paged segment owner: %w", mapSQLError(err))
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, session_id, user_id, sequence, source_text, translation,
			translation_status, translation_error, translator_request_id,
			final, start_ms, end_ms, created_at
		FROM segments
		WHERE session_id = ? AND user_id = ? AND sequence > ?
		ORDER BY sequence, id LIMIT ?`, sessionID, ownerID, afterSequence, limit+1)
	if err != nil {
		return SegmentPage{}, fmt.Errorf("store: list segment page: %w", err)
	}
	defer rows.Close()
	const maxPageBytes = 1 << 20
	page := SegmentPage{Items: make([]domain.Segment, 0, limit)}
	pageBytes := 0
	for rows.Next() {
		segment, err := scanSegment(rows)
		if err != nil {
			return SegmentPage{}, fmt.Errorf("store: scan segment page: %w", err)
		}
		size := len(segment.SourceText) + len(segment.Translation) +
			len(segment.TranslationError) + len(segment.TranslatorRequestID) + 512
		if len(page.Items) >= limit || (len(page.Items) > 0 && pageBytes+size > maxPageBytes) {
			page.HasMore = true
			break
		}
		page.Items = append(page.Items, segment)
		pageBytes += size
		page.NextAfter = segment.Sequence
	}
	if err := rows.Err(); err != nil {
		return SegmentPage{}, fmt.Errorf("store: list segment page: %w", err)
	}
	return page, nil
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
		SET status = 'failed', ended_at = ?, updated_at = ?
		WHERE status = 'live'`, encodeTime(now), encodeTime(now))
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
