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
)

// CreateInvitation stores an opaque keyed digest supplied by the service
// layer. The service must derive codeDigest with HMAC-SHA256 (or an equivalent
// keyed construction); this package deliberately never receives the six-
// character invitation code.
func (s *Store) CreateInvitation(
	ctx context.Context,
	invitation domain.Invitation,
	codeDigest []byte,
) error {
	return s.createInvitation(ctx, invitation, codeDigest, nil)
}

// CreateInvitationWithBucket additionally assigns the invitation to a coarse,
// keyed failure bucket. At most one unexpired invitation may be active in a
// bucket. The service deliberately keeps the bucket space small so invalid
// guesses can consume a durable attempt budget without storing the clear code.
func (s *Store) CreateInvitationWithBucket(
	ctx context.Context,
	invitation domain.Invitation,
	codeDigest []byte,
	bucket uint16,
) error {
	if bucket >= 4096 {
		return errors.New("store: invitation bucket must be between 0 and 4095")
	}
	value := int64(bucket)
	return s.createInvitation(ctx, invitation, codeDigest, &value)
}

func (s *Store) createInvitation(
	ctx context.Context,
	invitation domain.Invitation,
	codeDigest []byte,
	bucket *int64,
) error {
	if err := validateInvitationForCreate(invitation, codeDigest, bucket); err != nil {
		return err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: begin invitation creation: %w", err)
	}
	defer tx.Rollback()

	if err := createInvitationTx(ctx, tx, invitation, codeDigest, bucket); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: commit invitation creation: %w", err)
	}
	return nil
}

func validateInvitationForCreate(
	invitation domain.Invitation,
	codeDigest []byte,
	bucket *int64,
) error {
	if err := validateInvitationDigest(codeDigest); err != nil {
		return err
	}
	if invitation.ID == "" || invitation.CreatedAt.IsZero() || invitation.ExpiresAt.IsZero() {
		return errors.New("store: invitation id and timestamps are required")
	}
	if !invitation.ExpiresAt.After(invitation.CreatedAt) {
		return errors.New("store: invitation expiry must follow creation")
	}
	if bucket != nil && (*bucket < 0 || *bucket >= 4096) {
		return errors.New("store: invitation bucket must be between 0 and 4095")
	}
	return nil
}

func createInvitationTx(
	ctx context.Context,
	tx *sql.Tx,
	invitation domain.Invitation,
	codeDigest []byte,
	bucket *int64,
) error {
	if bucket != nil {
		// A partial UNIQUE index cannot use the wall clock in its predicate.
		// Retire an expired occupant inside this same write transaction before
		// checking and inserting, so expired codes never consume a bucket forever.
		if _, err := tx.ExecContext(ctx, `
			UPDATE invitations SET revoked_at = expires_at
			WHERE failure_bucket = ?
				AND used_at IS NULL AND revoked_at IS NULL
				AND expires_at <= ?`, *bucket, encodeTime(invitation.CreatedAt)); err != nil {
			return fmt.Errorf("store: retire expired invitation bucket occupant: %w", mapSQLError(err))
		}
		var existing int
		err := tx.QueryRowContext(ctx, `
			SELECT 1 FROM invitations
			WHERE failure_bucket = ?
				AND used_at IS NULL
				AND revoked_at IS NULL
				AND expires_at > ?
			LIMIT 1`, *bucket, encodeTime(invitation.CreatedAt)).Scan(&existing)
		if err == nil {
			return fmt.Errorf("%w: invitation failure bucket is already active", ErrConflict)
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("store: inspect invitation failure bucket: %w", err)
		}
	}

	_, err := tx.ExecContext(ctx, `
		INSERT INTO invitations(
			id, code_hash, created_by, created_at, expires_at, used_at, used_by,
			revoked_at, failure_bucket, failed_attempts, revocation_reason
		) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, 0, '')`,
		invitation.ID, codeDigest, invitation.CreatedBy,
		encodeTime(invitation.CreatedAt), encodeTime(invitation.ExpiresAt), bucket,
	)
	if err != nil {
		return fmt.Errorf("store: create invitation: %w", mapSQLError(err))
	}
	return nil
}

