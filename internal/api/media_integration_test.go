package api

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/admin"
	"github.com/Tularity/t-lingual/internal/auth"
	"github.com/Tularity/t-lingual/internal/config"
	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/media"
	"github.com/Tularity/t-lingual/internal/providers"
	"github.com/Tularity/t-lingual/internal/rooms"
	"github.com/Tularity/t-lingual/internal/secret"
	"github.com/Tularity/t-lingual/internal/sharing"
	"github.com/Tularity/t-lingual/internal/store"
	"github.com/Tularity/t-lingual/internal/workspace"
	"github.com/coder/websocket"
)

func newFileMediaFixture(t *testing.T) (*apiFixture, *media.Manager, *rooms.Service) {
	t.Helper()
	database, err := store.Open(filepath.Join(t.TempDir(), "state.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Close() })
	keyring, err := secret.New(bytes.Repeat([]byte{6}, 32))
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{Environment: config.Development, RPID: "localhost", RPDisplayName: "t-lingual test", RPOrigins: []string{"http://localhost:8080"}, SessionCookieName: "tlingual_session", SessionTTL: 24 * time.Hour, CeremonyTTL: 5 * time.Minute, InvitationTTL: 24 * time.Hour, MaxJSONBytes: 1 << 20}
	cfg.ASR.APIKey = "fixture-asr-secret"
	cfg.Translator.APIKey = "fixture-translator-secret"
	authService, err := auth.New(cfg, database, keyring)
	if err != nil {
		t.Fatal(err)
	}
	adminService, err := admin.New(database, keyring, cfg.InvitationTTL)
	if err != nil {
		t.Fatal(err)
	}
	workspaceService, err := workspace.New(database)
	if err != nil {
		t.Fatal(err)
	}
	shareService, err := sharing.New(database, keyring)
	if err != nil {
		t.Fatal(err)
	}
	registry, err := providers.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	roomService, err := rooms.New(database, shareService, registry, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { roomService.Shutdown(context.Background()) })
	manager, err := media.New(database, database.DataRoot())
	if err != nil {
		t.Fatal(err)
	}
	users := map[string]domain.User{}
	tokens := map[string]string{}
	now := time.Now().UTC()
	for i, name := range []string{"alice", "bob"} {
		user := domain.User{ID: "usr_" + name, WebAuthnID: bytes.Repeat([]byte{byte(i + 1)}, 64), Username: name, DisplayName: strings.ToUpper(name), Role: domain.RoleUser, Status: domain.UserActive, CreatedAt: now, UpdatedAt: now}
		if err := database.CreateUser(context.Background(), user); err != nil {
			t.Fatal(err)
		}
		token := "test-session-token-with-enough-entropy-" + name
		if err := database.CreateBrowserSession(context.Background(), domain.BrowserSession{ID: "ses_" + name, UserID: user.ID, CreatedAt: now, ExpiresAt: now.Add(24 * time.Hour), LastSeen: now}, token); err != nil {
			t.Fatal(err)
		}
		users[name] = user
		tokens[name] = token
	}
	apiServer, err := New(Dependencies{Config: cfg, Store: database, Auth: authService, Admin: adminService, Workspace: workspaceService, Providers: registry, Rooms: roomService, Sharing: shareService, Media: manager, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	return &apiFixture{handler: apiServer.Handler(), store: database, auth: authService, workspace: workspaceService, users: users, tokens: tokens, config: cfg}, manager, roomService
}
func fileMediaSession(t *testing.T, f *apiFixture, m *media.Manager) (domain.InterpretationSession, string) {
	t.Helper()
	session := sharedSession(t, f)
	ctx := context.Background()
	writer, _, err := m.Begin(ctx, session.UserID, session.ID, "run_http", 16000)
	if err != nil {
		t.Fatal(err)
	}
	pcm := make([]byte, 64000)
	binary.LittleEndian.PutUint32(pcm[4:], 0x3f800000)
	if err := writer.Append(ctx, pcm); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	parts, err := m.List(ctx, session.UserID, session.ID)
	if err != nil || len(parts) != 1 {
		t.Fatalf("audio parts %#v %v", parts, err)
	}
	return session, parts[0].ID
}
func authenticatedGET(t *testing.T, server *httptest.Server, f *apiFixture, path, user, rangeHeader string) (int, []byte, http.Header) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, server.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if user != "" {
		req.AddCookie(&http.Cookie{Name: f.config.SessionCookieName, Value: f.tokens[user]})
	}
	if rangeHeader != "" {
		req.Header.Set("Range", rangeHeader)
	}
	response, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, body, response.Header
}
func guestGET(t *testing.T, server *httptest.Server, f *apiFixture, path, cookie, rangeHeader string) (int, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, server.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: f.config.SessionCookieName + "_guest", Value: cookie})
	if rangeHeader != "" {
		req.Header.Set("Range", rangeHeader)
	}
	response, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, body
}
func TestMediaHTTPRangeOwnerSharedGuestRevocationAndBundle(t *testing.T) {
	f, m, _ := newFileMediaFixture(t)
	server := httptest.NewServer(f.handler)
	defer server.Close()
	session, partID := fileMediaSession(t, f, m)
	view := "/api/v1/view/sessions/" + session.ID
	audio := view + "/audio/" + partID
	if status, body, _ := authenticatedGET(t, server, f, view+"/audio", "alice", ""); status != 200 || !bytes.Contains(body, []byte(`"durationMs":1000`)) {
		t.Fatalf("owner audio index %d %s", status, body)
	}
	status, body, headers := authenticatedGET(t, server, f, audio, "alice", "bytes=44-51")
	if status != 206 || headers.Get("Content-Range") != "bytes 44-51/64044" || len(body) != 8 || binary.LittleEndian.Uint32(body[4:]) != 0x3f800000 {
		t.Fatalf("owner PCM range %d %q %x", status, headers.Get("Content-Range"), body)
	}
	status, body, _ = authenticatedGET(t, server, f, audio, "alice", "bytes=0-43")
	if status != 206 || len(body) != 44 || !bytes.Equal(body[:4], []byte("RIFF")) || binary.LittleEndian.Uint16(body[20:]) != 3 {
		t.Fatalf("WAV header %d %x", status, body)
	}
	if status, _, _ := authenticatedGET(t, server, f, audio, "bob", ""); status != 404 {
		t.Fatalf("stranger audio=%d", status)
	}
	if status, _, _ := authenticatedGET(t, server, f, view+"/audio", "bob", ""); status != 404 {
		t.Fatalf("stranger list=%d", status)
	}
	sharePath := "/api/v1/sessions/" + session.ID + "/shares"
	link := f.request(t, http.MethodPost, sharePath, `{"type":"link","permission":"view","expiresAt":null}`, "alice", true)
	if link.Code != 201 {
		t.Fatalf("create share=%d %s", link.Code, link.Body.String())
	}
	data := decodeObject(t, link)
	token := data["token"].(string)
	shareID := data["id"].(string)
	redeemed := guestRequest(f, http.MethodPost, "/api/v1/share-access", `{"token":"`+token+`","language":"en"}`, "", true)
	if redeemed.Code != 200 {
		t.Fatalf("redeem=%d %s", redeemed.Code, redeemed.Body.String())
	}
	cookie := redeemed.Result().Cookies()[0].Value
	if status, body := guestGET(t, server, f, audio, cookie, "bytes=44-47"); status != 206 || len(body) != 4 {
		t.Fatalf("guest range=%d %x", status, body)
	}
	if status, _ := guestGET(t, server, f, "/api/v1/sessions/"+session.ID+"/bundle", cookie, ""); status != 401 {
		t.Fatalf("guest bundle=%d", status)
	}
	if status, _, _ := authenticatedGET(t, server, f, "/api/v1/sessions/"+session.ID+"/bundle", "bob", ""); status != 404 {
		t.Fatalf("stranger bundle=%d", status)
	}
	status, bundle, _ := authenticatedGET(t, server, f, "/api/v1/sessions/"+session.ID+"/bundle", "alice", "")
	if status != 200 {
		t.Fatalf("owner bundle=%d %s", status, bundle)
	}
	archive, err := zip.NewReader(bytes.NewReader(bundle), int64(len(bundle)))
	if err != nil || len(archive.File) != 3 {
		t.Fatalf("bundle zip=%v files=%v", err, archive)
	}
	if revoked := f.request(t, http.MethodDelete, sharePath+"/"+shareID, "", "alice", true); revoked.Code != 204 {
		t.Fatalf("revoke=%d %s", revoked.Code, revoked.Body.String())
	}
	if status, _ := guestGET(t, server, f, audio, cookie, "bytes=44-47"); status != 404 {
		t.Fatalf("revoked guest range=%d", status)
	}
	if status, _, _ := authenticatedGET(t, server, f, view+"/audio/%2e%2e%2fnot-a-part", "alice", ""); status == 200 || status == 206 {
		t.Fatalf("part traversal accepted=%d", status)
	}
}

func TestMediaHTTPDeleteRemovesPrivateAudioDirectory(t *testing.T) {
	f, m, _ := newFileMediaFixture(t)
	session, partID := fileMediaSession(t, f, m)
	path := filepath.Join(f.store.DataRoot(), "sessions", session.ID)
	response := f.request(t, http.MethodDelete, "/api/v1/sessions/"+session.ID, "", "alice", true)
	if response.Code != http.StatusNoContent {
		t.Fatalf("delete=%d %s", response.Code, response.Body.String())
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("private audio retained: %v", err)
	}
	missing := f.request(t, http.MethodGet, "/api/v1/view/sessions/"+session.ID+"/audio/"+partID, "", "alice", false)
	if missing.Code != http.StatusNotFound {
		t.Fatalf("deleted audio=%d %s", missing.Code, missing.Body.String())
	}
}

func TestBundleEarlyMediaErrorUsesJSONContentType(t *testing.T) {
	f, m, _ := newFileMediaFixture(t)
	session, partID := fileMediaSession(t, f, m)
	path := filepath.Join(f.store.DataRoot(), "sessions", session.ID, "audio", partID+".pcm")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	response := f.request(t, http.MethodGet, "/api/v1/sessions/"+session.ID+"/bundle", "", "alice", false)
	if response.Code < 400 {
		t.Fatalf("missing audio bundle=%d", response.Code)
	}
	if contentType := response.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "application/json") {
		t.Fatalf("early bundle failure returned %q with status %d and body %s", contentType, response.Code, response.Body.String())
	}
}

