package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/config"
	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/secret"
	"github.com/Tularity/t-lingual/internal/store"
	"github.com/go-webauthn/webauthn/webauthn"
)

func newTestService(t *testing.T) (*Service, *store.Store, *secret.Keyring, time.Time) {
	t.Helper()
	database, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	keyring, err := secret.New(bytes.Repeat([]byte{9}, 32))
	if err != nil {
		t.Fatal(err)
	}
	service, err := New(config.Config{
		RPID:          "localhost",
		RPDisplayName: "t-lingual test",
		RPOrigins:     []string{"http://localhost:8080"},
		CeremonyTTL:   5 * time.Minute,
		SessionTTL:    24 * time.Hour,
	}, database, keyring)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, time.September, 1, 3, 0, 0, 0, time.UTC)
	service.now = func() time.Time { return now }
	return service, database, keyring, now
}

func TestConfigureUserRevokerIsThreadSafeAndOneTime(t *testing.T) {
	service, _, _, _ := newTestService(t)
	var callbackCalls atomic.Int32
	var wrongUser atomic.Bool
	revoker := UserRevokeFunc(func(userID string) {
		if userID != "usr_configured" {
			wrongUser.Store(true)
		}
		callbackCalls.Add(1)
	})

	const contenders = 16
	start := make(chan struct{})
	results := make(chan error, contenders)
	var wait sync.WaitGroup
	for range contenders {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			results <- service.ConfigureUserRevoker(revoker)
		}()
	}
	close(start)
	wait.Wait()
	close(results)
	succeeded, alreadySet := 0, 0
	for err := range results {
		switch {
		case err == nil:
			succeeded++
		case errors.Is(err, ErrUserRevokerSet):
			alreadySet++
		default:
			t.Fatalf("unexpected configure error: %v", err)
		}
	}
	if succeeded != 1 || alreadySet != contenders-1 {
		t.Fatalf("configure successes=%d alreadySet=%d", succeeded, alreadySet)
	}
	service.revokeLiveUser("usr_configured")
	if callbackCalls.Load() != 1 || wrongUser.Load() {
		t.Fatalf("callback calls=%d wrongUser=%v", callbackCalls.Load(), wrongUser.Load())
	}
}

func TestConfigureNilUserRevokerIsSafeAndFinal(t *testing.T) {
	service, _, _, _ := newTestService(t)
	if err := service.ConfigureUserRevoker(nil); err != nil {
		t.Fatal(err)
	}
	service.revokeLiveUser("usr_no_live")
	if err := service.ConfigureUserRevoker(func(string) {}); !errors.Is(err, ErrUserRevokerSet) {
		t.Fatalf("nil configuration was replaced: %v", err)
	}
}

func createInvite(t *testing.T, database *store.Store, keyring *secret.Keyring, now time.Time, code string) domain.Invitation {
	t.Helper()
	invitation := domain.Invitation{
		ID:        "inv_" + code,
		CreatedAt: now.Add(-time.Minute),
		ExpiresAt: now.Add(time.Hour),
	}
	digest := keyring.InvitationDigest(code)
	if err := database.CreateInvitationWithBucket(
		context.Background(), invitation, digest[:], keyring.InvitationBucket(code),
	); err != nil {
		t.Fatal(err)
	}
	return invitation
}

