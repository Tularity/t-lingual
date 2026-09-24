package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/admin"
	"github.com/Tularity/t-lingual/internal/asr"
	"github.com/Tularity/t-lingual/internal/auth"
	"github.com/Tularity/t-lingual/internal/config"
	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/secret"
	"github.com/Tularity/t-lingual/internal/store"
	"github.com/Tularity/t-lingual/internal/workspace"
)

type apiFixture struct {
	handler   http.Handler
	store     *store.Store
	auth      *auth.Service
	workspace *workspace.Service
	users     map[string]domain.User
	tokens    map[string]string
	config    config.Config
}

func newAPIFixture(t *testing.T) *apiFixture {
	return newAPIFixtureWithLive(t, nil)
}

func newAPIFixtureWithLive(t *testing.T, live LiveHandler) *apiFixture {
	t.Helper()
	database, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	keyring, _ := secret.New(bytes.Repeat([]byte{6}, 32))
	configuration := config.Config{
		Environment:       config.Development,
		RPID:              "localhost",
		RPDisplayName:     "t-lingual test",
		RPOrigins:         []string{"http://localhost:8080"},
		SessionCookieName: "tlingual_session",
		SessionTTL:        24 * time.Hour,
		CeremonyTTL:       5 * time.Minute,
		InvitationTTL:     24 * time.Hour,
		MaxJSONBytes:      1 << 20,
	}
	authService, err := auth.New(configuration, database, keyring)
	if err != nil {
		t.Fatal(err)
	}
	adminService, _ := admin.New(database, keyring, configuration.InvitationTTL)
	workspaceService, _ := workspace.New(database)
	// Authentication uses the real clock; fixed fixture dates eventually expire.
	now := time.Now().UTC()
	users := map[string]domain.User{}
	tokens := map[string]string{}
	for index, role := range []domain.Role{domain.RoleUser, domain.RoleUser, domain.RoleAdmin} {
		name := []string{"alice", "bob", "admin"}[index]
		user := domain.User{
			ID: "usr_" + name, WebAuthnID: bytes.Repeat([]byte{byte(index + 1)}, 64),
			Username: name, DisplayName: strings.ToUpper(name), Role: role, Status: domain.UserActive,
			CreatedAt: now, UpdatedAt: now,
		}
		if err := database.CreateUser(context.Background(), user); err != nil {
			t.Fatal(err)
		}
		token := "test-session-token-with-enough-entropy-" + name
		if err := database.CreateBrowserSession(context.Background(), domain.BrowserSession{
			ID: "ses_" + name, UserID: user.ID, CreatedAt: now, ExpiresAt: now.Add(24 * time.Hour), LastSeen: now,
		}, token); err != nil {
			t.Fatal(err)
		}
		users[name] = user
		tokens[name] = token
	}
	apiServer, err := New(Dependencies{
		Config: configuration, Store: database, Auth: authService, Admin: adminService,
		Workspace: workspaceService, Live: live, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	return &apiFixture{
		handler: apiServer.Handler(), store: database, auth: authService, workspace: workspaceService,
		users: users, tokens: tokens, config: configuration,
	}
}

type recordingLiveHandler struct {
	mu                     sync.Mutex
	servedUserID           string
	servedBrowserSessionID string
	servedInterpretationID string
	revokedBrowserSessions []string
	revokedUsers           []string
}

type countingASRHealth struct{ calls atomic.Int32 }

func (p *countingASRHealth) Ready(context.Context) error {
	p.calls.Add(1)
	return nil
}

func (p *countingASRHealth) Start(context.Context, asr.StartRequest) (asr.Stream, error) {
	return nil, errors.New("not used")
}

func (l *recordingLiveHandler) ServeLive(
	response http.ResponseWriter,
	_ *http.Request,
	user domain.User,
	browserSession domain.BrowserSession,
	interpretationID string,
) error {
	l.mu.Lock()
	l.servedUserID = user.ID
	l.servedBrowserSessionID = browserSession.ID
	l.servedInterpretationID = interpretationID
	l.mu.Unlock()
	response.WriteHeader(http.StatusNoContent)
	return nil
}

func (l *recordingLiveHandler) RevokeBrowserSession(browserSessionID string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.revokedBrowserSessions = append(l.revokedBrowserSessions, browserSessionID)
}

func (l *recordingLiveHandler) RevokeUser(userID string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.revokedUsers = append(l.revokedUsers, userID)
}

func (fixture *apiFixture) request(t *testing.T, method, target, body, user string, withOrigin bool) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	if withOrigin {
		request.Header.Set("Origin", fixture.config.RPOrigins[0])
	}
	if user != "" {
		request.AddCookie(&http.Cookie{Name: fixture.config.SessionCookieName, Value: fixture.tokens[user]})
	}
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	return response
}

type barrierRequestBody struct {
	reader  *strings.Reader
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func (body *barrierRequestBody) Read(buffer []byte) (int, error) {
	body.once.Do(func() { close(body.started) })
	<-body.release
	return body.reader.Read(buffer)
}

func (*barrierRequestBody) Close() error { return nil }

func TestWorkspaceAPIHidesOtherUsersSessions(t *testing.T) {
	fixture := newAPIFixture(t)
	created, err := fixture.workspace.Create(context.Background(), fixture.users["alice"].ID, workspace.CreateInput{
		Title: "Alice private session", SourceLanguage: "zh-CN", TargetLanguage: "en-US",
	})
	if err != nil {
		t.Fatal(err)
	}

	alice := fixture.request(t, http.MethodGet, "/api/v1/sessions/"+created.ID, "", "alice", false)
	if alice.Code != http.StatusOK || !strings.Contains(alice.Body.String(), "Alice private session") {
		t.Fatalf("owner response %d: %s", alice.Code, alice.Body.String())
	}
	bob := fixture.request(t, http.MethodGet, "/api/v1/sessions/"+created.ID, "", "bob", false)
	if bob.Code != http.StatusNotFound || strings.Contains(bob.Body.String(), "Alice") {
		t.Fatalf("cross-user response %d leaked data: %s", bob.Code, bob.Body.String())
	}
	list := fixture.request(t, http.MethodGet, "/api/v1/sessions", "", "bob", false)
	if list.Code != http.StatusOK || strings.Contains(list.Body.String(), created.ID) {
		t.Fatalf("cross-user list leaked data: %s", list.Body.String())
	}
}

func TestListSessionsRejectsUnknownStatus(t *testing.T) {
	fixture := newAPIFixture(t)
	response := fixture.request(t, http.MethodGet, "/api/v1/sessions?status=deleted", "", "alice", false)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("unknown status returned %d: %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"code":"INVALID_STATUS"`) {
		t.Fatalf("unexpected error contract: %s", response.Body.String())
	}
}

func TestMutationsRequireAllowedOrigin(t *testing.T) {
	fixture := newAPIFixture(t)
	body := `{"title":"Meeting","sourceLanguage":"en-US","targetLanguage":"fr-FR"}`
	missing := fixture.request(t, http.MethodPost, "/api/v1/sessions", body, "alice", false)
	if missing.Code != http.StatusForbidden {
		t.Fatalf("missing origin returned %d: %s", missing.Code, missing.Body.String())
	}
	foreignRequest := httptest.NewRequest(http.MethodPost, "/api/v1/sessions", strings.NewReader(body))
	foreignRequest.Header.Set("Origin", "https://evil.example")
	foreignRequest.AddCookie(&http.Cookie{Name: fixture.config.SessionCookieName, Value: fixture.tokens["alice"]})
	foreignResponse := httptest.NewRecorder()
	fixture.handler.ServeHTTP(foreignResponse, foreignRequest)
	if foreignResponse.Code != http.StatusForbidden {
		t.Fatalf("foreign origin returned %d", foreignResponse.Code)
	}
	allowed := fixture.request(t, http.MethodPost, "/api/v1/sessions", body, "alice", true)
	if allowed.Code != http.StatusCreated {
		t.Fatalf("allowed origin returned %d: %s", allowed.Code, allowed.Body.String())
	}
}

func TestAdminBoundariesAndOneTimeInviteValue(t *testing.T) {
	fixture := newAPIFixture(t)
	ordinary := fixture.request(t, http.MethodGet, "/api/v1/admin/users", "", "alice", false)
	if ordinary.Code != http.StatusForbidden {
		t.Fatalf("ordinary user admin response %d: %s", ordinary.Code, ordinary.Body.String())
	}
	createToken := fixture.createAuthorizationGrant(
		t, "admin", invitationCreateAuthorizationScope(t, 2),
	)
	created := fixture.requestWithAuthorization(
		t, http.MethodPost, "/api/v1/admin/invitations", `{"expiresInHours":2}`,
		"admin", true, createToken,
	)
	if created.Code != http.StatusCreated {
		t.Fatalf("admin invite response %d: %s", created.Code, created.Body.String())
	}
	var result struct {
		Code       string            `json:"code"`
		Invitation domain.Invitation `json:"invitation"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Code) != 6 || result.Invitation.ID == "" || created.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("unexpected invite response: %#v headers=%#v", result, created.Header())
	}
	listed := fixture.request(t, http.MethodGet, "/api/v1/admin/invitations", "", "admin", false)
	if listed.Code != http.StatusOK || strings.Contains(listed.Body.String(), result.Code) {
		t.Fatalf("invite clear value leaked from list: %s", listed.Body.String())
	}
}

func TestAdminMutationRechecksSessionAfterSlowBodyLogout(t *testing.T) {
	fixture := newAPIFixture(t)
	payload := `{"role":"admin"}`
	role := domain.RoleAdmin
	authorizationToken := fixture.createAuthorizationGrant(
		t, "admin", userUpdateAuthorizationScope(t, fixture.users["alice"].ID, &role, nil),
	)
	body := &barrierRequestBody{
		reader:  strings.NewReader(payload),
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
	request := httptest.NewRequest(
		http.MethodPatch, "/api/v1/admin/users/"+fixture.users["alice"].ID, body,
	)
	request.ContentLength = int64(len(payload))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", fixture.config.RPOrigins[0])
	request.Header.Set(passkeyAuthorizationHeader, authorizationToken)
	request.AddCookie(&http.Cookie{
		Name: fixture.config.SessionCookieName, Value: fixture.tokens["admin"],
	})
	response := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		fixture.handler.ServeHTTP(response, request)
	}()

	select {
	case <-body.started:
		// Authentication has completed and the handler is now blocked reading
		// the request body, reproducing the middleware-to-mutation TOCTOU.
	case <-time.After(5 * time.Second):
		t.Fatal("admin handler did not reach the request-body barrier")
	}
	if err := fixture.store.DeleteBrowserSession(context.Background(), fixture.tokens["admin"]); err != nil {
		t.Fatal(err)
	}
	close(body.release)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("admin handler did not finish after releasing request body")
	}

	if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "PASSKEY_AUTHORIZATION_INVALID") {
		t.Fatalf("revoked slow-body mutation response %d: %s", response.Code, response.Body.String())
	}
	alice, err := fixture.store.GetUserByID(context.Background(), fixture.users["alice"].ID)
	if err != nil {
		t.Fatal(err)
	}
	if alice.Role != domain.RoleUser {
		t.Fatalf("revoked admin session promoted user: %#v", alice)
	}
	events, err := fixture.store.ListAuditEventsAsTrustedControl(context.Background(), 100, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 0 {
		t.Fatalf("revoked admin session wrote audit events: %#v", events)
	}
}

func TestAdminPromotionRevokesPreexistingAuthenticationAndLiveAccess(t *testing.T) {
	live := &recordingLiveHandler{}
	fixture := newAPIFixtureWithLive(t, live)
	target := fixture.users["alice"]
	authenticatedBefore, _, err := fixture.auth.Authenticate(
		context.Background(), fixture.tokens["alice"],
	)
	if err != nil || authenticatedBefore.Role != domain.RoleUser {
		t.Fatalf("pre-promotion token precondition = %#v, %v", authenticatedBefore, err)
	}

	role := domain.RoleAdmin
	authorizationToken := fixture.createAuthorizationGrant(
		t, "admin", userUpdateAuthorizationScope(t, target.ID, &role, nil),
	)
	response := fixture.requestWithAuthorization(
		t, http.MethodPatch, "/api/v1/admin/users/"+target.ID,
		`{"role":"admin"}`, "admin", true, authorizationToken,
	)
	if response.Code != http.StatusOK {
		t.Fatalf("promotion response %d: %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"role":"admin"`) ||
		strings.Contains(response.Body.String(), "promotedToAdmin") {
		t.Fatalf("unexpected promotion response: %s", response.Body.String())
	}
	if _, _, err := fixture.auth.Authenticate(
		context.Background(), fixture.tokens["alice"],
	); !errors.Is(err, auth.ErrUnauthenticated) {
		t.Fatalf("pre-promotion token still authenticates: %v", err)
	}
	oldCookieAccess := fixture.request(t, http.MethodGet, "/api/v1/admin/users", "", "alice", false)
	if oldCookieAccess.Code != http.StatusUnauthorized {
		t.Fatalf(
			"pre-promotion cookie inherited admin access: status=%d body=%s",
			oldCookieAccess.Code, oldCookieAccess.Body.String(),
		)
	}

	live.mu.Lock()
	revokedUsers := append([]string(nil), live.revokedUsers...)
	live.mu.Unlock()
	if len(revokedUsers) != 1 || revokedUsers[0] != target.ID {
		t.Fatalf("promotion live revocations = %#v, want %q", revokedUsers, target.ID)
	}
	events, err := fixture.store.ListAuditEventsAsTrustedControl(context.Background(), 100, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Action != "user.role.set" || events[0].TargetID != target.ID {
		t.Fatalf("promotion audit events = %#v", events)
	}
}

func TestAdminUserPatchRejectsWholeInvalidCombination(t *testing.T) {
	fixture := newAPIFixture(t)
	response := fixture.request(
		t, http.MethodPatch, "/api/v1/admin/users/"+fixture.users["alice"].ID,
		`{"role":"admin","status":"bogus"}`, "admin", true,
	)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid combined update returned %d: %s", response.Code, response.Body.String())
	}
	stored, err := fixture.store.GetUserByID(context.Background(), fixture.users["alice"].ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Role != domain.RoleUser || stored.Status != domain.UserActive {
		t.Fatalf("invalid combined update partially mutated user: %#v", stored)
	}
}

func TestHealthSeparatesLivenessAndProviderReadiness(t *testing.T) {
	fixture := newAPIFixture(t)
	live := fixture.request(t, http.MethodGet, "/health/live", "", "", false)
	if live.Code != http.StatusOK {
		t.Fatalf("liveness returned %d", live.Code)
	}
	ready := fixture.request(t, http.MethodGet, "/health/ready", "", "", false)
	if ready.Code != http.StatusServiceUnavailable || !strings.Contains(ready.Body.String(), `"configured":false`) {
		t.Fatalf("readiness returned %d: %s", ready.Code, ready.Body.String())
	}
}

func TestReadinessHealthCoalescesAndCachesProviderProbes(t *testing.T) {
	fixture := newAPIFixture(t)
	provider := &countingASRHealth{}
	server := &API{store: fixture.store, asr: provider}

	const requests = 32
	start := make(chan struct{})
	statuses := make(chan int, requests)
	var wg sync.WaitGroup
	for range requests {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			response := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodGet, "/health/ready", nil)
			if err := server.readyHealth(response, request); err != nil {
				statuses <- 0
				return
			}
			statuses <- response.Code
		}()
	}
	close(start)
	wg.Wait()
	close(statuses)
	for status := range statuses {
		if status != http.StatusServiceUnavailable { // translator is deliberately unconfigured.
			t.Fatalf("readiness status = %d", status)
		}
	}
	if calls := provider.calls.Load(); calls != 1 {
		t.Fatalf("provider health was probed %d times for one cache window", calls)
	}

	server.readyMu.Lock()
	server.readyCache.expires = time.Now().Add(-time.Second)
	server.readyMu.Unlock()
	response := httptest.NewRecorder()
	if err := server.readyHealth(response, httptest.NewRequest(http.MethodGet, "/health/ready", nil)); err != nil {
		t.Fatal(err)
	}
	if calls := provider.calls.Load(); calls != 2 {
		t.Fatalf("expired cache did not trigger exactly one new probe: %d", calls)
	}
}

func TestStrictJSONRejectsUnknownFields(t *testing.T) {
	fixture := newAPIFixture(t)
	response := fixture.request(t, http.MethodPost, "/api/v1/sessions", `{"title":"x","sourceLanguage":"en","targetLanguage":"fr","owner":"bob"}`, "alice", true)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "INVALID_JSON") {
		t.Fatalf("unknown field returned %d: %s", response.Code, response.Body.String())
	}
}