func TestAudioListDoesNotMarkPreviousRunAsRecordingWhileNewRecorderWaitsForHello(t *testing.T) {
	f, m, _ := newFileMediaFixture(t)
	server := httptest.NewServer(f.handler)
	defer server.Close()
	session, _ := fileMediaSession(t, f, m)
	view := "/api/v1/view/sessions/" + session.ID
	header := http.Header{}
	header.Set("Origin", f.config.RPOrigins[0])
	header.Set("Cookie", f.config.SessionCookieName+"="+f.tokens["alice"])
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+view+"/record", &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		if response != nil {
			t.Fatalf("dial %d %v", response.StatusCode, err)
		}
		t.Fatal(err)
	}
	defer conn.CloseNow()
	status, body, _ := authenticatedGET(t, server, f, view+"/audio", "alice", "")
	if status != 200 {
		t.Fatalf("audio list=%d %s", status, body)
	}
	var listed struct {
		Parts []struct {
			State string `json:"state"`
		} `json:"parts"`
	}
	if err := json.Unmarshal(body, &listed); err != nil || len(listed.Parts) != 1 {
		t.Fatalf("audio list decode %s %v", body, err)
	}
	if listed.Parts[0].State != "ready" {
		t.Fatalf("previous run mislabeled as active: %s", body)
	}
}