func TestBeginRegistrationRequiresValidInviteAndDiscoverablePasskey(t *testing.T) {
	service, database, keyring, now := newTestService(t)
	createInvite(t, database, keyring, now, "012345")
	result, err := service.BeginRegistration(context.Background(), RegistrationInput{
		InvitationCode: "012345",
		Username:       "tester.one",
		DisplayName:    "测试 User",
		CredentialName: "Laptop",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.CeremonyToken == "" || !result.ExpiresAt.After(now) {
		t.Fatalf("unexpected begin result: %#v", result)
	}
	encoded, err := json.Marshal(result.Options)
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{`"residentKey":"required"`, `"userVerification":"required"`} {
		if !bytes.Contains(encoded, []byte(required)) {
			t.Fatalf("passkey options omitted %s: %s", required, encoded)
		}
	}

	ceremony, err := database.ConsumeWebAuthnCeremony(context.Background(), result.CeremonyToken, now)
	if err != nil {
		t.Fatal(err)
	}
	if ceremony.InvitationID != nil {
		t.Fatalf("begin ceremony exposed invitation validity: %#v", ceremony)
	}
	if bytes.Contains(ceremony.SessionJSON, []byte("challenge")) || bytes.Contains(ceremony.PendingUserJSON, []byte("tester.one")) {
		t.Fatal("ceremony state was stored without encryption")
	}
	if _, err := database.ConsumeWebAuthnCeremony(context.Background(), result.CeremonyToken, now); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("expected one-time ceremony token, got %v", err)
	}
}

func TestBeginRegistrationReturnsStableInvalidInputErrors(t *testing.T) {
	service, _, _, _ := newTestService(t)
	tests := []struct {
		name  string
		input RegistrationInput
	}{
		{
			name: "username",
			input: RegistrationInput{
				InvitationCode: "999999", Username: "x", DisplayName: "Valid User",
			},
		},
		{
			name: "display name",
			input: RegistrationInput{
				InvitationCode: "999999", Username: "valid-user", DisplayName: "Invalid\x00Name",
			},
		},
		{
			name: "credential name",
			input: RegistrationInput{
				InvitationCode: "999999", Username: "valid-user", DisplayName: "Valid User",
				CredentialName: "Invalid\x00Passkey",
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := service.BeginRegistration(context.Background(), test.input); !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("BeginRegistration error = %v, want ErrInvalidInput", err)
			}
		})
	}
}

func TestBeginAddCredentialValidatesNameBeforeConsumingActionGrant(t *testing.T) {
	service, database, _, now := newTestService(t)
	ctx := context.Background()
	user := domain.User{
		ID: "usr_invalid_credential_name", WebAuthnID: bytes.Repeat([]byte{3}, 64),
		Username: "credential-owner", DisplayName: "Credential Owner",
		Role: domain.RoleUser, Status: domain.UserActive, CreatedAt: now, UpdatedAt: now,
	}
	if err := database.CreateUser(ctx, user); err != nil {
		t.Fatal(err)
	}
	browserSession := domain.BrowserSession{
		ID: "ses_invalid_credential_name", UserID: user.ID, CreatedAt: now,
		ExpiresAt: now.Add(time.Hour), LastSeen: now,
	}
	if err := database.CreateBrowserSession(ctx, browserSession, "invalid-name-browser-session-token-with-enough-entropy"); err != nil {
		t.Fatal(err)
	}
	const grantToken = "invalid-name-action-grant-token-with-enough-entropy"
	if err := database.CreateActionGrant(ctx, store.ActionGrant{
		ID: "grant_invalid_credential_name", UserID: user.ID, BrowserSessionID: browserSession.ID,
		Action: store.ActionPasskeyManagement, CreatedAt: now, ExpiresAt: now.Add(2 * time.Minute),
	}, grantToken); err != nil {
		t.Fatal(err)
	}

	if _, err := service.BeginAddCredential(
		ctx, user.ID, browserSession.ID, grantToken, "Invalid\x00Passkey",
	); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("BeginAddCredential error = %v, want ErrInvalidInput", err)
	}
	if err := database.ConsumeActionGrant(
		ctx, grantToken, user.ID, browserSession.ID, store.ActionPasskeyManagement, now,
	); err != nil {
		t.Fatalf("invalid credential name consumed the action grant: %v", err)
	}
}

