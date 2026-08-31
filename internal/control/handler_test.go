package control

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/admin"
	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/secret"
	"github.com/Tularity/t-lingual/internal/store"
)

func newControlTestService(t *testing.T) (*admin.Service, *store.Store) {
	t.Helper()
	database, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	keyring, err := secret.New(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	service, err := admin.New(database, keyring, 24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	return service, database
}

func newControlTestHandler(t *testing.T, maxJSONBytes int64) (http.Handler, *store.Store) {
	return newControlTestHandlerWithRevoker(t, maxJSONBytes, nil)
}

func newControlTestHandlerWithRevoker(
	t *testing.T,
	maxJSONBytes int64,
	revokeUser RevokeUserFunc,
) (http.Handler, *store.Store) {
	t.Helper()
	service, database := newControlTestService(t)
	handler, err := NewHandler(service, revokeUser, maxJSONBytes)
	if err != nil {
		t.Fatal(err)
	}
	return handler, database
}

func controlRequest(handler http.Handler, method, path, body, contentType string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func decodeTestResponse[T any](t *testing.T, response *httptest.ResponseRecorder) T {
	t.Helper()
	var result T
	decoder := json.NewDecoder(response.Body)
	if err := decoder.Decode(&result); err != nil {
		t.Fatalf("decode response: %v; body=%q", err, response.Body.String())
	}
	return result
}

func responseErrorCode(t *testing.T, response *httptest.ResponseRecorder) string {
	t.Helper()
	return decodeTestResponse[errorEnvelope](t, response).Error.Code
}

func TestHandlerInvitationLifecycleUsesSocketBootstrapActor(t *testing.T) {
	handler, _ := newControlTestHandler(t, DefaultMaxJSONBytes)

	status := controlRequest(handler, http.MethodGet, StatusPath, "", "")
	if status.Code != http.StatusOK {
		t.Fatalf("status code = %d, body=%s", status.Code, status.Body.String())
	}
	statusBody := decodeTestResponse[StatusResponse](t, status)
	if statusBody.Status != "ok" || statusBody.APIVersion != "v1" {
		t.Fatalf("unexpected status response: %#v", statusBody)
	}

	created := controlRequest(handler, http.MethodPost, InvitationsPath, `{"ttl":"1h"}`, "application/json")
	if created.Code != http.StatusCreated {
		t.Fatalf("create code = %d, body=%s", created.Code, created.Body.String())
	}
	createdBody := decodeTestResponse[CreateInvitationResponse](t, created)
	if !regexp.MustCompile(`^[0-9]{6}$`).MatchString(createdBody.Code) {
		t.Fatalf("clear invitation code has wrong shape: %q", createdBody.Code)
	}
	if createdBody.Invitation.CreatedBy != nil {
		t.Fatalf("socket-created invitation unexpectedly has web actor: %#v", createdBody.Invitation)
	}

	listed := controlRequest(handler, http.MethodGet, InvitationsPath+"?limit=500&offset=0", "", "")
	if listed.Code != http.StatusOK {
		t.Fatalf("list code = %d, body=%s", listed.Code, listed.Body.String())
	}
	if strings.Contains(listed.Body.String(), `"code"`) {
		t.Fatalf("invitation list disclosed clear code: %s", listed.Body.String())
	}
	listedBody := decodeTestResponse[InvitationListResponse](t, listed)
	if len(listedBody.Invitations) != 1 || listedBody.Invitations[0].ID != createdBody.Invitation.ID {
		t.Fatalf("unexpected invitations: %#v", listedBody.Invitations)
	}

	revoked := controlRequest(handler, http.MethodPost, InvitationRevokePath,
		`{"id":"`+createdBody.Invitation.ID+`"}`, "application/json; charset=utf-8")
	if revoked.Code != http.StatusOK {
		t.Fatalf("revoke code = %d, body=%s", revoked.Code, revoked.Body.String())
	}
	repeated := controlRequest(handler, http.MethodPost, InvitationRevokePath,
		`{"id":"`+createdBody.Invitation.ID+`"}`, "application/json")
	if repeated.Code != http.StatusConflict || responseErrorCode(t, repeated) != "CONFLICT" {
		t.Fatalf("second revoke = %d, body=%s", repeated.Code, repeated.Body.String())
	}
}

func TestInvitationCodeIsNotLogged(t *testing.T) {
	handler, _ := newControlTestHandler(t, DefaultMaxJSONBytes)
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })

	created := controlRequest(handler, http.MethodPost, InvitationsPath, `{}`, "application/json")
	if created.Code != http.StatusCreated {
		t.Fatalf("create code = %d, body=%s", created.Code, created.Body.String())
	}
	response := decodeTestResponse[CreateInvitationResponse](t, created)
	if strings.Contains(logs.String(), response.Code) {
		t.Fatalf("clear invitation code was written to logs: %q", logs.String())
	}
}

func TestHandlerUserManagementUsesSharedAdminPolicy(t *testing.T) {
	handler, database := newControlTestHandler(t, DefaultMaxJSONBytes)
	now := time.Now().UTC()
	createControlTestUser(t, database, "usr_admin", domain.RoleAdmin, now)
	createControlTestUser(t, database, "usr_member", domain.RoleUser, now.Add(time.Second))
	memberToken := "opaque-control-member-token"
	if err := database.CreateBrowserSession(context.Background(), domain.BrowserSession{
		ID:        "ses_control_member",
		UserID:    "usr_member",
		CreatedAt: now.Add(time.Second),
		ExpiresAt: now.Add(time.Hour),
		LastSeen:  now.Add(time.Second),
	}, memberToken); err != nil {
		t.Fatal(err)
	}

	listed := controlRequest(handler, http.MethodGet, UsersPath, "", "")
	if listed.Code != http.StatusOK {
		t.Fatalf("list users = %d, body=%s", listed.Code, listed.Body.String())
	}
	users := decodeTestResponse[UserListResponse](t, listed)
	if len(users.Users) != 2 {
		t.Fatalf("unexpected users: %#v", users.Users)
	}

	role := controlRequest(handler, http.MethodPost, UserRolePath,
		`{"id":"usr_member","role":"admin"}`, "application/json")
	if role.Code != http.StatusOK {
		t.Fatalf("set role = %d, body=%s", role.Code, role.Body.String())
	}
	if _, err := database.LookupBrowserSession(
		context.Background(), memberToken, now.Add(2*time.Second),
	); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("CLI promotion retained pre-promotion session: %v", err)
	}
	status := controlRequest(handler, http.MethodPost, UserStatusPath,
		`{"id":"usr_member","status":"disabled"}`, "application/json")
	if status.Code != http.StatusOK {
		t.Fatalf("set status = %d, body=%s", status.Code, status.Body.String())
	}
	member, err := database.GetUserByID(context.Background(), "usr_member")
	if err != nil {
		t.Fatal(err)
	}
	if member.Role != domain.RoleAdmin || member.Status != domain.UserDisabled {
		t.Fatalf("shared admin policy did not update user: %#v", member)
	}

	finalAdmin := controlRequest(handler, http.MethodPost, UserStatusPath,
		`{"id":"usr_admin","status":"disabled"}`, "application/json")
	if finalAdmin.Code != http.StatusConflict || responseErrorCode(t, finalAdmin) != "SAFETY_CONFLICT" {
		t.Fatalf("final admin safety response = %d, body=%s", finalAdmin.Code, finalAdmin.Body.String())
	}
}

