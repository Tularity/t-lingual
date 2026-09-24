// Package admin implements the shared administrative policy used by both the
// authenticated web API and the container-local CLI.
package admin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/id"
	"github.com/Tularity/t-lingual/internal/secret"
	"github.com/Tularity/t-lingual/internal/store"
)

var ErrAdminRequired = errors.New("admin: active administrator required")

type Service struct {
	store      *store.Store
	keyring    *secret.Keyring
	defaultTTL time.Duration
	now        func() time.Time
	newID      func(string) (string, error)
}

func New(database *store.Store, keyring *secret.Keyring, defaultTTL time.Duration) (*Service, error) {
	if database == nil || keyring == nil || defaultTTL <= 0 {
		return nil, errors.New("admin store, keyring, and positive invitation TTL are required")
	}
	return &Service{
		store:      database,
		keyring:    keyring,
		defaultTTL: defaultTTL,
		now:        time.Now,
		newID:      id.New,
	}, nil
}

type InvitationResult struct {
	Invitation domain.Invitation `json:"invitation"`
	Code       string            `json:"code"`
}

// UserUpdate is applied as one transaction. Nil fields remain unchanged.
type UserUpdate struct {
	Role   *domain.Role       `json:"role,omitempty"`
	Status *domain.UserStatus `json:"status,omitempty"`
}

// UserUpdateResult exposes the committed user while keeping the privilege
// transition available to in-process consumers such as live-session cleanup.
type UserUpdateResult struct {
	domain.User
	PromotedToAdmin bool `json:"-"`
}

// WebAuthority is captured by the authenticated HTTP handler immediately
// before invoking a mutation. The store rechecks this exact browser session,
// its expiry, and the user's current active-admin role in the mutation's
// transaction.
type WebAuthority struct {
	UserID           string
	BrowserSessionID string
	CheckedAt        time.Time
}

// mutationAuthority separates an authenticated web actor from the local
// trusted-control socket. Durable user and session state are deliberately
// re-read from SQLite inside the mutation transaction.
type mutationAuthority struct {
	actorUserID      string
	browserSessionID string
	checkedAt        time.Time
	trustedControl   bool
}

func mutationAuthorityForWeb(authority WebAuthority) (mutationAuthority, error) {
	if authority.UserID == "" || authority.BrowserSessionID == "" || authority.CheckedAt.IsZero() {
		return mutationAuthority{}, ErrAdminRequired
	}
	return mutationAuthority{
		actorUserID:      authority.UserID,
		browserSessionID: authority.BrowserSessionID,
		checkedAt:        authority.CheckedAt.UTC(),
	}, nil
}

func trustedControlAuthority() mutationAuthority {
	return mutationAuthority{trustedControl: true}
}

func (a mutationAuthority) actorPointer() *string {
	if a.trustedControl {
		return nil
	}
	actorID := a.actorUserID
	return &actorID
}

func (s *Service) operationNow(authority mutationAuthority) time.Time {
	if authority.trustedControl {
		return s.now().UTC()
	}
	return authority.checkedAt
}

// CreateInvitation returns the clear six-digit value exactly once. Only its
// keyed digest is retained. Local-socket callers use the explicitly separate
// CreateInvitationAsTrustedControl method.
func (s *Service) CreateInvitation(ctx context.Context, web WebAuthority, ttl time.Duration) (InvitationResult, error) {
	authority, err := mutationAuthorityForWeb(web)
	if err != nil {
		return InvitationResult{}, err
	}
	return s.createInvitation(ctx, authority, ttl)
}

func (s *Service) CreateInvitationAsTrustedControl(ctx context.Context, ttl time.Duration) (InvitationResult, error) {
	return s.createInvitation(ctx, trustedControlAuthority(), ttl)
}

