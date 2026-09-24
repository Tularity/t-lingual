package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestOnboardingCompletionAndInterfacePatchPreserveQuickSetupSettings(t *testing.T) {
	fixture := newAPIFixture(t)
	me := fixture.requestWithAuthorization(t, http.MethodGet, "/api/v1/auth/me", "", "alice", false, "")
	var identity map[string]any
	if me.Code != http.StatusOK || json.Unmarshal(me.Body.Bytes(), &identity) != nil || identity["onboardingComplete"] != false {
		t.Fatalf("new user's onboarding response = %d %s", me.Code, me.Body.String())
	}
	complete := `{"defaultSourceLanguage":"auto","defaultTargetLanguage":"ja","autoStartMicrophone":false,` +
		`"showPartialTranscripts":true,"compactTranscriptLayout":false,"autoArchiveHours":72,` +
		`"interfaceLanguage":"en","themePreference":"light","onboardingComplete":true}`
	updated := fixture.requestWithAuthorization(t, http.MethodPut, "/api/v1/settings", complete, "alice", true, "")
	if updated.Code != http.StatusOK || !strings.Contains(updated.Body.String(), `"onboardingComplete":true`) {
		t.Fatalf("quick setup completion = %d %s", updated.Code, updated.Body.String())
	}
	stale := strings.Replace(complete, `"onboardingComplete":true`, `"onboardingComplete":false`, 1)
	staleWrite := fixture.requestWithAuthorization(t, http.MethodPut, "/api/v1/settings", stale, "alice", true, "")
	if staleWrite.Code != http.StatusOK || !strings.Contains(staleWrite.Body.String(), `"onboardingComplete":true`) {
		t.Fatalf("stale settings reset onboarding: %d %s", staleWrite.Code, staleWrite.Body.String())
	}
	noOrigin := fixture.requestWithAuthorization(t, http.MethodPatch, "/api/v1/settings/interface",
		`{"interfaceLanguage":"de"}`, "alice", false, "")
	if noOrigin.Code != http.StatusForbidden {
		t.Fatalf("interface patch without origin = %d", noOrigin.Code)
	}
	patched := fixture.requestWithAuthorization(t, http.MethodPatch, "/api/v1/settings/interface",
		`{"interfaceLanguage":"de","themePreference":"dark"}`, "alice", true, "")
	if patched.Code != http.StatusOK || !strings.Contains(patched.Body.String(), `"defaultTargetLanguage":"ja"`) ||
		!strings.Contains(patched.Body.String(), `"autoArchiveHours":72`) ||
		!strings.Contains(patched.Body.String(), `"onboardingComplete":true`) ||
		!strings.Contains(patched.Body.String(), `"interfaceLanguage":"de"`) {
		t.Fatalf("interface patch overwrote quick setup: %d %s", patched.Code, patched.Body.String())
	}
	withoutPresentationFields := `{"defaultSourceLanguage":"auto","defaultTargetLanguage":"fr",` +
		`"autoStartMicrophone":false,"showPartialTranscripts":true,"compactTranscriptLayout":false,` +
		`"autoArchiveHours":72,"onboardingComplete":false}`
	quickEdit := fixture.requestWithAuthorization(t, http.MethodPut, "/api/v1/settings",
		withoutPresentationFields, "alice", true, "")
	if quickEdit.Code != http.StatusOK || !strings.Contains(quickEdit.Body.String(), `"defaultTargetLanguage":"fr"`) ||
		!strings.Contains(quickEdit.Body.String(), `"interfaceLanguage":"de"`) ||
		!strings.Contains(quickEdit.Body.String(), `"themePreference":"dark"`) ||
		!strings.Contains(quickEdit.Body.String(), `"onboardingComplete":true`) {
		t.Fatalf("omitted interface fields clobbered presentation settings: %d %s", quickEdit.Code, quickEdit.Body.String())
	}
	me = fixture.requestWithAuthorization(t, http.MethodGet, "/api/v1/auth/me", "", "alice", false, "")
	if me.Code != http.StatusOK || json.Unmarshal(me.Body.Bytes(), &identity) != nil || identity["onboardingComplete"] != true {
		t.Fatalf("me did not reflect completed onboarding: %d %s", me.Code, me.Body.String())
	}
	bob := fixture.requestWithAuthorization(t, http.MethodGet, "/api/v1/settings", "", "bob", false, "")
	if bob.Code != http.StatusOK || strings.Contains(bob.Body.String(), `"defaultTargetLanguage":"ja"`) ||
		strings.Contains(bob.Body.String(), `"onboardingComplete":true`) {
		t.Fatalf("settings leaked between users: %d %s", bob.Code, bob.Body.String())
	}
}
