package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/language"
)

// SegmentTranslation is a durable, language-specific result. The source segment
// remains immutable after its final ASR event; different viewers never share
// the default-language fields on the legacy segments row.
type SegmentTranslation struct {
	SessionID      string
	SegmentID      string
	TargetLanguage string
	Status         domain.TranslationStatus
	Text           string
	Error          string
	RequestID      string
	UpdatedAt      time.Time
}

func canonicalTarget(target string) (string, error) {
	canonical, err := language.Canonicalize(target)
	if err != nil {
		return "", fmt.Errorf("store: invalid translation target: %w", err)
	}
	return canonical, nil
}

func scanTranslation(row rowScanner) (SegmentTranslation, error) {
	var result SegmentTranslation
	var updated int64
	if err := row.Scan(&result.SessionID, &result.SegmentID, &result.TargetLanguage,
		&result.Status, &result.Text, &result.Error, &result.RequestID, &updated); err != nil {
		return SegmentTranslation{}, mapSQLError(err)
	}
	result.UpdatedAt = decodeTime(updated)
	return result, nil
}

// ClaimTranslation returns claimed=false for any existing state, including a
// terminal failure. A provider outage must not be amplified by every watcher.
func (s *Store) ClaimTranslation(ctx context.Context, ownerID, sessionID, segmentID, target string, now time.Time) (SegmentTranslation, bool, error) {
	canonical, err := canonicalTarget(target)
	if err != nil || ownerID == "" || sessionID == "" || segmentID == "" || now.IsZero() {
		return SegmentTranslation{}, false, errors.New("store: translation claim identity or target is invalid")
	}
	result, err := s.db.ExecContext(ctx, `
		INSERT INTO segment_translations(session_id, segment_id, target_language, status, text, error, request_id, updated_at)
		SELECT segment.session_id, segment.id, ?, 'pending', '', '', '', ?
		FROM segments AS segment
		WHERE segment.id = ? AND segment.session_id = ? AND segment.user_id = ? AND segment.final = 1
		ON CONFLICT(segment_id, target_language) DO NOTHING`,
		canonical, encodeTime(now), segmentID, sessionID, ownerID)
	if err != nil {
		return SegmentTranslation{}, false, fmt.Errorf("store: claim translation: %w", mapSQLError(err))
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return SegmentTranslation{}, false, fmt.Errorf("store: inspect translation claim: %w", err)
	}
	record, err := s.GetTranslation(ctx, ownerID, sessionID, segmentID, canonical)
	return record, changed == 1, err
}

func (s *Store) GetTranslation(ctx context.Context, ownerID, sessionID, segmentID, target string) (SegmentTranslation, error) {
	canonical, err := canonicalTarget(target)
	if err != nil {
		return SegmentTranslation{}, err
	}
	return scanTranslation(s.db.QueryRowContext(ctx, `
		SELECT translation.session_id, translation.segment_id, translation.target_language,
			translation.status, translation.text, translation.error, translation.request_id, translation.updated_at
		FROM segment_translations AS translation
		JOIN segments AS segment ON segment.id = translation.segment_id AND segment.session_id = translation.session_id
		WHERE segment.id = ? AND segment.session_id = ? AND segment.user_id = ? AND translation.target_language = ?`,
		segmentID, sessionID, ownerID, canonical))
}

