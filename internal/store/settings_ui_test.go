package store

import (
	"context"
	"github.com/Tularity/t-lingual/internal/domain"
	"testing"
)

func TestUserAppearancePreferencesRoundTripAndValidation(t *testing.T) {
	db, _ := newTestStore(t)
	ctx := context.Background()
	owner := testUser("usr_theme", "theme", domain.RoleUser)
	mustCreateUser(t, db, owner)
	defaults, err := db.GetUserSettings(ctx, owner.ID)
	if err != nil || defaults.InterfaceLanguage != "system" || defaults.ThemePreference != "system" {
		t.Fatalf("defaults %#v %v", defaults, err)
	}
	defaults.InterfaceLanguage = "zh-Hans"
	defaults.ThemePreference = "dark"
	if err := db.UpsertUserSettings(ctx, defaults); err != nil {
		t.Fatal(err)
	}
	restored, err := db.GetUserSettings(ctx, owner.ID)
	if err != nil || restored.InterfaceLanguage != "zh-Hans" || restored.ThemePreference != "dark" {
		t.Fatalf("restored %#v %v", restored, err)
	}
	restored.ThemePreference = "fluorescent"
	if err := db.UpsertUserSettings(ctx, restored); err == nil {
		t.Fatal("invalid theme accepted")
	}
	restored.ThemePreference = "dark"
	restored.InterfaceLanguage = "../en"
	if err := db.UpsertUserSettings(ctx, restored); err == nil {
		t.Fatal("invalid locale accepted")
	}
}
