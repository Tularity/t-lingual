package store

import (
	"context"
	"fmt"
)

// MaxSegmentEndMS reads only the durable recording offset; the owner-scoped
// session row keeps an empty transcript distinct from a foreign session.
func (s *Store) MaxSegmentEndMS(ctx context.Context, ownerID, sessionID string) (int64, error) {
	var endMS int64
	err := s.db.QueryRowContext(ctx, `
		SELECT COALESCE(MAX(segment.end_ms), 0)
		FROM interpretation_sessions AS session
		LEFT JOIN segments AS segment
			ON segment.session_id = session.id AND segment.user_id = session.user_id
		WHERE session.id = ? AND session.user_id = ?
		GROUP BY session.id`, sessionID, ownerID,
	).Scan(&endMS)
	if err != nil {
		return 0, fmt.Errorf("store: max segment end: %w", mapSQLError(err))
	}
	return endMS, nil
}
