package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
)

const maxCredentialsPerUser = 10

func (s *Store) CreateCredential(ctx context.Context, credential domain.Credential) error {
	if err := validateCredential(credential); err != nil {
		return err
	}
	result, err := s.db.ExecContext(ctx, `
		INSERT INTO webauthn_credentials(
			id, user_id, credential_id, name, credential_json, created_at, last_used_at
		)
		SELECT ?, ?, ?, ?, ?, ?, ?
		WHERE (SELECT COUNT(*) FROM webauthn_credentials WHERE user_id = ?) < ?`,
		credential.ID, credential.UserID, credential.CredentialID, credential.Name,
		credential.CredentialJSON, encodeTime(credential.CreatedAt),
		encodeOptionalTime(credential.LastUsedAt), credential.UserID, maxCredentialsPerUser,
	)
	if err != nil {
		return fmt.Errorf("store: create credential: %w", mapSQLError(err))
	}
	return s.credentialCreateResult(ctx, result, credential.UserID, "create credential")
}

// CreateCredentialForActiveSession closes the gap between a step-up ceremony
// and its completion: credential creation succeeds only while the same browser
// session still exists, is unexpired, belongs to the user, and the account is
// active.
func (s *Store) CreateCredentialForActiveSession(
	ctx context.Context,
	credential domain.Credential,
	browserSessionID string,
	now time.Time,
) error {
	if err := validateCredential(credential); err != nil {
		return err
	}
	if browserSessionID == "" || now.IsZero() {
		return ErrNotFound
	}
	result, err := s.db.ExecContext(ctx, `
		INSERT INTO webauthn_credentials(
			id, user_id, credential_id, name, credential_json, created_at, last_used_at
		)
		SELECT ?, bs.user_id, ?, ?, ?, ?, ?
		FROM browser_sessions bs
		JOIN users u ON u.id = bs.user_id
		WHERE bs.id = ? AND bs.user_id = ? AND bs.expires_at > ? AND u.status = 'active'
			AND (SELECT COUNT(*) FROM webauthn_credentials existing
				WHERE existing.user_id = bs.user_id) < ?`,
		credential.ID, credential.CredentialID, credential.Name, credential.CredentialJSON,
		encodeTime(credential.CreatedAt), encodeOptionalTime(credential.LastUsedAt),
		browserSessionID, credential.UserID, encodeTime(now), maxCredentialsPerUser,
	)
	if err != nil {
		return fmt.Errorf("store: create credential for active session: %w", mapSQLError(err))
	}
	return s.credentialCreateResult(ctx, result, credential.UserID, "create credential for active session")
}

func (s *Store) credentialCreateResult(ctx context.Context, result sql.Result, userID, operation string) error {
	count, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("store: %s affected rows: %w", operation, err)
	}
	if count == 1 {
		return nil
	}
	var credentials int
	if err := s.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM webauthn_credentials WHERE user_id = ?", userID,
	).Scan(&credentials); err != nil {
		return fmt.Errorf("store: inspect %s quota: %w", operation, err)
	}
	if credentials >= maxCredentialsPerUser {
		return ErrCapacity
	}
	return ErrNotFound
}

func validateCredential(credential domain.Credential) error {
	if credential.ID == "" || credential.UserID == "" || len(credential.CredentialID) == 0 {
		return errors.New("store: credential id, user id, and WebAuthn credential id are required")
	}
	if len(credential.CredentialJSON) == 0 {
		return errors.New("store: credential JSON is required")
	}
	if credential.CreatedAt.IsZero() {
		return errors.New("store: credential creation time is required")
	}
	return nil
}

func (s *Store) ListCredentials(ctx context.Context, userID string) ([]domain.Credential, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, user_id, credential_id, name, credential_json, created_at, last_used_at, compromised_at
		FROM webauthn_credentials
		WHERE user_id = ? ORDER BY created_at, id`, userID)
	if err != nil {
		return nil, fmt.Errorf("store: list credentials: %w", err)
	}
	defer rows.Close()

	credentials := make([]domain.Credential, 0)
	for rows.Next() {
		credential, err := scanCredential(rows)
		if err != nil {
			return nil, fmt.Errorf("store: list credentials: %w", err)
		}
		credentials = append(credentials, credential)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list credentials: %w", err)
	}
	return credentials, nil
}

func (s *Store) GetCredentialByCredentialID(ctx context.Context, credentialID []byte) (domain.Credential, error) {
	return scanCredential(s.db.QueryRowContext(ctx, `
		SELECT id, user_id, credential_id, name, credential_json, created_at, last_used_at, compromised_at
		FROM webauthn_credentials WHERE credential_id = ?`, credentialID))
}

func scanCredential(row rowScanner) (domain.Credential, error) {
	var credential domain.Credential
	var createdAt int64
	var lastUsedAt, compromisedAt sql.NullInt64
	if err := row.Scan(
		&credential.ID, &credential.UserID, &credential.CredentialID, &credential.Name,
		&credential.CredentialJSON, &createdAt, &lastUsedAt, &compromisedAt,
	); err != nil {
		return domain.Credential{}, mapSQLError(err)
	}
	credential.CreatedAt = decodeTime(createdAt)
	credential.LastUsedAt = decodeOptionalTime(lastUsedAt)
	credential.CompromisedAt = decodeOptionalTime(compromisedAt)
	return credential, nil
}

func (s *Store) UpdateCredential(
	ctx context.Context,
	userID string,
	credentialID []byte,
	credentialJSON []byte,
	lastUsedAt *time.Time,
) error {
	if len(credentialJSON) == 0 {
		return errors.New("store: credential JSON is required")
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE webauthn_credentials
		SET credential_json = ?, last_used_at = ?
		WHERE user_id = ? AND credential_id = ?`,
		credentialJSON, encodeOptionalTime(lastUsedAt), userID, credentialID,
	)
	return requireAffected(result, err, "update credential")
}

