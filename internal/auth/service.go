// Package auth implements passkey-only registration, discoverable login, and
// opaque browser sessions. There is intentionally no password abstraction in
// this package.
package auth

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/Tularity/t-lingual/internal/config"
	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/id"
	"github.com/Tularity/t-lingual/internal/secret"
	"github.com/Tularity/t-lingual/internal/store"
	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

var (
	ErrInvalidInvitation    = errors.New("auth: invalid invitation")
	ErrInvalidInput         = errors.New("auth: invalid input")
	ErrUsernameTaken        = errors.New("auth: username is unavailable")
	ErrInvalidCeremony      = errors.New("auth: invalid or expired ceremony")
	ErrInvalidPasskey       = errors.New("auth: passkey validation failed")
	ErrInvalidAuthorization = errors.New("auth: passkey authorization is invalid")
	ErrAccountDisabled      = errors.New("auth: account is disabled")
	ErrUnauthenticated      = errors.New("auth: unauthenticated")
	ErrCredentialData       = errors.New("auth: credential data is invalid")
	ErrCredentialLimit      = errors.New("auth: credential limit reached")
	ErrUserRevokerSet       = errors.New("auth: user revoker is already configured")
)

var (
	usernamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$`)
	invitePattern   = regexp.MustCompile(`^[0-9]{6}$`)
)

const (
	credentialRegistration       = "credential_registration"
	credentialAuthorization      = "credential_authorization"
	invalidInvitationMaxFailures = 5
	maxOutstandingCeremonies     = 2048
	maxOwnedCeremonies           = 512
	maxCeremoniesPerOwner        = 8
	passkeyAuthorizationTTL      = 2 * time.Minute
)

type Service struct {
	store       *store.Store
	keyring     *secret.Keyring
	webauthn    *webauthn.WebAuthn
	ceremonyTTL time.Duration
	sessionTTL  time.Duration
	now         func() time.Time

	revokerMu         sync.RWMutex
	revokerConfigured bool
	revokeUser        UserRevokeFunc
}

// UserRevokeFunc immediately disconnects all live work owned by a user after
// a committed authentication security response. It receives no credential or
// browser-session secret.
type UserRevokeFunc func(userID string)

func New(config config.Config, database *store.Store, keyring *secret.Keyring) (*Service, error) {
	if database == nil || keyring == nil {
		return nil, errors.New("auth store and keyring are required")
	}
	passkeys, err := webauthn.New(&webauthn.Config{
		RPID:                  config.RPID,
		RPDisplayName:         config.RPDisplayName,
		RPOrigins:             append([]string(nil), config.RPOrigins...),
		RPTopOrigins:          append([]string(nil), config.RPOrigins...),
		RPAllowCrossOrigin:    false,
		AttestationPreference: protocol.PreferNoAttestation,
		AuthenticatorSelection: protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementRequired,
			UserVerification: protocol.VerificationRequired,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("configure WebAuthn: %w", err)
	}
	return &Service{
		store:       database,
		keyring:     keyring,
		webauthn:    passkeys,
		ceremonyTTL: config.CeremonyTTL,
		sessionTTL:  config.SessionTTL,
		now:         time.Now,
	}, nil
}

// ConfigureUserRevoker installs the optional live-user revoker exactly once.
// It is safe to race with readers and accepts nil for deployments without a
// live subsystem.
func (s *Service) ConfigureUserRevoker(revokeUser UserRevokeFunc) error {
	s.revokerMu.Lock()
	defer s.revokerMu.Unlock()
	if s.revokerConfigured {
		return ErrUserRevokerSet
	}
	s.revokeUser = revokeUser
	s.revokerConfigured = true
	return nil
}

func (s *Service) revokeLiveUser(userID string) {
	s.revokerMu.RLock()
	revokeUser := s.revokeUser
	s.revokerMu.RUnlock()
	if revokeUser != nil {
		revokeUser(userID)
	}
}

type RegistrationInput struct {
	InvitationCode string
	Username       string
	DisplayName    string
	CredentialName string
}

type BeginResult struct {
	CeremonyToken string
	ExpiresAt     time.Time
	Options       any
}

type SessionMetadata struct {
	UserAgent string
	IPAddress string
}

type LoginResult struct {
	User         domain.User
	Session      domain.BrowserSession
	SessionToken string
}

type pendingRegistration struct {
	User               domain.User `json:"user"`
	WebAuthnID         []byte      `json:"webAuthnId,omitempty"`
	BrowserSessionID   string      `json:"browserSessionId,omitempty"`
	CredentialName     string      `json:"credentialName"`
	InviteDigest       []byte      `json:"inviteDigest"`
	InviteBucket       uint16      `json:"inviteBucket"`
	AuthorizationScope string      `json:"authorizationScope,omitempty"`
}

type AuthorizationResult struct {
	Token     string
	ExpiresAt time.Time
}

func (s *Service) BeginRegistration(ctx context.Context, input RegistrationInput) (BeginResult, error) {
	input.InvitationCode = strings.TrimSpace(input.InvitationCode)
	input.Username = strings.TrimSpace(input.Username)
	input.DisplayName = strings.TrimSpace(input.DisplayName)
	input.CredentialName = strings.TrimSpace(input.CredentialName)
	if !invitePattern.MatchString(input.InvitationCode) {
		return BeginResult{}, ErrInvalidInvitation
	}
	if !usernamePattern.MatchString(input.Username) {
		return BeginResult{}, fmt.Errorf("%w: username", ErrInvalidInput)
	}
	if err := validateHumanName(input.DisplayName, 80); err != nil {
		return BeginResult{}, fmt.Errorf("%w: display name: %v", ErrInvalidInput, err)
	}
	credentialName, err := normalizeCredentialName(input.CredentialName)
	if err != nil {
		return BeginResult{}, err
	}
	input.CredentialName = credentialName

	now := s.now().UTC()
	digest := s.keyring.InvitationDigest(input.InvitationCode)

	userID, err := id.New("usr")
	if err != nil {
		return BeginResult{}, err
	}
	webAuthnID := make([]byte, 64)
	if _, err := rand.Read(webAuthnID); err != nil {
		return BeginResult{}, fmt.Errorf("generate WebAuthn user handle: %w", err)
	}
	user := domain.User{
		ID:          userID,
		WebAuthnID:  webAuthnID,
		Username:    input.Username,
		DisplayName: input.DisplayName,
		Role:        domain.RoleUser,
		Status:      domain.UserActive,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	options, sessionData, err := s.webauthn.BeginRegistration(
		webauthnUser{user: user},
		webauthn.WithResidentKeyRequirement(protocol.ResidentKeyRequirementRequired),
		webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementRequired,
			UserVerification: protocol.VerificationRequired,
		}),
		webauthn.WithConveyancePreference(protocol.PreferNoAttestation),
	)
	if err != nil {
		return BeginResult{}, fmt.Errorf("begin passkey registration: %w", err)
	}
	pending := pendingRegistration{
		User:           user,
		WebAuthnID:     append([]byte(nil), user.WebAuthnID...),
		CredentialName: input.CredentialName,
		InviteDigest:   digest[:],
		InviteBucket:   s.keyring.InvitationBucket(input.InvitationCode),
	}
	return s.persistCeremony(ctx, store.CeremonyRegistration, sessionData, pending, nil, "", "", options)
}

func (s *Service) FinishRegistration(ctx context.Context, ceremonyToken string, request *http.Request, metadata SessionMetadata) (LoginResult, error) {
	_, sessionData, pending, err := s.consumeCeremony(ctx, ceremonyToken, store.CeremonyRegistration)
	if err != nil {
		return LoginResult{}, err
	}
	credential, err := s.webauthn.FinishRegistration(webauthnUser{user: pending.User}, sessionData, request)
	if err != nil {
		return LoginResult{}, fmt.Errorf("%w: %v", ErrInvalidPasskey, err)
	}
	now := s.now().UTC()
	if len(pending.InviteDigest) != 32 || pending.InviteBucket >= 4096 {
		return LoginResult{}, ErrInvalidCeremony
	}
	credentialRecord, err := s.credentialRecord(pending.User.ID, pending.CredentialName, credential, now)
	if err != nil {
		return LoginResult{}, err
	}
	auditEventID, err := id.New("aud")
	if err != nil {
		return LoginResult{}, err
	}
	if _, err := s.store.CompleteRegistration(
		ctx,
		pending.InviteDigest,
		pending.InviteBucket,
		now,
		pending.User,
		credentialRecord,
		invalidInvitationMaxFailures,
		auditEventID,
	); err != nil {
		if errors.Is(err, store.ErrInvalidInvite) {
			return LoginResult{}, ErrInvalidInvitation
		}
		if errors.Is(err, store.ErrConflict) {
			return LoginResult{}, ErrUsernameTaken
		}
		return LoginResult{}, err
	}
	return s.issueSessionForCredential(ctx, pending.User, credentialRecord.CredentialID, metadata)
}

func (s *Service) BeginLogin(ctx context.Context) (BeginResult, error) {
	options, sessionData, err := s.webauthn.BeginDiscoverableLogin(webauthn.WithUserVerification(protocol.VerificationRequired))
	if err != nil {
		return BeginResult{}, fmt.Errorf("begin passkey login: %w", err)
	}
	return s.persistCeremony(ctx, store.CeremonyAuthentication, sessionData, nil, nil, "", "", options)
}

func (s *Service) FinishLogin(ctx context.Context, ceremonyToken string, request *http.Request, metadata SessionMetadata) (LoginResult, error) {
	_, sessionData, _, err := s.consumeCeremony(ctx, ceremonyToken, store.CeremonyAuthentication)
	if err != nil {
		return LoginResult{}, err
	}
	var authenticated domain.User
	var authenticatedRecord domain.Credential
	handler := func(rawID, userHandle []byte) (webauthn.User, error) {
		user, lookupErr := s.store.GetUserByWebAuthnID(ctx, userHandle)
		if lookupErr != nil {
			return nil, ErrInvalidPasskey
		}
		if user.Status != domain.UserActive {
			return nil, ErrAccountDisabled
		}
		loaded, loadErr := s.loadWebAuthnUser(ctx, user)
		if loadErr != nil {
			return nil, loadErr
		}
		record, found := loaded.credentialRecord(rawID)
		if !found || record.UserID != user.ID || record.CompromisedAt != nil {
			return nil, ErrInvalidPasskey
		}
		authenticated = user
		authenticatedRecord = record
		return loaded, nil
	}
	credential, err := s.webauthn.FinishDiscoverableLogin(handler, sessionData, request)
	if err != nil {
		if errors.Is(err, ErrAccountDisabled) {
			return LoginResult{}, ErrAccountDisabled
		}
		return LoginResult{}, fmt.Errorf("%w: %v", ErrInvalidPasskey, err)
	}
	if authenticated.ID == "" || credential == nil {
		return LoginResult{}, ErrInvalidPasskey
	}
	record := authenticatedRecord
	if record.ID == "" || record.UserID != authenticated.ID || record.CompromisedAt != nil || !bytes.Equal(record.CredentialID, credential.ID) {
		return LoginResult{}, ErrInvalidPasskey
	}
	if credential.Authenticator.CloneWarning {
		if err := s.handleCredentialCloneWarning(
			ctx, authenticated.ID, record.ID, s.now().UTC(),
		); err != nil {
			return LoginResult{}, err
		}
		return LoginResult{}, ErrInvalidPasskey
	}
	now := s.now().UTC()
	if err := s.updateCredentialAfterAssertion(ctx, authenticated.ID, record, credential, now); err != nil {
		return LoginResult{}, err
	}
	return s.issueSessionForCredential(ctx, authenticated, credential.ID, metadata)
}

func (s *Service) Authenticate(ctx context.Context, sessionToken string) (domain.User, domain.BrowserSession, error) {
	if strings.TrimSpace(sessionToken) == "" {
		return domain.User{}, domain.BrowserSession{}, ErrUnauthenticated
	}
	now := s.now().UTC()
	session, err := s.store.LookupBrowserSession(ctx, sessionToken, now)
	if err != nil {
		return domain.User{}, domain.BrowserSession{}, ErrUnauthenticated
	}
	user, err := s.store.GetUserByID(ctx, session.UserID)
	if err != nil || user.Status != domain.UserActive {
		return domain.User{}, domain.BrowserSession{}, ErrUnauthenticated
	}
	if now.Sub(session.LastSeen) >= 5*time.Minute {
		if err := s.store.TouchBrowserSession(ctx, sessionToken, now); err == nil {
			session.LastSeen = now
		}
	}
	return user, session, nil
}

func (s *Service) Logout(ctx context.Context, sessionToken string) error {
	if sessionToken == "" {
		return nil
	}
	err := s.store.DeleteBrowserSession(ctx, sessionToken)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	return err
}

// ListBrowserSessions returns the active browser sessions owned by userID.
// Session tokens are never returned by the persistence layer or this service.
func (s *Service) ListBrowserSessions(ctx context.Context, userID string) ([]domain.BrowserSession, error) {
	return s.store.ListActiveBrowserSessions(ctx, userID, s.now().UTC())
}

// RevokeBrowserSession lets the current browser sign itself out directly. A
// cookie attempting to revoke any other browser must also present a one-time
// user-verification grant bound to the current browser.
func (s *Service) RevokeBrowserSession(
	ctx context.Context,
	userID string,
	currentBrowserSessionID string,
	targetBrowserSessionID string,
	authorizationToken string,
) error {
	if targetBrowserSessionID != currentBrowserSessionID {
		if err := s.ConsumeCredentialAuthorization(
			ctx, userID, currentBrowserSessionID, authorizationToken,
			AuthorizationScopePasskeyManagement,
		); err != nil {
			return err
		}
	}
	return s.store.DeleteBrowserSessionByID(ctx, userID, targetBrowserSessionID)
}

// RevokeOtherBrowserSessions consumes a user-verification grant bound to the
// current browser before preserving that browser and revoking every other
// session owned by the same account.
func (s *Service) RevokeOtherBrowserSessions(
	ctx context.Context,
	userID string,
	currentBrowserSessionID string,
	authorizationToken string,
) ([]string, error) {
	now := s.now().UTC()
	if err := s.ConsumeCredentialAuthorization(
		ctx, userID, currentBrowserSessionID, authorizationToken,
		AuthorizationScopePasskeyManagement,
	); err != nil {
		return nil, err
	}
	deleted, err := s.store.DeleteOtherBrowserSessions(ctx, userID, currentBrowserSessionID, now)
	if errors.Is(err, store.ErrNotFound) {
		return nil, ErrUnauthenticated
	}
	return deleted, err
}

// BeginCredentialAuthorization asks for an assertion from one of the user's
// existing passkeys. A browser-session cookie alone cannot authorize adding or
// removing a sign-in credential.
func (s *Service) BeginCredentialAuthorization(ctx context.Context, userID, browserSessionID string) (BeginResult, error) {
	return s.BeginCredentialAuthorizationForScope(
		ctx, userID, browserSessionID, AuthorizationScopePasskeyManagement,
	)
}

// BeginCredentialAuthorizationForScope starts the same user-verification
// ceremony while sealing a restricted, canonical operation scope into its
// one-time pending state.
func (s *Service) BeginCredentialAuthorizationForScope(
	ctx context.Context,
	userID string,
	browserSessionID string,
	authorizationScope string,
) (BeginResult, error) {
	authorizationScope, err := NormalizeAuthorizationScope(authorizationScope)
	if err != nil {
		return BeginResult{}, err
	}
	now := s.now().UTC()
	if err := s.store.ValidateBrowserSession(ctx, userID, browserSessionID, now); err != nil {
		return BeginResult{}, ErrUnauthenticated
	}
	user, err := s.store.GetUserByID(ctx, userID)
	if err != nil || user.Status != domain.UserActive {
		return BeginResult{}, ErrUnauthenticated
	}
	loaded, err := s.loadWebAuthnUser(ctx, user)
	if err != nil {
		return BeginResult{}, err
	}
	options, sessionData, err := s.webauthn.BeginLogin(
		loaded,
		webauthn.WithUserVerification(protocol.VerificationRequired),
	)
	if err != nil {
		return BeginResult{}, fmt.Errorf("begin passkey authorization: %w", err)
	}
	pending := pendingRegistration{
		User: user, WebAuthnID: append([]byte(nil), user.WebAuthnID...),
		BrowserSessionID: browserSessionID, AuthorizationScope: authorizationScope,
	}
	return s.persistCeremony(ctx, credentialAuthorization, sessionData, pending, nil, userID, browserSessionID, options)
}

func (s *Service) FinishCredentialAuthorization(
	ctx context.Context,
	userID string,
	browserSessionID string,
	ceremonyToken string,
	request *http.Request,
) (AuthorizationResult, error) {
	_, sessionData, pending, err := s.consumeCeremony(ctx, ceremonyToken, credentialAuthorization)
	if err != nil {
		return AuthorizationResult{}, err
	}
	if pending.User.ID != userID || pending.BrowserSessionID != browserSessionID {
		return AuthorizationResult{}, ErrInvalidCeremony
	}
	authorizationScope, err := NormalizeAuthorizationScope(pending.AuthorizationScope)
	if err != nil {
		return AuthorizationResult{}, ErrInvalidCeremony
	}
	now := s.now().UTC()
	if err := s.store.ValidateBrowserSession(ctx, userID, browserSessionID, now); err != nil {
		return AuthorizationResult{}, ErrUnauthenticated
	}
	user, err := s.store.GetUserByID(ctx, userID)
	if err != nil || user.Status != domain.UserActive {
		return AuthorizationResult{}, ErrUnauthenticated
	}
	loaded, err := s.loadWebAuthnUser(ctx, user)
	if err != nil {
		return AuthorizationResult{}, err
	}
	credential, err := s.webauthn.FinishLogin(loaded, sessionData, request)
	if err != nil || credential == nil {
		return AuthorizationResult{}, fmt.Errorf("%w: passkey authorization failed", ErrInvalidPasskey)
	}
	record, found := loaded.credentialRecord(credential.ID)
	if !found || record.UserID != userID || record.CompromisedAt != nil {
		return AuthorizationResult{}, ErrInvalidPasskey
	}
	if credential.Authenticator.CloneWarning {
		if err := s.handleCredentialCloneWarning(ctx, userID, record.ID, now); err != nil {
			return AuthorizationResult{}, err
		}
		return AuthorizationResult{}, ErrInvalidPasskey
	}
	if err := s.updateCredentialAfterAssertion(ctx, userID, record, credential, now); err != nil {
		return AuthorizationResult{}, err
	}

	grantID, err := id.New("grant")
	if err != nil {
		return AuthorizationResult{}, err
	}
	grantToken, err := NewScopedAuthorizationToken(authorizationScope)
	if err != nil {
		return AuthorizationResult{}, err
	}
	expiresAt := now.Add(passkeyAuthorizationTTL)
	if err := s.store.CreateActionGrant(ctx, store.ActionGrant{
		ID: grantID, UserID: userID, BrowserSessionID: browserSessionID,
		Action: store.ActionPasskeyManagement, CreatedAt: now, ExpiresAt: expiresAt,
	}, grantToken); err != nil {
		return AuthorizationResult{}, ErrUnauthenticated
	}
	return AuthorizationResult{Token: grantToken, ExpiresAt: expiresAt}, nil
}

func (s *Service) BeginAddCredential(
	ctx context.Context,
	userID string,
	browserSessionID string,
	authorizationToken string,
	credentialName string,
) (BeginResult, error) {
	credentialName, err := normalizeCredentialName(credentialName)
	if err != nil {
		return BeginResult{}, err
	}
	if err := s.ConsumeCredentialAuthorization(
		ctx, userID, browserSessionID, authorizationToken,
		AuthorizationScopePasskeyManagement,
	); err != nil {
		return BeginResult{}, err
	}
	user, err := s.store.GetUserByID(ctx, userID)
	if err != nil || user.Status != domain.UserActive {
		return BeginResult{}, ErrUnauthenticated
	}
	loaded, err := s.loadWebAuthnUser(ctx, user)
	if err != nil {
		return BeginResult{}, err
	}
	exclusions := make([]protocol.CredentialDescriptor, 0, len(loaded.credentials))
	for _, credential := range loaded.credentials {
		exclusions = append(exclusions, credential.Descriptor())
	}
	options, sessionData, err := s.webauthn.BeginRegistration(
		loaded,
		webauthn.WithExclusions(exclusions),
		webauthn.WithResidentKeyRequirement(protocol.ResidentKeyRequirementRequired),
		webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementRequired,
			UserVerification: protocol.VerificationRequired,
		}),
	)
	if err != nil {
		return BeginResult{}, err
	}
	pending := pendingRegistration{
		User: user, WebAuthnID: append([]byte(nil), user.WebAuthnID...),
		BrowserSessionID: browserSessionID, CredentialName: credentialName,
	}
	return s.persistCeremony(ctx, credentialRegistration, sessionData, pending, nil, userID, browserSessionID, options)
}

func (s *Service) FinishAddCredential(
	ctx context.Context,
	userID string,
	browserSessionID string,
	ceremonyToken string,
	request *http.Request,
) (domain.Credential, error) {
	_, sessionData, pending, err := s.consumeCeremony(ctx, ceremonyToken, credentialRegistration)
	if err != nil {
		return domain.Credential{}, err
	}
	if pending.User.ID != userID || pending.BrowserSessionID != browserSessionID {
		return domain.Credential{}, ErrInvalidCeremony
	}
	loaded, err := s.loadWebAuthnUser(ctx, pending.User)
	if err != nil {
		return domain.Credential{}, err
	}
	credential, err := s.webauthn.FinishRegistration(loaded, sessionData, request)
	if err != nil {
		return domain.Credential{}, fmt.Errorf("%w: %v", ErrInvalidPasskey, err)
	}
	record, err := s.credentialRecord(userID, pending.CredentialName, credential, s.now().UTC())
	if err != nil {
		return domain.Credential{}, err
	}
	if err := s.store.CreateCredentialForActiveSession(ctx, record, browserSessionID, s.now().UTC()); err != nil {
		if errors.Is(err, store.ErrCapacity) {
			return domain.Credential{}, ErrCredentialLimit
		}
		return domain.Credential{}, err
	}
	return record, nil
}

func (s *Service) ListCredentials(ctx context.Context, userID string) ([]domain.Credential, error) {
	records, err := s.store.ListCredentials(ctx, userID)
	if err != nil {
		return nil, err
	}
	for index := range records {
		records[index].ID = base64.RawURLEncoding.EncodeToString(records[index].CredentialID)
		records[index].CredentialID = nil
		records[index].CredentialJSON = nil
	}
	return records, nil
}

func (s *Service) DeleteCredential(
	ctx context.Context,
	userID string,
	browserSessionID string,
	authorizationToken string,
	encodedCredentialID string,
) error {
	if err := s.ConsumeCredentialAuthorization(
		ctx, userID, browserSessionID, authorizationToken,
		AuthorizationScopePasskeyManagement,
	); err != nil {
		return err
	}
	credentialID, err := base64.RawURLEncoding.DecodeString(encodedCredentialID)
	if err != nil || len(credentialID) == 0 {
		return store.ErrNotFound
	}
	if _, err := s.store.DeleteCredentialAndBrowserSessions(ctx, userID, credentialID, false); err != nil {
		return err
	}
	// Sessions created by older schema versions are not credential-bound. A
	// conservative logout-all guarantees a removed passkey cannot retain access
	// through a cookie until its original TTL.
	return nil
}

func (s *Service) persistCeremony(
	ctx context.Context,
	kind string,
	sessionData *webauthn.SessionData,
	pending any,
	invitationID *string,
	ownerUserID string,
	browserSessionID string,
	options any,
) (BeginResult, error) {
	ceremonyID, err := id.New("wac")
	if err != nil {
		return BeginResult{}, err
	}
	token, err := id.Secret(32)
	if err != nil {
		return BeginResult{}, err
	}
	sessionJSON, err := json.Marshal(sessionData)
	if err != nil {
		return BeginResult{}, err
	}
	sealedSession, err := s.keyring.Seal(ceremonySessionPurpose(ceremonyID), sessionJSON)
	if err != nil {
		return BeginResult{}, err
	}
	var sealedPending []byte
	if pending != nil {
		pendingJSON, marshalErr := json.Marshal(pending)
		if marshalErr != nil {
			return BeginResult{}, marshalErr
		}
		sealedPending, err = s.keyring.Seal(ceremonyPendingPurpose(ceremonyID), pendingJSON)
		if err != nil {
			return BeginResult{}, err
		}
	}
	now := s.now().UTC()
	expires := now.Add(s.ceremonyTTL)
	if !sessionData.Expires.IsZero() && sessionData.Expires.Before(expires) {
		expires = sessionData.Expires
	}
	ceremony := store.WebAuthnCeremony{
		ID:               ceremonyID,
		Kind:             kind,
		SessionJSON:      sealedSession,
		PendingUserJSON:  sealedPending,
		InvitationID:     invitationID,
		OwnerUserID:      ownerUserID,
		BrowserSessionID: browserSessionID,
		CreatedAt:        now,
		ExpiresAt:        expires,
	}
	if err := s.store.CreateWebAuthnCeremonyBounded(
		ctx, ceremony, token,
		maxOutstandingCeremonies, maxOwnedCeremonies, maxCeremoniesPerOwner,
	); err != nil {
		return BeginResult{}, err
	}
	return BeginResult{CeremonyToken: token, ExpiresAt: expires, Options: options}, nil
}

func (s *Service) consumeCeremony(ctx context.Context, token, expectedKind string) (store.WebAuthnCeremony, webauthn.SessionData, pendingRegistration, error) {
	ceremony, err := s.store.ConsumeWebAuthnCeremony(ctx, token, s.now().UTC())
	if err != nil || ceremony.Kind != expectedKind {
		return store.WebAuthnCeremony{}, webauthn.SessionData{}, pendingRegistration{}, ErrInvalidCeremony
	}
	sessionJSON, err := s.keyring.Open(ceremonySessionPurpose(ceremony.ID), ceremony.SessionJSON)
	if err != nil {
		return store.WebAuthnCeremony{}, webauthn.SessionData{}, pendingRegistration{}, ErrCredentialData
	}
	var sessionData webauthn.SessionData
	if err := json.Unmarshal(sessionJSON, &sessionData); err != nil {
		return store.WebAuthnCeremony{}, webauthn.SessionData{}, pendingRegistration{}, ErrCredentialData
	}
	var pending pendingRegistration
	if len(ceremony.PendingUserJSON) > 0 {
		pendingJSON, openErr := s.keyring.Open(ceremonyPendingPurpose(ceremony.ID), ceremony.PendingUserJSON)
		if openErr != nil || json.Unmarshal(pendingJSON, &pending) != nil {
			return store.WebAuthnCeremony{}, webauthn.SessionData{}, pendingRegistration{}, ErrCredentialData
		}
		// domain.User intentionally excludes its WebAuthn handle from JSON so it
		// can never leak through an API response. Ceremony state therefore keeps
		// an explicit encrypted copy and binds it to the independently encrypted
		// SessionData before restoring it for go-webauthn. Missing or mismatched
		// handles are corrupted ceremony state, never a reason to weaken the
		// library's user/session ID check.
		if pending.User.ID == "" || len(pending.WebAuthnID) == 0 || len(pending.WebAuthnID) > 64 ||
			!bytes.Equal(pending.WebAuthnID, sessionData.UserID) {
			return store.WebAuthnCeremony{}, webauthn.SessionData{}, pendingRegistration{}, ErrCredentialData
		}
		pending.User.WebAuthnID = append([]byte(nil), pending.WebAuthnID...)
	}
	return ceremony, sessionData, pending, nil
}

func (s *Service) credentialRecord(userID, name string, credential *webauthn.Credential, now time.Time) (domain.Credential, error) {
	if credential == nil || len(credential.ID) == 0 {
		return domain.Credential{}, ErrCredentialData
	}
	recordID, err := id.New("cred")
	if err != nil {
		return domain.Credential{}, err
	}
	encoded, err := json.Marshal(credential)
	if err != nil {
		return domain.Credential{}, err
	}
	sealed, err := s.keyring.Seal(credentialPurpose(recordID), encoded)
	if err != nil {
		return domain.Credential{}, err
	}
	return domain.Credential{
		ID:             recordID,
		UserID:         userID,
		CredentialID:   append([]byte(nil), credential.ID...),
		Name:           name,
		CredentialJSON: sealed,
		CreatedAt:      now,
	}, nil
}

func (s *Service) loadWebAuthnUser(ctx context.Context, user domain.User) (webauthnUser, error) {
	records, err := s.store.ListCredentials(ctx, user.ID)
	if err != nil {
		return webauthnUser{}, err
	}
	credentials := make([]webauthn.Credential, 0, len(records))
	recordsByCredentialID := make(map[string]domain.Credential, len(records))
	for _, record := range records {
		if record.CompromisedAt != nil {
			continue
		}
		encoded, openErr := s.keyring.Open(credentialPurpose(record.ID), record.CredentialJSON)
		if openErr != nil {
			return webauthnUser{}, fmt.Errorf("%w: open credential %s", ErrCredentialData, record.ID)
		}
		var credential webauthn.Credential
		if err := json.Unmarshal(encoded, &credential); err != nil || !bytes.Equal(credential.ID, record.CredentialID) {
			return webauthnUser{}, fmt.Errorf("%w: decode credential %s", ErrCredentialData, record.ID)
		}
		credentials = append(credentials, credential)
		recordsByCredentialID[string(record.CredentialID)] = record
	}
	return webauthnUser{user: user, credentials: credentials, records: recordsByCredentialID}, nil
}

// updateCredentialAfterAssertion performs an optimistic, monotonic update of
// authenticator state. A second assertion that was verified from the same
// stored counter cannot blindly overwrite the first. A genuinely newer
// counter may retry against the latest row; an equal or lower non-zero counter
// is treated as a clone warning and revokes existing sessions.
func (s *Service) updateCredentialAfterAssertion(
	ctx context.Context,
	userID string,
	record domain.Credential,
	credential *webauthn.Credential,
	now time.Time,
) error {
	if credential == nil || record.ID == "" || record.CompromisedAt != nil || !bytes.Equal(record.CredentialID, credential.ID) {
		return ErrInvalidPasskey
	}
	expected := record
	for range 3 {
		encoded, err := json.Marshal(credential)
		if err != nil {
			return fmt.Errorf("encode updated passkey: %w", err)
		}
		sealed, err := s.keyring.Seal(credentialPurpose(record.ID), encoded)
		if err != nil {
			return err
		}
		err = s.store.UpdateCredentialIfCurrent(
			ctx, userID, credential.ID, expected.CredentialJSON, sealed, &now,
		)
		if err == nil {
			return nil
		}
		if !errors.Is(err, store.ErrConflict) {
			return err
		}

		latest, err := s.store.GetCredentialByCredentialID(ctx, credential.ID)
		if err != nil || latest.UserID != userID || latest.ID != record.ID || latest.CompromisedAt != nil {
			return ErrInvalidPasskey
		}
		latestJSON, err := s.keyring.Open(credentialPurpose(latest.ID), latest.CredentialJSON)
		if err != nil {
			return ErrCredentialData
		}
		var latestCredential webauthn.Credential
		if err := json.Unmarshal(latestJSON, &latestCredential); err != nil ||
			!bytes.Equal(latestCredential.ID, credential.ID) {
			return ErrCredentialData
		}
		incomingCount := credential.Authenticator.SignCount
		storedCount := latestCredential.Authenticator.SignCount
		if (incomingCount != 0 || storedCount != 0) && incomingCount <= storedCount {
			if err := s.handleCredentialCloneWarning(ctx, userID, record.ID, now); err != nil {
				return err
			}
			return ErrInvalidPasskey
		}
		expected = latest
	}
	return ErrInvalidPasskey
}

func (s *Service) handleCredentialCloneWarning(
	ctx context.Context,
	userID string,
	credentialRecordID string,
	now time.Time,
) error {
	auditEventID, err := id.New("aud")
	if err != nil {
		return err
	}
	if err := s.store.HandleCredentialCloneWarning(
		ctx, userID, credentialRecordID, auditEventID, now,
	); err != nil {
		return err
	}
	// Store success means credential quarantine, logout-all, and audit are
	// committed. Only now may live work be disconnected.
	s.revokeLiveUser(userID)
	return nil
}

func (s *Service) issueSession(ctx context.Context, user domain.User, metadata SessionMetadata) (LoginResult, error) {
	return s.issueSessionWithCredential(ctx, user, nil, metadata)
}

func (s *Service) issueSessionForCredential(
	ctx context.Context,
	user domain.User,
	credentialID []byte,
	metadata SessionMetadata,
) (LoginResult, error) {
	return s.issueSessionWithCredential(ctx, user, credentialID, metadata)
}

func (s *Service) issueSessionWithCredential(
	ctx context.Context,
	user domain.User,
	credentialID []byte,
	metadata SessionMetadata,
) (LoginResult, error) {
	sessionID, err := id.New("ses")
	if err != nil {
		return LoginResult{}, err
	}
	token, err := id.Secret(32)
	if err != nil {
		return LoginResult{}, err
	}
	now := s.now().UTC()
	session := domain.BrowserSession{
		ID:        sessionID,
		UserID:    user.ID,
		CreatedAt: now,
		ExpiresAt: now.Add(s.sessionTTL),
		LastSeen:  now,
		UserAgent: truncate(strings.TrimSpace(metadata.UserAgent), 512),
		IPAddress: truncate(strings.TrimSpace(metadata.IPAddress), 64),
	}
	var createErr error
	if len(credentialID) == 0 {
		createErr = s.store.CreateBrowserSession(ctx, session, token)
	} else {
		createErr = s.store.CreateBrowserSessionForCredential(ctx, session, token, credentialID)
	}
	if createErr != nil {
		if len(credentialID) > 0 && errors.Is(createErr, store.ErrNotFound) {
			return LoginResult{}, ErrInvalidPasskey
		}
		return LoginResult{}, createErr
	}
	return LoginResult{User: user, Session: session, SessionToken: token}, nil
}

type webauthnUser struct {
	user        domain.User
	credentials []webauthn.Credential
	records     map[string]domain.Credential
}

func (u webauthnUser) WebAuthnID() []byte                         { return u.user.WebAuthnID }
func (u webauthnUser) WebAuthnName() string                       { return u.user.Username }
func (u webauthnUser) WebAuthnDisplayName() string                { return u.user.DisplayName }
func (u webauthnUser) WebAuthnCredentials() []webauthn.Credential { return u.credentials }

func (u webauthnUser) credentialRecord(credentialID []byte) (domain.Credential, bool) {
	record, ok := u.records[string(credentialID)]
	return record, ok
}

func ceremonySessionPurpose(id string) string { return "webauthn-session/" + id }
func ceremonyPendingPurpose(id string) string { return "webauthn-pending/" + id }
func credentialPurpose(id string) string      { return "webauthn-credential/" + id }

func validateHumanName(value string, maxRunes int) error {
	if value == "" || !utf8.ValidString(value) {
		return errors.New("value is required and must be valid UTF-8")
	}
	count := 0
	for _, char := range value {
		if unicode.IsControl(char) {
			return errors.New("control characters are not allowed")
		}
		count++
	}
	if count > maxRunes {
		return fmt.Errorf("value cannot exceed %d characters", maxRunes)
	}
	return nil
}

func normalizeCredentialName(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		value = "Passkey"
	}
	if err := validateHumanName(value, 64); err != nil {
		return "", fmt.Errorf("%w: credential name: %v", ErrInvalidInput, err)
	}
	return value, nil
}

func truncate(value string, maxBytes int) string {
	if len(value) <= maxBytes {
		return value
	}
	value = value[:maxBytes]
	for !utf8.ValidString(value) {
		value = value[:len(value)-1]
	}
	return value
}
