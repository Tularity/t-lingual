package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/Tularity/t-lingual/internal/auth"
	"github.com/Tularity/t-lingual/internal/domain"
)

// changeGrant is a passkey authorization for exactly this change of this account.
func (fixture *apiFixture) changeGrant(t *testing.T, admin, kind, userID, body string) string {
	t.Helper()
	digest := sha256.Sum256([]byte(body))
	scope, err := auth.AdminUserChangeAuthorizationScope(kind, userID, hex.EncodeToString(digest[:]))
	if err != nil {
		t.Fatal(err)
	}
	return fixture.createAuthorizationGrant(t, admin, scope)
}

func TestAdministratorsSetAnAccountsLimitsOnlyWithAPasskeyForThatChange(t *testing.T) {
	fixture := newAPIFixture(t)
	bob := fixture.users["bob"].ID
	path := "/api/v1/admin/users/" + bob + "/limits"
	body := `{"concurrentRecordings":2,"monthlyRecordingMinutes":600,"storageMb":null,"workspaces":3,"guestLinks":false}`

	if response := fixture.requestWithAuthorization(t, http.MethodPut, path, body, "alice", true, fixture.changeGrant(t, "alice", "limits", bob, body)); response.Code != http.StatusForbidden {
		t.Fatalf("non-admin limits = %d: %s", response.Code, response.Body.String())
	}
	if response := fixture.requestWithAuthorization(t, http.MethodPut, path, body, "admin", true, ""); response.Code == http.StatusOK {
		t.Fatal("limits changed without a passkey")
	}
	// A passkey for other limits does not carry this change.
	other := `{"concurrentRecordings":8,"monthlyRecordingMinutes":null,"storageMb":null,"workspaces":null,"guestLinks":null}`
	if response := fixture.requestWithAuthorization(t, http.MethodPut, path, body, "admin", true, fixture.changeGrant(t, "admin", "limits", bob, other)); response.Code == http.StatusOK {
		t.Fatal("limits changed under another change's passkey")
	}
	if response := fixture.requestWithAuthorization(t, http.MethodPut, path, `{"concurrentRecordings":99}`, "admin", true, fixture.changeGrant(t, "admin", "limits", bob, `{"concurrentRecordings":99}`)); response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("out-of-range limit = %d", response.Code)
	}
	response := fixture.requestWithAuthorization(t, http.MethodPut, path, body, "admin", true, fixture.changeGrant(t, "admin", "limits", bob, body))
	var limits limitsView
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &limits) != nil {
		t.Fatalf("set limits = %d: %s", response.Code, response.Body.String())
	}
	if limits.Effective.ConcurrentRecordings != 2 || limits.Effective.Workspaces != 3 || limits.Effective.GuestLinks ||
		limits.Effective.StorageMB != domain.DefaultUserLimits.StorageMB || limits.Overrides.StorageMB != nil {
		t.Fatalf("limits = %#v", limits)
	}
	detail := fixture.request(t, http.MethodGet, "/api/v1/admin/users/"+bob, "", "admin", false)
	if detail.Code != http.StatusOK || !strings.Contains(detail.Body.String(), `"monthlyRecordingMinutes":600`) || !strings.Contains(detail.Body.String(), `"standing"`) {
		t.Fatalf("detail = %d: %s", detail.Code, detail.Body.String())
	}
	if response := fixture.request(t, http.MethodGet, "/api/v1/admin/users/"+bob, "", "alice", false); response.Code != http.StatusForbidden {
		t.Fatalf("non-admin detail = %d", response.Code)
	}
	audit := fixture.request(t, http.MethodGet, "/api/v1/admin/audit", "", "admin", false)
	if !strings.Contains(audit.Body.String(), "user.limits.set") {
		t.Fatalf("limits change not audited: %s", audit.Body.String())
	}

	// The workspace limit holds: three in all, the first included.
	for index := range 3 {
		response := fixture.request(t, http.MethodPost, "/api/v1/workspaces", `{"name":"W`+string(rune('a'+index))+`","icon":""}`, "bob", true)
		if index < 2 && response.Code != http.StatusCreated {
			t.Fatalf("workspace %d = %d: %s", index, response.Code, response.Body.String())
		}
		if index == 2 && response.Code != http.StatusConflict {
			t.Fatalf("workspace beyond the limit = %d: %s", response.Code, response.Body.String())
		}
	}
	// Back to the defaults.
	reset := `{"concurrentRecordings":null,"monthlyRecordingMinutes":null,"storageMb":null,"workspaces":null,"guestLinks":null}`
	response = fixture.requestWithAuthorization(t, http.MethodPut, path, reset, "admin", true, fixture.changeGrant(t, "admin", "limits", bob, reset))
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &limits) != nil || limits.Effective != domain.DefaultUserLimits {
		t.Fatalf("reset limits = %d: %s", response.Code, response.Body.String())
	}
}