// UpdateCredentialIfCurrent advances mutable authenticator state only when the
// encrypted credential blob is exactly the version used during verification.
// This prevents concurrent assertions from overwriting a newer signature
// counter or allowing two cloned authenticators to both advance from the same
// stored counter.
func (s *Store) UpdateCredentialIfCurrent(
	ctx context.Context,
	userID string,
	credentialID []byte,
	expectedCredentialJSON []byte,
	credentialJSON []byte,
	lastUsedAt *time.Time,
) error {
	if len(expectedCredentialJSON) == 0 || len(credentialJSON) == 0 {
		return errors.New("store: expected and updated credential JSON are required")
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE webauthn_credentials
		SET credential_json = ?, last_used_at = ?
		WHERE user_id = ? AND credential_id = ? AND credential_json = ?
			AND compromised_at IS NULL`,
		credentialJSON, encodeOptionalTime(lastUsedAt), userID, credentialID, expectedCredentialJSON,
	)
	if err != nil {
		return fmt.Errorf("store: compare-and-swap credential: %w", mapSQLError(err))
	}
	count, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("store: compare-and-swap credential affected rows: %w", err)
	}
	if count == 0 {
		return ErrConflict
	}
	return nil
}

// DeleteCredential removes a credential owned by userID. Unless allowLast is
// true, it refuses to remove the user's final credential so an account cannot
// accidentally become impossible to authenticate to.
func (s *Store) DeleteCredential(
	ctx context.Context,
	userID string,
	credentialID []byte,
	allowLast bool,
) error {
	_, err := s.deleteCredential(ctx, userID, credentialID, allowLast, false)
	return err
}

// DeleteCredentialAndBrowserSessions atomically removes the passkey and every
// browser session for the user. This conservative logout-all also covers
// sessions created before credential provenance was recorded.
func (s *Store) DeleteCredentialAndBrowserSessions(
	ctx context.Context,
	userID string,
	credentialID []byte,
	allowLast bool,
) (int64, error) {
	return s.deleteCredential(ctx, userID, credentialID, allowLast, true)
}

func (s *Store) deleteCredential(
	ctx context.Context,
	userID string,
	credentialID []byte,
	allowLast bool,
	deleteSessions bool,
) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("store: begin credential deletion: %w", err)
	}
	defer tx.Rollback()

	var exists int
	err = tx.QueryRowContext(ctx, `
		SELECT 1 FROM webauthn_credentials
		WHERE user_id = ? AND credential_id = ?`, userID, credentialID).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, fmt.Errorf("store: find credential for deletion: %w", err)
	}

	if !allowLast {
		var count int
		if err := tx.QueryRowContext(ctx,
			`SELECT count(*) FROM webauthn_credentials
			 WHERE user_id = ? AND credential_id <> ? AND compromised_at IS NULL`,
			userID, credentialID,
		).Scan(&count); err != nil {
			return 0, fmt.Errorf("store: count credentials: %w", err)
		}
		if count == 0 {
			return 0, fmt.Errorf("%w: cannot remove the final credential", ErrForbidden)
		}
	}

	if _, err := tx.ExecContext(ctx, `
		DELETE FROM webauthn_credentials
		WHERE user_id = ? AND credential_id = ?`, userID, credentialID); err != nil {
		return 0, fmt.Errorf("store: delete credential: %w", err)
	}
	var deletedSessions int64
	if deleteSessions {
		result, err := tx.ExecContext(ctx, "DELETE FROM browser_sessions WHERE user_id = ?", userID)
		if err != nil {
			return 0, fmt.Errorf("store: delete sessions with credential: %w", err)
		}
		deletedSessions, err = result.RowsAffected()
		if err != nil {
			return 0, fmt.Errorf("store: inspect sessions deleted with credential: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("store: commit credential deletion: %w", err)
	}
	return deletedSessions, nil
}
