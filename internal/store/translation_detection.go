package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/language"
)

func validDetection(source string, detection domain.SourceDetection) bool {
	canonical, err := language.Canonicalize(source)
	return err == nil && canonical == source && detection.Method == "fasttext-lid.176" &&
		!math.IsNaN(detection.Confidence) && !math.IsInf(detection.Confidence, 0) &&
		detection.Confidence >= 0 && detection.Confidence <= 1 &&
		detection.Rank >= 1 && detection.Rank <= 46 &&
		(!detection.ContextUsed || detection.Uncertain)
}

// FinishTranslationWithDetection commits the validated auto-LID decision in
// the same transaction as the terminal translation and quota adjustment.
// A crash cannot expose a successful translation without its source identity.
func (s *Store) FinishTranslationWithDetection(ctx context.Context, ownerID, sessionID, segmentID, target,
	text, requestID, resolvedSource string, detection domain.SourceDetection, now time.Time,
) (SegmentTranslation, error) {
	canonical, err := canonicalTarget(target)
	if err != nil {
		return SegmentTranslation{}, err
	}
	if ownerID == "" || sessionID == "" || segmentID == "" || now.IsZero() || text == "" ||
		len(text) > maxSegmentTextBytes || len(requestID) > 256 || !validDetection(resolvedSource, detection) {
		return SegmentTranslation{}, errors.New("store: invalid auto translation result")
	}
	encoded, err := json.Marshal(detection)
	if err != nil {
		return SegmentTranslation{}, fmt.Errorf("store: encode source detection: %w", err)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SegmentTranslation{}, fmt.Errorf("store: begin detected translation: %w", err)
	}
	defer tx.Rollback()
	var priorStatus domain.TranslationStatus
	var priorText string
	err = tx.QueryRowContext(ctx, `SELECT translation.status, translation.text
		FROM segment_translations translation
		JOIN segments segment ON segment.id = translation.segment_id AND segment.session_id = translation.session_id
		WHERE segment.id = ? AND segment.session_id = ? AND segment.user_id = ? AND translation.target_language = ?`,
		segmentID, sessionID, ownerID, canonical).Scan(&priorStatus, &priorText)
	if err != nil {
		return SegmentTranslation{}, fmt.Errorf("store: find detected translation: %w", mapSQLError(err))
	}
	if priorStatus != domain.TranslationPending {
		return SegmentTranslation{}, fmt.Errorf("%w: translation already %s", ErrConflict, priorStatus)
	}
	delta := int64(len(text) - len(priorText))
	if delta > 0 {
		usage, err := tx.ExecContext(ctx, `UPDATE interpretation_sessions
			SET transcript_bytes = transcript_bytes + ?
			WHERE id = ? AND user_id = ? AND transcript_bytes + ? <= ?
				AND COALESCE((SELECT SUM(transcript_bytes) FROM interpretation_sessions WHERE user_id = ?), 0) + ? <= ?`,
			delta, sessionID, ownerID, delta, maxTranscriptBytesPerSession,
			ownerID, delta, maxTranscriptBytesPerUser)
		if err != nil {
			return SegmentTranslation{}, fmt.Errorf("store: reserve detected translation bytes: %w", mapSQLError(err))
		}
		changed, err := usage.RowsAffected()
		if err != nil {
			return SegmentTranslation{}, fmt.Errorf("store: inspect detected translation quota: %w", err)
		}
		if changed != 1 {
			return SegmentTranslation{}, ErrCapacity
		}
	}
	result, err := tx.ExecContext(ctx, `UPDATE segment_translations
		SET status = 'succeeded', text = ?, error = '', request_id = ?, updated_at = ?,
			resolved_source_language = ?, source_detection_json = ?
		WHERE segment_id = ? AND session_id = ? AND target_language = ? AND status = 'pending'`,
		text, requestID, encodeTime(now), resolvedSource, string(encoded), segmentID, sessionID, canonical)
	if err != nil {
		return SegmentTranslation{}, fmt.Errorf("store: complete detected translation: %w", mapSQLError(err))
	}
	if changed, err := result.RowsAffected(); err != nil || changed != 1 {
		return SegmentTranslation{}, fmt.Errorf("%w: detected translation lost claim", ErrConflict)
	}
	if err := tx.Commit(); err != nil {
		return SegmentTranslation{}, fmt.Errorf("store: commit detected translation: %w", err)
	}
	return SegmentTranslation{SessionID: sessionID, SegmentID: segmentID, TargetLanguage: canonical,
		Status: domain.TranslationSucceeded, Text: text, RequestID: requestID, UpdatedAt: now.UTC()}, nil
}

