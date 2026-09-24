package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
)

func siteAuthorityFixture(t *testing.T) (*Store, domain.User, domain.User) {
	t.Helper()
	database, _ := newTestStore(t)
	admin := testUser("usr_site_admin", "site-admin", domain.RoleAdmin)
	ordinary := testUser("usr_site_ordinary", "site-ordinary", domain.RoleUser)
	for _, user := range []domain.User{admin, ordinary} {
		mustCreateUser(t, database, user)
		if err := database.CreateBrowserSession(context.Background(), domain.BrowserSession{
			ID: "ses_" + user.ID, UserID: user.ID, CreatedAt: testNow,
			ExpiresAt: testNow.Add(time.Hour), LastSeen: testNow,
		}, "browser-token-"+user.ID); err != nil {
			t.Fatal(err)
		}
	}
	return database, admin, ordinary
}

func TestSiteSettingsRequireLiveAdminSessionAndAuditChangesAtomically(t *testing.T) {
	database, admin, ordinary := siteAuthorityFixture(t)
	ctx := context.Background()
	if _, err := database.GetSiteSettingsAsAdmin(ctx, ordinary.ID, "ses_"+ordinary.ID, testNow); !errors.Is(err, ErrActiveAdminRequired) {
		t.Fatalf("ordinary user read admin policy: %v", err)
	}
	before, err := database.GetSiteSettingsAsAdmin(ctx, admin.ID, "ses_"+admin.ID, testNow)
	if err != nil || before.CodeAttemptsPerMinute != 3 {
		t.Fatalf("admin read default policy: %#v %v", before, err)
	}
	updated := SiteSettings{RegistrationHelpMarkdown: "## Registration\nAsk an administrator for a one-time code.", CodeAttemptsPerMinute: 1}
	actor := admin.ID
	audit := testAuditEvent("aud_site_update", &actor, "site_settings.update", "site_settings", "1", testNow.Add(time.Minute))
	ordinaryActor := ordinary.ID
	ordinaryAudit := testAuditEvent("aud_ordinary_site_update", &ordinaryActor, "site_settings.update", "site_settings", "1", testNow.Add(time.Minute))
	if _, err := database.UpdateSiteSettingsAsAdmin(ctx, ordinary.ID, "ses_"+ordinary.ID, testNow.Add(time.Minute), updated, ordinaryAudit); !errors.Is(err, ErrActiveAdminRequired) {
		t.Fatalf("ordinary user changed site settings: %v", err)
	}
	result, err := database.UpdateSiteSettingsAsAdmin(ctx, admin.ID, "ses_"+admin.ID, testNow.Add(time.Minute), updated, audit)
	if err != nil || result.CodeAttemptsPerMinute != 1 || result.RegistrationHelpMarkdown != updated.RegistrationHelpMarkdown {
		t.Fatalf("admin site update = %#v %v", result, err)
	}
	if _, err := database.UpdateSiteSettingsAsAdmin(ctx, admin.ID, "ses_"+admin.ID, testNow.Add(2*time.Minute),
		SiteSettings{RegistrationHelpMarkdown: "Changed", CodeAttemptsPerMinute: 5}, audit); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate audit did not roll back update: %v", err)
	}
	readback, err := database.GetSiteSettings(ctx)
	if err != nil || readback.CodeAttemptsPerMinute != 1 || readback.RegistrationHelpMarkdown != updated.RegistrationHelpMarkdown {
		t.Fatalf("audit rollback left partial site settings: %#v %v", readback, err)
	}
	for _, invalid := range []SiteSettings{
		{RegistrationHelpMarkdown: "Unexpected\x00control", CodeAttemptsPerMinute: 3},
		{RegistrationHelpMarkdown: "Ask an administrator.", CodeAttemptsPerMinute: 0},
		{RegistrationHelpMarkdown: strings.Repeat("x", 8193), CodeAttemptsPerMinute: 3},
		{RegistrationHelpMarkdown: "Broken\u2028separator", CodeAttemptsPerMinute: 3},
	} {
		if ValidateSiteSettings(invalid) == nil {
			t.Fatalf("unsafe site settings accepted: %#v", invalid)
		}
	}
	if err := ValidateSiteSettings(SiteSettings{RegistrationHelpMarkdown: "> Quote\n\n`<tag>`", CodeAttemptsPerMinute: 3}); err != nil {
		t.Fatalf("valid Markdown quote or code was rejected: %v", err)
	}
}

