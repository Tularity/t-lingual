package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
)

const gapColumns = `id, session_id, user_id, start_ms, end_ms, sequence_from, sequence_to, state,
	attempts, filled_segments, last_error, created_at, updated_at`

func scanGap(row rowScanner) (domain.RecognitionGap, error) {
	var gap domain.RecognitionGap
	var created, updated int64
	if err := row.Scan(&gap.ID, &gap.SessionID, &gap.UserID, &gap.StartMS, &gap.EndMS, &gap.SequenceFrom,
		&gap.SequenceTo, &gap.State, &gap.Attempts, &gap.FilledSegments, &gap.LastError, &created, &updated); err != nil {
		return domain.RecognitionGap{}, mapSQLError(err)
	}
	gap.CreatedAt, gap.UpdatedAt = decodeTime(created), decodeTime(updated)
	return gap, nil
}

// CreateRecognitionGap keeps a stretch of a recording for recognition later,
// with the sequence numbers set aside for its lines.
func (s *Store) CreateRecognitionGap(ctx context.Context, gap domain.RecognitionGap) error {
	if gap.ID == "" || gap.SessionID == "" || gap.UserID == "" || gap.StartMS < 0 || gap.EndMS <= gap.StartMS ||
		gap.SequenceFrom <= 0 || gap.SequenceTo < gap.SequenceFrom || gap.State != domain.GapPending || gap.CreatedAt.IsZero() {
		return errors.New("store: invalid recognition gap")
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO recognition_gaps(`+gapColumns+`)
		VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, '', ?, ?)`,
		gap.ID, gap.SessionID, gap.UserID, gap.StartMS, gap.EndMS, gap.SequenceFrom, gap.SequenceTo,
		encodeTime(gap.CreatedAt), encodeTime(gap.CreatedAt))
	if err != nil {
		return fmt.Errorf("store: create recognition gap: %w", mapSQLError(err))
	}
	return nil
}

// NextSequenceBase is the last sequence number a new recording must follow:
// past every saved line and every number set aside for a gap.
func (s *Store) NextSequenceBase(ctx context.Context, ownerID, sessionID string) (int64, error) {
	saved, err := s.MaxSegmentSequence(ctx, ownerID, sessionID)
	if err != nil {
		return 0, err
	}
	var reserved sql.NullInt64
	if err := s.db.QueryRowContext(ctx, `SELECT MAX(sequence_to) FROM recognition_gaps
		WHERE session_id = ? AND user_id = ?`, sessionID, ownerID).Scan(&reserved); err != nil {
		return 0, fmt.Errorf("store: max reserved sequence: %w", err)
	}
	return max(saved, reserved.Int64), nil
}

// ListRecognitionGaps is every gap of one session, earliest first.
func (s *Store) ListRecognitionGaps(ctx context.Context, ownerID, sessionID string) ([]domain.RecognitionGap, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+gapColumns+` FROM recognition_gaps
		WHERE session_id = ? AND user_id = ? ORDER BY start_ms, id LIMIT 500`, sessionID, ownerID)
	if err != nil {
		return nil, fmt.Errorf("store: list recognition gaps: %w", err)
	}
	defer rows.Close()
	gaps := make([]domain.RecognitionGap, 0)
	for rows.Next() {
		gap, err := scanGap(rows)
		if err != nil {
			return nil, fmt.Errorf("store: scan recognition gap: %w", err)
		}
		gaps = append(gaps, gap)
	}
	return gaps, rows.Err()
}

// ClaimRecognitionGap takes the oldest gap due to be filled: one waiting and
// past its retry delay, or one whose filler stopped answering long ago.
func (s *Store) ClaimRecognitionGap(ctx context.Context, now time.Time, retryAfter, staleAfter time.Duration) (domain.RecognitionGap, error) {
	gap, err := scanGap(s.db.QueryRowContext(ctx, `UPDATE recognition_gaps
		SET state = 'filling', attempts = attempts + 1, updated_at = ?
		WHERE id = (SELECT gap.id FROM recognition_gaps gap
			JOIN interpretation_sessions session ON session.id = gap.session_id AND session.user_id = gap.user_id
			WHERE (gap.state = 'pending' AND (gap.attempts = 0 OR gap.updated_at + gap.attempts * ? <= ?))
				OR (gap.state = 'filling' AND gap.updated_at <= ?)
			ORDER BY gap.created_at, gap.id LIMIT 1)
		RETURNING `+gapColumns,
		encodeTime(now), int64(retryAfter), encodeTime(now), encodeTime(now.Add(-staleAfter))))
	if err != nil {
		return domain.RecognitionGap{}, fmt.Errorf("store: claim recognition gap: %w", err)
	}
	return gap, nil
}

// FinishRecognitionGap records how a filling attempt ended.
func (s *Store) FinishRecognitionGap(ctx context.Context, gapID string, state domain.RecognitionGapState,
	filled int, lastError string, now time.Time) (domain.RecognitionGap, error) {
	if state != domain.GapPending && state != domain.GapFilled && state != domain.GapFailed {
		return domain.RecognitionGap{}, errors.New("store: invalid recognition gap outcome")
	}
	if len(lastError) > 200 {
		lastError = lastError[:200]
	}
	gap, err := scanGap(s.db.QueryRowContext(ctx, `UPDATE recognition_gaps
		SET state = ?, filled_segments = filled_segments + ?, last_error = ?, updated_at = ?
		WHERE id = ? AND state = 'filling' RETURNING `+gapColumns,
		state, filled, lastError, encodeTime(now), gapID))
	if err != nil {
		return domain.RecognitionGap{}, fmt.Errorf("store: finish recognition gap: %w", err)
	}
	return gap, nil
}

// CountRecognitionGaps is how many gaps wait and how many are being filled.
func (s *Store) CountRecognitionGaps(ctx context.Context) (pending, filling, failed int, err error) {
	err = s.db.QueryRowContext(ctx, `SELECT
		COALESCE(SUM(state = 'pending'), 0), COALESCE(SUM(state = 'filling'), 0), COALESCE(SUM(state = 'failed'), 0)
		FROM recognition_gaps`).Scan(&pending, &filling, &failed)
	if err != nil {
		err = fmt.Errorf("store: count recognition gaps: %w", err)
	}
	return pending, filling, failed, err
}

// GetSegmentByID reads one saved line.
func (s *Store) GetSegmentByID(ctx context.Context, ownerID, sessionID, segmentID string) (domain.Segment, error) {
	segment, err := scanSegment(s.db.QueryRowContext(ctx, `
		SELECT id, session_id, user_id, sequence, source_text, translation,
			translation_status, translation_error, translator_request_id,
			final, start_ms, end_ms, created_at,
			detected_language, speaker_id, wall0_ms, wall1_ms, language_source
		FROM segments WHERE id = ? AND session_id = ? AND user_id = ?`, segmentID, sessionID, ownerID))
	if err != nil {
		return domain.Segment{}, fmt.Errorf("store: get segment: %w", err)
	}
	return segment, nil
}

// RetryableTranslation is a translation to ask for again.
type RetryableTranslation struct {
	UserID, SessionID, SegmentID, TargetLanguage string
}

// ReclaimRetryableTranslations puts translations that failed only because
// translation was unavailable back to pending, oldest first, each no sooner
// than its retry delay allows and no more than maxAttempts times in all.
func (s *Store) ReclaimRetryableTranslations(ctx context.Context, codes []string, maxAttempts, limit int,
	retryAfter time.Duration, now time.Time) ([]RetryableTranslation, error) {
	if len(codes) == 0 || limit < 1 || limit > 64 || maxAttempts < 1 {
		return nil, errors.New("store: invalid translation retry")
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(codes)), ",")
	args := []any{encodeTime(now)}
	for _, code := range codes {
		args = append(args, code)
	}
	args = append(args, maxAttempts, int64(retryAfter), encodeTime(now), limit)
	rows, err := s.db.QueryContext(ctx, `UPDATE segment_translations
		SET status = 'pending', error = '', request_id = '', attempts = attempts + 1, updated_at = ?
		WHERE rowid IN (SELECT translation.rowid FROM segment_translations translation
			JOIN interpretation_sessions session ON session.id = translation.session_id
			JOIN users owner ON owner.id = session.user_id AND owner.status = 'active'
			WHERE translation.status = 'failed' AND translation.error IN (`+placeholders+`)
				AND session.archived_at IS NULL
				AND translation.attempts < ? AND translation.updated_at + translation.attempts * ? <= ?
			ORDER BY translation.updated_at LIMIT ?)
		RETURNING session_id, segment_id, target_language`, args...)
	if err != nil {
		return nil, fmt.Errorf("store: reclaim translations: %w", err)
	}
	type claimed struct{ sessionID, segmentID, target string }
	items := make([]claimed, 0)
	for rows.Next() {
		var item claimed
		if err := rows.Scan(&item.sessionID, &item.segmentID, &item.target); err != nil {
			rows.Close()
			return nil, fmt.Errorf("store: scan reclaimed translation: %w", err)
		}
		items = append(items, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	result := make([]RetryableTranslation, 0, len(items))
	for _, item := range items {
		var owner string
		if err := s.db.QueryRowContext(ctx, `SELECT user_id FROM interpretation_sessions WHERE id = ?`, item.sessionID).Scan(&owner); err != nil {
			continue
		}
		result = append(result, RetryableTranslation{UserID: owner, SessionID: item.sessionID, SegmentID: item.segmentID, TargetLanguage: item.target})
	}
	return result, nil
}

// CountRetryingTranslations is how many translations wait to be asked for again.
func (s *Store) CountRetryingTranslations(ctx context.Context, codes []string, maxAttempts int) (int, error) {
	if len(codes) == 0 {
		return 0, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(codes)), ",")
	args := make([]any, 0, len(codes)+1)
	for _, code := range codes {
		args = append(args, code)
	}
	args = append(args, maxAttempts)
	var count int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM segment_translations
		WHERE status = 'failed' AND error IN (`+placeholders+`) AND attempts < ?`, args...).Scan(&count)
	if err != nil {
		return 0, fmt.Errorf("store: count retrying translations: %w", err)
	}
	return count, nil
}
