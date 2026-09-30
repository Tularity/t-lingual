package api

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Tularity/t-lingual/internal/domain"
)

func avatarPNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 32, 32))
	for x := 0; x < 32; x++ {
		img.Set(x, x, color.RGBA{200, 100, 50, 255})
	}
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, img); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func (fixture *apiFixture) rawRequest(t *testing.T, method, target, contentType string, body []byte, user string, withOrigin bool) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, target, bytes.NewReader(body))
	request.Header.Set("Content-Type", contentType)
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

func decodeUser(t *testing.T, response *httptest.ResponseRecorder) domain.User {
	t.Helper()
	var user domain.User
	if err := json.Unmarshal(response.Body.Bytes(), &user); err != nil {
		t.Fatalf("decode user: %v: %s", err, response.Body.String())
	}
	return user
}

func TestProfileChangesOnlyTheCallersOwnAccount(t *testing.T) {
	fixture := newAPIFixture(t)

	if response := fixture.request(t, http.MethodPatch, "/api/v1/account/profile", `{"displayName":"Alice L."}`, "alice", false); response.Code != http.StatusForbidden {
		t.Fatalf("rename without origin = %d", response.Code)
	}
	response := fixture.request(t, http.MethodPatch, "/api/v1/account/profile", `{"displayName":"  Alice L.  "}`, "alice", true)
	if response.Code != http.StatusOK || decodeUser(t, response).DisplayName != "Alice L." {
		t.Fatalf("rename = %d: %s", response.Code, response.Body.String())
	}
	if response := fixture.request(t, http.MethodPatch, "/api/v1/account/profile", `{"displayName":"   "}`, "alice", true); response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("blank name = %d", response.Code)
	}
	if bob, _ := fixture.store.GetUserByID(t.Context(), fixture.users["bob"].ID); bob.DisplayName != "BOB" {
		t.Fatalf("bob renamed to %q", bob.DisplayName)
	}

	// A picture is the caller's own, re-encoded; a claimed type must match the bytes.
	if response := fixture.rawRequest(t, http.MethodPut, "/api/v1/account/avatar", "image/svg+xml", []byte(`<svg onload="alert(1)"/>`), "alice", true); response.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("svg = %d: %s", response.Code, response.Body.String())
	}
	if response := fixture.rawRequest(t, http.MethodPut, "/api/v1/account/avatar", "image/jpeg", avatarPNG(t), "alice", true); response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("mislabelled = %d: %s", response.Code, response.Body.String())
	}
	if response := fixture.rawRequest(t, http.MethodPut, "/api/v1/account/avatar", "image/png", avatarPNG(t), "alice", false); response.Code != http.StatusForbidden {
		t.Fatalf("avatar without origin = %d", response.Code)
	}
	response = fixture.rawRequest(t, http.MethodPut, "/api/v1/account/avatar", "image/png", avatarPNG(t), "alice", true)
	alice := decodeUser(t, response)
	if response.Code != http.StatusOK || alice.AvatarVersion == 0 {
		t.Fatalf("avatar = %d: %s", response.Code, response.Body.String())
	}
	me := fixture.request(t, http.MethodGet, "/api/v1/auth/me", "", "alice", false)
	if !strings.Contains(me.Body.String(), `"avatarVersion":`) {
		t.Fatalf("me without avatar version: %s", me.Body.String())
	}

	// Seen by its owner and by an administrator — nobody else, and never without a session.
	path := "/api/v1/users/" + alice.ID + "/avatar"
	own := fixture.request(t, http.MethodGet, path, "", "alice", false)
	if own.Code != http.StatusOK || own.Header().Get("Content-Type") != "image/png" || own.Header().Get("X-Content-Type-Options") != "nosniff" || !strings.Contains(own.Header().Get("Content-Security-Policy"), "sandbox") {
		t.Fatalf("own avatar = %d %v", own.Code, own.Header())
	}
	if decoded, format, err := image.Decode(bytes.NewReader(own.Body.Bytes())); err != nil || format != "png" || decoded.Bounds().Dx() != 32 {
		t.Fatalf("served avatar = %q %v", format, err)
	}
	if response := fixture.request(t, http.MethodGet, path, "", "admin", false); response.Code != http.StatusOK {
		t.Fatalf("admin avatar = %d", response.Code)
	}
	if response := fixture.request(t, http.MethodGet, path, "", "bob", false); response.Code != http.StatusNotFound {
		t.Fatalf("bob read alice's avatar = %d", response.Code)
	}
	if response := fixture.request(t, http.MethodGet, path, "", "", false); response.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous avatar = %d", response.Code)
	}

	// Removing it goes back to initials.
	removed := fixture.request(t, http.MethodDelete, "/api/v1/account/avatar", "", "alice", true)
	if removed.Code != http.StatusOK || decodeUser(t, removed).AvatarVersion != 0 {
		t.Fatalf("remove = %d: %s", removed.Code, removed.Body.String())
	}
	if response := fixture.request(t, http.MethodGet, path, "", "alice", false); response.Code != http.StatusNotFound {
		t.Fatalf("avatar after removal = %d", response.Code)
	}
}
