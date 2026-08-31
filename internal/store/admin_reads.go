package store

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
)

type rowsQueryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

// Each web administrative read opens one read transaction, re-authorizes the
// exact browser session in that transaction, and reads through the same
// snapshot. This prevents an authenticated middleware snapshot (including a
// pre-promotion cookie) from being upgraded merely because its user later has
// the admin role.
func (s *Store) ListInvitationsAsAdmin(
	ctx context.Context,
	actorUserID string,
	browserSessionID string,
	checkedAt time.Time,
	limit int,
	offset int,
) ([]domain.Invitation, error) {
	authority, err := webAdminMutationAuthority(actorUserID, browserSessionID, checkedAt)
	if err != nil {
		return nil, err
	}
	tx, err := s.beginAuthorizedAdminRead(ctx, authority)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	items, err := listInvitations(ctx, tx, limit, offset)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("store: commit administrative invitation read: %w", err)
	}
	return items, nil
}

func (s *Store) ListUsersAsAdmin(
	ctx context.Context,
	actorUserID string,
	browserSessionID string,
	checkedAt time.Time,
	limit int,
	offset int,
) ([]domain.User, error) {
	authority, err := webAdminMutationAuthority(actorUserID, browserSessionID, checkedAt)
	if err != nil {
		return nil, err
	}
	tx, err := s.beginAuthorizedAdminRead(ctx, authority)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	items, err := listUsers(ctx, tx, limit, offset)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("store: commit administrative user read: %w", err)
	}
	return items, nil
}

func (s *Store) ListAuditEventsAsAdmin(
	ctx context.Context,
	actorUserID string,
	browserSessionID string,
	checkedAt time.Time,
	limit int,
	offset int,
) ([]AuditEvent, error) {
	authority, err := webAdminMutationAuthority(actorUserID, browserSessionID, checkedAt)
	if err != nil {
		return nil, err
	}
	tx, err := s.beginAuthorizedAdminRead(ctx, authority)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	items, err := listAuditEvents(ctx, tx, limit, offset)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("store: commit administrative audit read: %w", err)
	}
	return items, nil
}

func (s *Store) beginAuthorizedAdminRead(
	ctx context.Context,
	authority adminMutationAuthority,
) (*sql.Tx, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, fmt.Errorf("store: begin administrative read: %w", err)
	}
	if err := requireAdminMutationAuthority(ctx, tx, authority); err != nil {
		_ = tx.Rollback()
		return nil, err
	}
	return tx, nil
}
