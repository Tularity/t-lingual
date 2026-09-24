package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/id"
)

// RedeemOneTimeCode is the shared six-digit code entry. Registration returns
// an unconsumed invitation for a short sealed ticket. Login consumes the code
// and creates a browser session in one transaction. Unknown guesses charge
// the existing durable failure bucket and share its auto-revocation policy.
func (s *Store) RedeemOneTimeCode(ctx context.Context, digest [sha256.Size]byte, bucket uint16,
	now time.Time, session domain.BrowserSession, clearToken, auditID,
	recoveryGrantID, recoveryGrantToken string, recoveryExpiresAt time.Time,
) (domain.Invitation, error) {
	if now.IsZero() || clearToken == "" || session.ID == "" || session.CreatedAt.IsZero() ||
		session.ExpiresAt.IsZero() || !session.ExpiresAt.After(session.CreatedAt) ||
		session.LastSeen.IsZero() || recoveryGrantID == "" || recoveryGrantToken == "" ||
		!recoveryExpiresAt.After(now) || recoveryExpiresAt.After(session.ExpiresAt) {
		return domain.Invitation{}, errors.New("store: invalid code redemption session")
	}
	if err := validateInvitationFailure(bucket, now, 5, auditID); err != nil {
		return domain.Invitation{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return domain.Invitation{}, fmt.Errorf("store: begin code redemption: %w", err)
	}
	defer tx.Rollback()
	invitation, err := scanInvitation(tx.QueryRowContext(ctx, `
		SELECT id, created_by, created_at, expires_at, used_at, used_by, revoked_at,
			revocation_reason, kind, target_user_id, not_before
		FROM invitations WHERE code_hash = ?`, digest[:]))
	if errors.Is(err, ErrNotFound) {
		if _, err := recordInvalidInvitationAttemptTx(ctx, tx, bucket, now, 5, auditID); err != nil {
			return domain.Invitation{}, err
		}
		if err := tx.Commit(); err != nil {
			return domain.Invitation{}, fmt.Errorf("store: commit unknown code failure: %w", err)
		}
		return domain.Invitation{}, ErrInvalidInvite
	}
	if err != nil {
		return domain.Invitation{}, fmt.Errorf("store: inspect code: %w", err)
	}
	if invitation.UsedAt != nil || invitation.RevokedAt != nil ||
		now.Before(invitation.NotBefore) || !now.Before(invitation.ExpiresAt) {
		return domain.Invitation{}, rejectKnownCode(ctx, tx, bucket)
	}
	if invitation.Kind == "registration" {
		if err := tx.Commit(); err != nil {
			return domain.Invitation{}, fmt.Errorf("store: validate registration code: %w", err)
		}
		return invitation, nil
	}
	if invitation.Kind != "login" || invitation.TargetUserID == "" {
		return domain.Invitation{}, rejectKnownCode(ctx, tx, bucket)
	}
	var status domain.UserStatus
	if err := tx.QueryRowContext(ctx, `SELECT status FROM users WHERE id = ?`, invitation.TargetUserID).Scan(&status); err != nil || status != domain.UserActive {
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return domain.Invitation{}, fmt.Errorf("store: inspect login target: %w", err)
		}
		return domain.Invitation{}, rejectKnownCode(ctx, tx, bucket)
	}
	invitation, err = scanInvitation(tx.QueryRowContext(ctx, `
		UPDATE invitations SET used_at = ?, used_by = ?
		WHERE id = ? AND code_hash = ? AND kind = 'login'
			AND used_at IS NULL AND revoked_at IS NULL
			AND not_before <= ? AND expires_at > ?
		RETURNING id, created_by, created_at, expires_at, used_at, used_by, revoked_at,
			revocation_reason, kind, target_user_id, not_before`,
		encodeTime(now), invitation.TargetUserID, invitation.ID, digest[:], encodeTime(now), encodeTime(now)))
	if errors.Is(err, ErrNotFound) {
		return domain.Invitation{}, ErrInvalidInvite
	}
	if err != nil {
		return domain.Invitation{}, fmt.Errorf("store: consume login code: %w", err)
	}
	hash := id.HashSecret(clearToken)
	result, err := tx.ExecContext(ctx, `
		INSERT INTO browser_sessions(id,user_id,token_hash,created_at,expires_at,last_seen,user_agent,ip_address)
		SELECT ?,u.id,?,?,?,?,?,? FROM users u WHERE u.id=? AND u.status='active'`,
		session.ID, hash[:], encodeTime(session.CreatedAt), encodeTime(session.ExpiresAt),
		encodeTime(session.LastSeen), session.UserAgent, session.IPAddress, invitation.TargetUserID)
	if err != nil {
		return domain.Invitation{}, fmt.Errorf("store: create code browser session: %w", mapSQLError(err))
	}
	if err := requireSingleAffected(result, "create code browser session"); err != nil {
		return domain.Invitation{}, err
	}
	grantHash := id.HashSecret(recoveryGrantToken)
	if _, err := tx.ExecContext(ctx, `INSERT INTO action_grants(
		id,token_hash,user_id,browser_session_id,action,created_at,expires_at
	) VALUES (?,?,?,?,'passkey_management',?,?)`,
		recoveryGrantID, grantHash[:], invitation.TargetUserID, session.ID,
		encodeTime(now), encodeTime(recoveryExpiresAt)); err != nil {
		return domain.Invitation{}, fmt.Errorf("store: create recovery add-passkey grant: %w", mapSQLError(err))
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM browser_sessions WHERE id IN (
		SELECT id FROM browser_sessions WHERE user_id=? ORDER BY last_seen DESC,created_at DESC,id DESC LIMIT -1 OFFSET ?)`,
		invitation.TargetUserID, maxBrowserSessionsPerUser); err != nil {
		return domain.Invitation{}, fmt.Errorf("store: enforce code session quota: %w", err)
	}
	metadata, _ := json.Marshal(map[string]string{"kind": "login"})
	if _, err := tx.ExecContext(ctx, `INSERT INTO audit_events(id,actor_user_id,action,target_type,target_id,metadata_json,created_at)
		VALUES (?, ?, 'code.redeem', 'invitation', ?, ?, ?)`,
		auditID, invitation.TargetUserID, invitation.ID, metadata, encodeTime(now)); err != nil {
		return domain.Invitation{}, fmt.Errorf("store: audit code login: %w", mapSQLError(err))
	}
	if err := tx.Commit(); err != nil {
		return domain.Invitation{}, fmt.Errorf("store: commit code login: %w", err)
	}
	return invitation, nil
}

func rejectKnownCode(ctx context.Context, tx *sql.Tx, bucket uint16) error {
	if err := padInvitationFailureTx(ctx, tx, bucket); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: commit inactive code rejection: %w", err)
	}
	return ErrInvalidInvite
}

func revokeOutstandingLoginCodesTx(ctx context.Context, tx *sql.Tx, userID string, now time.Time) error {
	_, err := tx.ExecContext(ctx, `UPDATE invitations SET revoked_at = ?, revocation_reason = 'administrator'
		WHERE kind = 'login' AND target_user_id = ? AND used_at IS NULL AND revoked_at IS NULL`,
		encodeTime(now), userID)
	if err != nil {
		return fmt.Errorf("store: revoke stale login codes after user change: %w", mapSQLError(err))
	}
	return nil
}
