package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/auth"
	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/id"
	"github.com/Tularity/t-lingual/internal/store"
)

func (fixture *apiFixture) createAuthorizationGrant(
	t *testing.T,
	user string,
	scope string,
) string {
	t.Helper()
	token, err := auth.NewScopedAuthorizationToken(scope)
	if err != nil {
		t.Fatal(err)
	}
	grantID, err := id.New("grant")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := fixture.store.CreateActionGrant(context.Background(), store.ActionGrant{
		ID: grantID, UserID: fixture.users[user].ID, BrowserSessionID: "ses_" + user,
		Action: store.ActionPasskeyManagement, CreatedAt: now, ExpiresAt: now.Add(2 * time.Minute),
	}, token); err != nil {
		t.Fatal(err)
	}
	return token
}

func (fixture *apiFixture) requestWithAuthorization(
	t *testing.T,
	method string,
	target string,
	body string,
	user string,
	withOrigin bool,
	authorizationToken string,
) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	if withOrigin {
		request.Header.Set("Origin", fixture.config.RPOrigins[0])
	}
	if authorizationToken != "" {
		request.Header.Set(passkeyAuthorizationHeader, authorizationToken)
	}
	if user != "" {
		request.AddCookie(&http.Cookie{
			Name: fixture.config.SessionCookieName, Value: fixture.tokens[user],
		})
	}
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	return response
}

func invitationCreateAuthorizationScope(t *testing.T, hours int) string {
	t.Helper()
	scope, err := auth.AdminInvitationCreateAuthorizationScope(hours)
	if err != nil {
		t.Fatal(err)
	}
	return scope
}

func invitationRevokeAuthorizationScope(t *testing.T, invitationID string) string {
	t.Helper()
	scope, err := auth.AdminInvitationRevokeAuthorizationScope(invitationID)
	if err != nil {
		t.Fatal(err)
	}
	return scope
}

func userUpdateAuthorizationScope(
	t *testing.T,
	userID string,
	role *domain.Role,
	status *domain.UserStatus,
) string {
	t.Helper()
	scope, err := auth.AdminUserUpdateAuthorizationScope(userID, role, status)
	if err != nil {
		t.Fatal(err)
	}
	return scope
}

func TestAdminMutationRequiresPasskeyAuthorization(t *testing.T) {
	fixture := newAPIFixture(t)
	response := fixture.request(
		t, http.MethodPost, "/api/v1/admin/invitations", `{"expiresInHours":2}`, "admin", true,
	)
	if response.Code != http.StatusForbidden ||
		!strings.Contains(response.Body.String(), `"code":"PASSKEY_AUTHORIZATION_INVALID"`) {
		t.Fatalf("missing authorization response %d: %s", response.Code, response.Body.String())
	}
	items, err := fixture.store.ListInvitationsAsTrustedControl(context.Background(), 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Fatalf("missing authorization created invitations: %#v", items)
	}
}

func TestAdminAuthorizationWrongOperationDoesNotConsumeIntendedGrant(t *testing.T) {
	fixture := newAPIFixture(t)
	token := fixture.createAuthorizationGrant(
		t, "admin", invitationCreateAuthorizationScope(t, 2),
	)
	wrong := fixture.requestWithAuthorization(
		t, http.MethodPatch, "/api/v1/admin/users/"+fixture.users["alice"].ID,
		`{"role":"admin"}`, "admin", true, token,
	)
	if wrong.Code != http.StatusForbidden ||
		!strings.Contains(wrong.Body.String(), `"code":"PASSKEY_AUTHORIZATION_INVALID"`) {
		t.Fatalf("wrong-operation response %d: %s", wrong.Code, wrong.Body.String())
	}
	alice, err := fixture.store.GetUserByID(context.Background(), fixture.users["alice"].ID)
	if err != nil {
		t.Fatal(err)
	}
	if alice.Role != domain.RoleUser {
		t.Fatalf("wrong operation promoted Alice: %#v", alice)
	}

	intended := fixture.requestWithAuthorization(
		t, http.MethodPost, "/api/v1/admin/invitations", `{"expiresInHours":2}`,
		"admin", true, token,
	)
	if intended.Code != http.StatusCreated {
		t.Fatalf("wrong operation consumed intended grant: %d: %s", intended.Code, intended.Body.String())
	}
}

