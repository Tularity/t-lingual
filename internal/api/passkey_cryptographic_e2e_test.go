package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/auth"
	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/secret"
	"github.com/Tularity/t-lingual/internal/store"
	"github.com/descope/virtualwebauthn"
	"github.com/go-webauthn/webauthn/webauthn"
)

// TestPasskeyCryptographicRegistrationLogoutAndLogin exercises the public HTTP
// contract with an actual keypair, attestation object, authenticator data, and
// assertion signature. This deliberately complements the focused error-path
// tests: a permissive stub cannot make this round trip pass.
func TestPasskeyCryptographicRegistrationLogoutAndLogin(t *testing.T) {
	fixture := newAPIFixture(t)
	ctx := context.Background()

	// newAPIFixture uses this deterministic master key. Recreating the keyring
	// lets the test provision an invitation and inspect encrypted authenticator
	// state without exposing either capability through production APIs.
	keyring, err := secret.New(bytes.Repeat([]byte{6}, 32))
	if err != nil {
		t.Fatal(err)
	}
	const invitationCode = "654321"
	now := time.Now().UTC()
	invitation := domain.Invitation{
		ID:        "inv_virtual_webauthn_round_trip",
		CreatedAt: now.Add(-time.Minute),
		ExpiresAt: now.Add(time.Hour),
	}
	digest := keyring.InvitationDigest(invitationCode)
	if err := fixture.store.CreateInvitationWithBucket(
		ctx, invitation, digest[:], keyring.InvitationBucket(invitationCode),
	); err != nil {
		t.Fatal(err)
	}

	rp := virtualwebauthn.RelyingParty{
		Name:   fixture.config.RPDisplayName,
		ID:     fixture.config.RPID,
		Origin: fixture.config.RPOrigins[0],
	}
	authenticator := virtualwebauthn.NewAuthenticatorWithOptions(
		virtualwebauthn.AuthenticatorOptions{
			ClientExtensionResults: map[string]any{
				"credProps": map[string]any{"rk": true},
			},
		},
	)
	credential := virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2)

	registrationBegin := passkeyE2ERequest(
		t,
		fixture,
		http.MethodPost,
		"/api/v1/auth/register/begin",
		`{"invitationCode":"654321","username":"crypto-user","displayName":"Crypto User","credentialName":"Virtual platform passkey"}`,
		nil,
		"",
	)
	if registrationBegin.Code != http.StatusOK {
		t.Fatalf("begin registration response %d: %s", registrationBegin.Code, registrationBegin.Body.String())
	}
	beginRegistration := decodePasskeyBegin(t, registrationBegin)
	attestationOptions, err := virtualwebauthn.ParseAttestationOptions(string(beginRegistration.Options))
	if err != nil {
		t.Fatalf("parse registration options: %v\n%s", err, beginRegistration.Options)
	}
	if attestationOptions.RelyingPartyID != rp.ID || attestationOptions.RelyingPartyName != rp.Name {
		t.Fatalf("unexpected relying party options: %#v", attestationOptions)
	}
	if attestationOptions.UserName != "crypto-user" || attestationOptions.UserDisplayName != "Crypto User" {
		t.Fatalf("unexpected registration user options: %#v", attestationOptions)
	}
	if len(attestationOptions.UserID) != 64 {
		t.Fatalf("user handle length = %d, want 64", len(attestationOptions.UserID))
	}
	if credential.IsExcludedForAttestation(*attestationOptions) {
		t.Fatal("new virtual credential was unexpectedly excluded")
	}

	attestation := virtualwebauthn.CreateAttestationResponse(
		rp, authenticator, credential, *attestationOptions,
	)
	registrationFinish := passkeyE2ERequest(
		t,
		fixture,
		http.MethodPost,
		"/api/v1/auth/register/finish",
		attestation,
		nil,
		beginRegistration.CeremonyToken,
	)
	if registrationFinish.Code != http.StatusOK {
		t.Fatalf("finish registration response %d: %s", registrationFinish.Code, registrationFinish.Body.String())
	}
	registered := decodePasskeyFinish(t, registrationFinish)
	if registered.OnboardingComplete == nil || *registered.OnboardingComplete {
		t.Fatalf("new registration omitted pending onboarding state: %#v", registered.OnboardingComplete)
	}
	if registered.User.Username != "crypto-user" || registered.User.Role != domain.RoleUser || registered.User.Status != domain.UserActive {
		t.Fatalf("unexpected registered user: %#v", registered.User)
	}
	registrationCookie := passkeyE2ESessionCookie(t, fixture, registrationFinish)
	if !registrationCookie.HttpOnly || registrationCookie.SameSite != http.SameSiteStrictMode || registrationCookie.Path != "/" || registrationCookie.MaxAge < 1 {
		t.Fatalf("unsafe registration session cookie: %#v", registrationCookie)
	}
	registeredUser, registrationSession, err := fixture.auth.Authenticate(ctx, registrationCookie.Value)
	if err != nil {
		t.Fatalf("authenticate registration session: %v", err)
	}
	if registeredUser.ID != registered.User.ID || registrationSession.UserID != registered.User.ID {
		t.Fatalf("registration session/user mismatch: user=%#v session=%#v", registeredUser, registrationSession)
	}
	if !bytes.Equal(registeredUser.WebAuthnID, []byte(attestationOptions.UserID)) {
		t.Fatal("stored discoverable user handle differs from registration options")
	}

	usedInvitation, err := fixture.store.GetInvitationByID(ctx, invitation.ID)
	if err != nil {
		t.Fatal(err)
	}
	if usedInvitation.UsedAt == nil || usedInvitation.UsedBy == nil || *usedInvitation.UsedBy != registered.User.ID {
		t.Fatalf("registration did not atomically consume invitation: %#v", usedInvitation)
	}
	storedCredential := passkeyE2EStoredCredential(t, fixture.store, keyring, registered.User.ID)
	if !bytes.Equal(storedCredential.record.CredentialID, credential.ID) {
		t.Fatal("stored credential ID differs from attested credential")
	}
	if storedCredential.authenticator.Authenticator.SignCount != 0 {
		t.Fatalf("registration signature counter = %d, want 0", storedCredential.authenticator.Authenticator.SignCount)
	}

	me := passkeyE2ERequest(t, fixture, http.MethodGet, "/api/v1/auth/me", "", registrationCookie, "")
	if me.Code != http.StatusOK || !strings.Contains(me.Body.String(), `"username":"crypto-user"`) {
		t.Fatalf("registration cookie did not authenticate /me: %d %s", me.Code, me.Body.String())
	}
	logout := passkeyE2ERequest(t, fixture, http.MethodPost, "/api/v1/auth/logout", `{}`, registrationCookie, "")
	if logout.Code != http.StatusNoContent {
		t.Fatalf("logout response %d: %s", logout.Code, logout.Body.String())
	}
	clearedCookie := passkeyE2ESessionCookie(t, fixture, logout)
	if clearedCookie.Value != "" || clearedCookie.MaxAge >= 0 || !clearedCookie.HttpOnly || clearedCookie.SameSite != http.SameSiteStrictMode {
		t.Fatalf("logout did not securely clear session cookie: %#v", clearedCookie)
	}
	if _, _, err := fixture.auth.Authenticate(ctx, registrationCookie.Value); !errors.Is(err, auth.ErrUnauthenticated) {
		t.Fatalf("logged-out registration session remained valid: %v", err)
	}
	loggedOutMe := passkeyE2ERequest(t, fixture, http.MethodGet, "/api/v1/auth/me", "", registrationCookie, "")
	if loggedOutMe.Code != http.StatusUnauthorized {
		t.Fatalf("logged-out cookie /me response %d: %s", loggedOutMe.Code, loggedOutMe.Body.String())
	}

	loginBegin := passkeyE2ERequest(
		t, fixture, http.MethodPost, "/api/v1/auth/login/begin", `{}`, nil, "",
	)
	if loginBegin.Code != http.StatusOK {
		t.Fatalf("begin login response %d: %s", loginBegin.Code, loginBegin.Body.String())
	}
	beginLogin := decodePasskeyBegin(t, loginBegin)
	assertionOptions, err := virtualwebauthn.ParseAssertionOptions(string(beginLogin.Options))
	if err != nil {
		t.Fatalf("parse login options: %v\n%s", err, beginLogin.Options)
	}
	if assertionOptions.RelyingPartyID != rp.ID {
		t.Fatalf("login relying party ID = %q, want %q", assertionOptions.RelyingPartyID, rp.ID)
	}
	if len(assertionOptions.AllowCredentials) != 0 {
		t.Fatalf("discoverable login unexpectedly constrained credentials: %#v", assertionOptions.AllowCredentials)
	}

	authenticator.Options.UserHandle = []byte(attestationOptions.UserID)
	authenticator.AddCredential(credential)
	credential.Counter++
	assertion := virtualwebauthn.CreateAssertionResponse(
		rp, authenticator, credential, *assertionOptions,
	)
	loginFinish := passkeyE2ERequest(
		t,
		fixture,
		http.MethodPost,
		"/api/v1/auth/login/finish",
		assertion,
		nil,
		beginLogin.CeremonyToken,
	)
	if loginFinish.Code != http.StatusOK {
		t.Fatalf("finish login response %d: %s", loginFinish.Code, loginFinish.Body.String())
	}
	loggedIn := decodePasskeyFinish(t, loginFinish)
	if loggedIn.OnboardingComplete == nil || *loggedIn.OnboardingComplete {
		t.Fatalf("passkey login omitted pending onboarding state: %#v", loggedIn.OnboardingComplete)
	}
	if loggedIn.User.ID != registered.User.ID || loggedIn.User.Username != registered.User.Username {
		t.Fatalf("discoverable login returned a different user: registered=%#v loggedIn=%#v", registered.User, loggedIn.User)
	}
	loginCookie := passkeyE2ESessionCookie(t, fixture, loginFinish)
	if loginCookie.Value == registrationCookie.Value {
		t.Fatal("login reused the logged-out browser session token")
	}
	loginUser, loginSession, err := fixture.auth.Authenticate(ctx, loginCookie.Value)
	if err != nil {
		t.Fatalf("authenticate login session: %v", err)
	}
	if loginUser.ID != registered.User.ID || loginSession.UserID != registered.User.ID || loginSession.ID == registrationSession.ID {
		t.Fatalf("unexpected login identity/session: user=%#v session=%#v", loginUser, loginSession)
	}
	if loginSession.UserAgent != "t-lingual virtual authenticator" || loginSession.IPAddress != "192.0.2.1" {
		t.Fatalf("login session metadata was not preserved: %#v", loginSession)
	}

	updatedCredential := passkeyE2EStoredCredential(t, fixture.store, keyring, registered.User.ID)
	if updatedCredential.authenticator.Authenticator.SignCount != credential.Counter {
		t.Fatalf(
			"persisted signature counter = %d, want %d",
			updatedCredential.authenticator.Authenticator.SignCount,
			credential.Counter,
		)
	}
	if updatedCredential.record.LastUsedAt == nil || updatedCredential.record.CompromisedAt != nil {
		t.Fatalf("unexpected post-login credential state: %#v", updatedCredential.record)
	}
	activeSessions, err := fixture.auth.ListBrowserSessions(ctx, registered.User.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(activeSessions) != 1 || activeSessions[0].ID != loginSession.ID {
		t.Fatalf("active browser sessions after logout/login = %#v", activeSessions)
	}
}