// GetTranslationDetection enforces the same owner/session/target boundary as
// GetTranslation. Missing or unfinished LID information is not inferred from
// the source segment's script guess.
func (s *Store) GetTranslationDetection(ctx context.Context, ownerID, sessionID, segmentID, target string) (string, domain.SourceDetection, error) {
	canonical, err := canonicalTarget(target)
	if err != nil {
		return "", domain.SourceDetection{}, err
	}
	var source, encoded string
	err = s.db.QueryRowContext(ctx, `SELECT translation.resolved_source_language, translation.source_detection_json
		FROM segment_translations translation
		JOIN segments segment ON segment.id = translation.segment_id AND segment.session_id = translation.session_id
		WHERE segment.id = ? AND segment.session_id = ? AND segment.user_id = ?
			AND translation.target_language = ? AND translation.status = 'succeeded'
			AND translation.resolved_source_language != ''`,
		segmentID, sessionID, ownerID, canonical).Scan(&source, &encoded)
	if err != nil {
		return "", domain.SourceDetection{}, mapSQLError(err)
	}
	var detection domain.SourceDetection
	if err := json.Unmarshal([]byte(encoded), &detection); err != nil || !validDetection(source, detection) {
		return "", domain.SourceDetection{}, errors.New("store: invalid saved source detection")
	}
	return source, detection, nil
}

// ProjectSourceDetection overlays a viewer-target-specific LID result on the
// response DTO. The persisted ASR segment and its provenance remain immutable.
func (s *Store) ProjectSourceDetection(ctx context.Context, ownerID, sessionID, target string, segments []domain.Segment) ([]domain.Segment, error) {
	canonical, err := canonicalTarget(target)
	if err != nil {
		return nil, err
	}
	if len(segments) == 0 {
		return segments, nil
	}
	if len(segments) > 200 {
		return nil, errors.New("store: source detection page exceeds 200 segments")
	}
	positions := make(map[string]int, len(segments))
	args := make([]any, 0, len(segments)+3)
	args = append(args, sessionID, ownerID, canonical)
	marks := make([]string, len(segments))
	for i, segment := range segments {
		if segment.SessionID != sessionID {
			return nil, ErrNotFound
		}
		positions[segment.ID] = i
		marks[i] = "?"
		args = append(args, segment.ID)
	}
	rows, err := s.db.QueryContext(ctx, `SELECT translation.segment_id, translation.resolved_source_language,
			translation.source_detection_json FROM segment_translations translation
		JOIN segments segment ON segment.id = translation.segment_id AND segment.session_id = translation.session_id
		WHERE segment.session_id = ? AND segment.user_id = ? AND translation.target_language = ?
			AND translation.status = 'succeeded' AND translation.resolved_source_language != ''
			AND segment.id IN (`+strings.Join(marks, ",")+`)`, args...)
	if err != nil {
		return nil, fmt.Errorf("store: read source detections: %w", mapSQLError(err))
	}
	defer rows.Close()
	for rows.Next() {
		var id, source, encoded string
		if err := rows.Scan(&id, &source, &encoded); err != nil {
			return nil, fmt.Errorf("store: scan source detection: %w", err)
		}
		position, ok := positions[id]
		if !ok {
			continue
		}
		var detection domain.SourceDetection
		if err := json.Unmarshal([]byte(encoded), &detection); err != nil || !validDetection(source, detection) {
			return nil, errors.New("store: invalid saved source detection")
		}
		segments[position].DetectedLanguage = source
		segments[position].LanguageSource = "translator"
		segments[position].SourceDetection = &detection
	}
	if err := rows.Err(); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("store: iterate source detections: %w", err)
	}
	return segments, nil
}
