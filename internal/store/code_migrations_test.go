package store

import (
	"context"
	"database/sql"
	"strings"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
)

func TestCodeAndLocaleMigrationsUpgradeExistingData(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", t.TempDir()+"/pre-code.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if _, err := db.ExecContext(ctx, `CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	for _, migration := range migrations {
		if migration.version > 15 {
			break
		}
		if _, err := db.ExecContext(ctx, migration.sql); err != nil {
			t.Fatalf("seed migration %d: %v", migration.version, err)
		}
		if _, err := db.ExecContext(ctx, `INSERT INTO schema_migrations(version, applied_at) VALUES (?,?)`, migration.version, encodeTime(testNow)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO users(id,webauthn_id,username,display_name,role,status,created_at,updated_at)
		VALUES ('usr_legacy',X'0102','legacy','Legacy','user','active',?,?)`, encodeTime(testNow), encodeTime(testNow)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO user_settings(user_id,default_source_language,default_target_language,
		auto_start_microphone,show_partial_transcripts,compact_transcript_layout,interface_language,theme_preference)
		VALUES ('usr_legacy','en','fr',1,1,0,'zh-Hans','dark')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO invitations(id,code_hash,created_at,expires_at)
		VALUES ('inv_legacy',?,?,?)`, []byte(strings.Repeat("a", 32)), encodeTime(testNow), encodeTime(testNow.Add(time.Hour))); err != nil {
		t.Fatal(err)
	}
	database := &Store{db: db}
	if err := database.migrate(ctx); err != nil {
		t.Fatalf("upgrade old database: %v", err)
	}
	legacy, err := database.GetInvitationByID(ctx, "inv_legacy")
	if err != nil || legacy.Kind != "registration" || !legacy.NotBefore.Equal(testNow) || legacy.TargetUserID != "" {
		t.Fatalf("legacy invitation migration = %#v %v", legacy, err)
	}
	var locale, theme, source, target string
	var microphone, partials, compact int
	if err := db.QueryRowContext(ctx, `SELECT interface_language,theme_preference,default_source_language,
		default_target_language,auto_start_microphone,show_partial_transcripts,compact_transcript_layout
		FROM user_settings WHERE user_id='usr_legacy'`).Scan(&locale, &theme, &source, &target,
		&microphone, &partials, &compact); err != nil {
		t.Fatal(err)
	}
	if locale != "zh-Hans" || theme != "dark" || source != "en" || target != "fr" || microphone != 1 || partials != 1 || compact != 0 {
		t.Fatalf("settings changed during migration: %q %q %q %q %d %d %d", locale, theme, source, target, microphone, partials, compact)
	}
	if _, err := db.ExecContext(ctx, `UPDATE user_settings SET interface_language='de' WHERE user_id='usr_legacy'`); err != nil {
		t.Fatalf("new locale constraint rejected supported short tag: %v", err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE user_settings SET interface_language=? WHERE user_id='usr_legacy'`, strings.Repeat("x", 17)); err == nil {
		t.Fatal("new locale constraint accepted an overlong tag")
	}
	legacySettings, err := database.GetUserSettings(ctx, "usr_legacy")
	if err != nil || !legacySettings.OnboardingComplete {
		t.Fatalf("existing user forced through onboarding: %#v %v", legacySettings, err)
	}
	newUser := testUser("usr_after_migration", "after-migration", domain.RoleUser)
	if err := database.CreateUser(ctx, newUser); err != nil {
		t.Fatal(err)
	}
	newSettings, err := database.GetUserSettings(ctx, newUser.ID)
	if err != nil || newSettings.OnboardingComplete {
		t.Fatalf("new user skipped onboarding: %#v %v", newSettings, err)
	}
	site, err := database.GetSiteSettings(ctx)
	if err != nil || site.CodeAttemptsPerMinute != 3 || site.RegistrationHelpMarkdown == "" ||
		strings.Contains(site.RegistrationHelpMarkdown, "@") {
		t.Fatalf("unsafe default site help or code budget: %#v %v", site, err)
	}
}
