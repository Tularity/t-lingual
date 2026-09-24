package store

import (
	"context"
	"errors"
)

// SegmentWindowAtTime returns a small chronological window around the phrase
// preceding an audio position. The ownership predicate is applied in SQL.
func (s *Store) SegmentWindowAtTime(ctx context.Context, ownerID, sessionID string, atMS int64, limit int) (SegmentPage, error) {
	if atMS < 0 {
		return SegmentPage{}, errors.New("negative audio position")
	}
	if _, err := s.GetInterpretationSession(ctx, ownerID, sessionID); err != nil {
		return SegmentPage{}, err
	}
	var sequence int64
	err := s.db.QueryRowContext(ctx, `SELECT COALESCE(MAX(sequence),0) FROM segments WHERE user_id=? AND session_id=? AND start_ms<=?`, ownerID, sessionID, atMS).Scan(&sequence)
	if err != nil {
		return SegmentPage{}, err
	}
	limit, _ = pagination(limit, 0)
	if limit > 200 {
		limit = 200
	}
	start := max(int64(-1), sequence-int64(limit/4)-1)
	return s.ListSegmentsWindow(ctx, ownerID, sessionID, SegmentPageQuery{Mode: SegmentPageAfter, Sequence: start, Limit: limit})
}