func TestAdministratorsChangeAnAccountsProfileAndPreferences(t *testing.T) {
	fixture := newAPIFixture(t)
	bob := fixture.users["bob"].ID
	profileBody := `{"displayName":"Robert","discoverable":true}`
	response := fixture.requestWithAuthorization(t, http.MethodPatch, "/api/v1/admin/users/"+bob+"/profile", profileBody, "admin", true, fixture.changeGrant(t, "admin", "profile", bob, profileBody))
	if response.Code != http.StatusOK || decodeUser(t, response).DisplayName != "Robert" || !decodeUser(t, response).Discoverable {
		t.Fatalf("profile = %d: %s", response.Code, response.Body.String())
	}
	if response := fixture.requestWithAuthorization(t, http.MethodPatch, "/api/v1/admin/users/"+bob+"/profile", `{}`, "admin", true, fixture.changeGrant(t, "admin", "profile", bob, `{}`)); response.Code != http.StatusBadRequest {
		t.Fatalf("empty profile change = %d", response.Code)
	}
	var before domain.UserSettings
	if earlier := fixture.request(t, http.MethodGet, "/api/v1/settings", "", "bob", false); json.Unmarshal(earlier.Body.Bytes(), &before) != nil {
		t.Fatalf("bob's settings = %s", earlier.Body.String())
	}
	settingsBody := `{"onboardingComplete":false,"defaultSourceLanguage":"en","defaultTargetLanguage":"ja","autoStartMicrophone":false,"showPartialTranscripts":true,"compactTranscriptLayout":true,"autoArchiveHours":72,"interfaceLanguage":"en","themePreference":"dark"}`
	response = fixture.requestWithAuthorization(t, http.MethodPut, "/api/v1/admin/users/"+bob+"/settings", settingsBody, "admin", true, fixture.changeGrant(t, "admin", "settings", bob, settingsBody))
	if response.Code != http.StatusOK {
		t.Fatalf("settings = %d: %s", response.Code, response.Body.String())
	}
	var settings domain.UserSettings
	own := fixture.request(t, http.MethodGet, "/api/v1/settings", "", "bob", false)
	if json.Unmarshal(own.Body.Bytes(), &settings) != nil || settings.DefaultTargetLanguage != "ja" || settings.AutoArchiveHours != 72 ||
		settings.ThemePreference != before.ThemePreference || settings.InterfaceLanguage != before.InterfaceLanguage || settings.OnboardingComplete != before.OnboardingComplete {
		t.Fatalf("bob's own settings = %s", own.Body.String())
	}
	if response := fixture.requestWithAuthorization(t, http.MethodPut, "/api/v1/admin/users/"+bob+"/settings", settingsBody, "alice", true, fixture.changeGrant(t, "alice", "settings", bob, settingsBody)); response.Code != http.StatusForbidden {
		t.Fatalf("non-admin settings = %d", response.Code)
	}
	audit := fixture.request(t, http.MethodGet, "/api/v1/admin/audit", "", "admin", false)
	if !strings.Contains(audit.Body.String(), "user.profile.update") || !strings.Contains(audit.Body.String(), "user.settings.update") {
		t.Fatalf("changes not audited: %s", audit.Body.String())
	}
}

func TestUsageIsOnesOwnAndEveryonesOnlyForAdministrators(t *testing.T) {
	fixture := newAPIFixture(t)
	own := fixture.request(t, http.MethodGet, "/api/v1/account/usage?days=7&offset=600", "", "alice", false)
	var body struct {
		Report struct {
			Days  []map[string]any `json:"days"`
			Users []map[string]any `json:"users"`
		} `json:"report"`
		Limits   domain.UserLimits `json:"limits"`
		Standing map[string]any    `json:"standing"`
	}
	if own.Code != http.StatusOK || json.Unmarshal(own.Body.Bytes(), &body) != nil || len(body.Report.Days) != 7 ||
		body.Report.Users != nil || body.Limits != domain.DefaultUserLimits || body.Standing == nil {
		t.Fatalf("own usage = %d: %s", own.Code, own.Body.String())
	}
	if response := fixture.request(t, http.MethodGet, "/api/v1/account/usage?days=400", "", "alice", false); response.Code != http.StatusBadRequest {
		t.Fatalf("over-long range = %d", response.Code)
	}
	if response := fixture.request(t, http.MethodGet, "/api/v1/account/usage?workspace=wsp_someone_elses", "", "alice", false); response.Code != http.StatusNotFound {
		t.Fatalf("another's workspace = %d", response.Code)
	}
	if response := fixture.request(t, http.MethodGet, "/api/v1/admin/usage", "", "alice", false); response.Code != http.StatusForbidden {
		t.Fatalf("non-admin site usage = %d", response.Code)
	}
	everyone := fixture.request(t, http.MethodGet, "/api/v1/admin/usage?days=30", "", "admin", false)
	if everyone.Code != http.StatusOK || !strings.Contains(everyone.Body.String(), `"users":[`) {
		t.Fatalf("site usage = %d: %s", everyone.Code, everyone.Body.String())
	}
	one := fixture.request(t, http.MethodGet, "/api/v1/admin/usage?user="+fixture.users["bob"].ID, "", "admin", false)
	if one.Code != http.StatusOK || !strings.Contains(one.Body.String(), `"standing"`) || strings.Contains(one.Body.String(), `"users":[`) {
		t.Fatalf("one account's usage = %d: %s", one.Code, one.Body.String())
	}
	if response := fixture.request(t, http.MethodGet, "/api/v1/admin/operations", "", "alice", false); response.Code != http.StatusForbidden {
		t.Fatalf("non-admin operations = %d", response.Code)
	}
}
