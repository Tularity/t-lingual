package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
)

// ErrActiveAdminRequired is returned when the durable user and browser-session
// records no longer grant web administrative authority. Callers must not use
// identity objects cached by authentication middleware to make this decision.
var ErrActiveAdminRequired = errors.New("store: active administrator required")

// AdminUserUpdate is the all-or-nothing set of administrative user changes.
// Nil fields are left unchanged.
type AdminUserUpdate struct {
	Role   *domain.Role
	Status *domain.UserStatus
}

// AdminUserUpdateResult includes the committed user and security-relevant
// transition information derived inside the same transaction.
type AdminUserUpdateResult struct {
	domain.User
	PromotedToAdmin bool
}

// adminMutationAuthority deliberately distinguishes a web actor, which must
// be re-authorized inside every transaction, from the trusted local control
// socket. The trusted form is only reachable through explicitly named methods.
type adminMutationAuthority struct {
	actorUserID      string
	browserSessionID string
	checkedAt        time.Time
	trustedControl   bool
}

func webAdminMutationAuthority(
	actorUserID string,
	browserSessionID string,
	checkedAt time.Time,
) (adminMutationAuthority, error) {
	if actorUserID == "" || browserSessionID == "" || checkedAt.IsZero() {
		return adminMutationAuthority{}, ErrActiveAdminRequired
	}
	return adminMutationAuthority{
		actorUserID:      actorUserID,
		browserSessionID: browserSessionID,
		checkedAt:        checkedAt.UTC(),
	}, nil
}

func trustedControlMutationAuthority() adminMutationAuthority {
	return adminMutationAuthority{trustedControl: true}
}

func (s *Store) CreateInvitationAsAdmin(
	ctx context.Context,
	actorUserID string,
	browserSessionID string,
	checkedAt time.Time,
	invitation domain.Invitation,
	codeDigest []byte,
	bucket uint16,
	audit AuditEvent,
) error {
	authority, err := webAdminMutationAuthority(actorUserID, browserSessionID, checkedAt)
	if err != nil {
		return err
	}
	return s.createInvitationWithAudit(ctx, authority, invitation, codeDigest, bucket, audit)
}

func (s *Store) CreateInvitationAsTrustedControl(
	ctx context.Context,
	invitation domain.Invitation,
	codeDigest []byte,
	bucket uint16,
	audit AuditEvent,
) error {
	return s.createInvitationWithAudit(
		ctx, trustedControlMutationAuthority(), invitation, codeDigest, bucket, audit,
	)
}

func (s *Store) createInvitationWithAudit(
	ctx context.Context,
	authority adminMutationAuthority,
	invitation domain.Invitation,
	codeDigest []byte,
	bucket uint16,
	audit AuditEvent,
) error {
	if bucket >= 4096 {
		return errors.New("store: invitation bucket must be between 0 and 4095")
	}
	bucketValue := int64(bucket)
	if err := validateInvitationForCreate(invitation, codeDigest, &bucketValue); err != nil {
		return err
	}
	if err := validateInvitationCreator(authority, invitation.CreatedBy); err != nil {
		return err
	}
	audit, err := validateAdminAudit(
		authority, audit, "invitation.create", "invitation", invitation.ID,
	)
	if err != nil {
		return err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: begin administrative invitation creation: %w", err)
	}
	defer tx.Rollback()
	if err := requireAdminMutationAuthority(ctx, tx, authority); err != nil {
		return err
	}
	if err := createInvitationTx(ctx, tx, invitation, codeDigest, &bucketValue); err != nil {
		return err
	}
	if err := appendAuditEventTx(ctx, tx, audit); err != nil {
		return err
	}
	return commitAdminMutation(ctx, tx, "invitation creation")
}

func (s *Store) RevokeInvitationAsAdmin(
	ctx context.Context,
	actorUserID string,
	browserSessionID string,
	checkedAt time.Time,
	invitationID string,
	now time.Time,
	audit AuditEvent,
) error {
	authority, err := webAdminMutationAuthority(actorUserID, browserSessionID, checkedAt)
	if err != nil {
		return err
	}
	return s.revokeInvitationWithAudit(ctx, authority, invitationID, now, audit)
}

func (s *Store) RevokeInvitationAsTrustedControl(
	ctx context.Context,
	invitationID string,
	now time.Time,
	audit AuditEvent,
) error {
	return s.revokeInvitationWithAudit(
		ctx, trustedControlMutationAuthority(), invitationID, now, audit,
	)
}