func validateInvitationDigest(codeDigest []byte) error {
	if len(codeDigest) != sha256.Size {
		return fmt.Errorf("%w: invitation digest must be exactly %d bytes", ErrInvalidInvite, sha256.Size)
	}
	return nil
}

func (s *Store) GetInvitationByID(ctx context.Context, invitationID string) (domain.Invitation, error) {
	return scanInvitation(s.db.QueryRowContext(ctx, `
		SELECT id, created_by, created_at, expires_at, used_at, used_by, revoked_at,
			revocation_reason
		FROM invitations WHERE id = ?`, invitationID))
}

// ValidateInvitation returns an active invitation without consuming it. The
// registration completion path must still call RegisterUserWithCredential,
// which repeats the checks and consumes it atomically to prevent TOCTOU races.
func (s *Store) ValidateInvitation(
	ctx context.Context,
	codeDigest [sha256.Size]byte,
	now time.Time,
) (domain.Invitation, error) {
	invitation, err := scanInvitation(s.db.QueryRowContext(ctx, `
		SELECT id, created_by, created_at, expires_at, used_at, used_by, revoked_at,
			revocation_reason
		FROM invitations
		WHERE code_hash = ?
			AND used_at IS NULL
			AND revoked_at IS NULL
			AND expires_at > ?`, codeDigest[:], encodeTime(now)))
	if errors.Is(err, ErrNotFound) {
		return domain.Invitation{}, ErrInvalidInvite
	}
	if err != nil {
		return domain.Invitation{}, fmt.Errorf("store: validate invitation: %w", err)
	}
	return invitation, nil
}

// ListInvitationsAsTrustedControl is an authorization-free persistence
// operation reserved for the local control plane. Web callers must use
// ListInvitationsAsAdmin so authority and the returned snapshot are coupled.
func (s *Store) ListInvitationsAsTrustedControl(ctx context.Context, limit, offset int) ([]domain.Invitation, error) {
	return listInvitations(ctx, s.db, limit, offset)
}

func listInvitations(ctx context.Context, queryer rowsQueryer, limit, offset int) ([]domain.Invitation, error) {
	limit, offset = pagination(limit, offset)
	rows, err := queryer.QueryContext(ctx, `
		SELECT id, created_by, created_at, expires_at, used_at, used_by, revoked_at,
			revocation_reason
		FROM invitations ORDER BY created_at DESC, id LIMIT ? OFFSET ?`, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("store: list invitations: %w", err)
	}
	defer rows.Close()

	invitations := make([]domain.Invitation, 0)
	for rows.Next() {
		invitation, err := scanInvitation(rows)
		if err != nil {
			return nil, fmt.Errorf("store: list invitations: %w", err)
		}
		invitations = append(invitations, invitation)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list invitations: %w", err)
	}
	return invitations, nil
}

func scanInvitation(row rowScanner) (domain.Invitation, error) {
	var invitation domain.Invitation
	var createdBy, usedBy sql.NullString
	var createdAt, expiresAt int64
	var usedAt, revokedAt sql.NullInt64
	if err := row.Scan(
		&invitation.ID, &createdBy, &createdAt, &expiresAt,
		&usedAt, &usedBy, &revokedAt, &invitation.RevocationReason,
	); err != nil {
		return domain.Invitation{}, mapSQLError(err)
	}
	invitation.CreatedBy = optionalString(createdBy)
	invitation.CreatedAt = decodeTime(createdAt)
	invitation.ExpiresAt = decodeTime(expiresAt)
	invitation.UsedAt = decodeOptionalTime(usedAt)
	invitation.UsedBy = optionalString(usedBy)
	invitation.RevokedAt = decodeOptionalTime(revokedAt)
	return invitation, nil
}

func optionalString(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	result := value.String
	return &result
}

// ConsumeInvitation atomically consumes a currently valid invitation. A used,
// revoked, expired, or unknown digest is intentionally indistinguishable.
func (s *Store) ConsumeInvitation(
	ctx context.Context,
	codeDigest []byte,
	usedBy string,
	now time.Time,
) (domain.Invitation, error) {
	if err := validateInvitationDigest(codeDigest); err != nil {
		return domain.Invitation{}, err
	}
	invitation, err := scanInvitation(s.db.QueryRowContext(ctx, `
		UPDATE invitations
		SET used_at = ?, used_by = ?
		WHERE code_hash = ?
			AND used_at IS NULL
			AND revoked_at IS NULL
			AND expires_at > ?
		RETURNING id, created_by, created_at, expires_at, used_at, used_by, revoked_at,
			revocation_reason`,
		encodeTime(now), usedBy, codeDigest, encodeTime(now),
	))
	if errors.Is(err, ErrNotFound) {
		return domain.Invitation{}, ErrInvalidInvite
	}
	if err != nil {
		return domain.Invitation{}, fmt.Errorf("store: consume invitation: %w", err)
	}
	return invitation, nil
}