// FinishTranslation persists one terminal provider result and its quota delta
// atomically. A successful result cannot be replaced by a late failed worker.
func (s *Store) FinishTranslation(ctx context.Context, ownerID, sessionID, segmentID, target string,
	status domain.TranslationStatus, text, errorCode, requestID string, now time.Time,
) (SegmentTranslation, error) {
	canonical, err := canonicalTarget(target)
	if err != nil {
		return SegmentTranslation{}, err
	}
	if ownerID == "" || sessionID == "" || segmentID == "" || now.IsZero() ||
		(status != domain.TranslationSucceeded && status != domain.TranslationFailed) ||
		(status == domain.TranslationSucceeded && text == "") ||
		(status == domain.TranslationFailed && text != "") ||
		len(text) > maxSegmentTextBytes || len(errorCode) > 128 || len(requestID) > 256 {
		return SegmentTranslation{}, errors.New("store: invalid translation result")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SegmentTranslation{}, fmt.Errorf("store: begin translation result: %w", err)
	}
	defer tx.Rollback()
	var priorStatus domain.TranslationStatus
	var priorText string
	err = tx.QueryRowContext(ctx, `
		SELECT translation.status, translation.text
		FROM segment_translations translation
		JOIN segments segment ON segment.id = translation.segment_id AND segment.session_id = translation.session_id
		WHERE segment.id = ? AND segment.session_id = ? AND segment.user_id = ? AND translation.target_language = ?`,
		segmentID, sessionID, ownerID, canonical).Scan(&priorStatus, &priorText)
	if err != nil {
		return SegmentTranslation{}, fmt.Errorf("store: find translation result: %w", mapSQLError(err))
	}
	if priorStatus != domain.TranslationPending {
		return SegmentTranslation{}, fmt.Errorf("%w: translation already %s", ErrConflict, priorStatus)
	}
	delta := int64(len(text) - len(priorText))
	if delta > 0 {
		usage, err := tx.ExecContext(ctx, `
			UPDATE interpretation_sessions
			SET transcript_bytes = transcript_bytes + ?
			WHERE id = ? AND user_id = ?
				AND transcript_bytes + ? <= ?
				AND COALESCE((SELECT SUM(transcript_bytes) FROM interpretation_sessions WHERE user_id = ?), 0) + ? <= ?`,
			delta, sessionID, ownerID, delta, maxTranscriptBytesPerSession,
			ownerID, delta, maxTranscriptBytesPerUser)
		if err != nil {
			return SegmentTranslation{}, fmt.Errorf("store: reserve translation bytes: %w", mapSQLError(err))
		}
		changed, err := usage.RowsAffected()
		if err != nil {
			return SegmentTranslation{}, fmt.Errorf("store: inspect translation quota: %w", err)
		}
		if changed != 1 {
			return SegmentTranslation{}, ErrCapacity
		}
	}
	_, err = tx.ExecContext(ctx, `
		UPDATE segment_translations SET status = ?, text = ?, error = ?, request_id = ?, updated_at = ?
		WHERE segment_id = ? AND session_id = ? AND target_language = ? AND status = 'pending'`,
		status, text, errorCode, requestID, encodeTime(now), segmentID, sessionID, canonical)
	if err != nil {
		return SegmentTranslation{}, fmt.Errorf("store: complete translation: %w", mapSQLError(err))
	}
	if err := tx.Commit(); err != nil {
		return SegmentTranslation{}, fmt.Errorf("store: commit translation result: %w", err)
	}
	return SegmentTranslation{SessionID: sessionID, SegmentID: segmentID, TargetLanguage: canonical,
		Status: status, Text: text, Error: errorCode, RequestID: requestID, UpdatedAt: now.UTC()}, nil
}

// FailTranslation is a quota-independent terminal fallback when a result
// cannot be stored. It never overwrites a successful result.
func (s *Store) FailTranslation(ctx context.Context, ownerID, sessionID, segmentID, target, code string, now time.Time) (SegmentTranslation, error) {
	if code == "" || len(code) > 128 {
		return SegmentTranslation{}, errors.New("store: invalid translation failure code")
	}
	return s.FinishTranslation(ctx, ownerID, sessionID, segmentID, target,
		domain.TranslationFailed, "", code, "", now)
}