func TestHandlerRevokesLiveUserOnlyAfterPromotionOrDisableCommit(t *testing.T) {
	var revoked []string
	handler, database := newControlTestHandlerWithRevoker(
		t,
		DefaultMaxJSONBytes,
		func(userID string) { revoked = append(revoked, userID) },
	)
	now := time.Now().UTC()
	createControlTestUser(t, database, "usr_callback_admin", domain.RoleAdmin, now)
	createControlTestUser(t, database, "usr_callback_member", domain.RoleUser, now.Add(time.Second))

	promoted := controlRequest(handler, http.MethodPost, UserRolePath,
		`{"id":"usr_callback_member","role":"admin"}`, "application/json")
	if promoted.Code != http.StatusOK {
		t.Fatalf("promotion = %d, body=%s", promoted.Code, promoted.Body.String())
	}
	if len(revoked) != 1 || revoked[0] != "usr_callback_member" {
		t.Fatalf("promotion revocations = %#v", revoked)
	}

	idempotent := controlRequest(handler, http.MethodPost, UserRolePath,
		`{"id":"usr_callback_member","role":"admin"}`, "application/json")
	demoted := controlRequest(handler, http.MethodPost, UserRolePath,
		`{"id":"usr_callback_member","role":"user"}`, "application/json")
	enabled := controlRequest(handler, http.MethodPost, UserStatusPath,
		`{"id":"usr_callback_member","status":"active"}`, "application/json")
	for name, response := range map[string]*httptest.ResponseRecorder{
		"idempotent": idempotent, "demotion": demoted, "enable": enabled,
	} {
		if response.Code != http.StatusOK {
			t.Fatalf("%s = %d, body=%s", name, response.Code, response.Body.String())
		}
	}
	if len(revoked) != 1 {
		t.Fatalf("non-revoking changes called live revoker: %#v", revoked)
	}

	disabled := controlRequest(handler, http.MethodPost, UserStatusPath,
		`{"id":"usr_callback_member","status":"disabled"}`, "application/json")
	if disabled.Code != http.StatusOK {
		t.Fatalf("disable = %d, body=%s", disabled.Code, disabled.Body.String())
	}
	if len(revoked) != 2 || revoked[1] != "usr_callback_member" {
		t.Fatalf("disable revocations = %#v", revoked)
	}
}

