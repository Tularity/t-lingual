package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/workspace"
)

func TestArchiveAPIRequiresOriginOwnershipAndUnarchive(t *testing.T) {
	fixture := newAPIFixture(t)
	owner := fixture.users["alice"]
	session, err := fixture.workspace.Create(context.Background(), owner.ID, workspace.CreateInput{
		Title: "Keep this transcript", SourceLanguage: "en", TargetLanguage: "fr",
	})
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/v1/sessions/" + session.ID + "/archive"
	if response := fixture.request(t, http.MethodPost, path, "", "alice", false); response.Code != http.StatusForbidden {
		t.Fatalf("missing origin archive = %d: %s", response.Code, response.Body.String())
	}
	for _, method := range []string{http.MethodPost, http.MethodDelete} {
		response := fixture.request(t, method, path, "", "bob", true)
		if response.Code != http.StatusNotFound || strings.Contains(response.Body.String(), session.Title) {
			t.Fatalf("cross-owner %s archive = %d: %s", method, response.Code, response.Body.String())
		}
	}
	response := fixture.request(t, http.MethodPost, path, "", "alice", true)
	if response.Code != http.StatusOK {
		t.Fatalf("archive = %d: %s", response.Code, response.Body.String())
	}
	var archived domain.InterpretationSession
	if err := json.Unmarshal(response.Body.Bytes(), &archived); err != nil {
		t.Fatal(err)
	}
	if archived.ArchivedAt == nil || archived.ArchiveReason != "manual" || archived.Status != domain.InterpretationCreated {
		t.Fatalf("archive did not preserve recording status: %#v", archived)
	}
	edit := fixture.request(t, http.MethodPatch, "/api/v1/sessions/"+session.ID,
		`{"title":"Changed","sourceLanguage":"en","targetLanguage":"fr"}`, "alice", true)
	if edit.Code != http.StatusConflict || !strings.Contains(edit.Body.String(), `"code":"SESSION_ARCHIVED"`) {
		t.Fatalf("archived edit = %d: %s", edit.Code, edit.Body.String())
	}
	listed := fixture.request(t, http.MethodGet, "/api/v1/sessions/"+session.ID, "", "alice", false)
	if listed.Code != http.StatusOK || !strings.Contains(listed.Body.String(), `"archiveReason":"manual"`) {
		t.Fatalf("archive missing from session details = %d: %s", listed.Code, listed.Body.String())
	}
	response = fixture.request(t, http.MethodDelete, path, "", "alice", true)
	if response.Code != http.StatusOK {
		t.Fatalf("unarchive = %d: %s", response.Code, response.Body.String())
	}
	var reopened domain.InterpretationSession
	if err := json.Unmarshal(response.Body.Bytes(), &reopened); err != nil {
		t.Fatal(err)
	}
	if reopened.ArchivedAt != nil || reopened.ArchiveReason != "" || !reopened.UpdatedAt.After(archived.UpdatedAt) {
		t.Fatalf("unarchive did not restart activity clock: %#v", reopened)
	}
	claimed, err := fixture.store.ClaimInterpretationSessionLive(context.Background(), owner.ID, session.ID, reopened.UpdatedAt)
	if err != nil || claimed.Status != domain.InterpretationLive {
		t.Fatalf("unarchived session not resumable: %#v, %v", claimed, err)
	}
	response = fixture.request(t, http.MethodPost, path, "", "alice", true)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), `"code":"SESSION_LIVE"`) {
		t.Fatalf("live archive = %d: %s", response.Code, response.Body.String())
	}
}

func TestSettingsAutoArchiveDefaultOmissionAndNever(t *testing.T) {
	fixture := newAPIFixture(t)
	path := "/api/v1/settings"
	initial := fixture.request(t, http.MethodGet, path, "", "alice", false)
	if initial.Code != http.StatusOK || !strings.Contains(initial.Body.String(), `"autoArchiveHours":24`) {
		t.Fatalf("default archive preference = %d: %s", initial.Code, initial.Body.String())
	}
	legacyBody := `{"defaultSourceLanguage":"en","defaultTargetLanguage":"fr","autoStartMicrophone":false,"showPartialTranscripts":true,"compactTranscriptLayout":false}`
	legacy := fixture.request(t, http.MethodPut, path, legacyBody, "alice", true)
	if legacy.Code != http.StatusOK || !strings.Contains(legacy.Body.String(), `"autoArchiveHours":24`) {
		t.Fatalf("legacy settings update dropped default = %d: %s", legacy.Code, legacy.Body.String())
	}
	never := fixture.request(t, http.MethodPut, path, strings.TrimSuffix(legacyBody, "}")+`,"autoArchiveHours":0}`, "alice", true)
	if never.Code != http.StatusOK || !strings.Contains(never.Body.String(), `"autoArchiveHours":0`) {
		t.Fatalf("never setting = %d: %s", never.Code, never.Body.String())
	}
	legacy = fixture.request(t, http.MethodPut, path, legacyBody, "alice", true)
	if legacy.Code != http.StatusOK || !strings.Contains(legacy.Body.String(), `"autoArchiveHours":0`) {
		t.Fatalf("legacy update overwrote explicit never preference = %d: %s", legacy.Code, legacy.Body.String())
	}
	other := fixture.request(t, http.MethodGet, path, "", "bob", false)
	if other.Code != http.StatusOK || !strings.Contains(other.Body.String(), `"autoArchiveHours":24`) {
		t.Fatalf("another user's default changed = %d: %s", other.Code, other.Body.String())
	}
	for _, hours := range []string{"-1", "8761"} {
		invalid := fixture.request(t, http.MethodPut, path, strings.TrimSuffix(legacyBody, "}")+`,"autoArchiveHours":`+hours+`}`, "alice", true)
		if invalid.Code != http.StatusUnprocessableEntity {
			t.Fatalf("invalid archive preference %s = %d: %s", hours, invalid.Code, invalid.Body.String())
		}
	}
}