type passkeyE2EBeginResponse struct {
	CeremonyToken string          `json:"ceremonyToken"`
	ExpiresAt     time.Time       `json:"expiresAt"`
	Options       json.RawMessage `json:"options"`
}

func decodePasskeyBegin(t *testing.T, response *httptest.ResponseRecorder) passkeyE2EBeginResponse {
	t.Helper()
	var result passkeyE2EBeginResponse
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode begin response: %v", err)
	}
	if result.CeremonyToken == "" || result.ExpiresAt.IsZero() || len(result.Options) == 0 {
		t.Fatalf("incomplete begin response: %#v", result)
	}
	return result
}

type passkeyE2EFinishResponse struct {
	User               domain.User `json:"user"`
	OnboardingComplete *bool       `json:"onboardingComplete"`
	Session            struct {
		ExpiresAt time.Time `json:"expiresAt"`
	} `json:"session"`
}

func decodePasskeyFinish(t *testing.T, response *httptest.ResponseRecorder) passkeyE2EFinishResponse {
	t.Helper()
	var result passkeyE2EFinishResponse
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode finish response: %v", err)
	}
	if result.User.ID == "" || result.Session.ExpiresAt.IsZero() {
		t.Fatalf("incomplete finish response: %#v", result)
	}
	return result
}