func (s *Store) RevokeInvitation(ctx context.Context, invitationID string, now time.Time) error {
	if err := validateInvitationRevocation(invitationID, now); err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: begin invitation revocation: %w", err)
	}
	defer tx.Rollback()
	if err := revokeInvitationTx(ctx, tx, invitationID, now); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: commit invitation revocation: %w", err)
	}
	return nil
}

func validateInvitationRevocation(invitationID string, now time.Time) error {
	if invitationID == "" {
		return errors.New("store: invitation id is required")
	}
	if now.IsZero() {
		return errors.New("store: invitation revocation time is required")
	}
	return nil
}

func revokeInvitationTx(ctx context.Context, tx *sql.Tx, invitationID string, now time.Time) error {
	result, err := tx.ExecContext(ctx, `
		UPDATE invitations SET revoked_at = ?, revocation_reason = 'administrator'
		WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`,
		encodeTime(now), invitationID,
	)
	if err != nil {
		return fmt.Errorf("store: revoke invitation: %w", mapSQLError(err))
	}
	count, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("store: revoke invitation affected rows: %w", err)
	}
	if count > 0 {
		return nil
	}
	var exists int
	err = tx.QueryRowContext(ctx,
		"SELECT 1 FROM invitations WHERE id = ?", invitationID,
	).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("store: inspect invitation for revocation: %w", err)
	}
	return fmt.Errorf("%w: invitation is already used or revoked", ErrConflict)
}

// RecordInvalidInvitationAttempt applies a durable failure to the active
// invitation occupying bucket. Once maxFailures is reached, the invitation is
// revoked and a system audit event is inserted in the same transaction.
func (s *Store) RecordInvalidInvitationAttempt(
	ctx context.Context,
	bucket uint16,
	now time.Time,
	maxFailures int,
	auditEventID string,
) (bool, error) {
	if err := validateInvitationFailure(bucket, now, maxFailures, auditEventID); err != nil {
		return false, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("store: begin invitation failure: %w", err)
	}
	defer tx.Rollback()
	revoked, err := recordInvalidInvitationAttemptTx(ctx, tx, bucket, now, maxFailures, auditEventID)
	if err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("store: commit invitation failure: %w", err)
	}
	return revoked, nil
}

func validateInvitationFailure(bucket uint16, now time.Time, maxFailures int, auditEventID string) error {
	if bucket >= 4096 {
		return errors.New("store: invitation bucket must be between 0 and 4095")
	}
	if maxFailures <= 0 {
		return errors.New("store: invitation failure threshold must be positive")
	}
	if auditEventID == "" {
		return errors.New("store: invitation failure audit id is required")
	}
	if now.IsZero() {
		return errors.New("store: invitation failure time is required")
	}
	return nil
}

