package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/admin"
	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/providers"
	"github.com/Tularity/t-lingual/internal/rooms"
	"github.com/Tularity/t-lingual/internal/secret"
	"github.com/Tularity/t-lingual/internal/sharing"
	"github.com/Tularity/t-lingual/internal/workspace"
	"github.com/coder/websocket"
)

func newSharedAPIFixture(t *testing.T, origin ...string) *apiFixture {
	t.Helper()
	fixture := newAPIFixture(t)
	if len(origin) > 0 {
		fixture.config.RPOrigins = []string{origin[0]}
		if strings.HasPrefix(origin[0], "https://") {
			fixture.config.CookieSecure = true
			fixture.config.SessionCookieName = "__Host-tlingual_session"
		}
	}
	fixture.config.ASR.APIKey = "fixture-asr-secret"
	fixture.config.Translator.APIKey = "fixture-translator-secret"
	keyring, err := secret.New(bytes.Repeat([]byte{6}, 32))
	if err != nil {
		t.Fatal(err)
	}
	adminService, err := admin.New(fixture.store, keyring, fixture.config.InvitationTTL)
	if err != nil {
		t.Fatal(err)
	}
	sharingService, err := sharing.New(fixture.store, keyring)
	if err != nil {
		t.Fatal(err)
	}
	registry, err := providers.New(fixture.config)
	if err != nil {
		t.Fatal(err)
	}
	roomService, err := rooms.New(fixture.store, sharingService, registry, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = roomService.Shutdown(context.Background()) })
	apiServer, err := New(Dependencies{
		Config: fixture.config, Store: fixture.store, Auth: fixture.auth,
		Admin: adminService, Workspace: fixture.workspace, Providers: registry,
		Rooms: roomService, Sharing: sharingService,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	fixture.handler = apiServer.Handler()
	return fixture
}

func sharedSession(t *testing.T, fixture *apiFixture) domain.InterpretationSession {
	t.Helper()
	session, err := fixture.workspace.Create(context.Background(), fixture.users["alice"].ID, workspace.CreateInput{
		Title: "Project discussion", SourceLanguage: "en", TargetLanguage: "zh-Hans",
	})
	if err != nil {
		t.Fatal(err)
	}
	return session
}

func decodeObject(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %d response %s: %v", response.Code, response.Body.String(), err)
	}
	return body
}

func guestRequest(fixture *apiFixture, method, target, body, cookie string, origin bool) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	if origin {
		request.Header.Set("Origin", fixture.config.RPOrigins[0])
	}
	if cookie != "" {
		request.AddCookie(&http.Cookie{Name: fixture.config.SessionCookieName + "_guest", Value: cookie})
	}
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	return response
}

func recordHandshake(t *testing.T, fixture *apiFixture, server *httptest.Server, path, cookieName, cookieValue string, allowedOrigin bool) (bool, int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	header := http.Header{}
	if allowedOrigin {
		header.Set("Origin", fixture.config.RPOrigins[0])
	} else {
		header.Set("Origin", "https://not-allowed.example.invalid")
	}
	header.Set("Cookie", cookieName+"="+cookieValue)
	connection, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+path+"/record", &websocket.DialOptions{HTTPHeader: header})
	if connection != nil {
		connection.CloseNow()
	}
	if err == nil {
		return true, http.StatusSwitchingProtocols
	}
	if response == nil {
		t.Fatalf("record handshake lacked response: %v", err)
	}
	response.Body.Close()
	return false, response.StatusCode
}

