package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/Tularity/t-lingual/internal/providers"
)

func providerScope(t *testing.T, endpoints providers.Endpoints) (string, string) {
	t.Helper()
	bytes, err := json.Marshal(endpoints)
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(bytes)
	return "admin:providers:update:" + hex.EncodeToString(hash[:]), string(bytes)
}

func TestAdminProvidersRequireExactFreshStepUpAndPersistEndpoints(t *testing.T) {
	fixture := newSharedAPIFixture(t)
	path := "/api/v1/admin/providers"
	initial := fixture.request(t, http.MethodGet, path, "", "admin", false)
	if initial.Code != http.StatusOK || !strings.Contains(initial.Body.String(), `"asrConfigured":false`) {
		t.Fatalf("initial providers = %d: %s", initial.Code, initial.Body.String())
	}
	if strings.Contains(initial.Body.String(), "fixture-asr-secret") || strings.Contains(initial.Body.String(), "fixture-translator-secret") {
		t.Fatalf("initial provider response leaked configured credentials: %s", initial.Body.String())
	}
	if nonAdmin := fixture.request(t, http.MethodGet, path, "", "alice", false); nonAdmin.Code != http.StatusForbidden {
		t.Fatalf("non-admin provider read = %d: %s", nonAdmin.Code, nonAdmin.Body.String())
	}
	if guest := guestRequest(fixture, http.MethodGet, path, "", "guest-not-an-account", false); guest.Code != http.StatusUnauthorized {
		t.Fatalf("guest provider read = %d: %s", guest.Code, guest.Body.String())
	}
	first := providers.Endpoints{ASRURL: "https://asr.example.invalid", TranslatorURL: ""}
	scope, body := providerScope(t, first)
	if missing := fixture.request(t, http.MethodPut, path, body, "admin", true); missing.Code != http.StatusForbidden {
		t.Fatalf("missing step-up = %d: %s", missing.Code, missing.Body.String())
	}
	adminGrant := fixture.createAuthorizationGrant(t, "admin", scope)
	if rejected := fixture.requestWithAuthorization(t, http.MethodPut, path, body, "admin", false, adminGrant); rejected.Code != http.StatusForbidden {
		t.Fatalf("missing origin = %d: %s", rejected.Code, rejected.Body.String())
	}
	other := providers.Endpoints{ASRURL: "https://changed.example.invalid", TranslatorURL: ""}
	_, otherBody := providerScope(t, other)
	if mismatched := fixture.requestWithAuthorization(t, http.MethodPut, path, otherBody, "admin", true, adminGrant); mismatched.Code != http.StatusForbidden {
		t.Fatalf("payload-mismatched step-up = %d: %s", mismatched.Code, mismatched.Body.String())
	}
	if badURL := fixture.requestWithAuthorization(t, http.MethodPut, path, `{"asrUrl":"https://user:secret@asr.example.invalid","translatorUrl":""}`, "admin", true, adminGrant); badURL.Code != http.StatusBadRequest {
		t.Fatalf("credential-bearing provider URL = %d: %s", badURL.Code, badURL.Body.String())
	}
	if nonAdmin := fixture.requestWithAuthorization(t, http.MethodPut, path, body, "alice", true, fixture.createAuthorizationGrant(t, "alice", scope)); nonAdmin.Code != http.StatusForbidden {
		t.Fatalf("non-admin provider write = %d: %s", nonAdmin.Code, nonAdmin.Body.String())
	}
	if unchanged := fixture.request(t, http.MethodGet, path, "", "admin", false); unchanged.Code != http.StatusOK || strings.Contains(unchanged.Body.String(), first.ASRURL) {
		t.Fatalf("rejected writes mutated provider = %d: %s", unchanged.Code, unchanged.Body.String())
	}
	saved := fixture.requestWithAuthorization(t, http.MethodPut, path, body, "admin", true, adminGrant)
	if saved.Code != http.StatusOK || !strings.Contains(saved.Body.String(), first.ASRURL) || !strings.Contains(saved.Body.String(), `"translatorConfigured":false`) {
		t.Fatalf("provider update = %d: %s", saved.Code, saved.Body.String())
	}
	if replay := fixture.requestWithAuthorization(t, http.MethodPut, path, body, "admin", true, adminGrant); replay.Code != http.StatusForbidden {
		t.Fatalf("replayed authorization = %d: %s", replay.Code, replay.Body.String())
	}
	stored, err := fixture.store.ProviderSettings(context.Background())
	if err != nil || string(stored) != body {
		t.Fatalf("persisted settings = %q, %v; want %q", stored, err, body)
	}
	readBack := fixture.request(t, http.MethodGet, path, "", "admin", false)
	if readBack.Code != http.StatusOK || !strings.Contains(readBack.Body.String(), first.ASRURL) || strings.Contains(readBack.Body.String(), "fixture-asr-secret") || strings.Contains(readBack.Body.String(), "fixture-translator-secret") {
		t.Fatalf("provider readback = %d: %s", readBack.Code, readBack.Body.String())
	}
}

func TestAdminProviderURLChangeDoesNotProbeTranslator(t *testing.T) {
	fixture := newSharedAPIFixture(t)
	path := "/api/v1/admin/providers"
	// Reserved .invalid origins make a real upstream request fail. A successful
	// mutation proves that editing configuration is a local operation only.
	endpoints := providers.Endpoints{ASRURL: "https://asr.example.invalid", TranslatorURL: "https://translator.example.invalid"}
	scope, body := providerScope(t, endpoints)
	token := fixture.createAuthorizationGrant(t, "admin", scope)
	response := fixture.requestWithAuthorization(t, http.MethodPut, path, body, "admin", true, token)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), endpoints.TranslatorURL) {
		t.Fatalf("endpoint-only update = %d: %s", response.Code, response.Body.String())
	}
}
