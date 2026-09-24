package auth

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/store"
	"github.com/go-webauthn/webauthn/webauthn"
)

func TestAuthorizationScopesAreRestrictedAndCanonical(t *testing.T) {
	role := domain.RoleAdmin
	status := domain.UserDisabled
	tests := []struct {
		name  string
		scope string
		want  string
		valid bool
	}{
		{name: "omitted default", scope: "", want: AuthorizationScopePasskeyManagement, valid: true},
		{name: "explicit default", scope: AuthorizationScopePasskeyManagement, want: AuthorizationScopePasskeyManagement, valid: true},
		{name: "add-passkey recovery only", scope: AuthorizationScopeRecoveryPasskeyAdd, want: AuthorizationScopeRecoveryPasskeyAdd, valid: true},
		{name: "site settings digest", scope: "admin:site-settings:update:" + strings.Repeat("a", 64), want: "admin:site-settings:update:" + strings.Repeat("a", 64), valid: true},
		{name: "default invitation expiry", scope: "admin:invitation:create:0", want: "admin:invitation:create:0", valid: true},
		{name: "explicit invitation expiry", scope: "admin:invitation:create:720", want: "admin:invitation:create:720", valid: true},
		{name: "invitation target", scope: "admin:invitation:revoke:inv_abc123", want: "admin:invitation:revoke:inv_abc123", valid: true},
		{name: "user payload", scope: "admin:user:update:usr_abc123:admin:disabled", want: "admin:user:update:usr_abc123:admin:disabled", valid: true},
		{name: "leading zero hours", scope: "admin:invitation:create:02"},
		{name: "excessive hours", scope: "admin:invitation:create:721"},
		{name: "foreign operation", scope: "admin:audit:delete:all"},
		{name: "target delimiter", scope: "admin:invitation:revoke:inv_bad:target"},
		{name: "empty update", scope: "admin:user:update:usr_abc123:-:-"},
		{name: "unknown role", scope: "admin:user:update:usr_abc123:owner:-"},
		{name: "surrounding whitespace", scope: " admin:invitation:create:2"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := NormalizeAuthorizationScope(test.scope)
			if test.valid {
				if err != nil || got != test.want {
					t.Fatalf("NormalizeAuthorizationScope(%q) = %q, %v", test.scope, got, err)
				}
				return
			}
			if !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("NormalizeAuthorizationScope(%q) error = %v", test.scope, err)
			}
		})
	}

	updateScope, err := AdminUserUpdateAuthorizationScope("usr_target", &role, &status)
	if err != nil || updateScope != "admin:user:update:usr_target:admin:disabled" {
		t.Fatalf("AdminUserUpdateAuthorizationScope = %q, %v", updateScope, err)
	}
}

func TestSiteSettingsScopeMatchesCompactBrowserJSONIncludingMarkdownSymbols(t *testing.T) {
	markdown := "> Ask <admin> & use \"code\"\nNext line."
	// This is the exact UTF-8 output of JSON.stringify({registrationHelpMarkdown,
	// codeAttemptsPerMinute}) with that insertion order and no extra spaces.
	compact := `{"registrationHelpMarkdown":"> Ask <admin> & use \"code\"\nNext line.","codeAttemptsPerMinute":3}`
	hash := sha256.Sum256([]byte(compact))
	want := fmt.Sprintf("admin:site-settings:update:%x", hash)
	got, err := AdminSiteSettingsAuthorizationScope(markdown, 3)
	if err != nil || got != want {
		t.Fatalf("site settings scope = %q %v, want %q", got, err, want)
	}
}

func TestScopedAuthorizationGrantBindsScopeBeforeAtomicConsumption(t *testing.T) {
	service, database, _, now := newTestService(t)
	ctx := context.Background()
	user, browserSession := createAuthorizationOwner(t, database, now, time.Hour)
	createScope, err := AdminInvitationCreateAuthorizationScope(2)
	if err != nil {
		t.Fatal(err)
	}
	wrongScope, err := AdminInvitationCreateAuthorizationScope(3)
	if err != nil {
		t.Fatal(err)
	}
	token, err := NewScopedAuthorizationToken(createScope)
	if err != nil {
		t.Fatal(err)
	}
	createAuthorizationGrant(t, database, now, user.ID, browserSession.ID, "grant_scoped", token)

	if err := service.ConsumeCredentialAuthorization(
		ctx, user.ID, browserSession.ID, token, wrongScope,
	); !errors.Is(err, ErrInvalidAuthorization) {
		t.Fatalf("wrong scope error = %v, want ErrInvalidAuthorization", err)
	}
	if err := service.ConsumeCredentialAuthorization(
		ctx, user.ID, browserSession.ID, token, createScope,
	); err != nil {
		t.Fatalf("scope mismatch consumed intended grant: %v", err)
	}
	if err := service.ConsumeCredentialAuthorization(
		ctx, user.ID, browserSession.ID, token, createScope,
	); !errors.Is(err, ErrInvalidAuthorization) {
		t.Fatalf("grant replay error = %v, want ErrInvalidAuthorization", err)
	}
}