func TestSharedUserViewRecordAndOwnerOnlyMutations(t *testing.T) {
	server := httptest.NewUnstartedServer(nil)
	fixture := newSharedAPIFixture(t, "http://"+server.Listener.Addr().String())
	server.Config.Handler = fixture.handler
	server.Start()
	defer server.Close()
	session := sharedSession(t, fixture)
	path := "/api/v1/sessions/" + session.ID + "/shares"
	if missingOrigin := fixture.request(t, http.MethodPost, path, `{"type":"user","userId":"usr_bob","permission":"view","expiresAt":null}`, "alice", false); missingOrigin.Code != http.StatusForbidden {
		t.Fatalf("share without origin = %d: %s", missingOrigin.Code, missingOrigin.Body.String())
	}
	if unauthorized := fixture.request(t, http.MethodGet, path, "", "bob", false); unauthorized.Code != http.StatusNotFound {
		t.Fatalf("non-owner shares = %d: %s", unauthorized.Code, unauthorized.Body.String())
	}
	created := fixture.request(t, http.MethodPost, path, `{"type":"user","userId":"usr_bob","permission":"view","expiresAt":null}`, "alice", true)
	if created.Code != http.StatusCreated {
		t.Fatalf("create share = %d: %s", created.Code, created.Body.String())
	}
	shareID, _ := decodeObject(t, created)["id"].(string)
	if shareID == "" {
		t.Fatal("share ID absent")
	}
	if denied := fixture.request(t, http.MethodPost, path, `{"type":"link","permission":"record","expiresAt":null}`, "bob", true); denied.Code == http.StatusCreated {
		t.Fatal("recipient created a share")
	}
	viewPath := "/api/v1/view/sessions/" + session.ID
	view := fixture.request(t, http.MethodGet, viewPath, "", "bob", false)
	if view.Code != http.StatusOK || decodeObject(t, view)["access"].(map[string]any)["permission"] != "view" {
		t.Fatalf("recipient view = %d: %s", view.Code, view.Body.String())
	}
	if stop := fixture.request(t, http.MethodPost, viewPath+"/recording/stop", `{}`, "bob", true); stop.Code != http.StatusForbidden {
		t.Fatalf("view-only stop = %d: %s", stop.Code, stop.Body.String())
	}
	if upgraded, status := recordHandshake(t, fixture, server, viewPath, fixture.config.SessionCookieName, fixture.tokens["bob"], true); upgraded || status != http.StatusForbidden {
		t.Fatalf("view-only record handshake upgraded=%t status=%d", upgraded, status)
	}
	update := fixture.request(t, http.MethodPatch, path+"/"+shareID, `{"permission":"record","expiresAt":null}`, "alice", true)
	if update.Code != http.StatusOK {
		t.Fatalf("permission update = %d: %s", update.Code, update.Body.String())
	}
	view = fixture.request(t, http.MethodGet, viewPath, "", "bob", false)
	if view.Code != http.StatusOK || decodeObject(t, view)["access"].(map[string]any)["permission"] != "record" {
		t.Fatalf("record grant = %d: %s", view.Code, view.Body.String())
	}
	if upgraded, status := recordHandshake(t, fixture, server, viewPath, fixture.config.SessionCookieName, fixture.tokens["bob"], true); !upgraded {
		t.Fatalf("record-granted collaborator handshake status=%d", status)
	}
	if upgraded, status := recordHandshake(t, fixture, server, viewPath, fixture.config.SessionCookieName, fixture.tokens["bob"], false); upgraded || status != http.StatusForbidden {
		t.Fatalf("disallowed record origin upgraded=%t status=%d", upgraded, status)
	}
	if stop := fixture.request(t, http.MethodPost, viewPath+"/recording/stop", `{}`, "bob", true); stop.Code != http.StatusForbidden {
		t.Fatalf("record collaborator stopped owner-controlled recorder = %d: %s", stop.Code, stop.Body.String())
	}
	if revoked := fixture.request(t, http.MethodDelete, path+"/"+shareID, "", "alice", true); revoked.Code != http.StatusNoContent {
		t.Fatalf("revoke share = %d: %s", revoked.Code, revoked.Body.String())
	}
	if removed := fixture.request(t, http.MethodGet, viewPath, "", "bob", false); removed.Code != http.StatusNotFound {
		t.Fatalf("revoked recipient view = %d: %s", removed.Code, removed.Body.String())
	}
}

