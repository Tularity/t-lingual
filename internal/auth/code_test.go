package auth

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
)

func TestCodeEntryRegistrationTicketIsShortLivedAndDoesNotConsumeInvitation(t *testing.T) {
	service, database, keyring, now := newTestService(t)
	created := createInvite(t, database, keyring, now, "012345")
	result, err := service.RedeemCode(context.Background(), "012345", SessionMetadata{})
	if err != nil || result.Kind != "registration" || result.RegistrationTicket == "" ||
		!result.ExpiresAt.Equal(now.Add(5*time.Minute)) || result.Login != nil {
		t.Fatalf("registration code result = %#v %v", result, err)
	}
	stored, err := database.GetInvitationByID(context.Background(), created.ID)
	if err != nil || stored.UsedAt != nil {
		t.Fatalf("code was consumed before passkey registration: %#v %v", stored, err)
	}
	if _, err := service.BeginRegistration(context.Background(), RegistrationInput{
		RegistrationTicket: result.RegistrationTicket, Username: "ticket-user", DisplayName: "Ticket User",
	}); err != nil {
		t.Fatalf("ticket did not start passkey registration: %v", err)
	}
	if _, err := service.BeginRegistration(context.Background(), RegistrationInput{
		RegistrationTicket: result.RegistrationTicket, InvitationCode: "012345",
		Username: "ticket-user", DisplayName: "Ticket User",
	}); !errors.Is(err, ErrInvalidInvitation) {
		t.Fatalf("two registration proofs accepted: %v", err)
	}
	service.now = func() time.Time { return now.Add(5 * time.Minute) }
	if _, err := service.BeginRegistration(context.Background(), RegistrationInput{
		RegistrationTicket: result.RegistrationTicket, Username: "expired-ticket", DisplayName: "Ticket User",
	}); !errors.Is(err, ErrInvalidInvitation) {
		t.Fatalf("expired registration ticket accepted: %v", err)
	}
}

func TestLoginCodeCreatesScopedOneTimeRecoveryGrantButCannotAuthorizeOtherActions(t *testing.T) {
	service, database, keyring, now := newTestService(t)
	user := domain.User{ID: "usr_recovery", WebAuthnID: []byte("recovery-handle"), Username: "recovery",
		DisplayName: "Recovery", Role: domain.RoleUser, Status: domain.UserActive, CreatedAt: now, UpdatedAt: now}
	if err := database.CreateUser(context.Background(), user); err != nil {
		t.Fatal(err)
	}
	code := "987654"
	digest := keyring.InvitationDigest(code)
	if err := database.CreateInvitationWithBucket(context.Background(), domain.Invitation{
		ID: "inv_recovery", Kind: "login", TargetUserID: user.ID, CreatedAt: now,
		NotBefore: now, ExpiresAt: now.Add(10 * time.Minute),
	}, digest[:], keyring.InvitationBucket(code)); err != nil {
		t.Fatal(err)
	}
	result, err := service.RedeemCode(context.Background(), code, SessionMetadata{UserAgent: "test", IPAddress: "127.0.0.1"})
	if err != nil || result.Kind != "login" || result.Login == nil || result.Login.User.ID != user.ID ||
		result.RecoveryAuthorization == nil || result.RecoveryAuthorization.Token == "" {
		t.Fatalf("login code response = %#v %v", result, err)
	}
	if _, _, err := service.Authenticate(context.Background(), result.Login.SessionToken); err != nil {
		t.Fatalf("new session cannot authenticate: %v", err)
	}
	grant := result.RecoveryAuthorization.Token
	if scope, valid := authorizationTokenScope(grant); !valid || scope != AuthorizationScopeRecoveryPasskeyAdd {
		t.Fatal("login code yielded a broad or malformed grant")
	}
	if err := service.ConsumeCredentialAuthorization(context.Background(), user.ID, result.Login.Session.ID,
		grant, AuthorizationScopePasskeyManagement); !errors.Is(err, ErrInvalidAuthorization) {
		t.Fatalf("recovery grant authorized normal passkey management: %v", err)
	}
	first, err := service.BeginAddCredential(context.Background(), user.ID, result.Login.Session.ID, grant, "Replacement key")
	if err != nil {
		t.Fatalf("recovery grant failed to begin adding a passkey: %v", err)
	}
	// Consuming the ceremony without a WebAuthn finish simulates a canceled
	// authenticator prompt. It must not spend the separate recovery grant.
	ceremony, err := database.ConsumeWebAuthnCeremony(context.Background(), first.CeremonyToken, now)
	if err != nil || bytes.Contains(ceremony.PendingUserJSON, []byte(grant)) {
		t.Fatalf("recovery ceremony was not encrypted or cancellable: %v", err)
	}
	if _, err := service.BeginAddCredential(context.Background(), user.ID, result.Login.Session.ID, grant, "Retry key"); err != nil {
		t.Fatalf("recovery grant could not retry after cancellation: %v", err)
	}
	service.now = func() time.Time { return now.Add(2 * time.Minute) }
	if _, err := service.BeginAddCredential(context.Background(), user.ID, result.Login.Session.ID, grant, "Expired key"); !errors.Is(err, ErrInvalidAuthorization) {
		t.Fatalf("expired recovery grant started another ceremony: %v", err)
	}
	if _, err := service.RedeemCode(context.Background(), code, SessionMetadata{}); !errors.Is(err, ErrInvalidInvitation) {
		t.Fatalf("replayed login code = %v", err)
	}
}
