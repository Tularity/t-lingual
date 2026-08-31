package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/store"
)

func browserSessionRequest(
	t *testing.T,
	fixture *apiFixture,
	handler http.Handler,
	method string,
	target string,
	user string,
) (*http.Request, *httptest.ResponseRecorder) {
	t.Helper()
	request := httptest.NewRequest(method, target, nil)
	request.Header.Set("Origin", fixture.config.RPOrigins[0])
	if user != "" {
		request.AddCookie(&http.Cookie{
			Name: fixture.config.SessionCookieName, Value: fixture.tokens[user],
		})
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return request, response
}

func TestBrowserSessionAPIListsAndRevokesOwnedSession(t *testing.T) {
	live := &recordingLiveHandler{}
	fixture := newAPIFixtureWithLive(t, live)
	handler := fixture.handler
	ctx := context.Background()
	now := time.Now().UTC()
	other := domain.BrowserSession{
		ID: "ses_alice_tablet", UserID: fixture.users["alice"].ID,
		CreatedAt: now, ExpiresAt: now.Add(time.Hour), LastSeen: now,
		UserAgent: "Mozilla/5.0 Tablet", IPAddress: "198.51.100.28",
	}
	const otherToken = "alice-tablet-browser-token-with-enough-entropy"
	if err := fixture.store.CreateBrowserSession(ctx, other, otherToken); err != nil {
		t.Fatal(err)
	}

	_, listed := browserSessionRequest(
		t, fixture, handler, http.MethodGet, "/api/v1/auth/sessions", "alice",
	)
	if listed.Code != http.StatusOK {
		t.Fatalf("list response %d: %s", listed.Code, listed.Body.String())
	}
	var payload struct {
		Items []struct {
			ID        string `json:"id"`
			UserAgent string `json:"userAgent"`
			IPAddress string `json:"ipAddress"`
			Current   bool   `json:"current"`
		} `json:"items"`
	}
	if err := json.Unmarshal(listed.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Items) != 2 {
		t.Fatalf("browser session payload = %#v", payload.Items)
	}
	otherIndex := slices.IndexFunc(payload.Items, func(item struct {
		ID        string `json:"id"`
		UserAgent string `json:"userAgent"`
		IPAddress string `json:"ipAddress"`
		Current   bool   `json:"current"`
	}) bool {
		return item.ID == other.ID
	})
	currentIndex := slices.IndexFunc(payload.Items, func(item struct {
		ID        string `json:"id"`
		UserAgent string `json:"userAgent"`
		IPAddress string `json:"ipAddress"`
		Current   bool   `json:"current"`
	}) bool {
		return item.ID == "ses_alice"
	})
	if otherIndex < 0 || payload.Items[otherIndex].Current ||
		payload.Items[otherIndex].UserAgent != other.UserAgent ||
		payload.Items[otherIndex].IPAddress != other.IPAddress {
		t.Fatalf("other browser payload = %#v", payload.Items)
	}
	if currentIndex < 0 || !payload.Items[currentIndex].Current {
		t.Fatalf("current session markers = %#v", payload.Items)
	}
	if strings.Contains(listed.Body.String(), "userId") || strings.Contains(listed.Body.String(), otherToken) {
		t.Fatalf("browser session response leaked owner or token: %s", listed.Body.String())
	}

	_, stolenCookie := browserSessionRequest(
		t, fixture, handler, http.MethodDelete, "/api/v1/auth/sessions/"+other.ID, "alice",
	)
	if stolenCookie.Code != http.StatusForbidden ||
		!strings.Contains(stolenCookie.Body.String(), "PASSKEY_AUTHORIZATION_INVALID") {
		t.Fatalf("stolen-cookie revoke response %d: %s", stolenCookie.Code, stolenCookie.Body.String())
	}
	if _, err := fixture.store.LookupBrowserSession(ctx, otherToken, now); err != nil {
		t.Fatalf("stolen cookie revoked another browser: %v", err)
	}

	createGrant := func(id, token string) {
		t.Helper()
		if err := fixture.store.CreateActionGrant(ctx, store.ActionGrant{
			ID: id, UserID: fixture.users["alice"].ID, BrowserSessionID: "ses_alice",
			Action: store.ActionPasskeyManagement, CreatedAt: now, ExpiresAt: now.Add(time.Minute),
		}, token); err != nil {
			t.Fatal(err)
		}
	}
	authorizedDelete := func(target, token string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(http.MethodDelete, "/api/v1/auth/sessions/"+target, nil)
		request.Header.Set("Origin", fixture.config.RPOrigins[0])
		request.Header.Set(passkeyAuthorizationHeader, token)
		request.AddCookie(&http.Cookie{
			Name: fixture.config.SessionCookieName, Value: fixture.tokens["alice"],
		})
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	forgedGrant := authorizedDelete(other.ID, "forged-single-session-grant")
	if forgedGrant.Code != http.StatusForbidden {
		t.Fatalf("forged grant revoke response %d: %s", forgedGrant.Code, forgedGrant.Body.String())
	}
	if _, err := fixture.store.LookupBrowserSession(ctx, otherToken, now); err != nil {
		t.Fatalf("forged grant revoked another browser: %v", err)
	}
	const crossOwnerGrant = "cross-owner-delete-grant-token-with-enough-entropy"
	createGrant("grant_cross_owner_delete", crossOwnerGrant)
	crossOwner := authorizedDelete("ses_bob", crossOwnerGrant)
	if crossOwner.Code != http.StatusNotFound {
		t.Fatalf("cross-owner revoke response %d: %s", crossOwner.Code, crossOwner.Body.String())
	}
	if _, _, err := fixture.auth.Authenticate(ctx, fixture.tokens["bob"]); err != nil {
		t.Fatalf("cross-owner revoke removed Bob's session: %v", err)
	}

	const ownGrant = "owned-session-delete-grant-token-with-enough-entropy"
	createGrant("grant_owned_session_delete", ownGrant)
	revoked := authorizedDelete(other.ID, ownGrant)
	if revoked.Code != http.StatusNoContent {
		t.Fatalf("owned revoke response %d: %s", revoked.Code, revoked.Body.String())
	}
	if _, err := fixture.store.LookupBrowserSession(ctx, otherToken, now); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("revoked session lookup = %v", err)
	}
	live.mu.Lock()
	revokedLive := append([]string(nil), live.revokedBrowserSessions...)
	live.mu.Unlock()
	if !slices.Equal(revokedLive, []string{other.ID}) {
		t.Fatalf("live session revocations = %#v", revokedLive)
	}

	_, revokedCurrent := browserSessionRequest(
		t, fixture, handler, http.MethodDelete, "/api/v1/auth/sessions/ses_alice", "alice",
	)
	if revokedCurrent.Code != http.StatusNoContent {
		t.Fatalf("current revoke response %d: %s", revokedCurrent.Code, revokedCurrent.Body.String())
	}
	cookies := revokedCurrent.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != fixture.config.SessionCookieName || cookies[0].Value != "" || cookies[0].MaxAge >= 0 {
		t.Fatalf("current revoke did not clear session cookie: %#v", cookies)
	}
}

func TestRevokeOtherBrowserSessionsAPIRequiresPasskeyGrantAndDisconnectsLive(t *testing.T) {
	live := &recordingLiveHandler{}
	fixture := newAPIFixtureWithLive(t, live)
	handler := fixture.handler
	ctx := context.Background()
	now := time.Now().UTC()
	otherIDs := []string{"ses_alice_phone", "ses_alice_laptop"}
	for index, browserSessionID := range otherIDs {
		if err := fixture.store.CreateBrowserSession(ctx, domain.BrowserSession{
			ID: browserSessionID, UserID: fixture.users["alice"].ID,
			CreatedAt: now.Add(time.Duration(index) * time.Second),
			ExpiresAt: now.Add(time.Hour), LastSeen: now.Add(time.Duration(index) * time.Second),
			UserAgent: "Other browser", IPAddress: "203.0.113.19",
		}, "other-browser-token-with-enough-entropy-"+browserSessionID); err != nil {
			t.Fatal(err)
		}
	}

	_, missingGrant := browserSessionRequest(
		t, fixture, handler, http.MethodPost, "/api/v1/auth/sessions/revoke-others", "alice",
	)
	if missingGrant.Code != http.StatusForbidden ||
		!strings.Contains(missingGrant.Body.String(), "PASSKEY_AUTHORIZATION_INVALID") {
		t.Fatalf("missing grant response %d: %s", missingGrant.Code, missingGrant.Body.String())
	}
	const grantToken = "api-revoke-others-grant-token-with-enough-entropy"
	if err := fixture.store.CreateActionGrant(ctx, store.ActionGrant{
		ID: "grant_api_revoke_others", UserID: fixture.users["alice"].ID,
		BrowserSessionID: "ses_alice", Action: store.ActionPasskeyManagement,
		CreatedAt: now, ExpiresAt: now.Add(time.Minute),
	}, grantToken); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/sessions/revoke-others", nil)
	request.Header.Set("Origin", fixture.config.RPOrigins[0])
	request.Header.Set(passkeyAuthorizationHeader, grantToken)
	request.AddCookie(&http.Cookie{
		Name: fixture.config.SessionCookieName, Value: fixture.tokens["alice"],
	})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"revoked":2`) {
		t.Fatalf("revoke others response %d: %s", response.Code, response.Body.String())
	}
	if _, _, err := fixture.auth.Authenticate(ctx, fixture.tokens["alice"]); err != nil {
		t.Fatalf("revoke others removed current session: %v", err)
	}
	if _, _, err := fixture.auth.Authenticate(ctx, fixture.tokens["bob"]); err != nil {
		t.Fatalf("revoke others removed another owner's session: %v", err)
	}
	live.mu.Lock()
	revokedLive := append([]string(nil), live.revokedBrowserSessions...)
	live.mu.Unlock()
	slices.Sort(revokedLive)
	slices.Sort(otherIDs)
	if !slices.Equal(revokedLive, otherIDs) {
		t.Fatalf("revoke-others live disconnects = %#v", revokedLive)
	}

	replay := httptest.NewRequest(http.MethodPost, "/api/v1/auth/sessions/revoke-others", nil)
	replay.Header.Set("Origin", fixture.config.RPOrigins[0])
	replay.Header.Set(passkeyAuthorizationHeader, grantToken)
	replay.AddCookie(&http.Cookie{
		Name: fixture.config.SessionCookieName, Value: fixture.tokens["alice"],
	})
	replayResponse := httptest.NewRecorder()
	handler.ServeHTTP(replayResponse, replay)
	if replayResponse.Code != http.StatusForbidden {
		t.Fatalf("grant replay response %d: %s", replayResponse.Code, replayResponse.Body.String())
	}
}
