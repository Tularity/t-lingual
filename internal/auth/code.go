package auth

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/id"
	"github.com/Tularity/t-lingual/internal/store"
)

const registrationTicketPurpose = "one-time-registration-ticket/v1"

type CodeResult struct {
	Kind                  string
	RegistrationTicket    string
	ExpiresAt             time.Time
	Login                 *LoginResult
	RecoveryAuthorization *AuthorizationResult
}

type registrationTicket struct {
	InvitationID string    `json:"invitationId"`
	Digest       []byte    `json:"digest"`
	Bucket       uint16    `json:"bucket"`
	ExpiresAt    time.Time `json:"expiresAt"`
}

// RedeemCode is one entry point for both types of six-digit code. A login
// commits the code consumption and browser session together. A registration
// code produces a sealed short-lived ticket and remains unconsumed until a
// verified passkey registration commits atomically with its first credential.
func (s *Service) RedeemCode(ctx context.Context, code string, metadata SessionMetadata) (CodeResult, error) {
	code = strings.TrimSpace(code)
	if !invitePattern.MatchString(code) {
		return CodeResult{}, ErrInvalidInvitation
	}
	now := s.now().UTC()
	sessionID, err := id.New("ses")
	if err != nil {
		return CodeResult{}, err
	}
	token, err := id.Secret(32)
	if err != nil {
		return CodeResult{}, err
	}
	auditID, err := id.New("aud")
	if err != nil {
		return CodeResult{}, err
	}
	grantID, err := id.New("agr")
	if err != nil {
		return CodeResult{}, err
	}
	grantToken, err := NewScopedAuthorizationToken(AuthorizationScopeRecoveryPasskeyAdd)
	if err != nil {
		return CodeResult{}, err
	}
	grantExpiresAt := now.Add(2 * time.Minute)
	session := domain.BrowserSession{ID: sessionID, CreatedAt: now, ExpiresAt: now.Add(s.sessionTTL), LastSeen: now,
		UserAgent: truncate(strings.TrimSpace(metadata.UserAgent), 512), IPAddress: truncate(strings.TrimSpace(metadata.IPAddress), 64)}
	digest := s.keyring.InvitationDigest(code)
	bucket := s.keyring.InvitationBucket(code)
	invitation, err := s.store.RedeemOneTimeCode(ctx, digest, bucket, now, session, token, auditID,
		grantID, grantToken, grantExpiresAt)
	if errors.Is(err, store.ErrInvalidInvite) {
		return CodeResult{}, ErrInvalidInvitation
	}
	if err != nil {
		return CodeResult{}, err
	}
	if invitation.Kind == "registration" {
		expires := now.Add(5 * time.Minute)
		if invitation.ExpiresAt.Before(expires) {
			expires = invitation.ExpiresAt
		}
		data, err := json.Marshal(registrationTicket{InvitationID: invitation.ID, Digest: digest[:], Bucket: bucket, ExpiresAt: expires})
		if err != nil {
			return CodeResult{}, err
		}
		sealed, err := s.keyring.Seal(registrationTicketPurpose, data)
		if err != nil {
			return CodeResult{}, err
		}
		return CodeResult{Kind: "registration", RegistrationTicket: string(sealed), ExpiresAt: expires}, nil
	}
	user, err := s.store.GetUserByID(ctx, invitation.TargetUserID)
	if err != nil || user.Status != domain.UserActive {
		return CodeResult{}, ErrAccountDisabled
	}
	session.UserID = user.ID
	login := LoginResult{User: user, Session: session, SessionToken: token}
	return CodeResult{Kind: "login", ExpiresAt: session.ExpiresAt, Login: &login,
		RecoveryAuthorization: &AuthorizationResult{Token: grantToken, ExpiresAt: grantExpiresAt}}, nil
}

func (s *Service) openRegistrationTicket(ctx context.Context, sealed string, now time.Time) ([sha256.Size]byte, uint16, error) {
	var digest [sha256.Size]byte
	if len(sealed) < 40 || len(sealed) > 2048 {
		return digest, 0, ErrInvalidInvitation
	}
	plain, err := s.keyring.Open(registrationTicketPurpose, []byte(sealed))
	if err != nil {
		return digest, 0, ErrInvalidInvitation
	}
	var ticket registrationTicket
	if json.Unmarshal(plain, &ticket) != nil || len(ticket.Digest) != sha256.Size ||
		ticket.Bucket >= 4096 || ticket.InvitationID == "" || !now.Before(ticket.ExpiresAt) {
		return digest, 0, ErrInvalidInvitation
	}
	copy(digest[:], ticket.Digest)
	invitation, err := s.store.ValidateInvitation(ctx, digest, now)
	if err != nil || invitation.ID != ticket.InvitationID {
		return digest, 0, ErrInvalidInvitation
	}
	return digest, ticket.Bucket, nil
}