func TestHandlerDoesNotRevokeLiveUserWhenMutationFails(t *testing.T) {
	var revoked []string
	handler, database := newControlTestHandlerWithRevoker(
		t,
		DefaultMaxJSONBytes,
		func(userID string) { revoked = append(revoked, userID) },
	)
	createControlTestUser(t, database, "usr_callback_only_admin", domain.RoleAdmin, time.Now().UTC())

	finalAdmin := controlRequest(handler, http.MethodPost, UserStatusPath,
		`{"id":"usr_callback_only_admin","status":"disabled"}`, "application/json")
	if finalAdmin.Code != http.StatusConflict || responseErrorCode(t, finalAdmin) != "SAFETY_CONFLICT" {
		t.Fatalf("failed disable = %d, body=%s", finalAdmin.Code, finalAdmin.Body.String())
	}
	missing := controlRequest(handler, http.MethodPost, UserRolePath,
		`{"id":"usr_callback_missing","role":"admin"}`, "application/json")
	if missing.Code != http.StatusNotFound {
		t.Fatalf("missing promotion = %d, body=%s", missing.Code, missing.Body.String())
	}
	if len(revoked) != 0 {
		t.Fatalf("failed mutations called live revoker: %#v", revoked)
	}
}

func TestHandlerRejectsNonStrictRequests(t *testing.T) {
	handler, _ := newControlTestHandler(t, 32)
	tests := []struct {
		name        string
		method      string
		path        string
		body        string
		contentType string
		status      int
		code        string
	}{
		{name: "wrong media type", method: http.MethodPost, path: InvitationsPath, body: `{}`, contentType: "text/plain", status: http.StatusUnsupportedMediaType, code: "JSON_REQUIRED"},
		{name: "unknown field", method: http.MethodPost, path: InvitationsPath, body: `{"unknown":true}`, contentType: "application/json", status: http.StatusBadRequest, code: "INVALID_JSON"},
		{name: "two values", method: http.MethodPost, path: InvitationsPath, body: `{} {}`, contentType: "application/json", status: http.StatusBadRequest, code: "INVALID_JSON"},
		{name: "too large", method: http.MethodPost, path: InvitationsPath, body: `{"ttl":"123456789012345678901234567890123456"}`, contentType: "application/json", status: http.StatusRequestEntityTooLarge, code: "REQUEST_TOO_LARGE"},
		{name: "unknown query", method: http.MethodGet, path: UsersPath + "?cursor=x", status: http.StatusBadRequest, code: "INVALID_PAGINATION"},
		{name: "wrong method", method: http.MethodDelete, path: UsersPath, status: http.StatusMethodNotAllowed, code: "METHOD_NOT_ALLOWED"},
		{name: "unknown route", method: http.MethodGet, path: "/v1/unknown", status: http.StatusNotFound, code: "ROUTE_NOT_FOUND"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := controlRequest(handler, test.method, test.path, test.body, test.contentType)
			if response.Code != test.status || responseErrorCode(t, response) != test.code {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if response.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("control response is cacheable")
			}
		})
	}
}

func TestNewHandlerValidatesDependencies(t *testing.T) {
	service, _ := newControlTestService(t)
	if _, err := NewHandler(nil, nil, DefaultMaxJSONBytes); err == nil {
		t.Fatal("nil admin service was accepted")
	}
	if _, err := NewHandler(service, nil, 0); err == nil {
		t.Fatal("zero body limit was accepted")
	}
}

func createControlTestUser(t *testing.T, database *store.Store, id string, role domain.Role, now time.Time) {
	t.Helper()
	if err := database.CreateUser(context.Background(), domain.User{
		ID:          id,
		WebAuthnID:  []byte("webauthn-" + id),
		Username:    id,
		DisplayName: id,
		Role:        role,
		Status:      domain.UserActive,
		CreatedAt:   now,
		UpdatedAt:   now,
	}); err != nil {
		t.Fatal(err)
	}
}
