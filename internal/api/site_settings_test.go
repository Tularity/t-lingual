package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Tularity/t-lingual/internal/auth"
)

func TestPublicSiteHelpAndAdminSiteSettingsRequireBoundStepUp(t *testing.T) {
	fixture := newAPIFixture(t)
	public := fixture.requestWithAuthorization(t, http.MethodGet, "/api/v1/site-content", "", "", false, "")
	if public.Code != http.StatusOK {
		t.Fatalf("public site content = %d %s", public.Code, public.Body.String())
	}
	var visible map[string]any
	if err := json.Unmarshal(public.Body.Bytes(), &visible); err != nil || len(visible) != 1 || visible["registrationHelpMarkdown"] == "" {
		t.Fatalf("public site content leaked admin fields: %#v %v", visible, err)
	}
	ordinary := fixture.requestWithAuthorization(t, http.MethodGet, "/api/v1/admin/site-settings", "", "alice", false, "")
	if ordinary.Code != http.StatusForbidden {
		t.Fatalf("ordinary user read site settings: %d", ordinary.Code)
	}
	adminRead := fixture.requestWithAuthorization(t, http.MethodGet, "/api/v1/admin/site-settings", "", "admin", false, "")
	if adminRead.Code != http.StatusOK || !strings.Contains(adminRead.Body.String(), `"codeAttemptsPerMinute":3`) {
		t.Fatalf("admin site settings = %d %s", adminRead.Code, adminRead.Body.String())
	}
	markdown := "## Registration\nAsk an administrator for a single-use code."
	scope, err := auth.AdminSiteSettingsAuthorizationScope(markdown, 1, 1500)
	if err != nil {
		t.Fatal(err)
	}
	grant := fixture.createAuthorizationGrant(t, "admin", scope)
	wrong := fixture.requestWithAuthorization(t, http.MethodPut, "/api/v1/admin/site-settings",
		`{"registrationHelpMarkdown":"Other help","codeAttemptsPerMinute":1,"draftTranslationIntervalMs":1500}`, "admin", true, grant)
	if wrong.Code != http.StatusForbidden {
		t.Fatalf("wrong payload reused passkey step-up: %d %s", wrong.Code, wrong.Body.String())
	}
	// A changed translation interval is part of what the passkey authorizes.
	if response := fixture.requestWithAuthorization(t, http.MethodPut, "/api/v1/admin/site-settings",
		`{"registrationHelpMarkdown":"## Registration\nAsk an administrator for a single-use code.","codeAttemptsPerMinute":1,"draftTranslationIntervalMs":0}`,
		"admin", true, grant); response.Code != http.StatusForbidden {
		t.Fatalf("another interval reused passkey step-up: %d %s", response.Code, response.Body.String())
	}
	body := `{"registrationHelpMarkdown":"## Registration\nAsk an administrator for a single-use code.","codeAttemptsPerMinute":1,"draftTranslationIntervalMs":1500}`
	withoutOrigin := fixture.requestWithAuthorization(t, http.MethodPut, "/api/v1/admin/site-settings", body, "admin", false, grant)
	if withoutOrigin.Code != http.StatusForbidden {
		t.Fatalf("site mutation without origin = %d", withoutOrigin.Code)
	}
	updated := fixture.requestWithAuthorization(t, http.MethodPut, "/api/v1/admin/site-settings", body, "admin", true, grant)
	if updated.Code != http.StatusOK || !strings.Contains(updated.Body.String(), `"codeAttemptsPerMinute":1`) ||
		!strings.Contains(updated.Body.String(), `"draftTranslationIntervalMs":1500`) {
		t.Fatalf("authorized site update = %d %s", updated.Code, updated.Body.String())
	}
	public = fixture.requestWithAuthorization(t, http.MethodGet, "/api/v1/site-content", "", "", false, "")
	if err := json.Unmarshal(public.Body.Bytes(), &visible); err != nil || visible["registrationHelpMarkdown"] != markdown {
		t.Fatalf("hot public help = %#v %v", visible, err)
	}
}

func TestCodeRatePolicyHotReloadRetainsExactIPWindowAndRetryAfter(t *testing.T) {
	fixture := newAPIFixture(t)
	attempt := func(remote, forwarded string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/code", strings.NewReader(`{"code":"000000"}`))
		request.RemoteAddr = remote
		request.Header.Set("Origin", fixture.config.RPOrigins[0])
		request.Header.Set("Content-Type", "application/json")
		if forwarded != "" {
			request.Header.Set("X-Forwarded-For", forwarded)
		}
		response := httptest.NewRecorder()
		fixture.handler.ServeHTTP(response, request)
		return response
	}
	for range 2 {
		if response := attempt("192.0.2.1:2000", ""); response.Code != http.StatusUnprocessableEntity {
			t.Fatalf("default budget rejected early: %d %s", response.Code, response.Body.String())
		}
	}
	update := func(attempts int) {
		t.Helper()
		markdown := "Ask an administrator for a registration code."
		scope, err := auth.AdminSiteSettingsAuthorizationScope(markdown, attempts, 1000)
		if err != nil {
			t.Fatal(err)
		}
		grant := fixture.createAuthorizationGrant(t, "admin", scope)
		body, _ := json.Marshal(map[string]any{"registrationHelpMarkdown": markdown, "codeAttemptsPerMinute": attempts, "draftTranslationIntervalMs": 1000})
		response := fixture.requestWithAuthorization(t, http.MethodPut, "/api/v1/admin/site-settings",
			string(body), "admin", true, grant)
		if response.Code != http.StatusOK {
			t.Fatalf("change budget to %d = %d %s", attempts, response.Code, response.Body.String())
		}
	}
	update(1)
	blocked := attempt("192.0.2.1:2001", "203.0.113.99") // untrusted XFF cannot forge another IP
	if blocked.Code != http.StatusTooManyRequests || blocked.Header().Get("Retry-After") == "" {
		t.Fatalf("lowered budget reset old counter: %d %s", blocked.Code, blocked.Body.String())
	}
	if independent := attempt("192.0.2.2:2000", ""); independent.Code != http.StatusUnprocessableEntity {
		t.Fatalf("same /24 address shared another IP's counter: %d", independent.Code)
	}
	update(4)
	for range 2 {
		if response := attempt("192.0.2.1:2002", ""); response.Code != http.StatusUnprocessableEntity {
			t.Fatalf("raised budget failed to reuse count: %d %s", response.Code, response.Body.String())
		}
	}
	if blocked := attempt("192.0.2.1:2003", ""); blocked.Code != http.StatusTooManyRequests {
		t.Fatalf("raised budget accepted fifth attempt: %d", blocked.Code)
	}
}