func (s *Store) revokeInvitationWithAudit(
	ctx context.Context,
	authority adminMutationAuthority,
	invitationID string,
	now time.Time,
	audit AuditEvent,
) error {
	if err := validateInvitationRevocation(invitationID, now); err != nil {
		return err
	}
	audit, err := validateAdminAudit(
		authority, audit, "invitation.revoke", "invitation", invitationID,
	)
	if err != nil {
		return err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: begin administrative invitation revocation: %w", err)
	}
	defer tx.Rollback()
	if err := requireAdminMutationAuthority(ctx, tx, authority); err != nil {
		return err
	}
	if err := revokeInvitationTx(ctx, tx, invitationID, now); err != nil {
		return err
	}
	if err := appendAuditEventTx(ctx, tx, audit); err != nil {
		return err
	}
	return commitAdminMutation(ctx, tx, "invitation revocation")
}

func (s *Store) UpdateUserAsAdmin(
	ctx context.Context,
	actorUserID string,
	browserSessionID string,
	checkedAt time.Time,
	userID string,
	update AdminUserUpdate,
	updatedAt time.Time,
	roleAudit *AuditEvent,
	statusAudit *AuditEvent,
) (AdminUserUpdateResult, error) {
	authority, err := webAdminMutationAuthority(actorUserID, browserSessionID, checkedAt)
	if err != nil {
		return AdminUserUpdateResult{}, err
	}
	return s.updateUserWithAudit(
		ctx, authority, userID, update, updatedAt, roleAudit, statusAudit,
	)
}

func (s *Store) UpdateUserAsTrustedControl(
	ctx context.Context,
	userID string,
	update AdminUserUpdate,
	updatedAt time.Time,
	roleAudit *AuditEvent,
	statusAudit *AuditEvent,
) (AdminUserUpdateResult, error) {
	return s.updateUserWithAudit(
		ctx, trustedControlMutationAuthority(), userID, update, updatedAt, roleAudit, statusAudit,
	)
}

type normalizedAdminUserUpdate struct {
	setRole   bool
	role      domain.Role
	setStatus bool
	status    domain.UserStatus
}

func normalizeAdminUserUpdate(userID string, update AdminUserUpdate, updatedAt time.Time) (normalizedAdminUserUpdate, error) {
	if userID == "" {
		return normalizedAdminUserUpdate{}, errors.New("store: user id is required")
	}
	if updatedAt.IsZero() {
		return normalizedAdminUserUpdate{}, errors.New("store: user update time is required")
	}
	normalized := normalizedAdminUserUpdate{}
	if update.Role != nil {
		if !update.Role.Valid() {
			return normalizedAdminUserUpdate{}, fmt.Errorf("store: invalid user role %q", *update.Role)
		}
		normalized.setRole = true
		normalized.role = *update.Role
	}
	if update.Status != nil {
		if *update.Status != domain.UserActive && *update.Status != domain.UserDisabled {
			return normalizedAdminUserUpdate{}, fmt.Errorf("store: invalid user status %q", *update.Status)
		}
		normalized.setStatus = true
		normalized.status = *update.Status
	}
	if !normalized.setRole && !normalized.setStatus {
		return normalizedAdminUserUpdate{}, errors.New("store: user update is empty")
	}
	return normalized, nil
}

func (s *Store) updateUserWithAudit(
	ctx context.Context,
	authority adminMutationAuthority,
	userID string,
	update AdminUserUpdate,
	updatedAt time.Time,
	roleAudit *AuditEvent,
	statusAudit *AuditEvent,
) (AdminUserUpdateResult, error) {
	normalized, err := normalizeAdminUserUpdate(userID, update, updatedAt)
	if err != nil {
		return AdminUserUpdateResult{}, err
	}
	validatedRoleAudit, err := validateOptionalAdminAudit(
		authority, normalized.setRole, roleAudit, "user.role.set", userID,
	)
	if err != nil {
		return AdminUserUpdateResult{}, err
	}
	validatedStatusAudit, err := validateOptionalAdminAudit(
		authority, normalized.setStatus, statusAudit, "user.status.set", userID,
	)
	if err != nil {
		return AdminUserUpdateResult{}, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return AdminUserUpdateResult{}, fmt.Errorf("store: begin administrative user update: %w", err)
	}
	defer tx.Rollback()
	if err := requireAdminMutationAuthority(ctx, tx, authority); err != nil {
		return AdminUserUpdateResult{}, err
	}

	currentRole, currentStatus, err := userRoleAndStatus(ctx, tx, userID)
	if err != nil {
		return AdminUserUpdateResult{}, err
	}
	finalRole, finalStatus := currentRole, currentStatus
	if normalized.setRole {
		finalRole = normalized.role
	}
	if normalized.setStatus {
		finalStatus = normalized.status
	}
	if currentRole == domain.RoleAdmin && currentStatus == domain.UserActive &&
		(finalRole != domain.RoleAdmin || finalStatus != domain.UserActive) {
		if err := requireAnotherActiveAdmin(ctx, tx, userID); err != nil {
			return AdminUserUpdateResult{}, err
		}
	}
	promotedToAdmin := currentRole == domain.RoleUser && finalRole == domain.RoleAdmin

	result, err := tx.ExecContext(ctx, `
		UPDATE users SET role = ?, status = ?, updated_at = ? WHERE id = ?`,
		finalRole, finalStatus, encodeTime(updatedAt), userID,
	)
	if err := requireAffected(result, err, "update user role and status"); err != nil {
		return AdminUserUpdateResult{}, err
	}
	if currentRole != finalRole || currentStatus != finalStatus {
		// Code issuance predates this privilege/status generation. Revoke in
		// the same transaction so a racing redemption either wins under the
		// old role (then session cleanup below applies) or sees the revocation.
		if err := revokeOutstandingLoginCodesTx(ctx, tx, userID, updatedAt); err != nil {
			return AdminUserUpdateResult{}, err
		}
	}
	if finalStatus == domain.UserDisabled || promotedToAdmin {
		if _, err := tx.ExecContext(ctx, "DELETE FROM browser_sessions WHERE user_id = ?", userID); err != nil {
			return AdminUserUpdateResult{}, fmt.Errorf("store: delete user browser sessions after privilege change: %w", mapSQLError(err))
		}
	}
	if validatedRoleAudit != nil {
		if err := appendAuditEventTx(ctx, tx, *validatedRoleAudit); err != nil {
			return AdminUserUpdateResult{}, err
		}
	}
	if validatedStatusAudit != nil {
		if err := appendAuditEventTx(ctx, tx, *validatedStatusAudit); err != nil {
			return AdminUserUpdateResult{}, err
		}
	}

	updated, err := scanUser(tx.QueryRowContext(ctx, `
		SELECT id, webauthn_id, username, display_name, role, status, created_at, updated_at
		FROM users WHERE id = ?`, userID))
	if err != nil {
		return AdminUserUpdateResult{}, fmt.Errorf("store: read updated user: %w", err)
	}
	if err := commitAdminMutation(ctx, tx, "user update"); err != nil {
		return AdminUserUpdateResult{}, err
	}
	return AdminUserUpdateResult{User: updated, PromotedToAdmin: promotedToAdmin}, nil
}

