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

type rowScanner interface {
	Scan(dest ...any) error
}

func (s *Store) CreateUser(ctx context.Context, user domain.User) error {
	if err := validateUser(user); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO users(
			id, webauthn_id, username, display_name, role, status, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		user.ID, user.WebAuthnID, user.Username, user.DisplayName, user.Role, user.Status,
		encodeTime(user.CreatedAt), encodeTime(user.UpdatedAt),
	)
	if err != nil {
		return fmt.Errorf("store: create user: %w", mapSQLError(err))
	}
	return nil
}

func validateUser(user domain.User) error {
	if user.ID == "" || len(user.WebAuthnID) == 0 || strings.TrimSpace(user.Username) == "" {
		return errors.New("store: user id, WebAuthn id, and username are required")
	}
	if !user.Role.Valid() {
		return fmt.Errorf("store: invalid user role %q", user.Role)
	}
	if user.Status != domain.UserActive && user.Status != domain.UserDisabled {
		return fmt.Errorf("store: invalid user status %q", user.Status)
	}
	if user.CreatedAt.IsZero() || user.UpdatedAt.IsZero() {
		return errors.New("store: user timestamps are required")
	}
	return nil
}

func (s *Store) GetUserByID(ctx context.Context, userID string) (domain.User, error) {
	return scanUser(s.db.QueryRowContext(ctx, `
		SELECT id, webauthn_id, username, display_name, role, status, created_at, updated_at
		FROM users WHERE id = ?`, userID))
}

func (s *Store) GetUserByUsername(ctx context.Context, username string) (domain.User, error) {
	return scanUser(s.db.QueryRowContext(ctx, `
		SELECT id, webauthn_id, username, display_name, role, status, created_at, updated_at
		FROM users WHERE username = ? COLLATE NOCASE`, username))
}

func (s *Store) GetUserByWebAuthnID(ctx context.Context, webAuthnID []byte) (domain.User, error) {
	return scanUser(s.db.QueryRowContext(ctx, `
		SELECT id, webauthn_id, username, display_name, role, status, created_at, updated_at
		FROM users WHERE webauthn_id = ?`, webAuthnID))
}

func scanUser(row rowScanner) (domain.User, error) {
	var user domain.User
	var role, status string
	var createdAt, updatedAt int64
	if err := row.Scan(
		&user.ID, &user.WebAuthnID, &user.Username, &user.DisplayName,
		&role, &status, &createdAt, &updatedAt,
	); err != nil {
		return domain.User{}, mapSQLError(err)
	}
	user.Role = domain.Role(role)
	user.Status = domain.UserStatus(status)
	user.CreatedAt = decodeTime(createdAt)
	user.UpdatedAt = decodeTime(updatedAt)
	return user, nil
}

// ListUsersAsTrustedControl is an authorization-free persistence operation
// reserved for the local control plane. Web callers must use ListUsersAsAdmin.
func (s *Store) ListUsersAsTrustedControl(ctx context.Context, limit, offset int) ([]domain.User, error) {
	return listUsers(ctx, s.db, limit, offset)
}

func listUsers(ctx context.Context, queryer rowsQueryer, limit, offset int) ([]domain.User, error) {
	limit, offset = pagination(limit, offset)
	rows, err := queryer.QueryContext(ctx, `
		SELECT id, webauthn_id, username, display_name, role, status, created_at, updated_at
		FROM users ORDER BY created_at DESC, id LIMIT ? OFFSET ?`, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("store: list users: %w", err)
	}
	defer rows.Close()

	users := make([]domain.User, 0)
	for rows.Next() {
		user, err := scanUser(rows)
		if err != nil {
			return nil, fmt.Errorf("store: list users: %w", err)
		}
		users = append(users, user)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list users: %w", err)
	}
	return users, nil
}

func (s *Store) UpdateUserRole(ctx context.Context, userID string, role domain.Role, updatedAt time.Time) error {
	if !role.Valid() {
		return fmt.Errorf("store: invalid user role %q", role)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: begin user role update: %w", err)
	}
	defer tx.Rollback()

	currentRole, currentStatus, err := userRoleAndStatus(ctx, tx, userID)
	if err != nil {
		return err
	}
	if currentRole == domain.RoleAdmin && currentStatus == domain.UserActive && role != domain.RoleAdmin {
		if err := requireAnotherActiveAdmin(ctx, tx, userID); err != nil {
			return err
		}
	}
	result, err := tx.ExecContext(ctx,
		"UPDATE users SET role = ?, updated_at = ? WHERE id = ?",
		role, encodeTime(updatedAt), userID,
	)
	if err := requireAffected(result, err, "update user role"); err != nil {
		return err
	}
	if currentRole != role {
		if err := revokeOutstandingLoginCodesTx(ctx, tx, userID, updatedAt); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: commit user role update: %w", err)
	}
	return nil
}

func (s *Store) UpdateUserStatus(ctx context.Context, userID string, status domain.UserStatus, updatedAt time.Time) error {
	if status != domain.UserActive && status != domain.UserDisabled {
		return fmt.Errorf("store: invalid user status %q", status)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: begin user status update: %w", err)
	}
	defer tx.Rollback()

	currentRole, currentStatus, err := userRoleAndStatus(ctx, tx, userID)
	if err != nil {
		return err
	}
	if currentRole == domain.RoleAdmin && currentStatus == domain.UserActive && status != domain.UserActive {
		if err := requireAnotherActiveAdmin(ctx, tx, userID); err != nil {
			return err
		}
	}
	result, err := tx.ExecContext(ctx,
		"UPDATE users SET status = ?, updated_at = ? WHERE id = ?",
		status, encodeTime(updatedAt), userID,
	)
	if err := requireAffected(result, err, "update user status"); err != nil {
		return err
	}
	if currentStatus != status {
		if err := revokeOutstandingLoginCodesTx(ctx, tx, userID, updatedAt); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: commit user status update: %w", err)
	}
	return nil
}

type queryRower interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func userRoleAndStatus(
	ctx context.Context,
	queryer queryRower,
	userID string,
) (domain.Role, domain.UserStatus, error) {
	var role domain.Role
	var status domain.UserStatus
	err := queryer.QueryRowContext(ctx,
		"SELECT role, status FROM users WHERE id = ?", userID,
	).Scan(&role, &status)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", ErrNotFound
	}
	if err != nil {
		return "", "", fmt.Errorf("store: inspect user role and status: %w", err)
	}
	return role, status, nil
}

func requireAnotherActiveAdmin(ctx context.Context, queryer queryRower, userID string) error {
	var count int
	if err := queryer.QueryRowContext(ctx, `
		SELECT count(*) FROM users
		WHERE role = 'admin' AND status = 'active' AND id <> ?`, userID).Scan(&count); err != nil {
		return fmt.Errorf("store: count other active administrators: %w", err)
	}
	if count == 0 {
		return fmt.Errorf("%w: cannot remove the final active administrator", ErrForbidden)
	}
	return nil
}

func requireAffected(result sql.Result, err error, operation string) error {
	if err != nil {
		return fmt.Errorf("store: %s: %w", operation, mapSQLError(err))
	}
	count, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("store: %s affected rows: %w", operation, err)
	}
	if count == 0 {
		return ErrNotFound
	}
	return nil
}
