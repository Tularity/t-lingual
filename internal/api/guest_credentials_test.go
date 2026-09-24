package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/workspace"
)

func redeemFixtureGuest(t *testing.T, fixture *apiFixture) (domain.InterpretationSession, string, *http.Cookie) {
	t.Helper()
	session := sharedSession(t, fixture)
	response := fixture.request(t, "POST", "/api/v1/sessions/"+session.ID+"/shares", `{"type":"link","permission":"view","expiresAt":null}`, "alice", true)
	if response.Code != http.StatusCreated {
		t.Fatal(response.Code, response.Body.String())
	}
	share := decodeObject(t, response)
	redeemed := guestRequest(fixture, "POST", "/api/v1/share-access", `{"token":"`+share["token"].(string)+`","language":"en"}`, "", true)
	if redeemed.Code != http.StatusOK {
		t.Fatal(redeemed.Code, redeemed.Body.String())
	}
	cookies := redeemed.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("expected one guest credential, got %d", len(cookies))
	}
	return session, share["id"].(string), cookies[0]
}

func TestGuestCookieMeetsSecureHostPrefixRequirements(t *testing.T) {
	for _, origin := range []string{"http://localhost:8080", "https://lingua.example"} {
		t.Run(origin, func(t *testing.T) {
			fixture := newSharedAPIFixture(t, origin)
			session, _, cookie := redeemFixtureGuest(t, fixture)
			if !cookie.HttpOnly || cookie.Domain != "" || cookie.SameSite != http.SameSiteStrictMode {
				t.Fatal("guest credential lost cookie protections")
			}
			if strings.HasPrefix(cookie.Name, "__Host-") {
				if !cookie.Secure || cookie.Path != "/" {
					t.Fatalf("browser would reject the host-prefixed cookie: secure=%v path=%q", cookie.Secure, cookie.Path)
				}
			} else if cookie.Path != "/api/v1" {
				t.Fatal("development cookie scope changed")
			}
			response := guestRequest(fixture, "GET", "/api/v1/view/sessions/"+session.ID, "", cookie.Value, false)
			if response.Code != http.StatusOK {
				t.Fatal("guest cannot view its shared session", response.Code)
			}
			if response := guestRequest(fixture, "GET", "/api/v1/settings", "", cookie.Value, false); response.Code != http.StatusUnauthorized {
				t.Fatal("guest acquired account access", response.Code)
			}
		})
	}
}

func TestExpiredAccountCookieDoesNotBlockGuestOrConferAccountAccess(t *testing.T) {
	fixture := newSharedAPIFixture(t, "https://lingua.example")
	session, shareID, guest := redeemFixtureGuest(t, fixture)
	private, err := fixture.workspace.Create(context.Background(), fixture.users["bob"].ID, workspace.CreateInput{Title: "Private workspace", SourceLanguage: "en", TargetLanguage: "fr"})
	if err != nil {
		t.Fatal(err)
	}
	if err := fixture.store.DeleteBrowserSession(context.Background(), fixture.tokens["bob"]); err != nil {
		t.Fatal(err)
	}
	request := func(path string, includeGuest bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.AddCookie(&http.Cookie{Name: fixture.config.SessionCookieName, Value: fixture.tokens["bob"]})
		if includeGuest {
			r.AddCookie(guest)
		}
		w := httptest.NewRecorder()
		fixture.handler.ServeHTTP(w, r)
		return w
	}
	viewPath := "/api/v1/view/sessions/" + session.ID
	view := request(viewPath, true)
	if view.Code != http.StatusOK {
		t.Fatalf("stale account cookie blocked guest: %d %s", view.Code, view.Body.String())
	}
	access := decodeObject(t, view)["access"].(map[string]any)
	if access["isOwner"] != false || access["permission"] != "view" || !strings.HasPrefix(access["viewerId"].(string), "guest:") {
		t.Fatal("guest fallback inherited account identity", access)
	}
	for _, path := range []string{"/api/v1/settings", "/api/v1/admin/users"} {
		if got := request(path, true).Code; got != http.StatusUnauthorized {
			t.Fatalf("guest reached account route %s: %d", path, got)
		}
	}
	if got := request("/api/v1/view/sessions/"+private.ID, true).Code; got != http.StatusNotFound {
		t.Fatal("expired account retained private-session access", got)
	}
	if got := request(viewPath, false).Code; got != http.StatusUnauthorized {
		t.Fatal("expired account authenticated without guest credential", got)
	}
	revoke := fixture.request(t, "DELETE", "/api/v1/sessions/"+session.ID+"/shares/"+shareID, "", "alice", true)
	if revoke.Code != http.StatusNoContent {
		t.Fatal(revoke.Code, revoke.Body.String())
	}
	if got := request(viewPath, true).Code; got != http.StatusNotFound {
		t.Fatal("revoked guest remained usable", got)
	}
}
