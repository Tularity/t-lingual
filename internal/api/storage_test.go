package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/store"
)

func TestAnAccountSeesItsOwnStorageAndWhatItHasLeft(t *testing.T) {
	fixture := newAPIFixture(t)
	created := fixture.request(t, http.MethodPost, "/api/v1/sessions", `{"title":"Standup","sourceLanguage":"en","targetLanguage":"fr"}`, "bob", true)
	var session struct {
		ID string `json:"id"`
	}
	if created.Code != http.StatusCreated || json.Unmarshal(created.Body.Bytes(), &session) != nil {
		t.Fatalf("create session = %d: %s", created.Code, created.Body.String())
	}
	bob := fixture.users["bob"].ID
	part := store.RecordingPart{ID: "part_storage", RunID: "run_storage", SampleRate: 16000, CreatedAt: time.Now().UTC()}
	if err := fixture.store.CreateRecordingPart(context.Background(), bob, session.ID, part); err != nil {
		t.Fatal(err)
	}
	if err := fixture.store.AdvanceRecordingPart(context.Background(), bob, session.ID, part.ID, 64_000); err != nil {
		t.Fatal(err)
	}

	read := func(user string) accountStorageView {
		t.Helper()
		response := fixture.request(t, http.MethodGet, "/api/v1/account/storage", "", user, false)
		var view accountStorageView
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &view) != nil {
			t.Fatalf("storage for %s = %d: %s", user, response.Code, response.Body.String())
		}
		return view
	}
	view := read("bob")
	if view.AudioBytes != 64_000 || view.UsedBytes < 64_000 || view.Sessions != 1 || view.SessionsWithAudio != 1 || view.LimitBytes != 0 {
		t.Fatalf("bob's storage = %#v", view)
	}
	// With no limit, what is left is what the disk holding recordings has
	// free; this store keeps none on disk, so it is not known.
	if view.AvailableBytes != nil {
		t.Fatalf("available without a limit or a disk = %v", *view.AvailableBytes)
	}
	// Someone else's recordings are not counted as yours.
	if other := read("alice"); other.UsedBytes != 0 || other.Sessions != 0 {
		t.Fatalf("alice's storage = %#v", other)
	}

	// A limit caps what is left.
	limits := `{"concurrentRecordings":null,"monthlyRecordingMinutes":null,"storageMb":1,"workspaces":null,"guestLinks":null}`
	if response := fixture.requestWithAuthorization(t, http.MethodPut, "/api/v1/admin/users/"+bob+"/limits", limits, "admin", true, fixture.changeGrant(t, "admin", "limits", bob, limits)); response.Code != http.StatusOK {
		t.Fatalf("limits = %d: %s", response.Code, response.Body.String())
	}
	view = read("bob")
	if view.LimitBytes != 1<<20 || view.AvailableBytes == nil || *view.AvailableBytes != 1<<20-view.UsedBytes {
		t.Fatalf("bob's storage with a limit = %#v, available %v", view, view.AvailableBytes)
	}
	// Room left: a new session can still be made.
	if response := fixture.request(t, http.MethodPost, "/api/v1/sessions", `{"title":"Second","sourceLanguage":"en","targetLanguage":"fr"}`, "bob", true); response.Code != http.StatusCreated {
		t.Fatalf("session with room left = %d: %s", response.Code, response.Body.String())
	}
	// Full: no new session for bob, while alice is unaffected.
	if err := fixture.store.AdvanceRecordingPart(context.Background(), bob, session.ID, part.ID, 2<<20); err != nil {
		t.Fatal(err)
	}
	full := fixture.request(t, http.MethodPost, "/api/v1/sessions", `{"title":"Third","sourceLanguage":"en","targetLanguage":"fr"}`, "bob", true)
	if full.Code != http.StatusConflict || !strings.Contains(full.Body.String(), `"code":"STORAGE_FULL"`) {
		t.Fatalf("session with storage full = %d: %s", full.Code, full.Body.String())
	}
	if response := fixture.request(t, http.MethodPost, "/api/v1/sessions", `{"title":"Alice","sourceLanguage":"en","targetLanguage":"fr"}`, "alice", true); response.Code != http.StatusCreated {
		t.Fatalf("another account's session = %d: %s", response.Code, response.Body.String())
	}
	if view := read("bob"); view.AvailableBytes == nil || *view.AvailableBytes != 0 {
		t.Fatalf("available when full = %v", view.AvailableBytes)
	}
	if response := fixture.request(t, http.MethodGet, "/api/v1/account/storage", "", "", false); response.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous storage = %d", response.Code)
	}
}
