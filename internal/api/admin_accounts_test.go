package api

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/auth"
	"github.com/Tularity/t-lingual/internal/domain"
)

// targetGrant is a passkey authorization for removing exactly this passkey or browser of this account.
func (fixture *apiFixture) targetGrant(t *testing.T, admin, kind, userID, target string) string {
	t.Helper()
	digest := sha256.Sum256([]byte(target))
	scope, err := auth.AdminUserChangeAuthorizationScope(kind, userID, hex.EncodeToString(digest[:]))
	if err != nil {
		t.Fatal(err)
	}
	return fixture.createAuthorizationGrant(t, admin, scope)
}

func (fixture *apiFixture) addPasskey(t *testing.T, userID, id string, raw byte) string {
	t.Helper()
	if err := fixture.store.CreateCredential(context.Background(), domain.Credential{
		ID: id, UserID: userID, CredentialID: []byte{raw, raw, raw, raw}, Name: "Passkey " + id,
		CredentialJSON: []byte("sealed"), CreatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString([]byte{raw, raw, raw, raw})
}

func (fixture *apiFixture) addBrowser(t *testing.T, userID, id, agent string) {
	t.Helper()
	now := time.Now().UTC()
	if err := fixture.store.CreateBrowserSession(context.Background(), domain.BrowserSession{
		ID: id, UserID: userID, CreatedAt: now, ExpiresAt: now.Add(time.Hour), LastSeen: now, UserAgent: agent,
	}, "test-session-token-with-enough-entropy-"+id); err != nil {
		t.Fatal(err)
	}
}

func TestAdministratorsSignSomeoneOutOfOneBrowserWithAPasskeyForThatBrowser(t *testing.T) {
	fixture := newAPIFixture(t)
	bob := fixture.users["bob"].ID
	fixture.addBrowser(t, bob, "ses_bob_phone", "Phone browser")

	security := fixture.request(t, http.MethodGet, "/api/v1/admin/users/"+bob+"/security", "", "admin", false)
	var listed struct {
		Passkeys []domain.Credential      `json:"passkeys"`
		Sessions []browserSessionResponse `json:"sessions"`
	}
	if security.Code != http.StatusOK || json.Unmarshal(security.Body.Bytes(), &listed) != nil || len(listed.Sessions) != 2 {
		t.Fatalf("security = %d: %s", security.Code, security.Body.String())
	}
	if strings.Contains(security.Body.String(), "token") {
		t.Fatalf("security listing exposes a token: %s", security.Body.String())
	}
	if response := fixture.request(t, http.MethodGet, "/api/v1/admin/users/"+bob+"/security", "", "alice", false); response.Code != http.StatusForbidden {
		t.Fatalf("non-admin security = %d", response.Code)
	}

	path := "/api/v1/admin/users/" + bob + "/sessions/ses_bob_phone"
	// A passkey for bob's other browser does not sign this one out.
	if response := fixture.requestWithAuthorization(t, http.MethodDelete, path, "", "admin", true, fixture.targetGrant(t, "admin", "session", bob, "ses_bob")); response.Code == http.StatusNoContent {
		t.Fatal("browser signed out under another browser's passkey")
	}
	if response := fixture.requestWithAuthorization(t, http.MethodDelete, path, "", "alice", true, fixture.targetGrant(t, "alice", "session", bob, "ses_bob_phone")); response.Code != http.StatusForbidden {
		t.Fatalf("non-admin sign-out = %d", response.Code)
	}
	if response := fixture.requestWithAuthorization(t, http.MethodDelete, path, "", "admin", true, fixture.targetGrant(t, "admin", "session", bob, "ses_bob_phone")); response.Code != http.StatusNoContent {
		t.Fatalf("sign-out = %d: %s", response.Code, response.Body.String())
	}
	// The other browser is still signed in; the phone is not.
	if response := fixture.request(t, http.MethodGet, "/api/v1/auth/me", "", "bob", false); response.Code != http.StatusOK {
		t.Fatalf("bob's remaining browser = %d", response.Code)
	}
	sessions, _ := fixture.auth.ListBrowserSessions(context.Background(), bob)
	if len(sessions) != 1 || sessions[0].ID != "ses_bob" {
		t.Fatalf("sessions after sign-out = %#v", sessions)
	}
	audit := fixture.request(t, http.MethodGet, "/api/v1/admin/audit", "", "admin", false)
	if !strings.Contains(audit.Body.String(), "user.session.revoke") || !strings.Contains(audit.Body.String(), "Phone browser") {
		t.Fatalf("sign-out not audited: %s", audit.Body.String())
	}
	// An administrator's own browsers are managed in their own settings.
	own := "/api/v1/admin/users/" + fixture.users["admin"].ID + "/sessions/ses_admin"
	if response := fixture.requestWithAuthorization(t, http.MethodDelete, own, "", "admin", true, fixture.targetGrant(t, "admin", "session", fixture.users["admin"].ID, "ses_admin")); response.Code != http.StatusForbidden {
		t.Fatalf("own sign-out through administration = %d", response.Code)
	}
}

func TestAdministratorsRemoveSomeonesPasskeyEvenTheLastSigningThemOutEverywhere(t *testing.T) {
	fixture := newAPIFixture(t)
	bob := fixture.users["bob"].ID
	laptop := fixture.addPasskey(t, bob, "cred_bob_laptop", 7)
	phone := fixture.addPasskey(t, bob, "cred_bob_phone", 9)
	fixture.addBrowser(t, bob, "ses_bob_phone", "Phone browser")

	path := func(credential string) string { return "/api/v1/admin/users/" + bob + "/passkeys/" + credential }
	if response := fixture.requestWithAuthorization(t, http.MethodDelete, path(laptop), "", "admin", true, fixture.targetGrant(t, "admin", "passkey", bob, phone)); response.Code == http.StatusNoContent {
		t.Fatal("passkey removed under another passkey's authorization")
	}
	if response := fixture.requestWithAuthorization(t, http.MethodDelete, path(laptop), "", "admin", true, fixture.targetGrant(t, "admin", "passkey", bob, laptop)); response.Code != http.StatusNoContent {
		t.Fatalf("remove passkey = %d: %s", response.Code, response.Body.String())
	}
	if response := fixture.request(t, http.MethodGet, "/api/v1/auth/me", "", "bob", false); response.Code != http.StatusUnauthorized {
		t.Fatalf("bob still signed in after a passkey was removed = %d", response.Code)
	}
	// The last one too: bob then needs a sign-in code.
	if response := fixture.requestWithAuthorization(t, http.MethodDelete, path(phone), "", "admin", true, fixture.targetGrant(t, "admin", "passkey", bob, phone)); response.Code != http.StatusNoContent {
		t.Fatalf("remove last passkey = %d: %s", response.Code, response.Body.String())
	}
	passkeys, _ := fixture.auth.ListCredentials(context.Background(), bob)
	if len(passkeys) != 0 {
		t.Fatalf("passkeys left = %#v", passkeys)
	}
	audit := fixture.request(t, http.MethodGet, "/api/v1/admin/audit", "", "admin", false)
	if !strings.Contains(audit.Body.String(), "user.passkey.delete") || !strings.Contains(audit.Body.String(), "Passkey cred_bob_phone") {
		t.Fatalf("passkey removal not audited: %s", audit.Body.String())
	}
	if response := fixture.requestWithAuthorization(t, http.MethodDelete, path(phone), "", "admin", true, fixture.targetGrant(t, "admin", "passkey", bob, phone)); response.Code != http.StatusNotFound {
		t.Fatalf("remove a passkey already gone = %d", response.Code)
	}
}

func TestAccountsWithoutTheirOwnLimitsFollowTheDefaultsAnAdministratorSets(t *testing.T) {
	fixture := newAPIFixture(t)
	bob := fixture.users["bob"].ID
	body := `{"concurrentRecordings":3,"monthlyRecordingMinutes":120,"storageMb":0,"workspaces":2,"guestLinks":false}`
	grant := func(user, body string) string {
		digest := sha256.Sum256([]byte(body))
		scope, err := auth.AdminDefaultLimitsAuthorizationScope(hex.EncodeToString(digest[:]))
		if err != nil {
			t.Fatal(err)
		}
		return fixture.createAuthorizationGrant(t, user, scope)
	}
	if response := fixture.requestWithAuthorization(t, http.MethodPut, "/api/v1/admin/limits", body, "alice", true, grant("alice", body)); response.Code != http.StatusForbidden {
		t.Fatalf("non-admin defaults = %d: %s", response.Code, response.Body.String())
	}
	other := strings.Replace(body, `"workspaces":2`, `"workspaces":50`, 1)
	if response := fixture.requestWithAuthorization(t, http.MethodPut, "/api/v1/admin/limits", body, "admin", true, grant("admin", other)); response.Code == http.StatusOK {
		t.Fatal("defaults changed under another change's passkey")
	}
	invalid := strings.Replace(body, `"concurrentRecordings":3`, `"concurrentRecordings":0`, 1)
	if response := fixture.requestWithAuthorization(t, http.MethodPut, "/api/v1/admin/limits", invalid, "admin", true, grant("admin", invalid)); response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("out-of-range defaults = %d", response.Code)
	}
	if response := fixture.requestWithAuthorization(t, http.MethodPut, "/api/v1/admin/limits", body, "admin", true, grant("admin", body)); response.Code != http.StatusOK {
		t.Fatalf("set defaults = %d: %s", response.Code, response.Body.String())
	}
	read := fixture.request(t, http.MethodGet, "/api/v1/admin/limits", "", "admin", false)
	var view defaultLimitsView
	if read.Code != http.StatusOK || json.Unmarshal(read.Body.Bytes(), &view) != nil || view.Defaults.Workspaces != 2 || view.BuiltIn != domain.DefaultUserLimits {
		t.Fatalf("defaults = %d: %s", read.Code, read.Body.String())
	}
	// Bob has no limits of his own: he follows the new defaults.
	limits, err := fixture.store.EffectiveLimits(context.Background(), bob)
	if err != nil || limits.ConcurrentRecordings != 3 || limits.MonthlyRecordingMinutes != 120 || limits.GuestLinks || limits.Workspaces != 2 {
		t.Fatalf("bob's limits = %#v, %v", limits, err)
	}
	for index := range 2 {
		response := fixture.request(t, http.MethodPost, "/api/v1/workspaces", `{"name":"W`+string(rune('a'+index))+`","icon":""}`, "bob", true)
		if index == 0 && response.Code != http.StatusCreated {
			t.Fatalf("workspace within the default = %d: %s", response.Code, response.Body.String())
		}
		if index == 1 && response.Code != http.StatusConflict {
			t.Fatalf("workspace beyond the default = %d: %s", response.Code, response.Body.String())
		}
	}
	// His own value still wins over the default.
	own := `{"concurrentRecordings":null,"monthlyRecordingMinutes":null,"storageMb":null,"workspaces":null,"guestLinks":true}`
	if response := fixture.requestWithAuthorization(t, http.MethodPut, "/api/v1/admin/users/"+bob+"/limits", own, "admin", true, fixture.changeGrant(t, "admin", "limits", bob, own)); response.Code != http.StatusOK {
		t.Fatalf("own limits = %d: %s", response.Code, response.Body.String())
	}
	if limits, _ := fixture.store.EffectiveLimits(context.Background(), bob); !limits.GuestLinks || limits.ConcurrentRecordings != 3 {
		t.Fatalf("bob's limits with his own guest links = %#v", limits)
	}
	audit := fixture.request(t, http.MethodGet, "/api/v1/admin/audit", "", "admin", false)
	if !strings.Contains(audit.Body.String(), "limits.defaults.set") {
		t.Fatalf("defaults change not audited: %s", audit.Body.String())
	}
}
