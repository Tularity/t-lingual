package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/secret"
	"github.com/descope/virtualwebauthn"
)

func TestCodeLoginCanceledPasskeyPromptCanRetryAndOnlyFinishConsumesRecoveryGrant(t *testing.T) {
	fixture := newAPIFixture(t)
	ctx := context.Background()
	now := time.Now().UTC()
	user := domain.User{ID: "usr_recovery_e2e", Username: "recovery-e2e", DisplayName: "Recovery",
		WebAuthnID: bytes.Repeat([]byte{42}, 64), Role: domain.RoleUser, Status: domain.UserActive,
		CreatedAt: now, UpdatedAt: now}
	if err := fixture.store.CreateUser(ctx, user); err != nil {
		t.Fatal(err)
	}
	keyring, err := secret.New(bytes.Repeat([]byte{6}, 32))
	if err != nil {
		t.Fatal(err)
	}
	const code = "345678"
	digest := keyring.InvitationDigest(code)
	if err := fixture.store.CreateInvitationWithBucket(ctx, domain.Invitation{
		ID: "inv_recovery_e2e", Kind: "login", TargetUserID: user.ID, CreatedAt: now,
		NotBefore: now, ExpiresAt: now.Add(10 * time.Minute),
	}, digest[:], keyring.InvitationBucket(code)); err != nil {
		t.Fatal(err)
	}
	codeResponse := passkeyE2ERequest(t, fixture, http.MethodPost, "/api/v1/auth/code", `{"code":"345678"}`, nil, "")
	if codeResponse.Code != http.StatusOK {
		t.Fatalf("recovery code login = %d %s", codeResponse.Code, codeResponse.Body.String())
	}
	var codeResult struct {
		RecoveryAuthorization struct {
			AuthorizationToken string `json:"authorizationToken"`
		} `json:"recoveryAuthorization"`
	}
	if err := json.Unmarshal(codeResponse.Body.Bytes(), &codeResult); err != nil || codeResult.RecoveryAuthorization.AuthorizationToken == "" {
		t.Fatalf("missing recovery grant: %#v %v", codeResult, err)
	}
	cookie := passkeyE2ESessionCookie(t, fixture, codeResponse)
	begin := func() *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/api/v1/passkeys/begin", strings.NewReader(`{"name":"Recovered key"}`))
		request.Header.Set("Origin", fixture.config.RPOrigins[0])
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set(passkeyAuthorizationHeader, codeResult.RecoveryAuthorization.AuthorizationToken)
		request.AddCookie(cookie)
		response := httptest.NewRecorder()
		fixture.handler.ServeHTTP(response, request)
		return response
	}
	first := begin()
	if first.Code != http.StatusOK {
		t.Fatalf("first recovery begin = %d %s", first.Code, first.Body.String())
	}
	// The first WebAuthn prompt is canceled by the browser. A second fresh
	// ceremony must be allowed while the original two-minute grant is valid.
	second := begin()
	if second.Code != http.StatusOK {
		t.Fatalf("retry after canceled prompt = %d %s", second.Code, second.Body.String())
	}
	secondBegin := decodePasskeyBegin(t, second)
	options, err := virtualwebauthn.ParseAttestationOptions(string(secondBegin.Options))
	if err != nil {
		t.Fatal(err)
	}
	rp := virtualwebauthn.RelyingParty{Name: fixture.config.RPDisplayName, ID: fixture.config.RPID, Origin: fixture.config.RPOrigins[0]}
	authenticator := virtualwebauthn.NewAuthenticatorWithOptions(virtualwebauthn.AuthenticatorOptions{
		ClientExtensionResults: map[string]any{"credProps": map[string]any{"rk": true}},
	})
	credential := virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2)
	attestation := virtualwebauthn.CreateAttestationResponse(rp, authenticator, credential, *options)
	finish := passkeyE2ERequest(t, fixture, http.MethodPost, "/api/v1/passkeys/finish", attestation, cookie, secondBegin.CeremonyToken)
	if finish.Code != http.StatusCreated {
		t.Fatalf("recovery finish = %d %s", finish.Code, finish.Body.String())
	}
	credentials, err := fixture.store.ListCredentials(ctx, user.ID)
	if err != nil || len(credentials) != 1 {
		t.Fatalf("recovery did not persist exactly one key: %#v %v", credentials, err)
	}
	if replay := begin(); replay.Code != http.StatusForbidden {
		t.Fatalf("committed recovery reused grant: %d %s", replay.Code, replay.Body.String())
	}
}