func passkeyE2ERequest(
	t *testing.T,
	fixture *apiFixture,
	method string,
	target string,
	body string,
	cookie *http.Cookie,
	ceremonyToken string,
) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	request.Header.Set("Origin", fixture.config.RPOrigins[0])
	request.Header.Set("User-Agent", "t-lingual virtual authenticator")
	if method != http.MethodGet {
		request.Header.Set("Content-Type", "application/json")
	}
	if ceremonyToken != "" {
		request.Header.Set(ceremonyHeader, ceremonyToken)
	}
	if cookie != nil {
		request.AddCookie(cookie)
	}
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	return response
}

func passkeyE2ESessionCookie(
	t *testing.T,
	fixture *apiFixture,
	response *httptest.ResponseRecorder,
) *http.Cookie {
	t.Helper()
	for _, cookie := range response.Result().Cookies() {
		if cookie.Name == fixture.config.SessionCookieName {
			return cookie
		}
	}
	t.Fatalf("response did not set %q cookie: %s", fixture.config.SessionCookieName, response.Header().Values("Set-Cookie"))
	return nil
}

type passkeyE2ECredentialState struct {
	record        domain.Credential
	authenticator webauthn.Credential
}

func passkeyE2EStoredCredential(
	t *testing.T,
	database *store.Store,
	keyring *secret.Keyring,
	userID string,
) passkeyE2ECredentialState {
	t.Helper()
	records, err := database.ListCredentials(context.Background(), userID)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 {
		t.Fatalf("stored credentials = %d, want 1", len(records))
	}
	cleartext, err := keyring.Open("webauthn-credential/"+records[0].ID, records[0].CredentialJSON)
	if err != nil {
		t.Fatalf("open stored credential: %v", err)
	}
	var authenticator webauthn.Credential
	if err := json.Unmarshal(cleartext, &authenticator); err != nil {
		t.Fatalf("decode stored credential: %v", err)
	}
	return passkeyE2ECredentialState{record: records[0], authenticator: authenticator}
}
