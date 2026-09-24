package store

import (
	"context"
	"crypto/sha256"
	"fmt"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/id"
)

// ValidateRecoveryAddGrant is read-only. It permits multiple fresh passkey
// ceremonies during the short code-login window, but does not extend expiry.
func (s *Store) ValidateRecoveryAddGrant(ctx context.Context, clearToken, userID, browserSessionID string, now time.Time) error {
	if clearToken == "" || userID == "" || browserSessionID == "" || now.IsZero() {
		return ErrNotFound
	}
	digest := id.HashSecret(clearToken)
	var valid int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM action_grants grant_row
		JOIN browser_sessions session ON session.id=grant_row.browser_session_id
		JOIN users u ON u.id=grant_row.user_id
		WHERE grant_row.token_hash=? AND grant_row.user_id=? AND grant_row.browser_session_id=?
			AND grant_row.action=? AND grant_row.expires_at>?
			AND session.user_id=u.id AND session.expires_at>? AND u.status='active'`,
		digest[:], userID, browserSessionID, ActionPasskeyManagement, encodeTime(now), encodeTime(now)).Scan(&valid)
	return mapSQLError(err)
}

// CreateCredentialWithRecoveryGrant consumes the exact session-bound recovery
// grant in the same transaction as inserting a validated new passkey. Failed
// writes roll back the deletion; racing distinct ceremonies can commit at most
// one credential. A ceremony cannot extend the grant's two-minute expiry.
func (s *Store) CreateCredentialWithRecoveryGrant(ctx context.Context, credential domain.Credential,
	browserSessionID string, grantDigest []byte, now time.Time) error {
	if err := validateCredential(credential); err != nil {
		return err
	}
	if browserSessionID == "" || len(grantDigest) != sha256.Size || now.IsZero() {
		return ErrNotFound
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: begin recovery credential creation: %w", err)
	}
	defer tx.Rollback()
	consumed, err := tx.ExecContext(ctx, `DELETE FROM action_grants
		WHERE token_hash=? AND user_id=? AND browser_session_id=? AND action=? AND expires_at>?
			AND EXISTS (SELECT 1 FROM browser_sessions bs JOIN users u ON u.id=bs.user_id
				WHERE bs.id=action_grants.browser_session_id AND bs.user_id=action_grants.user_id
				AND bs.expires_at>? AND u.status='active')`,
		grantDigest, credential.UserID, browserSessionID, ActionPasskeyManagement,
		encodeTime(now), encodeTime(now))
	if err != nil {
		return fmt.Errorf("store: consume recovery grant: %w", mapSQLError(err))
	}
	changed, err := consumed.RowsAffected()
	if err != nil {
		return fmt.Errorf("store: inspect recovery grant: %w", err)
	}
	if changed != 1 {
		return ErrNotFound
	}
	insert, err := tx.ExecContext(ctx, `INSERT INTO webauthn_credentials(
		id,user_id,credential_id,name,credential_json,created_at,last_used_at)
		SELECT ?,bs.user_id,?,?,?,?,? FROM browser_sessions bs JOIN users u ON u.id=bs.user_id
		WHERE bs.id=? AND bs.user_id=? AND bs.expires_at>? AND u.status='active'
			AND (SELECT COUNT(*) FROM webauthn_credentials existing WHERE existing.user_id=bs.user_id)<?`,
		credential.ID, credential.CredentialID, credential.Name, credential.CredentialJSON,
		encodeTime(credential.CreatedAt), encodeOptionalTime(credential.LastUsedAt),
		browserSessionID, credential.UserID, encodeTime(now), maxCredentialsPerUser)
	if err != nil {
		return fmt.Errorf("store: create recovery credential: %w", mapSQLError(err))
	}
	inserted, err := insert.RowsAffected()
	if err != nil {
		return fmt.Errorf("store: inspect recovery credential insert: %w", err)
	}
	if inserted != 1 {
		var count int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM webauthn_credentials WHERE user_id=?`, credential.UserID).Scan(&count); err != nil {
			return fmt.Errorf("store: inspect recovery credential quota: %w", err)
		}
		if count >= maxCredentialsPerUser {
			return ErrCapacity
		}
		return ErrNotFound
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: commit recovery credential: %w", err)
	}
	return nil
}
