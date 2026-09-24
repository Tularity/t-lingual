// Package sharing resolves access to owner-managed interpretation sessions.
// Link secrets and guest cookies are generated here; callers never select raw
// database IDs in place of an authenticated viewer.
package sharing

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/id"
	"github.com/Tularity/t-lingual/internal/language"
	"github.com/Tularity/t-lingual/internal/secret"
	"github.com/Tularity/t-lingual/internal/store"
)

var ErrInvalidInput = errors.New("sharing: invalid input")

const guestSessionTTL = 30 * 24 * time.Hour

type Service struct {
	store   *store.Store
	keyring *secret.Keyring
	now     func() time.Time
}

func New(database *store.Store, keyring *secret.Keyring) (*Service, error) {
	if database == nil || keyring == nil {
		return nil, errors.New("sharing store and keyring are required")
	}
	return &Service{store: database, keyring: keyring, now: time.Now}, nil
}

type CreateInput struct {
	Kind            domain.ShareKind       `json:"kind"`
	Permission      domain.SharePermission `json:"permission"`
	RecipientUserID string                 `json:"recipientUserId,omitempty"`
	ExpiresAt       *time.Time             `json:"expiresAt"`
}

type UpdateInput struct {
	Permission domain.SharePermission `json:"permission"`
	ExpiresAt  *time.Time             `json:"expiresAt"`
}

type CreatedShare struct {
	Share domain.SessionShare `json:"share"`
	Token string              `json:"token,omitempty"`
}

type RedeemedGuest struct {
	Guest       domain.GuestSession  `json:"guest"`
	Access      domain.SessionAccess `json:"access"`
	CookieToken string               `json:"-"`
}

func newToken() (string, [sha256.Size]byte, error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", [sha256.Size]byte{}, fmt.Errorf("generate sharing token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw[:]), sha256.Sum256(raw[:]), nil
}

func tokenDigest(token string) ([sha256.Size]byte, error) {
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) != 32 || base64.RawURLEncoding.EncodeToString(raw) != token {
		return [sha256.Size]byte{}, store.ErrNotFound
	}
	return sha256.Sum256(raw), nil
}