func recordInvalidInvitationAttemptTx(
	ctx context.Context,
	tx *sql.Tx,
	bucket uint16,
	now time.Time,
	maxFailures int,
	auditEventID string,
) (bool, error) {
	var invitationID string
	var failures int
	err := tx.QueryRowContext(ctx, `
		SELECT id, failed_attempts FROM invitations
		WHERE failure_bucket = ?
			AND used_at IS NULL
			AND revoked_at IS NULL
			AND expires_at > ?
		LIMIT 1`, int64(bucket), encodeTime(now)).Scan(&invitationID, &failures)
	if errors.Is(err, sql.ErrNoRows) {
		if err := padInvitationFailureTx(ctx, tx, bucket); err != nil {
			return false, err
		}
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("store: find invitation failure bucket: %w", err)
	}

	failures++
	revoked := failures >= maxFailures
	if revoked {
		result, err := tx.ExecContext(ctx, `
			UPDATE invitations
			SET failed_attempts = ?, revoked_at = ?, revocation_reason = 'failed_attempts'
			WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`,
			failures, encodeTime(now), invitationID)
		if err != nil {
			return false, fmt.Errorf("store: auto-revoke invitation: %w", mapSQLError(err))
		}
		if err := requireSingleAffected(result, "auto-revoke invitation"); err != nil {
			return false, err
		}
		metadata, _ := json.Marshal(map[string]any{
			"reason":         "failed_attempts",
			"failedAttempts": failures,
		})
		_, err = tx.ExecContext(ctx, `
			INSERT INTO audit_events(
				id, actor_user_id, action, target_type, target_id, metadata_json, created_at
			) VALUES (?, NULL, 'invitation.auto_revoke', 'invitation', ?, ?, ?)`,
			auditEventID, invitationID, metadata, encodeTime(now))
		if err != nil {
			return false, fmt.Errorf("store: audit invitation auto-revoke: %w", mapSQLError(err))
		}
	} else {
		result, err := tx.ExecContext(ctx, `
			UPDATE invitations SET failed_attempts = ?
			WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`, failures, invitationID)
		if err != nil {
			return false, fmt.Errorf("store: update invitation failures: %w", mapSQLError(err))
		}
		if err := requireSingleAffected(result, "update invitation failures"); err != nil {
			return false, err
		}
	}
	return revoked, nil
}

func padInvitationFailureTx(ctx context.Context, tx *sql.Tx, bucket uint16) error {
	result, err := tx.ExecContext(ctx, `
		UPDATE invitation_failure_padding_v2
		SET counter = CASE WHEN counter >= 2147483646 THEN 0 ELSE counter + 1 END
		WHERE bucket = ?`, int64(bucket))
	if err != nil {
		return fmt.Errorf("store: pad invitation failure write: %w", mapSQLError(err))
	}
	return requireSingleAffected(result, "pad invitation failure write")
}

func requireSingleAffected(result sql.Result, operation string) error {
	count, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("store: inspect %s result: %w", operation, err)
	}
	if count != 1 {
		return fmt.Errorf("%w: %s changed %d rows", ErrConflict, operation, count)
	}
	return nil
}

// CompleteRegistration exposes no invitation or username oracle during the
// begin ceremony. After successful WebAuthn verification it atomically either
// registers with an active exact code, rejects a known historical code without
// harming a future bucket occupant, or charges a truly unknown code to the
// active invitation in its coarse failure bucket.
func (s *Store) CompleteRegistration(
	ctx context.Context,
	codeDigest []byte,
	bucket uint16,
	now time.Time,
	user domain.User,
	credential domain.Credential,
	maxFailures int,
	auditEventID string,
) (domain.Invitation, error) {
	if err := validateRegistration(codeDigest, user, credential); err != nil {
		return domain.Invitation{}, err
	}
	if err := validateInvitationFailure(bucket, now, maxFailures, auditEventID); err != nil {
		return domain.Invitation{}, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return domain.Invitation{}, fmt.Errorf("store: begin registration completion: %w", err)
	}
	defer tx.Rollback()

	var invitationID string
	var usedAt, revokedAt sql.NullInt64
	var expiresAt int64
	err = tx.QueryRowContext(ctx, `
		SELECT id, used_at, revoked_at, expires_at
		FROM invitations WHERE code_hash = ?`, codeDigest,
	).Scan(&invitationID, &usedAt, &revokedAt, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		if _, err := recordInvalidInvitationAttemptTx(ctx, tx, bucket, now, maxFailures, auditEventID); err != nil {
			return domain.Invitation{}, err
		}
		if err := tx.Commit(); err != nil {
			return domain.Invitation{}, fmt.Errorf("store: commit unknown invitation failure: %w", err)
		}
		return domain.Invitation{}, ErrInvalidInvite
	}
	if err != nil {
		return domain.Invitation{}, fmt.Errorf("store: inspect registration invitation: %w", err)
	}
	if usedAt.Valid || revokedAt.Valid || expiresAt <= encodeTime(now) {
		if err := padInvitationFailureTx(ctx, tx, bucket); err != nil {
			return domain.Invitation{}, err
		}
		if err := tx.Commit(); err != nil {
			return domain.Invitation{}, fmt.Errorf("store: commit historical invitation rejection: %w", err)
		}
		return domain.Invitation{}, ErrInvalidInvite
	}

	invitation, err := registerUserWithCredentialTx(ctx, tx, invitationID, codeDigest, now, user, credential)
	if err != nil {
		return domain.Invitation{}, err
	}
	if err := tx.Commit(); err != nil {
		return domain.Invitation{}, fmt.Errorf("store: commit registration completion: %w", err)
	}
	return invitation, nil
}