func TestLiveReceivesAuthenticatedBrowserSessionAndLogoutRevokesIt(t *testing.T) {
	live := &recordingLiveHandler{}
	fixture := newAPIFixtureWithLive(t, live)
	created, err := fixture.workspace.Create(context.Background(), fixture.users["alice"].ID, workspace.CreateInput{
		Title: "Live identity", SourceLanguage: "en-US", TargetLanguage: "fr-FR",
	})
	if err != nil {
		t.Fatal(err)
	}

	served := fixture.request(t, http.MethodGet, "/api/v1/sessions/"+created.ID+"/live", "", "alice", true)
	if served.Code != http.StatusNoContent {
		t.Fatalf("live handler response %d: %s", served.Code, served.Body.String())
	}
	live.mu.Lock()
	servedUserID := live.servedUserID
	servedBrowserSessionID := live.servedBrowserSessionID
	servedInterpretationID := live.servedInterpretationID
	live.mu.Unlock()
	if servedUserID != fixture.users["alice"].ID || servedBrowserSessionID != "ses_alice" || servedInterpretationID != created.ID {
		t.Fatalf("live identity user=%q browser=%q interpretation=%q", servedUserID, servedBrowserSessionID, servedInterpretationID)
	}

	loggedOut := fixture.request(t, http.MethodPost, "/api/v1/auth/logout", `{}`, "alice", true)
	if loggedOut.Code != http.StatusNoContent {
		t.Fatalf("logout response %d: %s", loggedOut.Code, loggedOut.Body.String())
	}
	live.mu.Lock()
	revoked := append([]string(nil), live.revokedBrowserSessions...)
	live.mu.Unlock()
	if len(revoked) != 1 || revoked[0] != "ses_alice" {
		t.Fatalf("logout revoked browser sessions = %#v", revoked)
	}
	if err := fixture.store.ValidateBrowserSession(context.Background(), fixture.users["alice"].ID, "ses_alice", time.Now().UTC()); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("logout left browser session valid: %v", err)
	}
}

