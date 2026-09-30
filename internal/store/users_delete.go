package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
)

// UserSessionIDs lists every session one account owns, archived ones included.
func (s *Store) UserSessionIDs(ctx context.Context, userID string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id FROM interpretation_sessions WHERE user_id = ? ORDER BY created_at`, userID)
	if err != nil {
		return nil, fmt.Errorf("store: list account sessions: %w", err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("store: read account session: %w", err)
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// DeleteUserAsAdmin removes one account for good, with everything the
// database keeps of it: passkeys, browsers, settings, workspaces, shares,
// memberships, limits and avatar go with it; invitations and the audit log
// keep their rows with the person unset. Its sessions must already be gone,
// since their recordings live outside the database. Sign-in codes made for it
// are revoked, the last active administrator cannot be removed, and the
// removal and its audit event commit together.
func (s *Store) DeleteUserAsAdmin(ctx context.Context, actorUserID, browserSessionID string, checkedAt time.Time,
	userID string, event AuditEvent, now time.Time) error {
	if userID == "" || userID == actorUserID || now.IsZero() {
		return ErrForbidden
	}
	authority, err := webAdminMutationAuthority(actorUserID, browserSessionID, checkedAt)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: begin account deletion: %w", err)
	}
	defer tx.Rollback()
	if err := requireAdminMutationAuthority(ctx, tx, authority); err != nil {
		return err
	}
	role, status, err := userRoleAndStatus(ctx, tx, userID)
	if err != nil {
		return err
	}
	if role == domain.RoleAdmin && status == domain.UserActive {
		if err := requireAnotherActiveAdmin(ctx, tx, userID); err != nil {
			return err
		}
	}
	var sessions int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM interpretation_sessions WHERE user_id = ?`, userID).Scan(&sessions); err != nil {
		return fmt.Errorf("store: count sessions of deleted account: %w", err)
	}
	if sessions > 0 {
		return fmt.Errorf("%w: the account still has sessions", ErrConflict)
	}
	if err := revokeOutstandingLoginCodesTx(ctx, tx, userID, now); err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, userID)
	if err := requireAffected(result, err, "delete user"); err != nil {
		if errors.Is(err, ErrNotFound) {
			return err
		}
		return fmt.Errorf("store: delete user: %w", mapSQLError(err))
	}
	if err := appendAuditEventTx(ctx, tx, event); err != nil {
		return err
	}
	return commitAdminMutation(ctx, tx, "account deletion")
}