func validName(value string) bool {
	if strings.TrimSpace(value) == "" || len(value) > 320 || !utf8.ValidString(value) || utf8.RuneCountInString(value) > 80 {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}

func validPermission(value domain.SharePermission) bool {
	return value == domain.ShareView || value == domain.ShareRecord
}

func (s *Service) Create(ctx context.Context, ownerID, sessionID string, input CreateInput) (CreatedShare, error) {
	if ownerID == "" || sessionID == "" || !validPermission(input.Permission) ||
		(input.Kind != domain.ShareUser && input.Kind != domain.ShareLink) ||
		(input.Kind == domain.ShareUser && (input.RecipientUserID == "" || input.RecipientUserID == ownerID)) ||
		(input.Kind == domain.ShareLink && input.RecipientUserID != "") {
		return CreatedShare{}, ErrInvalidInput
	}
	now := s.now().UTC()
	if input.ExpiresAt != nil && !input.ExpiresAt.After(now) {
		return CreatedShare{}, ErrInvalidInput
	}
	shareID, err := id.New("shr")
	if err != nil {
		return CreatedShare{}, err
	}
	share := domain.SessionShare{
		ID: shareID, SessionID: sessionID, OwnerUserID: ownerID,
		Kind: input.Kind, Permission: input.Permission, CreatedAt: now, ExpiresAt: input.ExpiresAt,
	}
	var token string
	var digest [sha256.Size]byte
	var sealed []byte
	if input.Kind == domain.ShareUser {
		share.RecipientUserID = &input.RecipientUserID
	} else {
		token, digest, err = newToken()
		if err != nil {
			return CreatedShare{}, err
		}
		sealed, err = s.keyring.Seal("session-share/"+shareID, []byte(token))
		if err != nil {
			return CreatedShare{}, err
		}
	}
	var hash []byte
	if input.Kind == domain.ShareLink {
		hash = digest[:]
	}
	if err := s.store.CreateSessionShare(ctx, ownerID, share, hash, sealed); err != nil {
		return CreatedShare{}, err
	}
	return CreatedShare{Share: share, Token: token}, nil
}

func (s *Service) List(ctx context.Context, ownerID, sessionID string) ([]domain.SessionShare, error) {
	return s.store.ListSessionShares(ctx, ownerID, sessionID)
}

func (s *Service) Update(ctx context.Context, ownerID, sessionID, shareID string, input UpdateInput) (domain.SessionShare, error) {
	if !validPermission(input.Permission) || input.ExpiresAt != nil && !input.ExpiresAt.After(s.now()) {
		return domain.SessionShare{}, ErrInvalidInput
	}
	return s.store.UpdateSessionShare(ctx, ownerID, sessionID, shareID, input.Permission, input.ExpiresAt, s.now().UTC())
}

func (s *Service) Revoke(ctx context.Context, ownerID, sessionID, shareID string) (domain.SessionShare, error) {
	return s.store.RevokeSessionShare(ctx, ownerID, sessionID, shareID, s.now().UTC())
}

func (s *Service) LinkToken(ctx context.Context, ownerID, sessionID, shareID string) (string, error) {
	share, sealed, err := s.store.GetSessionShare(ctx, ownerID, sessionID, shareID)
	if err != nil {
		return "", err
	}
	if share.Kind != domain.ShareLink || share.RevokedAt != nil || share.ExpiresAt != nil && !share.ExpiresAt.After(s.now()) {
		return "", store.ErrNotFound
	}
	plain, err := s.keyring.Open("session-share/"+shareID, sealed)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

func (s *Service) Redeem(ctx context.Context, linkToken, displayName, targetLanguage string) (RedeemedGuest, error) {
	digest, err := tokenDigest(linkToken)
	if err != nil {
		return RedeemedGuest{}, err
	}
	now := s.now().UTC()
	share, err := s.store.FindActiveLinkShare(ctx, digest, now)
	if err != nil {
		return RedeemedGuest{}, err
	}
	displayName = strings.TrimSpace(displayName)
	if displayName == "" {
		displayName = "Guest"
	}
	if !validName(displayName) {
		return RedeemedGuest{}, ErrInvalidInput
	}
	if targetLanguage == "" {
		targetLanguage = "en"
	}
	targetLanguage, err = language.Canonicalize(targetLanguage)
	if err != nil {
		return RedeemedGuest{}, ErrInvalidInput
	}
	guestID, err := id.New("gst")
	if err != nil {
		return RedeemedGuest{}, err
	}
	cookieToken, cookieDigest, err := newToken()
	if err != nil {
		return RedeemedGuest{}, err
	}
	expires := now.Add(guestSessionTTL)
	if share.ExpiresAt != nil && share.ExpiresAt.Before(expires) {
		expires = *share.ExpiresAt
	}
	guest := domain.GuestSession{
		ID: guestID, ShareID: share.ID, SessionID: share.SessionID,
		DisplayName: displayName, TargetLanguage: targetLanguage, CreatedAt: now, ExpiresAt: expires,
	}
	if err := s.store.CreateGuestSession(ctx, guest, cookieDigest, now); err != nil {
		return RedeemedGuest{}, err
	}
	viewer := domain.Viewer{ID: "guest:" + guestID, GuestID: guestID, DisplayName: displayName}
	access, err := s.Resolve(ctx, viewer, share.SessionID)
	if err != nil {
		return RedeemedGuest{}, err
	}
	return RedeemedGuest{Guest: guest, Access: access, CookieToken: cookieToken}, nil
}

func (s *Service) AuthenticateGuest(ctx context.Context, cookieToken string) (domain.Viewer, error) {
	digest, err := tokenDigest(cookieToken)
	if err != nil {
		return domain.Viewer{}, err
	}
	guest, _, err := s.store.FindActiveGuestSession(ctx, "", &digest, s.now().UTC())
	if err != nil {
		return domain.Viewer{}, err
	}
	return domain.Viewer{ID: "guest:" + guest.ID, GuestID: guest.ID, DisplayName: guest.DisplayName}, nil
}

func (s *Service) Resolve(ctx context.Context, viewer domain.Viewer, sessionID string) (domain.SessionAccess, error) {
	if sessionID == "" {
		return domain.SessionAccess{}, store.ErrNotFound
	}
	now := s.now().UTC()
	var session domain.InterpretationSession
	var shareID string
	var permission domain.SharePermission
	var linkAccess bool
	var isOwner bool
	var fallbackTarget string
	if viewer.UserID != "" {
		user, err := s.store.GetUserByID(ctx, viewer.UserID)
		if err != nil || user.Status != domain.UserActive {
			return domain.SessionAccess{}, store.ErrNotFound
		}
		viewer.ID = "user:" + user.ID
		viewer.DisplayName = user.DisplayName
		session, err = s.store.GetInterpretationSession(ctx, user.ID, sessionID)
		if errors.Is(err, store.ErrNotFound) {
			share, shareErr := s.store.FindActiveUserShare(ctx, user.ID, sessionID, now)
			if errors.Is(shareErr, store.ErrNotFound) && viewer.GuestID != "" {
				guest, link, guestErr := s.store.FindActiveGuestSession(ctx, viewer.GuestID, nil, now)
				if guestErr != nil || guest.SessionID != sessionID {
					return domain.SessionAccess{}, store.ErrNotFound
				}
				share, linkAccess = link, true
			} else if shareErr != nil {
				return domain.SessionAccess{}, shareErr
			}
			session, err = s.store.GetInterpretationSession(ctx, share.OwnerUserID, sessionID)
			if err != nil {
				return domain.SessionAccess{}, err
			}
			shareID, permission = share.ID, share.Permission
		} else if err != nil {
			return domain.SessionAccess{}, err
		} else {
			isOwner, permission = true, domain.ShareRecord
		}
		settings, err := s.store.GetUserSettings(ctx, user.ID)
		if err != nil {
			return domain.SessionAccess{}, err
		}
		fallbackTarget = settings.DefaultTargetLanguage
	} else if viewer.GuestID != "" && viewer.UserID == "" {
		guest, share, err := s.store.FindActiveGuestSession(ctx, viewer.GuestID, nil, now)
		if err != nil || guest.SessionID != sessionID {
			return domain.SessionAccess{}, store.ErrNotFound
		}
		viewer.ID = "guest:" + guest.ID
		viewer.DisplayName = guest.DisplayName
		session, err = s.store.GetInterpretationSession(ctx, share.OwnerUserID, sessionID)
		if err != nil {
			return domain.SessionAccess{}, err
		}
		shareID, permission = share.ID, share.Permission
		fallbackTarget = guest.TargetLanguage
	} else {
		return domain.SessionAccess{}, store.ErrForbidden
	}
	if !isOwner && viewer.UserID != "" && !linkAccess {
		// A share can be revoked while its session and preference are loaded.
		currentShare, err := s.store.FindActiveUserShare(ctx, viewer.UserID, sessionID, s.now().UTC())
		if err != nil {
			return domain.SessionAccess{}, err
		}
		shareID, permission = currentShare.ID, currentShare.Permission
	} else if viewer.GuestID != "" && !isOwner {
		_, currentShare, err := s.store.FindActiveGuestSession(ctx, viewer.GuestID, nil, s.now().UTC())
		if err != nil {
			return domain.SessionAccess{}, err
		}
		shareID, permission = currentShare.ID, currentShare.Permission
	}
	target, err := s.store.GetViewerTargetLanguage(ctx, sessionID, viewer.ID)
	if errors.Is(err, store.ErrNotFound) {
		target = fallbackTarget
	} else if err != nil {
		return domain.SessionAccess{}, err
	}
	target, err = language.Canonicalize(target)
	if err != nil {
		return domain.SessionAccess{}, fmt.Errorf("sharing: stored viewer language is invalid: %w", err)
	}
	return domain.SessionAccess{
		Session: session, Viewer: viewer, Permission: permission,
		IsOwner: isOwner, TargetLanguage: target, ShareID: shareID,
	}, nil
}

func (s *Service) ListAccessibleSessions(ctx context.Context, viewer domain.Viewer, limit, offset int) ([]domain.SessionAccess, error) {
	now := s.now().UTC()
	items, err := s.store.ListAccessibleInterpretationSessions(ctx, viewer, now, limit, offset)
	if err != nil {
		return nil, err
	}
	result := make([]domain.SessionAccess, 0, len(items))
	for _, session := range items {
		access, err := s.Resolve(ctx, viewer, session.ID)
		if errors.Is(err, store.ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		result = append(result, access)
	}
	return result, nil
}

func (s *Service) SetTargetLanguage(ctx context.Context, viewer domain.Viewer, sessionID, targetLanguage string) (domain.SessionAccess, error) {
	target, err := language.Canonicalize(targetLanguage)
	if err != nil {
		return domain.SessionAccess{}, ErrInvalidInput
	}
	access, err := s.Resolve(ctx, viewer, sessionID)
	if err != nil {
		return domain.SessionAccess{}, err
	}
	if err := s.store.UpsertViewerTargetLanguage(ctx, sessionID, access.Viewer.ID, target, s.now().UTC()); err != nil {
		return domain.SessionAccess{}, err
	}
	return s.Resolve(ctx, viewer, sessionID)
}

func (s *Service) SearchUsers(ctx context.Context, requesterID, query string) ([]domain.User, error) {
	query = strings.TrimSpace(query)
	if !validName(query) {
		return nil, ErrInvalidInput
	}
	return s.store.SearchShareRecipients(ctx, requesterID, query, 20)
}
