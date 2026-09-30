package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/auth"
	"github.com/Tularity/t-lingual/internal/store"
)

func (fixture *apiFixture) deleteGrant(t *testing.T, admin, userID string) string {
	t.Helper()
	scope, err := auth.AdminUserDeleteAuthorizationScope(userID)
	if err != nil {
		t.Fatal(err)
	}
	return fixture.createAuthorizationGrant(t, admin, scope)
}

func TestAdministratorsDeleteAnAccountWithEverythingItHolds(t *testing.T) {
	fixture := newAPIFixture(t)
	bob := fixture.users["bob"].ID
	created := fixture.request(t, http.MethodPost, "/api/v1/sessions", `{"title":"Bob's","sourceLanguage":"en","targetLanguage":"fr"}`, "bob", true)
	var session struct {
		ID string `json:"id"`
	}
	if created.Code != http.StatusCreated || json.Unmarshal(created.Body.Bytes(), &session) != nil {
		t.Fatalf("create session = %d: %s", created.Code, created.Body.String())
	}
	fixture.addPasskey(t, bob, "cred_bob", 3)
	// A session of alice's stays, whoever is deleted.
	if response := fixture.request(t, http.MethodPost, "/api/v1/sessions", `{"title":"Alice's","sourceLanguage":"en","targetLanguage":"fr"}`, "alice", true); response.Code != http.StatusCreated {
		t.Fatalf("alice's session = %d", response.Code)
	}
	// A sign-in code made for bob stops working with him.
	codeBody := `{"kind":"login","targetUserId":"` + bob + `","ttlSeconds":600}`
	codeScope, _ := auth.AdminCodeCreateAuthorizationScope("login", bob, "", "", 600)
	if response := fixture.requestWithAuthorization(t, http.MethodPost, "/api/v1/admin/codes", codeBody, "admin", true, fixture.createAuthorizationGrant(t, "admin", codeScope)); response.Code != http.StatusCreated {
		t.Fatalf("sign-in code = %d: %s", response.Code, response.Body.String())
	}

	path := "/api/v1/admin/users/" + bob
	if response := fixture.requestWithAuthorization(t, http.MethodDelete, path, "", "alice", true, fixture.deleteGrant(t, "alice", bob)); response.Code != http.StatusForbidden {
		t.Fatalf("non-admin deletion = %d", response.Code)
	}
	if response := fixture.requestWithAuthorization(t, http.MethodDelete, path, "", "admin", true, ""); response.Code == http.StatusNoContent {
		t.Fatal("deleted without a passkey")
	}
	// A passkey for deleting alice does not delete bob.
	if response := fixture.requestWithAuthorization(t, http.MethodDelete, path, "", "admin", true, fixture.deleteGrant(t, "admin", fixture.users["alice"].ID)); response.Code == http.StatusNoContent {
		t.Fatal("deleted under another account's passkey")
	}
	if response := fixture.requestWithAuthorization(t, http.MethodDelete, path, "", "admin", true, fixture.deleteGrant(t, "admin", bob)); response.Code != http.StatusNoContent {
		t.Fatalf("delete = %d: %s", response.Code, response.Body.String())
	}

	ctx := context.Background()
	if _, err := fixture.store.GetUserByID(ctx, bob); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("deleted user still readable: %v", err)
	}
	if _, err := fixture.store.GetInterpretationSession(ctx, bob, session.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("deleted user's session still readable: %v", err)
	}
	if passkeys, _ := fixture.auth.ListCredentials(ctx, bob); len(passkeys) != 0 {
		t.Fatalf("deleted user's passkeys = %d", len(passkeys))
	}
	if response := fixture.request(t, http.MethodGet, "/api/v1/auth/me", "", "bob", false); response.Code != http.StatusUnauthorized {
		t.Fatalf("deleted user's browser still signed in = %d", response.Code)
	}
	if response := fixture.request(t, http.MethodGet, "/api/v1/sessions", "", "alice", false); !strings.Contains(response.Body.String(), "Alice's") {
		t.Fatalf("alice's sessions after bob's deletion: %s", response.Body.String())
	}
	invitations := fixture.request(t, http.MethodGet, "/api/v1/admin/invitations", "", "admin", false)
	if !strings.Contains(invitations.Body.String(), `"revokedAt":"`) {
		t.Fatalf("bob's sign-in code was not revoked: %s", invitations.Body.String())
	}
	audit := fixture.request(t, http.MethodGet, "/api/v1/admin/audit", "", "admin", false)
	if !strings.Contains(audit.Body.String(), `"user.delete"`) || !strings.Contains(audit.Body.String(), `"username":"bob"`) {
		t.Fatalf("deletion not audited: %s", audit.Body.String())
	}
	if response := fixture.requestWithAuthorization(t, http.MethodDelete, path, "", "admin", true, fixture.deleteGrant(t, "admin", bob)); response.Code != http.StatusNotFound {
		t.Fatalf("deleting an account already gone = %d", response.Code)
	}
}

func TestAnAdministratorCannotDeleteThemselves(t *testing.T) {
	fixture := newAPIFixture(t)
	admin := fixture.users["admin"].ID
	if response := fixture.requestWithAuthorization(t, http.MethodDelete, "/api/v1/admin/users/"+admin, "", "admin", true, fixture.deleteGrant(t, "admin", admin)); response.Code != http.StatusForbidden {
		t.Fatalf("self deletion = %d: %s", response.Code, response.Body.String())
	}
	// The store refuses it too, whatever calls it.
	now := time.Now().UTC()
	if err := fixture.store.DeleteUserAsAdmin(context.Background(), admin, "ses_admin", now, admin, store.AuditEvent{}, now); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("store self deletion = %v", err)
	}
	if _, err := fixture.store.GetUserByID(context.Background(), admin); err != nil {
		t.Fatalf("administrator gone after a refused deletion: %v", err)
	}
}