func TestCredentialAuthorizationPreservesLegacyPasskeyManagementGrant(t *testing.T) {
	service, database, _, now := newTestService(t)
	user, browserSession := createAuthorizationOwner(t, database, now, time.Hour)
	const legacyToken = "legacy-passkey-management-grant-with-enough-entropy"
	createAuthorizationGrant(t, database, now, user.ID, browserSession.ID, "grant_legacy", legacyToken)
	if err := service.ConsumeCredentialAuthorization(
		context.Background(), user.ID, browserSession.ID, legacyToken,
		AuthorizationScopePasskeyManagement,
	); err != nil {
		t.Fatalf("legacy passkey-management grant rejected: %v", err)
	}
}

func TestCredentialAuthorizationRejectsLogoutAndSessionExpiry(t *testing.T) {
	t.Run("logout", func(t *testing.T) {
		service, database, _, now := newTestService(t)
		user, browserSession := createAuthorizationOwner(t, database, now, time.Hour)
		scope, _ := AdminInvitationCreateAuthorizationScope(1)
		token, _ := NewScopedAuthorizationToken(scope)
		createAuthorizationGrant(t, database, now, user.ID, browserSession.ID, "grant_logout", token)
		if err := database.DeleteBrowserSession(
			context.Background(), "authorization-owner-session-token-with-enough-entropy",
		); err != nil {
			t.Fatal(err)
		}
		if err := service.ConsumeCredentialAuthorization(
			context.Background(), user.ID, browserSession.ID, token, scope,
		); !errors.Is(err, ErrInvalidAuthorization) {
			t.Fatalf("logged-out grant error = %v", err)
		}
	})

	t.Run("expiry", func(t *testing.T) {
		service, database, _, now := newTestService(t)
		clock := now
		service.now = func() time.Time { return clock }
		user, browserSession := createAuthorizationOwner(t, database, now, time.Minute)
		scope, _ := AdminInvitationCreateAuthorizationScope(1)
		token, _ := NewScopedAuthorizationToken(scope)
		createAuthorizationGrant(t, database, now, user.ID, browserSession.ID, "grant_expiry", token)
		clock = now.Add(90 * time.Second)
		if err := service.ConsumeCredentialAuthorization(
			context.Background(), user.ID, browserSession.ID, token, scope,
		); !errors.Is(err, ErrInvalidAuthorization) {
			t.Fatalf("expired-session grant error = %v", err)
		}
	})
}

func TestAuthorizationScopeIsSealedIntoPendingCeremony(t *testing.T) {
	service, database, keyring, now := newTestService(t)
	user, browserSession := createAuthorizationOwner(t, database, now, time.Hour)
	credential := webauthn.Credential{ID: []byte("authorization-owner-credential")}
	credentialJSON, err := json.Marshal(credential)
	if err != nil {
		t.Fatal(err)
	}
	sealedCredential, err := keyring.Seal(credentialPurpose("cred_authorization_owner"), credentialJSON)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.CreateCredential(context.Background(), domain.Credential{
		ID: "cred_authorization_owner", UserID: user.ID, CredentialID: credential.ID,
		Name: "Authorization passkey", CredentialJSON: sealedCredential, CreatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	scope, _ := AdminInvitationRevokeAuthorizationScope("inv_sealed_scope")
	result, err := service.BeginCredentialAuthorizationForScope(
		context.Background(), user.ID, browserSession.ID, scope,
	)
	if err != nil {
		t.Fatal(err)
	}
	ceremony, err := database.ConsumeWebAuthnCeremony(context.Background(), result.CeremonyToken, now)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(ceremony.PendingUserJSON, []byte(scope)) {
		t.Fatal("authorization scope was persisted without encryption")
	}
	opened, err := keyring.Open(ceremonyPendingPurpose(ceremony.ID), ceremony.PendingUserJSON)
	if err != nil {
		t.Fatal(err)
	}
	var pending pendingRegistration
	if err := json.Unmarshal(opened, &pending); err != nil {
		t.Fatal(err)
	}
	if pending.AuthorizationScope != scope || pending.BrowserSessionID != browserSession.ID {
		t.Fatalf("sealed pending authorization = %#v", pending)
	}
}

func createAuthorizationOwner(
	t *testing.T,
	database *store.Store,
	now time.Time,
	sessionLifetime time.Duration,
) (domain.User, domain.BrowserSession) {
	t.Helper()
	user := domain.User{
		ID: "usr_authorization_owner", WebAuthnID: bytes.Repeat([]byte{8}, 64),
		Username: "authorization-owner", DisplayName: "Authorization Owner",
		Role: domain.RoleAdmin, Status: domain.UserActive, CreatedAt: now, UpdatedAt: now,
	}
	if err := database.CreateUser(context.Background(), user); err != nil {
		t.Fatal(err)
	}
	browserSession := domain.BrowserSession{
		ID: "ses_authorization_owner", UserID: user.ID, CreatedAt: now,
		ExpiresAt: now.Add(sessionLifetime), LastSeen: now,
	}
	if err := database.CreateBrowserSession(
		context.Background(), browserSession,
		"authorization-owner-session-token-with-enough-entropy",
	); err != nil {
		t.Fatal(err)
	}
	return user, browserSession
}

func createAuthorizationGrant(
	t *testing.T,
	database *store.Store,
	now time.Time,
	userID string,
	browserSessionID string,
	grantID string,
	token string,
) {
	t.Helper()
	if err := database.CreateActionGrant(context.Background(), store.ActionGrant{
		ID: grantID, UserID: userID, BrowserSessionID: browserSessionID,
		Action: store.ActionPasskeyManagement, CreatedAt: now, ExpiresAt: now.Add(2 * time.Minute),
	}, token); err != nil {
		t.Fatal(err)
	}
}
