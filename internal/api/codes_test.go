package api

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"testing"

	"github.com/Tularity/t-lingual/internal/auth"
)

func TestAdminCodeStepUpBindsTargetAndScheduleThenLoginUsesScopedRecoveryGrant(t *testing.T) {
	fixture := newAPIFixture(t)
	path := "/api/v1/admin/codes"
	aliceID := fixture.users["alice"].ID
	body := `{"kind":"login","targetUserId":"` + aliceID + `","ttlSeconds":600}`
	missing := fixture.requestWithAuthorization(t, http.MethodPost, path, body, "admin", true, "")
	if missing.Code != http.StatusForbidden {
		t.Fatalf("missing step-up = %d %s", missing.Code, missing.Body.String())
	}
	scope, err := auth.AdminCodeCreateAuthorizationScope("login", aliceID, "", "", 600)
	if err != nil {
		t.Fatal(err)
	}
	grant := fixture.createAuthorizationGrant(t, "admin", scope)
	wrong := fixture.requestWithAuthorization(t, http.MethodPost, path,
		`{"kind":"login","targetUserId":"`+fixture.users["bob"].ID+`","ttlSeconds":600}`,
		"admin", true, grant)
	if wrong.Code != http.StatusForbidden {
		t.Fatalf("wrong target reused step-up = %d %s", wrong.Code, wrong.Body.String())
	}
	created := fixture.requestWithAuthorization(t, http.MethodPost, path, body, "admin", true, grant)
	if created.Code != http.StatusCreated || created.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("correct creation = %d %s", created.Code, created.Body.String())
	}
	var code struct {
		Code         string `json:"code"`
		Kind         string `json:"kind"`
		TargetUserID string `json:"targetUserId"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &code); err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^[0-9]{6}$`).MatchString(code.Code) || code.Kind != "login" || code.TargetUserID != aliceID {
		t.Fatalf("created code metadata = %#v", code)
	}
	redeemed := fixture.requestWithAuthorization(t, http.MethodPost, "/api/v1/auth/code",
		`{"code":"`+code.Code+`"}`, "", true, "")
	if redeemed.Code != http.StatusOK || redeemed.Header().Get("Cache-Control") != "no-store" ||
		len(redeemed.Result().Cookies()) != 1 {
		t.Fatalf("login code response = %d %s", redeemed.Code, redeemed.Body.String())
	}
	var login struct {
		Kind                  string `json:"kind"`
		OnboardingComplete    *bool  `json:"onboardingComplete"`
		RecoveryAuthorization struct {
			AuthorizationToken string `json:"authorizationToken"`
		} `json:"recoveryAuthorization"`
	}
	if err := json.Unmarshal(redeemed.Body.Bytes(), &login); err != nil || login.Kind != "login" ||
		login.RecoveryAuthorization.AuthorizationToken == "" ||
		login.OnboardingComplete == nil || *login.OnboardingComplete {
		t.Fatalf("recovery response = %#v %v", login, err)
	}
	user, _, err := fixture.auth.Authenticate(context.Background(), redeemed.Result().Cookies()[0].Value)
	if err != nil || user.ID != aliceID {
		t.Fatalf("code session identity = %#v %v", user, err)
	}
	if scope, err := auth.AdminUserUpdateAuthorizationScope(aliceID, nil, nil); err == nil && scope != "" {
		t.Fatal("unexpectedly accepted empty user mutation scope")
	}
	replay := fixture.requestWithAuthorization(t, http.MethodPost, "/api/v1/auth/code",
		`{"code":"`+code.Code+`"}`, "", true, "")
	if replay.Code != http.StatusUnprocessableEntity || !strings.Contains(replay.Body.String(), `"code":"INVALID_CODE"`) {
		t.Fatalf("replayed code = %d %s", replay.Code, replay.Body.String())
	}
}

func TestRegistrationCodeReturnsTicketWithoutConsumingAndStartsPasskeyCeremony(t *testing.T) {
	fixture := newAPIFixture(t)
	scope, err := auth.AdminCodeCreateAuthorizationScope("registration", "", "", "", 3600)
	if err != nil {
		t.Fatal(err)
	}
	grant := fixture.createAuthorizationGrant(t, "admin", scope)
	created := fixture.requestWithAuthorization(t, http.MethodPost, "/api/v1/admin/codes",
		`{"kind":"registration","ttlSeconds":3600}`, "admin", true, grant)
	if created.Code != http.StatusCreated {
		t.Fatalf("registration code create = %d %s", created.Code, created.Body.String())
	}
	var code struct{ Code, ID string }
	if err := json.Unmarshal(created.Body.Bytes(), &code); err != nil || code.Code == "" {
		t.Fatalf("registration code = %#v %v", code, err)
	}
	redeemed := fixture.requestWithAuthorization(t, http.MethodPost, "/api/v1/auth/code",
		`{"code":"`+code.Code+`"}`, "", true, "")
	var ticket struct{ Kind, RegistrationTicket string }
	if redeemed.Code != http.StatusOK || json.Unmarshal(redeemed.Body.Bytes(), &ticket) != nil ||
		ticket.Kind != "registration" || ticket.RegistrationTicket == "" || len(redeemed.Result().Cookies()) != 0 {
		t.Fatalf("ticket response = %d %s", redeemed.Code, redeemed.Body.String())
	}
	invitation, err := fixture.store.GetInvitationByID(context.Background(), code.ID)
	if err != nil || invitation.UsedAt != nil {
		t.Fatalf("ticket consumed invitation early: %#v %v", invitation, err)
	}
	begin := fixture.requestWithAuthorization(t, http.MethodPost, "/api/v1/auth/register/begin",
		`{"registrationTicket":"`+ticket.RegistrationTicket+`","username":"ticket-user","displayName":"Ticket User"}`,
		"", true, "")
	if begin.Code != http.StatusOK {
		t.Fatalf("ticket registration begin = %d %s", begin.Code, begin.Body.String())
	}
}