func TestBeginRegistrationDoesNotRevealInviteState(t *testing.T) {
	service, database, _, now := newTestService(t)
	for _, code := range []string{"12345", "abcdef"} {
		_, err := service.BeginRegistration(context.Background(), RegistrationInput{
			InvitationCode: code,
			Username:       "valid-user",
			DisplayName:    "Valid User",
		})
		if !errors.Is(err, ErrInvalidInvitation) {
			t.Fatalf("malformed code %q returned %v", code, err)
		}
	}

	result, err := service.BeginRegistration(context.Background(), RegistrationInput{
		InvitationCode: "999999",
		Username:       "valid-user",
		DisplayName:    "Valid User",
	})
	if err != nil || result.CeremonyToken == "" {
		t.Fatalf("unknown six-digit code did not receive a ceremony: %#v, %v", result, err)
	}
	ceremony, err := database.ConsumeWebAuthnCeremony(context.Background(), result.CeremonyToken, now)
	if err != nil {
		t.Fatal(err)
	}
	if ceremony.InvitationID != nil {
		t.Fatalf("unknown code ceremony was bound to an invitation: %#v", ceremony)
	}
	if bytes.Contains(ceremony.PendingUserJSON, []byte("invalidInviteBucket")) {
		t.Fatal("invalid-code state was stored without encryption")
	}
}

func TestBeginRegistrationDoesNotExposeUsernameAvailability(t *testing.T) {
	service, database, _, now := newTestService(t)
	user := domain.User{
		ID: "usr_taken_unknown", WebAuthnID: bytes.Repeat([]byte{7}, 64),
		Username: "taken-unknown", DisplayName: "Taken", Role: domain.RoleUser,
		Status: domain.UserActive, CreatedAt: now, UpdatedAt: now,
	}
	if err := database.CreateUser(context.Background(), user); err != nil {
		t.Fatal(err)
	}
	for _, code := range []string{"999999", "888888"} {
		result, err := service.BeginRegistration(context.Background(), RegistrationInput{
			InvitationCode: code,
			Username:       "TAKEN-UNKNOWN",
			DisplayName:    "Other",
		})
		if err != nil || result.CeremonyToken == "" {
			t.Fatalf("code %q exposed username availability: %#v, %v", code, result, err)
		}
	}
}

