package api

import "testing"

func TestOmittedInterfacePreferencesPreserveCurrentAccountChoice(t *testing.T) {
	fixture := newAPIFixture(t)
	initial := `{"defaultSourceLanguage":"auto","defaultTargetLanguage":"en","autoStartMicrophone":false,"showPartialTranscripts":true,"compactTranscriptLayout":false,"interfaceLanguage":"zh-Hans","themePreference":"dark"}`
	if response := fixture.request(t, "PUT", "/api/v1/settings", initial, "alice", true); response.Code != 200 {
		t.Fatal(response.Code, response.Body.String())
	}
	legacy := `{"defaultSourceLanguage":"en","defaultTargetLanguage":"fr","autoStartMicrophone":false,"showPartialTranscripts":true,"compactTranscriptLayout":true}`
	response := fixture.request(t, "PUT", "/api/v1/settings", legacy, "alice", true)
	if response.Code != 200 {
		t.Fatal(response.Code, response.Body.String())
	}
	body := decodeObject(t, response)
	if body["interfaceLanguage"] != "zh-Hans" || body["themePreference"] != "dark" {
		t.Fatalf("legacy client reset interface preference: %#v", body)
	}
	other := decodeObject(t, fixture.request(t, "GET", "/api/v1/settings", "", "bob", false))
	if other["interfaceLanguage"] != "system" || other["themePreference"] != "system" {
		t.Fatal("preferences escaped account")
	}
}