func TestAdminAuthorizationBindsUserTargetAndPayload(t *testing.T) {
	t.Run("target", func(t *testing.T) {
		fixture := newAPIFixture(t)
		role := domain.RoleAdmin
		token := fixture.createAuthorizationGrant(
			t, "admin", userUpdateAuthorizationScope(t, fixture.users["alice"].ID, &role, nil),
		)
		wrong := fixture.requestWithAuthorization(
			t, http.MethodPatch, "/api/v1/admin/users/"+fixture.users["bob"].ID,
			`{"role":"admin"}`, "admin", true, token,
		)
		if wrong.Code != http.StatusForbidden ||
			!strings.Contains(wrong.Body.String(), `"code":"PASSKEY_AUTHORIZATION_INVALID"`) {
			t.Fatalf("wrong-target response %d: %s", wrong.Code, wrong.Body.String())
		}
		bob, err := fixture.store.GetUserByID(context.Background(), fixture.users["bob"].ID)
		if err != nil {
			t.Fatal(err)
		}
		if bob.Role != domain.RoleUser {
			t.Fatalf("wrong target promoted Bob: %#v", bob)
		}
		intended := fixture.requestWithAuthorization(
			t, http.MethodPatch, "/api/v1/admin/users/"+fixture.users["alice"].ID,
			`{"role":"admin"}`, "admin", true, token,
		)
		if intended.Code != http.StatusOK {
			t.Fatalf("wrong target consumed intended grant: %d: %s", intended.Code, intended.Body.String())
		}
	})

	t.Run("payload", func(t *testing.T) {
		fixture := newAPIFixture(t)
		role := domain.RoleAdmin
		token := fixture.createAuthorizationGrant(
			t, "admin", userUpdateAuthorizationScope(t, fixture.users["bob"].ID, &role, nil),
		)
		wrong := fixture.requestWithAuthorization(
			t, http.MethodPatch, "/api/v1/admin/users/"+fixture.users["bob"].ID,
			`{"status":"disabled"}`, "admin", true, token,
		)
		if wrong.Code != http.StatusForbidden ||
			!strings.Contains(wrong.Body.String(), `"code":"PASSKEY_AUTHORIZATION_INVALID"`) {
			t.Fatalf("wrong-payload response %d: %s", wrong.Code, wrong.Body.String())
		}
		bob, err := fixture.store.GetUserByID(context.Background(), fixture.users["bob"].ID)
		if err != nil {
			t.Fatal(err)
		}
		if bob.Role != domain.RoleUser || bob.Status != domain.UserActive {
			t.Fatalf("wrong payload changed Bob: %#v", bob)
		}
		intended := fixture.requestWithAuthorization(
			t, http.MethodPatch, "/api/v1/admin/users/"+fixture.users["bob"].ID,
			`{"role":"admin"}`, "admin", true, token,
		)
		if intended.Code != http.StatusOK {
			t.Fatalf("wrong payload consumed intended grant: %d: %s", intended.Code, intended.Body.String())
		}
	})
}

func TestInvalidAdminBodyDoesNotConsumeAuthorization(t *testing.T) {
	fixture := newAPIFixture(t)
	role := domain.RoleAdmin
	token := fixture.createAuthorizationGrant(
		t, "admin", userUpdateAuthorizationScope(t, fixture.users["alice"].ID, &role, nil),
	)
	invalid := fixture.requestWithAuthorization(
		t, http.MethodPatch, "/api/v1/admin/users/"+fixture.users["alice"].ID,
		`{"role":"admin","status":"bogus"}`, "admin", true, token,
	)
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid-body response %d: %s", invalid.Code, invalid.Body.String())
	}
	valid := fixture.requestWithAuthorization(
		t, http.MethodPatch, "/api/v1/admin/users/"+fixture.users["alice"].ID,
		`{"role":"admin"}`, "admin", true, token,
	)
	if valid.Code != http.StatusOK {
		t.Fatalf("invalid body consumed authorization: %d: %s", valid.Code, valid.Body.String())
	}
}