func TestUnifiedCodeEntryHasSeparateStrictGuessingBudget(t *testing.T) {
	fixture := newAPIFixture(t)
	for index := range 3 {
		response := fixture.requestWithAuthorization(t, http.MethodPost, "/api/v1/auth/code",
			`{"code":"000000"}`, "", true, "")
		if response.Code != http.StatusUnprocessableEntity {
			t.Fatalf("guess %d = HTTP %d", index, response.Code)
		}
	}
	limited := fixture.requestWithAuthorization(t, http.MethodPost, "/api/v1/auth/code",
		`{"code":"000000"}`, "", true, "")
	if limited.Code != http.StatusTooManyRequests || limited.Header().Get("Retry-After") == "" {
		t.Fatalf("unbounded code guessing: %d %s", limited.Code, limited.Body.String())
	}
}

func TestLegacyRegistrationCodeAndUnifiedEntryShareSamePerIPBudget(t *testing.T) {
	fixture := newAPIFixture(t)
	// Invalid six-digit values still start the legacy ceremony; their final
	// passkey step would reject them. Every begin must nevertheless spend a
	// code guess so that the old route cannot evade the new entry limit.
	for index := range 2 {
		response := fixture.requestWithAuthorization(t, http.MethodPost, "/api/v1/auth/register/begin",
			`{"invitationCode":"000000","username":"code-user","displayName":"Code User"}`, "", true, "")
		if response.Code != http.StatusOK {
			t.Fatalf("legacy begin %d = %d %s", index, response.Code, response.Body.String())
		}
	}
	third := fixture.requestWithAuthorization(t, http.MethodPost, "/api/v1/auth/code",
		`{"code":"000000"}`, "", true, "")
	if third.Code != http.StatusUnprocessableEntity {
		t.Fatalf("shared third attempt = %d %s", third.Code, third.Body.String())
	}
	blocked := fixture.requestWithAuthorization(t, http.MethodPost, "/api/v1/auth/register/begin",
		`{"invitationCode":"000000","username":"code-user","displayName":"Code User"}`, "", true, "")
	if blocked.Code != http.StatusTooManyRequests || blocked.Header().Get("Retry-After") == "" {
		t.Fatalf("legacy route bypassed shared budget: %d %s", blocked.Code, blocked.Body.String())
	}
}

func TestAnAdministratorMakesASignInCodeForThemselves(t *testing.T) {
	fixture := newAPIFixture(t)
	adminID := fixture.users["admin"].ID
	body := `{"kind":"login","targetUserId":"` + adminID + `","ttlSeconds":300}`
	scope, err := auth.AdminCodeCreateAuthorizationScope("login", adminID, "", "", 300)
	if err != nil {
		t.Fatal(err)
	}
	created := fixture.requestWithAuthorization(t, http.MethodPost, "/api/v1/admin/codes", body, "admin", true,
		fixture.createAuthorizationGrant(t, "admin", scope))
	var code struct {
		Code string `json:"code"`
	}
	if created.Code != http.StatusCreated || json.Unmarshal(created.Body.Bytes(), &code) != nil {
		t.Fatalf("own sign-in code = %d %s", created.Code, created.Body.String())
	}
	// Redeemed elsewhere, it signs the administrator in on another browser.
	redeemed := fixture.requestWithAuthorization(t, http.MethodPost, "/api/v1/auth/code", `{"code":"`+code.Code+`"}`, "", true, "")
	if redeemed.Code != http.StatusOK || len(redeemed.Result().Cookies()) != 1 {
		t.Fatalf("own code redeemed = %d %s", redeemed.Code, redeemed.Body.String())
	}
	user, _, err := fixture.auth.Authenticate(context.Background(), redeemed.Result().Cookies()[0].Value)
	if err != nil || user.ID != adminID {
		t.Fatalf("own code signed in %#v %v", user, err)
	}
	// Their first browser stays signed in.
	if response := fixture.request(t, http.MethodGet, "/api/v1/auth/me", "", "admin", false); response.Code != http.StatusOK {
		t.Fatalf("first browser after own code = %d", response.Code)
	}
}
