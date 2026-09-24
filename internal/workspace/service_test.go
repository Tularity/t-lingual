package workspace

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/store"
)

func newWorkspace(t *testing.T) (*Service, *store.Store) {
	t.Helper()
	database, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	service, _ := New(database)
	now := time.Date(2026, 9, 1, 5, 0, 0, 0, time.UTC)
	service.now = func() time.Time { return now }
	for index, userID := range []string{"usr_one", "usr_two", "usr"} {
		user := domain.User{ID: userID, WebAuthnID: bytes.Repeat([]byte{byte(index + 1)}, 64), Username: userID, DisplayName: userID, Role: domain.RoleUser, Status: domain.UserActive, CreatedAt: now, UpdatedAt: now}
		if err := database.CreateUser(context.Background(), user); err != nil {
			t.Fatal(err)
		}
	}
	return service, database
}

func TestSessionLifecycleIsOwnerScoped(t *testing.T) {
	service, _ := newWorkspace(t)
	created, err := service.Create(context.Background(), "usr_one", CreateInput{SourceLanguage: "zh-CN", TargetLanguage: "en-US"})
	if err != nil {
		t.Fatal(err)
	}
	if created.Status != domain.InterpretationCreated || created.Title != "Untitled interpretation" ||
		created.SourceLanguage != "zh-Hans" || created.TargetLanguage != "en" {
		t.Fatalf("unexpected session: %#v", created)
	}
	if _, err := service.Get(context.Background(), "usr_two", created.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cross-owner get leaked a session: %v", err)
	}
	updated, err := service.Update(context.Background(), "usr_one", created.ID, UpdateInput{Title: "Meeting", SourceLanguage: "en-GB", TargetLanguage: "fr-FR"})
	if err != nil || updated.Title != "Meeting" || updated.SourceLanguage != "en" || updated.TargetLanguage != "fr" {
		t.Fatalf("update failed: %#v %v", updated, err)
	}
	if err := service.Delete(context.Background(), "usr_two", created.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cross-owner delete leaked a session: %v", err)
	}
}

func TestLiveSessionCannotBeEditedOrDeleted(t *testing.T) {
	service, database := newWorkspace(t)
	created, err := service.Create(context.Background(), "usr_one", CreateInput{Title: "Live", SourceLanguage: "auto", TargetLanguage: "en-US"})
	if err != nil {
		t.Fatal(err)
	}
	now := service.now()
	if err := database.UpdateInterpretationSessionStatus(context.Background(), "usr_one", created.ID, domain.InterpretationLive, &now, nil, now); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Update(context.Background(), "usr_one", created.ID, UpdateInput{Title: "Changed", SourceLanguage: "zh-CN", TargetLanguage: "en-US"}); !errors.Is(err, ErrSessionLive) {
		t.Fatalf("live edit returned %v", err)
	}
	if err := service.Delete(context.Background(), "usr_one", created.ID); !errors.Is(err, ErrSessionLive) {
		t.Fatalf("live delete returned %v", err)
	}
}

func TestLanguageValidation(t *testing.T) {
	service, _ := newWorkspace(t)
	tests := []CreateInput{
		{SourceLanguage: "auto", TargetLanguage: "auto"},
		{SourceLanguage: "en_US", TargetLanguage: "fr-FR"},
		{SourceLanguage: "xx", TargetLanguage: "fr"},
		{SourceLanguage: "zh", TargetLanguage: "en"},
	}
	for _, input := range tests {
		if _, err := service.Create(context.Background(), "usr", input); err == nil {
			t.Fatalf("expected invalid languages: %#v", input)
		}
	}
}

func TestRecognitionSetupPersistsAndViewerTargetDefaultsToUserSettings(t *testing.T) {
	service, database := newWorkspace(t)
	ctx := context.Background()
	settings := domain.DefaultUserSettings("usr_one")
	settings.DefaultSourceLanguage = "auto"
	settings.DefaultTargetLanguage = "fr"
	if err := database.UpsertUserSettings(ctx, settings); err != nil {
		t.Fatal(err)
	}
	created, err := service.Create(ctx, "usr_one", CreateInput{
		Title: "Multilingual", SourceLanguage: "en", RecognitionLanguages: []string{"en-US", "fr-FR"},
		Diarization: true,
	})
	if err != nil || created.SourceLanguage != "auto" || created.TargetLanguage != "fr" ||
		len(created.RecognitionLanguages) != 2 || created.RecognitionLanguages[0] != "en" ||
		created.RecognitionLanguages[1] != "fr" || !created.Diarization {
		t.Fatalf("multilingual create = %#v, %v", created, err)
	}
	legacyFalse, err := service.Create(ctx, "usr_one", CreateInput{Title: "Legacy false option",
		SourceLanguage: "en", TargetLanguage: "fr", Diarization: false})
	if err != nil || !legacyFalse.Diarization {
		t.Fatalf("new session accepted diarization:false: %#v %v", legacyFalse, err)
	}
	falseValue := false
	updated, err := service.Update(ctx, "usr_one", created.ID, UpdateInput{
		Title: "New speakers", SourceLanguage: "auto", RecognitionLanguages: []string{"ja", "ko"},
		Diarization: &falseValue,
	})
	if err != nil || updated.TargetLanguage != "fr" || updated.SourceLanguage != "auto" ||
		len(updated.RecognitionLanguages) != 2 || updated.RecognitionLanguages[0] != "ja" || !updated.Diarization {
		t.Fatalf("recognition update = %#v, %v", updated, err)
	}
	retained, err := service.Update(ctx, "usr_one", created.ID, UpdateInput{
		Title: "Retained setup", SourceLanguage: "auto", TargetLanguage: "de",
	})
	if err != nil || len(retained.RecognitionLanguages) != 2 || retained.RecognitionLanguages[1] != "ko" || !retained.Diarization {
		t.Fatalf("omitted setup was not retained: %#v, %v", retained, err)
	}
	if _, err := service.Create(ctx, "usr_one", CreateInput{
		Title: "Duplicate", SourceLanguage: "auto", TargetLanguage: "en",
		RecognitionLanguages: []string{"en", "en-US"},
	}); !errors.Is(err, ErrInvalidSession) {
		t.Fatalf("duplicate recognition language = %v", err)
	}
}

func TestRecordingMayMatchViewerDefaultLanguage(t *testing.T) {
	service, _ := newWorkspace(t)
	session, err := service.Create(context.Background(), "usr_one", CreateInput{Title: "English meeting", SourceLanguage: "en", TargetLanguage: "en", RecognitionLanguages: []string{"en"}})
	if err != nil || session.SourceLanguage != "en" {
		t.Fatalf("same-language recording: %#v, %v", session, err)
	}
}