func TestWebAdminDisableImmediatelyRevokesUsersLiveStreams(t *testing.T) {
	live := &recordingLiveHandler{}
	fixture := newAPIFixtureWithLive(t, live)
	status := domain.UserDisabled
	authorizationToken := fixture.createAuthorizationGrant(
		t, "admin", userUpdateAuthorizationScope(t, fixture.users["bob"].ID, nil, &status),
	)
	response := fixture.requestWithAuthorization(
		t, http.MethodPatch, "/api/v1/admin/users/"+fixture.users["bob"].ID,
		`{"status":"disabled"}`, "admin", true, authorizationToken,
	)
	if response.Code != http.StatusOK {
		t.Fatalf("disable response %d: %s", response.Code, response.Body.String())
	}
	live.mu.Lock()
	revoked := append([]string(nil), live.revokedUsers...)
	live.mu.Unlock()
	if len(revoked) != 1 || revoked[0] != fixture.users["bob"].ID {
		t.Fatalf("disabled user revocations = %#v", revoked)
	}
	user, err := fixture.store.GetUserByID(context.Background(), fixture.users["bob"].ID)
	if err != nil {
		t.Fatal(err)
	}
	if user.Status != domain.UserDisabled {
		t.Fatalf("disabled user status = %q", user.Status)
	}
}