func TestBeginRegistrationDefersCaseInsensitiveUsernameCollisionUntilFinish(t *testing.T) {
	service, database, keyring, now := newTestService(t)
	createInvite(t, database, keyring, now, "111111")
	user := domain.User{
		ID:          "usr_existing",
		WebAuthnID:  bytes.Repeat([]byte{4}, 64),
		Username:    "Taken.Name",
		DisplayName: "Existing",
		Role:        domain.RoleUser,
		Status:      domain.UserActive,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if err := database.CreateUser(context.Background(), user); err != nil {
		t.Fatal(err)
	}
	result, err := service.BeginRegistration(context.Background(), RegistrationInput{
		InvitationCode: "111111",
		Username:       "taken.name",
		DisplayName:    "Other",
	})
	if err != nil || result.CeremonyToken == "" {
		t.Fatalf("begin exposed username collision: %#v, %v", result, err)
	}
}

func TestBeginLoginIsUsernamelessAndRequiresVerification(t *testing.T) {
	service, _, _, _ := newTestService(t)
	result, err := service.BeginLogin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(result.Options)
	if !bytes.Contains(encoded, []byte(`"userVerification":"required"`)) {
		t.Fatalf("login does not require user verification: %s", encoded)
	}
	if bytes.Contains(encoded, []byte(`"allowCredentials":[{`)) {
		t.Fatalf("discoverable login unexpectedly restricts credentials: %s", encoded)
	}
}

func TestAuthenticateRejectsDisabledAccount(t *testing.T) {
	service, database, _, now := newTestService(t)
	user := domain.User{
		ID:          "usr_active",
		WebAuthnID:  bytes.Repeat([]byte{5}, 64),
		Username:    "active-user",
		DisplayName: "Active User",
		Role:        domain.RoleUser,
		Status:      domain.UserActive,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if err := database.CreateUser(context.Background(), user); err != nil {
		t.Fatal(err)
	}
	login, err := service.issueSession(context.Background(), user, SessionMetadata{UserAgent: strings.Repeat("x", 600), IPAddress: "127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	got, _, err := service.Authenticate(context.Background(), login.SessionToken)
	if err != nil || got.ID != user.ID {
		t.Fatalf("active account did not authenticate: %#v %v", got, err)
	}
	if err := database.UpdateUserStatus(context.Background(), user.ID, domain.UserDisabled, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := service.Authenticate(context.Background(), login.SessionToken); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("disabled account retained a valid session: %v", err)
	}
}

func TestCeremonyKindMismatchIsRejected(t *testing.T) {
	service, _, _, _ := newTestService(t)
	result, err := service.BeginLogin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := service.consumeCeremony(context.Background(), result.CeremonyToken, store.CeremonyRegistration); !errors.Is(err, ErrInvalidCeremony) {
		t.Fatalf("expected ceremony kind mismatch, got %v", err)
	}
}

func TestConcurrentEqualPasskeyCountersTriggerCASCloneProtection(t *testing.T) {
	service, database, keyring, now := newTestService(t)
	ctx := context.Background()
	user := domain.User{
		ID: "usr_counter_clone", WebAuthnID: bytes.Repeat([]byte{8}, 64),
		Username: "counter-clone", DisplayName: "Counter Clone",
		Role: domain.RoleUser, Status: domain.UserActive, CreatedAt: now, UpdatedAt: now,
	}
	if err := database.CreateUser(ctx, user); err != nil {
		t.Fatal(err)
	}
	original := webauthn.Credential{ID: []byte("counter-clone-credential")}
	original.Authenticator.SignCount = 7
	encoded, err := json.Marshal(original)
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := keyring.Seal(credentialPurpose("cred_counter_clone"), encoded)
	if err != nil {
		t.Fatal(err)
	}
	record := domain.Credential{
		ID: "cred_counter_clone", UserID: user.ID, CredentialID: original.ID,
		Name: "Hardware passkey", CredentialJSON: sealed, CreatedAt: now,
	}
	if err := database.CreateCredential(ctx, record); err != nil {
		t.Fatal(err)
	}
	browser := domain.BrowserSession{
		ID: "bs_counter_clone", UserID: user.ID, CreatedAt: now,
		ExpiresAt: now.Add(time.Hour), LastSeen: now,
	}
	const browserToken = "counter-clone-browser-token-with-enough-entropy"
	if err := database.CreateBrowserSession(ctx, browser, browserToken); err != nil {
		t.Fatal(err)
	}
	var liveRevocations atomic.Int32
	var wrongRevocationUser atomic.Bool
	if err := service.ConfigureUserRevoker(func(userID string) {
		if userID != user.ID {
			wrongRevocationUser.Store(true)
		}
		liveRevocations.Add(1)
	}); err != nil {
		t.Fatal(err)
	}

	const contenders = 2
	start := make(chan struct{})
	results := make(chan error, contenders)
	var wait sync.WaitGroup
	for range contenders {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			asserted := original
			asserted.Authenticator.SignCount = 8
			results <- service.updateCredentialAfterAssertion(ctx, user.ID, record, &asserted, now.Add(time.Minute))
		}()
	}
	close(start)
	wait.Wait()
	close(results)
	succeeded, rejected := 0, 0
	for err := range results {
		switch {
		case err == nil:
			succeeded++
		case errors.Is(err, ErrInvalidPasskey):
			rejected++
		default:
			t.Fatalf("unexpected counter update result: %v", err)
		}
	}
	if succeeded != 1 || rejected != 1 {
		t.Fatalf("counter update successes=%d clone rejections=%d", succeeded, rejected)
	}
	if liveRevocations.Load() != 1 || wrongRevocationUser.Load() {
		t.Fatalf(
			"clone live revocations=%d wrongUser=%v",
			liveRevocations.Load(), wrongRevocationUser.Load(),
		)
	}
	if _, err := database.LookupBrowserSession(ctx, browserToken, now.Add(time.Minute)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("clone protection did not revoke browser sessions: %v", err)
	}
	quarantined, err := database.GetCredentialByCredentialID(ctx, record.CredentialID)
	if err != nil || quarantined.CompromisedAt == nil {
		t.Fatalf("clone protection did not quarantine credential: %#v, %v", quarantined, err)
	}
	retry := original
	retry.Authenticator.SignCount = 9
	if err := service.updateCredentialAfterAssertion(ctx, user.ID, quarantined, &retry, now.Add(2*time.Minute)); !errors.Is(err, ErrInvalidPasskey) {
		t.Fatalf("quarantined credential advanced past stored counter: %v", err)
	}
	if _, err := service.issueSessionForCredential(
		ctx, user, record.CredentialID, SessionMetadata{IPAddress: "192.0.2.9"},
	); !errors.Is(err, ErrInvalidPasskey) {
		t.Fatalf("quarantined credential created a post-revocation session: %v", err)
	}
}

func TestCloneWarningRevokesLiveOnlyAfterCommittedQuarantine(t *testing.T) {
	service, database, _, now := newTestService(t)
	ctx := context.Background()
	user := domain.User{
		ID: "usr_clone_callback", WebAuthnID: bytes.Repeat([]byte{3}, 64),
		Username: "clone-callback", DisplayName: "Clone Callback",
		Role: domain.RoleUser, Status: domain.UserActive, CreatedAt: now, UpdatedAt: now,
	}
	if err := database.CreateUser(ctx, user); err != nil {
		t.Fatal(err)
	}
	credential := domain.Credential{
		ID: "cred_clone_callback", UserID: user.ID,
		CredentialID: []byte("clone-callback-credential"),
		Name:         "Passkey", CredentialJSON: []byte("{}"), CreatedAt: now,
	}
	if err := database.CreateCredential(ctx, credential); err != nil {
		t.Fatal(err)
	}
	const token = "clone-callback-browser-token-with-entropy"
	if err := database.CreateBrowserSession(ctx, domain.BrowserSession{
		ID: "ses_clone_callback", UserID: user.ID, CreatedAt: now,
		ExpiresAt: now.Add(time.Hour), LastSeen: now,
	}, token); err != nil {
		t.Fatal(err)
	}

	callbackState := make(chan string, 2)
	if err := service.ConfigureUserRevoker(func(userID string) {
		if userID != user.ID {
			callbackState <- "wrong user"
			return
		}
		stored, err := database.GetCredentialByCredentialID(ctx, credential.CredentialID)
		if err != nil || stored.CompromisedAt == nil {
			callbackState <- "credential was not committed as compromised"
			return
		}
		if _, err := database.LookupBrowserSession(ctx, token, now.Add(time.Minute)); !errors.Is(err, store.ErrNotFound) {
			callbackState <- "browser session still existed"
			return
		}
		callbackState <- ""
	}); err != nil {
		t.Fatal(err)
	}
	if err := service.handleCredentialCloneWarning(
		ctx, user.ID, credential.ID, now.Add(time.Minute),
	); err != nil {
		t.Fatal(err)
	}
	if state := <-callbackState; state != "" {
		t.Fatalf("callback observed pre-commit state: %s", state)
	}
	select {
	case state := <-callbackState:
		t.Fatalf("successful clone transaction invoked callback twice: %q", state)
	default:
	}

	if err := service.handleCredentialCloneWarning(
		ctx, user.ID, "cred_missing_clone_callback", now.Add(2*time.Minute),
	); err == nil {
		t.Fatal("missing clone-warning credential unexpectedly committed")
	}
	select {
	case state := <-callbackState:
		t.Fatalf("failed clone transaction invoked callback: %q", state)
	default:
	}
}