func TestOnboardingCompletionIsMonotonicAndInterfacePatchPreservesOtherFields(t *testing.T) {
	database, _, ordinary := siteAuthorityFixture(t)
	ctx := context.Background()
	initial, err := database.GetUserSettings(ctx, ordinary.ID)
	if err != nil || initial.OnboardingComplete {
		t.Fatalf("new user onboarding default: %#v %v", initial, err)
	}
	initial.DefaultTargetLanguage = "ja"
	initial.AutoArchiveHours = 72
	initial.OnboardingComplete = true
	if err := database.UpsertUserSettings(ctx, initial); err != nil {
		t.Fatal(err)
	}
	// A stale whole-settings save cannot reopen onboarding.
	stale := initial
	stale.OnboardingComplete = false
	if err := database.UpsertUserSettings(ctx, stale); err != nil {
		t.Fatal(err)
	}
	locale, theme := "de", "dark"
	patched, err := database.PatchUserInterfaceSettings(ctx, ordinary.ID, &locale, &theme)
	if err != nil || patched.DefaultTargetLanguage != "ja" || patched.AutoArchiveHours != 72 ||
		!patched.OnboardingComplete || patched.InterfaceLanguage != locale || patched.ThemePreference != theme {
		t.Fatalf("interface patch erased quick setup: %#v %v", patched, err)
	}
	light := "light"
	patched, err = database.PatchUserInterfaceSettings(ctx, ordinary.ID, nil, &light)
	if err != nil || patched.InterfaceLanguage != locale || patched.ThemePreference != light {
		t.Fatalf("partial theme patch erased locale: %#v %v", patched, err)
	}
	if _, err := database.PatchUserInterfaceSettings(ctx, "usr_foreign", &locale, nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign settings patch = %v", err)
	}
}

func TestConcurrentQuickSetupWithoutInterfaceFieldsAndInterfacePatchDoNotOverwriteEachOther(t *testing.T) {
	database, _, _ := siteAuthorityFixture(t)
	ctx := context.Background()
	for index := range 20 {
		user := testUser(fmt.Sprintf("usr_quick_%d", index), fmt.Sprintf("quick-%d", index), domain.RoleUser)
		mustCreateUser(t, database, user)
		quick := domain.DefaultUserSettings(user.ID)
		quick.DefaultTargetLanguage = "ja"
		quick.OnboardingComplete = true
		quick.InterfaceLanguage = "" // omitted in the full PUT
		quick.ThemePreference = ""
		locale, theme := "de", "dark"
		start := make(chan struct{})
		errorsSeen := make(chan error, 2)
		var wait sync.WaitGroup
		wait.Add(2)
		go func() {
			defer wait.Done()
			<-start
			errorsSeen <- database.UpsertUserSettings(ctx, quick)
		}()
		go func() {
			defer wait.Done()
			<-start
			_, err := database.PatchUserInterfaceSettings(ctx, user.ID, &locale, &theme)
			errorsSeen <- err
		}()
		close(start)
		wait.Wait()
		close(errorsSeen)
		for err := range errorsSeen {
			if err != nil {
				t.Fatalf("iteration %d concurrent preferences: %v", index, err)
			}
		}
		final, err := database.GetUserSettings(ctx, user.ID)
		if err != nil || final.DefaultTargetLanguage != "ja" || !final.OnboardingComplete ||
			final.InterfaceLanguage != "de" || final.ThemePreference != "dark" {
			t.Fatalf("iteration %d lost concurrent settings: %#v %v", index, final, err)
		}
	}
}