func TestSharedViewerTargetsAreIndependentAndGuestCannotAccessAccount(t *testing.T) {
	server := httptest.NewUnstartedServer(nil)
	fixture := newSharedAPIFixture(t, "http://"+server.Listener.Addr().String())
	server.Config.Handler = fixture.handler
	server.Start()
	defer server.Close()
	session := sharedSession(t, fixture)
	if err := fixture.store.AppendSegment(context.Background(), fixture.users["alice"].ID, domain.Segment{
		ID: "seg_shared_projection", SessionID: session.ID, UserID: fixture.users["alice"].ID,
		Sequence: 1, SourceText: "Hello", Translation: "只属于其他语言的旧缓存", TranslationStatus: domain.TranslationSucceeded,
		Final: true, StartMS: 0, EndMS: 500, CreatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	path := "/api/v1/sessions/" + session.ID + "/shares"
	created := fixture.request(t, http.MethodPost, path, `{"type":"user","userId":"usr_bob","permission":"view","expiresAt":null}`, "alice", true)
	if created.Code != http.StatusCreated {
		t.Fatalf("user share = %d: %s", created.Code, created.Body.String())
	}
	link := fixture.request(t, http.MethodPost, path, `{"type":"link","permission":"record","expiresAt":null}`, "alice", true)
	if link.Code != http.StatusCreated {
		t.Fatalf("link share = %d: %s", link.Code, link.Body.String())
	}
	linkBody := decodeObject(t, link)
	token, _ := linkBody["token"].(string)
	if token == "" {
		t.Fatal("clear link token absent at creation")
	}
	if forbidden := guestRequest(fixture, http.MethodPost, "/api/v1/share-access", `{"token":"`+token+`","language":"ja"}`, "", false); forbidden.Code != http.StatusForbidden {
		t.Fatalf("redeem without origin = %d: %s", forbidden.Code, forbidden.Body.String())
	}
	redeem := guestRequest(fixture, http.MethodPost, "/api/v1/share-access", `{"token":"`+token+`","language":"ja"}`, "", true)
	if redeem.Code != http.StatusOK || len(redeem.Result().Cookies()) != 1 {
		t.Fatalf("guest redeem = %d: %s", redeem.Code, redeem.Body.String())
	}
	guestCookie := redeem.Result().Cookies()[0].Value
	viewPath := "/api/v1/view/sessions/" + session.ID
	guestView := guestRequest(fixture, http.MethodGet, viewPath, "", guestCookie, false)
	if guestView.Code != http.StatusOK || decodeObject(t, guestView)["access"].(map[string]any)["permission"] != "record" {
		t.Fatalf("guest record grant = %d: %s", guestView.Code, guestView.Body.String())
	}
	if upgraded, status := recordHandshake(t, fixture, server, viewPath, fixture.config.SessionCookieName+"_guest", guestCookie, true); !upgraded {
		t.Fatalf("record-granted guest handshake status=%d", status)
	}
	for _, route := range []string{"/api/v1/settings", "/api/v1/admin/providers", path} {
		response := guestRequest(fixture, http.MethodGet, route, "", guestCookie, false)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("guest account route %s = %d: %s", route, response.Code, response.Body.String())
		}
	}
	bobLanguage := fixture.request(t, http.MethodPut, viewPath+"/language", `{"targetLanguage":"fr"}`, "bob", true)
	if bobLanguage.Code != http.StatusOK || decodeObject(t, bobLanguage)["targetLanguage"] != "fr" {
		t.Fatalf("bob target = %d: %s", bobLanguage.Code, bobLanguage.Body.String())
	}
	guestLanguage := guestRequest(fixture, http.MethodPut, viewPath+"/language", `{"targetLanguage":"de"}`, guestCookie, true)
	if guestLanguage.Code != http.StatusOK || decodeObject(t, guestLanguage)["targetLanguage"] != "de" {
		t.Fatalf("guest target = %d: %s", guestLanguage.Code, guestLanguage.Body.String())
	}
	owner := fixture.request(t, http.MethodGet, viewPath, "", "alice", false)
	bob := fixture.request(t, http.MethodGet, viewPath, "", "bob", false)
	guest := guestRequest(fixture, http.MethodGet, viewPath, "", guestCookie, false)
	for label, pair := range map[string]struct {
		response *httptest.ResponseRecorder
		target   string
	}{
		"owner": {owner, "en"}, "bob": {bob, "fr"}, "guest": {guest, "de"},
	} {
		if pair.response.Code != http.StatusOK || decodeObject(t, pair.response)["access"].(map[string]any)["targetLanguage"] != pair.target {
			t.Fatalf("%s target isolation = %d: %s", label, pair.response.Code, pair.response.Body.String())
		}
		if strings.Contains(pair.response.Body.String(), "只属于其他语言的旧缓存") {
			t.Fatalf("%s view leaked a translation for another language", label)
		}
	}
	shareID, _ := linkBody["id"].(string)
	if revoked := fixture.request(t, http.MethodDelete, path+"/"+shareID, "", "alice", true); revoked.Code != http.StatusNoContent {
		t.Fatalf("link revoke = %d: %s", revoked.Code, revoked.Body.String())
	}
	if revokedGuest := guestRequest(fixture, http.MethodGet, viewPath, "", guestCookie, false); revokedGuest.Code != http.StatusNotFound {
		t.Fatalf("revoked guest = %d: %s", revokedGuest.Code, revokedGuest.Body.String())
	}
}

func TestSharedLinkExpirationInvalidatesRedeemedGuest(t *testing.T) {
	server := httptest.NewUnstartedServer(nil)
	fixture := newSharedAPIFixture(t, "http://"+server.Listener.Addr().String())
	server.Config.Handler = fixture.handler
	server.Start()
	defer server.Close()
	session := sharedSession(t, fixture)
	sharePath := "/api/v1/sessions/" + session.ID + "/shares"
	link := fixture.request(t, http.MethodPost, sharePath, `{"type":"link","permission":"view","expiresAt":null}`, "alice", true)
	if link.Code != http.StatusCreated {
		t.Fatalf("short link = %d: %s", link.Code, link.Body.String())
	}
	token, _ := decodeObject(t, link)["token"].(string)
	shareID, _ := decodeObject(t, link)["id"].(string)
	redeem := guestRequest(fixture, http.MethodPost, "/api/v1/share-access", `{"token":"`+token+`","language":"en"}`, "", true)
	if redeem.Code != http.StatusOK {
		t.Fatalf("short link redeem = %d: %s", redeem.Code, redeem.Body.String())
	}
	cookie := redeem.Result().Cookies()[0].Value
	if view := guestRequest(fixture, http.MethodGet, "/api/v1/view/sessions/"+session.ID, "", cookie, false); view.Code != http.StatusOK {
		t.Fatalf("guest view before expiry = %d: %s", view.Code, view.Body.String())
	}
	if upgraded, status := recordHandshake(t, fixture, server, "/api/v1/view/sessions/"+session.ID, fixture.config.SessionCookieName+"_guest", cookie, true); upgraded || status != http.StatusForbidden {
		t.Fatalf("view-only guest record handshake upgraded=%t status=%d", upgraded, status)
	}
	expiration := time.Now().UTC().Add(300 * time.Millisecond)
	update := fixture.request(t, http.MethodPatch, sharePath+"/"+shareID, `{"permission":"view","expiresAt":"`+expiration.Format(time.RFC3339Nano)+`"}`, "alice", true)
	if update.Code != http.StatusOK {
		t.Fatalf("shorten link expiry = %d: %s", update.Code, update.Body.String())
	}
	if remaining := time.Until(expiration); remaining > 0 {
		time.Sleep(remaining + 50*time.Millisecond)
	}
	if expired := guestRequest(fixture, http.MethodGet, "/api/v1/view/sessions/"+session.ID, "", cookie, false); expired.Code != http.StatusNotFound {
		t.Fatalf("expired guest = %d: %s", expired.Code, expired.Body.String())
	}
}
