package domain

import "testing"

func TestRoleValidation(t *testing.T) {
	if !RoleUser.Valid() || !RoleAdmin.Valid() || Role("owner").Valid() {
		t.Fatal("role validation does not enforce the two supported roles")
	}
}

func TestDefaultSettings(t *testing.T) {
	settings := DefaultUserSettings("usr_1")
	if settings.UserID != "usr_1" || settings.DefaultSourceLanguage != "auto" || !settings.ShowPartialTranscripts {
		t.Fatalf("unexpected defaults: %#v", settings)
	}
}