func (s *Service) createInvitation(
	ctx context.Context,
	authority mutationAuthority,
	ttl time.Duration,
) (InvitationResult, error) {
	if ttl == 0 {
		ttl = s.defaultTTL
	}
	if ttl < time.Minute || ttl > 30*24*time.Hour {
		return InvitationResult{}, errors.New("admin: invitation TTL must be between one minute and 30 days")
	}
	now := s.operationNow(authority)
	for range 32 {
		code, err := secret.InvitationCode()
		if err != nil {
			return InvitationResult{}, err
		}
		invitationID, err := s.newID("inv")
		if err != nil {
			return InvitationResult{}, err
		}
		invitation := domain.Invitation{
			ID:        invitationID,
			Kind:      "registration",
			CreatedBy: authority.actorPointer(),
			CreatedAt: now,
			NotBefore: now,
			ExpiresAt: now.Add(ttl),
		}
		audit, err := s.newAuditEvent(
			authority.actorPointer(),
			"invitation.create",
			"invitation",
			invitation.ID,
			map[string]any{"expiresAt": invitation.ExpiresAt},
			now,
		)
		if err != nil {
			return InvitationResult{}, err
		}
		digest := s.keyring.InvitationDigest(code)
		bucket := s.keyring.InvitationBucket(code)
		if authority.trustedControl {
			err = s.store.CreateInvitationAsTrustedControl(
				ctx, invitation, digest[:], bucket, audit,
			)
		} else {
			err = s.store.CreateInvitationAsAdmin(
				ctx,
				authority.actorUserID,
				authority.browserSessionID,
				authority.checkedAt,
				invitation,
				digest[:],
				bucket,
				audit,
			)
		}
		if err != nil {
			if errors.Is(err, store.ErrConflict) {
				continue
			}
			return InvitationResult{}, mapAuthorizationError(err)
		}
		return InvitationResult{Invitation: invitation, Code: code}, nil
	}
	return InvitationResult{}, errors.New("admin: invitation code space is temporarily exhausted")
}

func (s *Service) ListInvitations(ctx context.Context, web WebAuthority, limit, offset int) ([]domain.Invitation, error) {
	authority, err := mutationAuthorityForWeb(web)
	if err != nil {
		return nil, err
	}
	items, err := s.store.ListInvitationsAsAdmin(
		ctx, authority.actorUserID, authority.browserSessionID, authority.checkedAt, limit, offset,
	)
	return items, mapAuthorizationError(err)
}

func (s *Service) ListInvitationsAsTrustedControl(ctx context.Context, limit, offset int) ([]domain.Invitation, error) {
	return s.store.ListInvitationsAsTrustedControl(ctx, limit, offset)
}

func (s *Service) RevokeInvitation(ctx context.Context, web WebAuthority, invitationID string) error {
	authority, err := mutationAuthorityForWeb(web)
	if err != nil {
		return err
	}
	return s.revokeInvitation(ctx, authority, invitationID)
}

func (s *Service) RevokeInvitationAsTrustedControl(ctx context.Context, invitationID string) error {
	return s.revokeInvitation(ctx, trustedControlAuthority(), invitationID)
}

func (s *Service) revokeInvitation(
	ctx context.Context,
	authority mutationAuthority,
	invitationID string,
) error {
	now := s.operationNow(authority)
	audit, err := s.newAuditEvent(
		authority.actorPointer(), "invitation.revoke", "invitation", invitationID, nil, now,
	)
	if err != nil {
		return err
	}
	if authority.trustedControl {
		err = s.store.RevokeInvitationAsTrustedControl(ctx, invitationID, now, audit)
	} else {
		err = s.store.RevokeInvitationAsAdmin(
			ctx,
			authority.actorUserID,
			authority.browserSessionID,
			authority.checkedAt,
			invitationID,
			now,
			audit,
		)
	}
	return mapAuthorizationError(err)
}

func (s *Service) ListUsers(ctx context.Context, web WebAuthority, limit, offset int) ([]domain.User, error) {
	authority, err := mutationAuthorityForWeb(web)
	if err != nil {
		return nil, err
	}
	items, err := s.store.ListUsersAsAdmin(
		ctx, authority.actorUserID, authority.browserSessionID, authority.checkedAt, limit, offset,
	)
	return items, mapAuthorizationError(err)
}

func (s *Service) ListUsersAsTrustedControl(ctx context.Context, limit, offset int) ([]domain.User, error) {
	return s.store.ListUsersAsTrustedControl(ctx, limit, offset)
}

// UpdateUser prevalidates the full requested change, then applies role,
// status, browser-session revocation, and one audit event per supplied field in
// a single transaction. The returned user is the committed durable state.
func (s *Service) UpdateUser(
	ctx context.Context,
	web WebAuthority,
	userID string,
	update UserUpdate,
) (UserUpdateResult, error) {
	authority, err := mutationAuthorityForWeb(web)
	if err != nil {
		return UserUpdateResult{}, err
	}
	return s.updateUser(ctx, authority, userID, update)
}

func (s *Service) UpdateUserAsTrustedControl(
	ctx context.Context,
	userID string,
	update UserUpdate,
) (UserUpdateResult, error) {
	return s.updateUser(ctx, trustedControlAuthority(), userID, update)
}