// RegisterUserWithCredential validates and consumes an invitation, creates the
// user, and creates the first credential in one transaction. No partial state
// is visible if any step fails.
func (s *Store) RegisterUserWithCredential(
	ctx context.Context,
	codeDigest []byte,
	now time.Time,
	user domain.User,
	credential domain.Credential,
) (domain.Invitation, error) {
	if err := validateRegistration(codeDigest, user, credential); err != nil {
		return domain.Invitation{}, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return domain.Invitation{}, fmt.Errorf("store: begin registration: %w", err)
	}
	defer tx.Rollback()

	// Read first so invalid invitation attempts do not leak uniqueness details
	// from the proposed username or WebAuthn credential.
	var invitationID string
	err = tx.QueryRowContext(ctx, `
		SELECT id FROM invitations
		WHERE code_hash = ?
			AND used_at IS NULL
			AND revoked_at IS NULL
			AND expires_at > ?`, codeDigest, encodeTime(now)).Scan(&invitationID)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Invitation{}, ErrInvalidInvite
	}
	if err != nil {
		return domain.Invitation{}, fmt.Errorf("store: validate registration invitation: %w", err)
	}

	invitation, err := registerUserWithCredentialTx(ctx, tx, invitationID, codeDigest, now, user, credential)
	if err != nil {
		return domain.Invitation{}, err
	}
	if err := tx.Commit(); err != nil {
		return domain.Invitation{}, fmt.Errorf("store: commit registration: %w", err)
	}
	return invitation, nil
}

func validateRegistration(codeDigest []byte, user domain.User, credential domain.Credential) error {
	if err := validateInvitationDigest(codeDigest); err != nil {
		return err
	}
	if err := validateUser(user); err != nil {
		return err
	}
	if err := validateCredential(credential); err != nil {
		return err
	}
	if credential.UserID != user.ID {
		return errors.New("store: first credential belongs to a different user")
	}
	return nil
}

func registerUserWithCredentialTx(
	ctx context.Context,
	tx *sql.Tx,
	invitationID string,
	codeDigest []byte,
	now time.Time,
	user domain.User,
	credential domain.Credential,
) (domain.Invitation, error) {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO users(
			id, webauthn_id, username, display_name, role, status, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		user.ID, user.WebAuthnID, user.Username, user.DisplayName, user.Role, user.Status,
		encodeTime(user.CreatedAt), encodeTime(user.UpdatedAt),
	)
	if err != nil {
		return domain.Invitation{}, fmt.Errorf("store: register user: %w", mapSQLError(err))
	}

	_, err = tx.ExecContext(ctx, `
		INSERT INTO webauthn_credentials(
			id, user_id, credential_id, name, credential_json, created_at, last_used_at
		) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		credential.ID, credential.UserID, credential.CredentialID, credential.Name,
		credential.CredentialJSON, encodeTime(credential.CreatedAt),
		encodeOptionalTime(credential.LastUsedAt),
	)
	if err != nil {
		return domain.Invitation{}, fmt.Errorf("store: register credential: %w", mapSQLError(err))
	}

	invitation, err := scanInvitation(tx.QueryRowContext(ctx, `
		UPDATE invitations
		SET used_at = ?, used_by = ?
		WHERE id = ?
			AND code_hash = ?
			AND used_at IS NULL
			AND revoked_at IS NULL
			AND expires_at > ?
		RETURNING id, created_by, created_at, expires_at, used_at, used_by, revoked_at,
			revocation_reason`,
		encodeTime(now), user.ID, invitationID, codeDigest, encodeTime(now),
	))
	if errors.Is(err, ErrNotFound) {
		return domain.Invitation{}, ErrInvalidInvite
	}
	if err != nil {
		return domain.Invitation{}, fmt.Errorf("store: consume registration invitation: %w", err)
	}

	return invitation, nil
}