// PresentSegments applies only the requested language's records to source
// segments. Legacy default-language text is never leaked to another target.
func (s *Store) PresentSegments(ctx context.Context, ownerID, sessionID, target string, segments []domain.Segment) ([]domain.Segment, error) {
	canonical, err := canonicalTarget(target)
	if err != nil {
		return nil, err
	}
	result := make([]domain.Segment, len(segments))
	copy(result, segments)
	if len(result) == 0 {
		return result, nil
	}
	if len(result) > 200 {
		return nil, errors.New("store: translation presentation page exceeds 200 segments")
	}
	placeholders := make([]string, len(result))
	args := make([]any, 0, len(result)+3)
	args = append(args, sessionID, ownerID, canonical)
	positions := make(map[string]int, len(result))
	for i, segment := range result {
		if segment.SessionID != sessionID {
			return nil, ErrNotFound
		}
		positions[segment.ID] = i
		result[i].Translation = ""
		result[i].TranslationStatus = domain.TranslationNotRequested
		result[i].TranslationError = ""
		result[i].TranslatorRequestID = ""
		placeholders[i] = "?"
		args = append(args, segment.ID)
	}
	var owned int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM segments WHERE session_id = ? AND user_id = ? AND id IN (`+
		strings.Join(placeholders, ",")+`)`, append([]any{sessionID, ownerID}, args[3:]...)...).Scan(&owned); err != nil {
		return nil, fmt.Errorf("store: verify translated segment ownership: %w", err)
	}
	if owned != len(result) {
		return nil, ErrNotFound
	}
	query := `
		SELECT translation.session_id, translation.segment_id, translation.target_language,
			translation.status, translation.text, translation.error, translation.request_id, translation.updated_at
		FROM segment_translations translation
		JOIN segments segment ON segment.id = translation.segment_id AND segment.session_id = translation.session_id
		WHERE segment.session_id = ? AND segment.user_id = ? AND translation.target_language = ?
			AND segment.id IN (` + strings.Join(placeholders, ",") + `)`
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("store: read translated segments: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		record, err := scanTranslation(rows)
		if err != nil {
			return nil, err
		}
		position, found := positions[record.SegmentID]
		if !found {
			continue
		}
		result[position].TranslationStatus = record.Status
		result[position].Translation = record.Text
		result[position].TranslationError = record.Error
		result[position].TranslatorRequestID = record.RequestID
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: scan translated segments: %w", err)
	}
	return result, nil
}

// SetSegmentSpeaker persists a late ASR diarization correction only on the
// owner's source segment. Speaker IDs are anonymous local turn labels.
func (s *Store) SetSegmentSpeaker(ctx context.Context, ownerID, sessionID, segmentID, speakerID string) error {
	if ownerID == "" || sessionID == "" || segmentID == "" || len(speakerID) > 128 {
		return errors.New("store: invalid segment speaker")
	}
	result, err := s.db.ExecContext(ctx, `UPDATE segments SET speaker_id = ?
		WHERE id = ? AND session_id = ? AND user_id = ?`, speakerID, segmentID, sessionID, ownerID)
	return requireAffected(result, err, "set segment speaker")
}

type SpeakerCandidate struct {
	ID        string
	SpeakerID string
	Wall0MS   int64
	Wall1MS   int64
}

// SpeakerCandidatesForWallRange reads only overlapping final rows from this
// recording generation. The caller must compare all buffered speaker spans
// before deciding whether to change a row; the newest span alone is not proof.
func (s *Store) SpeakerCandidatesForWallRange(ctx context.Context, ownerID, sessionID string,
	firstSequence, wall0MS, wall1MS int64) ([]SpeakerCandidate, error) {
	if ownerID == "" || sessionID == "" ||
		firstSequence < 0 || wall0MS < 0 || wall1MS <= wall0MS {
		return nil, errors.New("store: invalid speaker candidate range")
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, speaker_id, wall0_ms, wall1_ms FROM segments
		WHERE session_id = ? AND user_id = ? AND sequence >= ?
			AND wall1_ms > wall0_ms AND wall0_ms < ? AND wall1_ms > ?
		ORDER BY sequence LIMIT 257`, sessionID, ownerID, firstSequence, wall1MS, wall0MS)
	if err != nil {
		return nil, fmt.Errorf("store: find speaker candidates: %w", mapSQLError(err))
	}
	defer rows.Close()
	result := make([]SpeakerCandidate, 0)
	for rows.Next() {
		var candidate SpeakerCandidate
		if err := rows.Scan(&candidate.ID, &candidate.SpeakerID, &candidate.Wall0MS, &candidate.Wall1MS); err != nil {
			return nil, fmt.Errorf("store: scan speaker candidate: %w", err)
		}
		result = append(result, candidate)
		if len(result) > 256 {
			return nil, ErrCapacity
		}
	}
	return result, rows.Err()
}
