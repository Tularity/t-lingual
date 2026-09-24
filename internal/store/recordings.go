package store

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"time"
)

const (
	maxSessionAudioBytes int64 = 4 << 30
	maxOwnerAudioBytes   int64 = 32 << 30
)

var safeRecordingID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,96}$`)

type RecordingPart struct {
	ID           string    `json:"id"`
	SessionID    string    `json:"sessionId"`
	RunID        string    `json:"runId"`
	Index        int       `json:"index"`
	SampleRate   int       `json:"sampleRate"`
	OffsetFrames int64     `json:"offsetFrames"`
	Frames       int64     `json:"frames"`
	Bytes        int64     `json:"bytes"`
	CreatedAt    time.Time `json:"createdAt"`
}

func (s *Store) DataRoot() string { return s.dataRoot }

// CreateRecordingPart derives the path from a validated server-generated id;
// no client file name is ever persisted or later joined to the data root.
func (s *Store) CreateRecordingPart(ctx context.Context, ownerID, sessionID string, part RecordingPart) error {
	if ownerID == "" || sessionID == "" || !safeRecordingID.MatchString(sessionID) ||
		!safeRecordingID.MatchString(part.ID) || !safeRecordingID.MatchString(part.RunID) ||
		part.Index < 0 || part.SampleRate < 8000 || part.SampleRate > 192000 ||
		part.OffsetFrames < 0 || part.CreatedAt.IsZero() {
		return errors.New("store: invalid recording part")
	}
	result, err := s.db.ExecContext(ctx, `INSERT INTO recording_parts
        (id, session_id, user_id, run_id, part_index, sample_rate, offset_frames, frames, bytes, created_at)
        SELECT ?, id, user_id, ?, ?, ?, ?, 0, 0, ? FROM interpretation_sessions
        WHERE id = ? AND user_id = ? AND archived_at IS NULL`,
		part.ID, part.RunID, part.Index, part.SampleRate, part.OffsetFrames,
		encodeTime(part.CreatedAt), sessionID, ownerID)
	return requireAffected(result, err, "create recording part")
}

// AdvanceRecordingPart follows a successful file sync. A crash between sync
// and this update is reconciled from the aligned file length before reuse.
func (s *Store) AdvanceRecordingPart(ctx context.Context, ownerID, sessionID, partID string, bytes int64) error {
	if bytes < 0 || bytes%4 != 0 {
		return errors.New("store: invalid recording length")
	}
	result, err := s.db.ExecContext(ctx, `UPDATE recording_parts SET bytes = ?, frames = ? / 4
        WHERE id = ? AND session_id = ? AND user_id = ? AND bytes <= ?
          AND ? + COALESCE((SELECT SUM(bytes) FROM recording_parts WHERE session_id = ?), 0) - bytes <= ?
          AND ? + COALESCE((SELECT SUM(bytes) FROM recording_parts WHERE user_id = ?), 0) - bytes <= ?`,
		bytes, bytes, partID, sessionID, ownerID, bytes,
		bytes, sessionID, maxSessionAudioBytes, bytes, ownerID, maxOwnerAudioBytes)
	if err != nil {
		return fmt.Errorf("store: advance recording part: %w", mapSQLError(err))
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed == 1 {
		return nil
	}
	if _, err := s.GetRecordingPart(ctx, ownerID, sessionID, partID); err != nil {
		return err
	}
	return ErrCapacity
}

func (s *Store) GetRecordingPart(ctx context.Context, ownerID, sessionID, partID string) (RecordingPart, error) {
	var p RecordingPart
	var created int64
	err := s.db.QueryRowContext(ctx, `SELECT id, session_id, run_id, part_index, sample_rate, offset_frames, frames, bytes, created_at
        FROM recording_parts WHERE id = ? AND session_id = ? AND user_id = ?`, partID, sessionID, ownerID).
		Scan(&p.ID, &p.SessionID, &p.RunID, &p.Index, &p.SampleRate, &p.OffsetFrames, &p.Frames, &p.Bytes, &created)
	if err != nil {
		return RecordingPart{}, mapSQLError(err)
	}
	p.CreatedAt = decodeTime(created)
	return p, nil
}

func (s *Store) ListRecordingParts(ctx context.Context, ownerID, sessionID string) ([]RecordingPart, error) {
	if _, err := s.GetInterpretationSession(ctx, ownerID, sessionID); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id, session_id, run_id, part_index, sample_rate, offset_frames, frames, bytes, created_at
        FROM recording_parts WHERE session_id = ? AND user_id = ? ORDER BY created_at, rowid`, sessionID, ownerID)
	if err != nil {
		return nil, fmt.Errorf("store: list recording parts: %w", err)
	}
	defer rows.Close()
	result := make([]RecordingPart, 0)
	for rows.Next() {
		var p RecordingPart
		var created int64
		if err := rows.Scan(&p.ID, &p.SessionID, &p.RunID, &p.Index, &p.SampleRate, &p.OffsetFrames, &p.Frames, &p.Bytes, &created); err != nil {
			return nil, err
		}
		p.CreatedAt = decodeTime(created)
		result = append(result, p)
	}
	return result, rows.Err()
}

// RecordingDurationMS uses every saved PCM frame, including trailing silence.
// Callers reconcile files first when recovering after an unclean shutdown.
func (s *Store) RecordingDurationMS(ctx context.Context, ownerID, sessionID string) (int64, error) {
	if _, err := s.GetInterpretationSession(ctx, ownerID, sessionID); err != nil {
		return 0, err
	}
	rows, err := s.ListRecordingParts(ctx, ownerID, sessionID)
	if err != nil {
		return 0, err
	}
	var end int64
	for _, p := range rows {
		candidate := (p.OffsetFrames + p.Frames) * 1000 / int64(p.SampleRate)
		if candidate > end {
			end = candidate
		}
	}
	return end, nil
}