func (s *Service) updateUser(
	ctx context.Context,
	authority mutationAuthority,
	userID string,
	update UserUpdate,
) (UserUpdateResult, error) {
	if userID == "" {
		return UserUpdateResult{}, errors.New("admin: user id is required")
	}
	if update.Role == nil && update.Status == nil {
		return UserUpdateResult{}, errors.New("admin: user update is empty")
	}
	if update.Role != nil && !update.Role.Valid() {
		return UserUpdateResult{}, errors.New("admin: invalid role")
	}
	if update.Status != nil && *update.Status != domain.UserActive && *update.Status != domain.UserDisabled {
		return UserUpdateResult{}, errors.New("admin: invalid user status")
	}

	now := s.operationNow(authority)
	actorID := authority.actorPointer()
	var roleAudit, statusAudit *store.AuditEvent
	if update.Role != nil {
		event, err := s.newAuditEvent(
			actorID, "user.role.set", "user", userID, map[string]any{"role": *update.Role}, now,
		)
		if err != nil {
			return UserUpdateResult{}, err
		}
		roleAudit = &event
	}
	if update.Status != nil {
		event, err := s.newAuditEvent(
			actorID, "user.status.set", "user", userID, map[string]any{"status": *update.Status}, now,
		)
		if err != nil {
			return UserUpdateResult{}, err
		}
		statusAudit = &event
	}
	storeUpdate := store.AdminUserUpdate{Role: update.Role, Status: update.Status}
	var updated store.AdminUserUpdateResult
	var err error
	if authority.trustedControl {
		updated, err = s.store.UpdateUserAsTrustedControl(
			ctx, userID, storeUpdate, now, roleAudit, statusAudit,
		)
	} else {
		updated, err = s.store.UpdateUserAsAdmin(
			ctx,
			authority.actorUserID,
			authority.browserSessionID,
			authority.checkedAt,
			userID,
			storeUpdate,
			now,
			roleAudit,
			statusAudit,
		)
	}
	if err != nil {
		return UserUpdateResult{}, mapAuthorizationError(err)
	}
	return UserUpdateResult{
		User:            updated.User,
		PromotedToAdmin: updated.PromotedToAdmin,
	}, nil
}

// SetUserRole and SetUserStatus are web compatibility wrappers. The local
// socket uses the separately named trusted-control update method.
func (s *Service) SetUserRole(ctx context.Context, web WebAuthority, userID string, role domain.Role) error {
	_, err := s.UpdateUser(ctx, web, userID, UserUpdate{Role: &role})
	return err
}

func (s *Service) SetUserStatus(ctx context.Context, web WebAuthority, userID string, status domain.UserStatus) error {
	_, err := s.UpdateUser(ctx, web, userID, UserUpdate{Status: &status})
	return err
}

func (s *Service) ListAuditEvents(ctx context.Context, web WebAuthority, limit, offset int) ([]store.AuditEvent, error) {
	authority, err := mutationAuthorityForWeb(web)
	if err != nil {
		return nil, err
	}
	events, err := s.store.ListAuditEventsAsAdmin(
		ctx, authority.actorUserID, authority.browserSessionID, authority.checkedAt, limit, offset,
	)
	return events, mapAuthorizationError(err)
}

func (s *Service) ListAuditEventsAsTrustedControl(ctx context.Context, limit, offset int) ([]store.AuditEvent, error) {
	return s.store.ListAuditEventsAsTrustedControl(ctx, limit, offset)
}

func mapAuthorizationError(err error) error {
	if errors.Is(err, store.ErrActiveAdminRequired) {
		return ErrAdminRequired
	}
	return err
}

func (s *Service) newAuditEvent(
	actorID *string,
	action string,
	targetType string,
	targetID string,
	metadata any,
	createdAt time.Time,
) (store.AuditEvent, error) {
	eventID, err := s.newID("aud")
	if err != nil {
		return store.AuditEvent{}, err
	}
	encoded := json.RawMessage("{}")
	if metadata != nil {
		encoded, err = json.Marshal(metadata)
		if err != nil {
			return store.AuditEvent{}, fmt.Errorf("encode audit metadata: %w", err)
		}
	}
	return store.AuditEvent{
		ID:          eventID,
		ActorUserID: actorID,
		Action:      action,
		TargetType:  targetType,
		TargetID:    targetID,
		Metadata:    encoded,
		CreatedAt:   createdAt,
	}, nil
}
