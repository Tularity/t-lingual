package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/Tularity/t-lingual/internal/id"
)

const ActionPasskeyManagement = "passkey_management"

type ActionGrant struct {
	ID               string
	UserID           string
	BrowserSessionID string
	Action           string
	CreatedAt        time.Time
	ExpiresAt        time.Time
}

// CreateActionGrant binds a short-lived one-time authorization to the active
// browser session that completed user verification. A new grant replaces the
// previous unconsumed grant for the same session and action, bounding storage
// even when a verified user repeatedly performs the step-up ceremony.
func (s *Store) CreateActionGrant(ctx context.Context, grant ActionGrant, clearToken string) error {
	if grant.ID == "" || grant.UserID == "" || grant.BrowserSessionID == "" || clearToken == "" {
		return errors.New("store: action grant identity and token are required")
	}
	if grant.Action != ActionPasskeyManagement {
		return errors.New("store: unsupported action grant")
	}
	if grant.CreatedAt.IsZero() || !grant.ExpiresAt.After(grant.CreatedAt) {
		return errors.New("store: valid action grant timestamps are required")
	}
	digest := id.HashSecret(clearToken)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: begin action grant replacement: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		"DELETE FROM action_grants WHERE browser_session_id = ? AND action = ?",
		grant.BrowserSessionID, grant.Action,
	); err != nil {
		return fmt.Errorf("store: replace prior action grant: %w", err)
	}
	result, err := tx.ExecContext(ctx, `
		INSERT INTO action_grants(
			id, token_hash, user_id, browser_session_id, action, created_at, expires_at
		)
		SELECT ?, ?, bs.user_id, bs.id, ?, ?, ?
		FROM browser_sessions bs
		JOIN users u ON u.id = bs.user_id
		WHERE bs.id = ? AND bs.user_id = ? AND bs.expires_at > ? AND u.status = 'active'`,
		grant.ID, digest[:], grant.Action, encodeTime(grant.CreatedAt), encodeTime(grant.ExpiresAt),
		grant.BrowserSessionID, grant.UserID, encodeTime(grant.CreatedAt),
	)
	if err != nil {
		return fmt.Errorf("store: create action grant: %w", mapSQLError(err))
	}
	if err := requireAffected(result, nil, "create action grant"); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: commit action grant replacement: %w", err)
	}
	return nil
}

// ConsumeActionGrant deletes a matching grant in the same statement that
// verifies its user, browser session, purpose, expiry, and current account
// status. Replays and grants from another session are indistinguishable.
func (s *Store) ConsumeActionGrant(
	ctx context.Context,
	clearToken string,
	userID string,
	browserSessionID string,
	action string,
	now time.Time,
) error {
	if clearToken == "" || userID == "" || browserSessionID == "" || action != ActionPasskeyManagement {
		return ErrNotFound
	}
	digest := id.HashSecret(clearToken)
	result, err := s.db.ExecContext(ctx, `
		DELETE FROM action_grants
		WHERE token_hash = ? AND user_id = ? AND browser_session_id = ?
			AND action = ? AND expires_at > ?
			AND EXISTS (
				SELECT 1 FROM browser_sessions bs
				JOIN users u ON u.id = bs.user_id
				WHERE bs.id = action_grants.browser_session_id
					AND bs.user_id = action_grants.user_id
					AND bs.expires_at > ? AND u.status = 'active'
			)`,
		digest[:], userID, browserSessionID, action, encodeTime(now), encodeTime(now),
	)
	return requireAffected(result, err, "consume action grant")
}

func (s *Store) DeleteExpiredActionGrants(ctx context.Context, now time.Time) (int64, error) {
	result, err := s.db.ExecContext(ctx,
		"DELETE FROM action_grants WHERE expires_at <= ?", encodeTime(now),
	)
	if err != nil {
		return 0, fmt.Errorf("store: delete expired action grants: %w", err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("store: inspect expired action grant deletion: %w", err)
	}
	return count, nil
}