func TestAdminInvitationCreateRevokeAndReplayAuthorization(t *testing.T) {
	fixture := newAPIFixture(t)
	createToken := fixture.createAuthorizationGrant(
		t, "admin", invitationCreateAuthorizationScope(t, 2),
	)
	created := fixture.requestWithAuthorization(
		t, http.MethodPost, "/api/v1/admin/invitations", `{"expiresInHours":2}`,
		"admin", true, createToken,
	)
	if created.Code != http.StatusCreated {
		t.Fatalf("authorized create response %d: %s", created.Code, created.Body.String())
	}
	var payload struct {
		Invitation domain.Invitation `json:"invitation"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}

	replayedCreate := fixture.requestWithAuthorization(
		t, http.MethodPost, "/api/v1/admin/invitations", `{"expiresInHours":2}`,
		"admin", true, createToken,
	)
	if replayedCreate.Code != http.StatusForbidden ||
		!strings.Contains(replayedCreate.Body.String(), `"code":"PASSKEY_AUTHORIZATION_INVALID"`) {
		t.Fatalf("create replay response %d: %s", replayedCreate.Code, replayedCreate.Body.String())
	}
	items, err := fixture.store.ListInvitationsAsTrustedControl(context.Background(), 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("create replay changed invitation count: %#v", items)
	}

	revokeToken := fixture.createAuthorizationGrant(
		t, "admin", invitationRevokeAuthorizationScope(t, payload.Invitation.ID),
	)
	invalidRevoke := fixture.requestWithAuthorization(
		t, http.MethodPost, "/api/v1/admin/invitations/"+payload.Invitation.ID+"/revoke",
		`{"unexpected":true}`, "admin", true, revokeToken,
	)
	if invalidRevoke.Code != http.StatusBadRequest {
		t.Fatalf("invalid revoke body response %d: %s", invalidRevoke.Code, invalidRevoke.Body.String())
	}
	revoked := fixture.requestWithAuthorization(
		t, http.MethodPost, "/api/v1/admin/invitations/"+payload.Invitation.ID+"/revoke",
		"", "admin", true, revokeToken,
	)
	if revoked.Code != http.StatusNoContent {
		t.Fatalf("authorized revoke response %d: %s", revoked.Code, revoked.Body.String())
	}
	stored, err := fixture.store.GetInvitationByID(context.Background(), payload.Invitation.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.RevokedAt == nil {
		t.Fatalf("authorized revoke left invitation active: %#v", stored)
	}
	replayedRevoke := fixture.requestWithAuthorization(
		t, http.MethodPost, "/api/v1/admin/invitations/"+payload.Invitation.ID+"/revoke",
		"", "admin", true, revokeToken,
	)
	if replayedRevoke.Code != http.StatusForbidden ||
		!strings.Contains(replayedRevoke.Body.String(), `"code":"PASSKEY_AUTHORIZATION_INVALID"`) {
		t.Fatalf("revoke replay response %d: %s", replayedRevoke.Code, replayedRevoke.Body.String())
	}
}

func TestAuthorizationBeginRejectsUnrestrictedScope(t *testing.T) {
	fixture := newAPIFixture(t)
	response := fixture.request(
		t, http.MethodPost, "/api/v1/passkeys/authorize/begin",
		`{"scope":"admin:audit:delete:all"}`, "admin", true,
	)
	if response.Code != http.StatusUnprocessableEntity ||
		!strings.Contains(response.Body.String(), `"code":"INVALID_INPUT"`) {
		t.Fatalf("unrestricted scope response %d: %s", response.Code, response.Body.String())
	}
}
