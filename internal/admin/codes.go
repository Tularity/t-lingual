package admin

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/secret"
	"github.com/Tularity/t-lingual/internal/store"
)

var ErrInvalidCode = errors.New("admin: invalid code configuration")

type CodeCreateInput struct {
	Kind         string
	TargetUserID string
	NotBefore    *time.Time
	ExpiresAt    *time.Time
	TTL          time.Duration
}

func (s *Service) CreateCode(ctx context.Context, web WebAuthority, input CodeCreateInput) (InvitationResult, error) {
	authority, err := mutationAuthorityForWeb(web)
	if err != nil {
		return InvitationResult{}, err
	}
	return s.createCode(ctx, authority, input)
}

func (s *Service) CreateCodeAsTrustedControl(ctx context.Context, input CodeCreateInput) (InvitationResult, error) {
	return s.createCode(ctx, trustedControlAuthority(), input)
}

func (s *Service) createCode(ctx context.Context, authority mutationAuthority, input CodeCreateInput) (InvitationResult, error) {
	now := s.operationNow(authority)
	start := now
	if input.NotBefore != nil {
		start = input.NotBefore.UTC()
	}
	if start.Before(now) {
		start = now // a chosen activation time that elapsed during step-up is active immediately
	}
	if start.After(now.Add(30*24*time.Hour)) || (input.ExpiresAt != nil && input.TTL != 0) {
		return InvitationResult{}, fmt.Errorf("%w: schedule", ErrInvalidCode)
	}
	maxTTL, ttl := 30*24*time.Hour, input.TTL
	switch input.Kind {
	case "registration":
		if input.TargetUserID != "" {
			return InvitationResult{}, fmt.Errorf("%w: registration target", ErrInvalidCode)
		}
		if ttl == 0 {
			ttl = s.defaultTTL
		}
	case "login":
		if input.TargetUserID == "" {
			return InvitationResult{}, fmt.Errorf("%w: login target", ErrInvalidCode)
		}
		maxTTL = 15 * time.Minute
		if ttl == 0 {
			ttl = 10 * time.Minute
		}
	default:
		return InvitationResult{}, fmt.Errorf("%w: kind", ErrInvalidCode)
	}
	expires := start.Add(ttl)
	if input.ExpiresAt != nil {
		expires = input.ExpiresAt.UTC()
	}
	if expires.Sub(start) < time.Minute || expires.Sub(start) > maxTTL {
		return InvitationResult{}, fmt.Errorf("%w: lifetime", ErrInvalidCode)
	}
	for range 32 {
		code, err := secret.InvitationCode()
		if err != nil {
			return InvitationResult{}, err
		}
		codeID, err := s.newID("inv")
		if err != nil {
			return InvitationResult{}, err
		}
		invitation := domain.Invitation{ID: codeID, Kind: input.Kind, TargetUserID: input.TargetUserID,
			CreatedBy: authority.actorPointer(), CreatedAt: now, NotBefore: start, ExpiresAt: expires}
		audit, err := s.newAuditEvent(authority.actorPointer(), "invitation.create", "invitation", codeID,
			map[string]any{"kind": input.Kind, "targetUserId": input.TargetUserID, "notBefore": start, "expiresAt": expires}, now)
		if err != nil {
			return InvitationResult{}, err
		}
		digest := s.keyring.InvitationDigest(code)
		bucket := s.keyring.InvitationBucket(code)
		if authority.trustedControl {
			err = s.store.CreateInvitationAsTrustedControl(ctx, invitation, digest[:], bucket, audit)
		} else {
			err = s.store.CreateInvitationAsAdmin(ctx, authority.actorUserID, authority.browserSessionID,
				authority.checkedAt, invitation, digest[:], bucket, audit)
		}
		if err == nil {
			return InvitationResult{Invitation: invitation, Code: code}, nil
		}
		if !errors.Is(err, store.ErrConflict) {
			return InvitationResult{}, mapAuthorizationError(err)
		}
	}
	return InvitationResult{}, errors.New("admin: six-digit code space is temporarily exhausted")
}