func validateOptionalAdminAudit(
	authority adminMutationAuthority,
	required bool,
	event *AuditEvent,
	action string,
	targetID string,
) (*AuditEvent, error) {
	if !required {
		if event != nil {
			return nil, fmt.Errorf("store: %s audit supplied without its user update", action)
		}
		return nil, nil
	}
	if event == nil {
		return nil, fmt.Errorf("store: %s audit is required", action)
	}
	validated, err := validateAdminAudit(authority, *event, action, "user", targetID)
	if err != nil {
		return nil, err
	}
	return &validated, nil
}

func validateInvitationCreator(authority adminMutationAuthority, createdBy *string) error {
	if authority.trustedControl {
		if createdBy != nil {
			return errors.New("store: trusted-control invitation creator must be empty")
		}
		return nil
	}
	if createdBy == nil || *createdBy != authority.actorUserID {
		return errors.New("store: invitation creator does not match administrator")
	}
	return nil
}

func validateAdminAudit(
	authority adminMutationAuthority,
	event AuditEvent,
	action string,
	targetType string,
	targetID string,
) (AuditEvent, error) {
	event, err := validateAuditEvent(event)
	if err != nil {
		return AuditEvent{}, err
	}
	if event.Action != action || event.TargetType != targetType || event.TargetID != targetID {
		return AuditEvent{}, errors.New("store: administrative audit does not match its mutation")
	}
	if authority.trustedControl {
		if event.ActorUserID != nil {
			return AuditEvent{}, errors.New("store: trusted-control audit actor must be empty")
		}
	} else if event.ActorUserID == nil || *event.ActorUserID != authority.actorUserID {
		return AuditEvent{}, errors.New("store: administrative audit actor does not match administrator")
	}
	if event.ActorUserID != nil {
		actorID := *event.ActorUserID
		event.ActorUserID = &actorID
	}
	event.Metadata = append(json.RawMessage(nil), event.Metadata...)
	return event, nil
}

func requireAdminMutationAuthority(
	ctx context.Context,
	tx *sql.Tx,
	authority adminMutationAuthority,
) error {
	if authority.trustedControl {
		return nil
	}
	var exists int
	err := tx.QueryRowContext(ctx, `
		SELECT 1
		FROM users u
		JOIN browser_sessions bs ON bs.user_id = u.id
		WHERE u.id = ?
			AND u.role = 'admin'
			AND u.status = 'active'
			AND bs.id = ?
			AND bs.expires_at > ?`,
		authority.actorUserID,
		authority.browserSessionID,
		encodeTime(authority.checkedAt),
	).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrActiveAdminRequired
	}
	if err != nil {
		return fmt.Errorf("store: re-authorize administrator: %w", err)
	}
	return nil
}

func commitAdminMutation(ctx context.Context, tx *sql.Tx, operation string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: commit administrative %s: %w", operation, err)
	}
	return nil
}