func TestRegistrationInvalidIdentityFieldsReturnGenericInvalidInput(t *testing.T) {
	tests := []struct {
		name  string
		input map[string]string
	}{
		{
			name: "username",
			input: map[string]string{
				"invitationCode": "999999", "username": "x", "displayName": "Valid User",
			},
		},
		{
			name: "display name",
			input: map[string]string{
				"invitationCode": "999999", "username": "valid-user", "displayName": "Invalid\x00Name",
			},
		},
		{
			name: "credential name",
			input: map[string]string{
				"invitationCode": "999999", "username": "valid-user", "displayName": "Valid User",
				"credentialName": "Invalid\x00Passkey",
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newAPIFixture(t)
			body, err := json.Marshal(test.input)
			if err != nil {
				t.Fatal(err)
			}
			response := fixture.request(
				t, http.MethodPost, "/api/v1/auth/register/begin", string(body), "", true,
			)
			if response.Code != http.StatusUnprocessableEntity {
				t.Fatalf("status = %d: %s", response.Code, response.Body.String())
			}
			var envelope struct {
				Error struct {
					Code    string `json:"code"`
					Message string `json:"message"`
				} `json:"error"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
				t.Fatal(err)
			}
			if envelope.Error.Code != "INVALID_INPUT" || envelope.Error.Message != "One or more fields are invalid." {
				t.Fatalf("error contract = %#v", envelope.Error)
			}
			for _, detail := range []string{"username", "display name", "credential name", "control"} {
				if strings.Contains(strings.ToLower(response.Body.String()), detail) {
					t.Fatalf("response leaked validation detail %q: %s", detail, response.Body.String())
				}
			}
		})
	}
}
