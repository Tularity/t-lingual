package store

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
)

var testNow = time.Date(2026, time.September, 1, 1, 2, 3, 456789000, time.FixedZone("test", 10*60*60))

func newTestStore(t *testing.T) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "nested", "state.sqlite")
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("close store: %v", err)
		}
	})
	return store, path
}

func testUser(userID, username string, role domain.Role) domain.User {
	return domain.User{
		ID:          userID,
		WebAuthnID:  []byte("webauthn-" + userID),
		Username:    username,
		DisplayName: "Display " + username,
		Role:        role,
		Status:      domain.UserActive,
		CreatedAt:   testNow,
		UpdatedAt:   testNow,
	}
}

func mustCreateUser(t *testing.T, store *Store, user domain.User) {
	t.Helper()
	if err := store.CreateUser(context.Background(), user); err != nil {
		t.Fatalf("create user %s: %v", user.ID, err)
	}
}

func invitationDigest(code string) []byte {
	mac := hmac.New(sha256.New, []byte("test-only-invitation-key-with-32b"))
	_, _ = mac.Write([]byte(code))
	return mac.Sum(nil)
}

func invitationDigestArray(code string) [sha256.Size]byte {
	var result [sha256.Size]byte
	copy(result[:], invitationDigest(code))
	return result
}

func TestOpenCreatesParentAppliesPragmasAndMigratesIdempotently(t *testing.T) {
	store, path := newTestStore(t)
	ctx := context.Background()

	if _, err := os.Stat(filepath.Dir(path)); err != nil {
		t.Fatalf("database parent was not created: %v", err)
	}
	var foreignKeys, busyTimeout int
	if err := store.db.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&foreignKeys); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRowContext(ctx, "PRAGMA busy_timeout").Scan(&busyTimeout); err != nil {
		t.Fatal(err)
	}
	if foreignKeys != 1 || busyTimeout != 5000 {
		t.Fatalf("unexpected pragmas: foreign_keys=%d busy_timeout=%d", foreignKeys, busyTimeout)
	}
	var journalMode string
	if err := store.db.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&journalMode); err != nil {
		t.Fatal(err)
	}
	if journalMode != "wal" {
		t.Fatalf("journal mode = %q, want wal", journalMode)
	}

	wantTables := []string{
		"users", "webauthn_credentials", "invitations", "browser_sessions",
		"webauthn_ceremonies", "interpretation_sessions", "segments",
		"user_settings", "audit_events",
	}
	for _, table := range wantTables {
		var count int
		if err := store.db.QueryRowContext(ctx, `
			SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, table,
		).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 1 {
			t.Errorf("table %s count = %d", table, count)
		}
	}

	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(path)
	if err != nil {
		t.Fatalf("idempotent reopen: %v", err)
	}
	store.db = reopened.db
	var migrations int
	if err := store.db.QueryRowContext(ctx, "SELECT count(*) FROM schema_migrations").Scan(&migrations); err != nil {
		t.Fatal(err)
	}
	if migrations != len(migrationsForTest()) {
		t.Fatalf("migration count = %d, want %d", migrations, len(migrationsForTest()))
	}
}

func migrationsForTest() []migration { return migrations }

func TestUsersCredentialsAndForeignKeys(t *testing.T) {
	store, _ := newTestStore(t)
	ctx := context.Background()
	alice := testUser("usr_alice", "Alice", domain.RoleUser)
	mustCreateUser(t, store, alice)

	got, err := store.GetUserByUsername(ctx, "aLiCe")
	if err != nil || got.ID != alice.ID || got.CreatedAt.Location() != time.UTC {
		t.Fatalf("case-insensitive lookup = %#v, %v", got, err)
	}
	got, err = store.GetUserByWebAuthnID(ctx, alice.WebAuthnID)
	if err != nil || got.ID != alice.ID {
		t.Fatalf("WebAuthn lookup = %#v, %v", got, err)
	}

	duplicate := testUser("usr_duplicate", "ALICE", domain.RoleUser)
	if err := store.CreateUser(ctx, duplicate); !errors.Is(err, ErrConflict) {
		t.Fatalf("case-only duplicate error = %v, want conflict", err)
	}
	if err := store.UpdateUserRole(ctx, alice.ID, domain.RoleAdmin, testNow.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := store.UpdateUserStatus(ctx, alice.ID, domain.UserDisabled, testNow.Add(2*time.Minute)); !errors.Is(err, ErrForbidden) {
		t.Fatalf("disable final active administrator = %v, want forbidden", err)
	}
	backup := testUser("usr_backup_admin", "backup-admin", domain.RoleAdmin)
	mustCreateUser(t, store, backup)
	if err := store.UpdateUserStatus(ctx, alice.ID, domain.UserDisabled, testNow.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	got, err = store.GetUserByID(ctx, alice.ID)
	if err != nil || got.Role != domain.RoleAdmin || got.Status != domain.UserDisabled {
		t.Fatalf("updated user = %#v, %v", got, err)
	}

	missingOwnerCredential := domain.Credential{
		ID:             "cred_missing",
		UserID:         "usr_missing",
		CredentialID:   []byte("missing-owner-credential"),
		Name:           "key",
		CredentialJSON: []byte(`{"id":"missing"}`),
		CreatedAt:      testNow,
	}
	if err := store.CreateCredential(ctx, missingOwnerCredential); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign-key error = %v, want not found", err)
	}

	first := domain.Credential{
		ID:             "cred_first",
		UserID:         alice.ID,
		CredentialID:   []byte("credential-first"),
		Name:           "First key",
		CredentialJSON: []byte(`{"signCount":0}`),
		CreatedAt:      testNow,
	}
	if err := store.CreateCredential(ctx, first); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteCredential(ctx, alice.ID, first.CredentialID, false); !errors.Is(err, ErrForbidden) {
		t.Fatalf("delete final credential = %v, want forbidden", err)
	}

	second := first
	second.ID = "cred_second"
	second.CredentialID = []byte("credential-second")
	if err := store.CreateCredential(ctx, second); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteCredential(ctx, alice.ID, first.CredentialID, false); err != nil {
		t.Fatalf("delete one of two credentials: %v", err)
	}
	usedAt := testNow.Add(time.Hour)
	if err := store.UpdateCredential(
		ctx, alice.ID, second.CredentialID, []byte(`{"signCount":2}`), &usedAt,
	); err != nil {
		t.Fatal(err)
	}
	updated, err := store.GetCredentialByCredentialID(ctx, second.CredentialID)
	if err != nil || updated.LastUsedAt == nil || !updated.LastUsedAt.Equal(usedAt) ||
		!bytes.Equal(updated.CredentialJSON, []byte(`{"signCount":2}`)) {
		t.Fatalf("updated credential = %#v, %v", updated, err)
	}
	credentials, err := store.ListCredentials(ctx, alice.ID)
	if err != nil || len(credentials) != 1 || credentials[0].ID != second.ID {
		t.Fatalf("credentials = %#v, %v", credentials, err)
	}
}

func TestCredentialStateCompareAndSwapAllowsOneConcurrentAdvance(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	user := testUser("usr_counter_cas", "counter-cas", domain.RoleUser)
	mustCreateUser(t, database, user)
	credential := domain.Credential{
		ID: "cred_counter_cas", UserID: user.ID, CredentialID: []byte("counter-cas-id"),
		Name: "Counter key", CredentialJSON: []byte(`{"signCount":7}`), CreatedAt: testNow,
	}
	if err := database.CreateCredential(ctx, credential); err != nil {
		t.Fatal(err)
	}

	const contenders = 24
	start := make(chan struct{})
	results := make(chan error, contenders)
	var wait sync.WaitGroup
	for index := range contenders {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			updated := []byte(fmt.Sprintf(`{"signCount":8,"winner":%d}`, index))
			usedAt := testNow.Add(time.Minute)
			results <- database.UpdateCredentialIfCurrent(
				ctx, user.ID, credential.CredentialID, credential.CredentialJSON, updated, &usedAt,
			)
		}()
	}
	close(start)
	wait.Wait()
	close(results)
	succeeded, conflicted := 0, 0
	for err := range results {
		switch {
		case err == nil:
			succeeded++
		case errors.Is(err, ErrConflict):
			conflicted++
		default:
			t.Fatalf("unexpected CAS result: %v", err)
		}
	}
	if succeeded != 1 || conflicted != contenders-1 {
		t.Fatalf("credential CAS successes=%d conflicts=%d", succeeded, conflicted)
	}
}

func TestCannotRemoveLastActiveAdministratorConcurrently(t *testing.T) {
	store, _ := newTestStore(t)
	ctx := context.Background()
	first := testUser("usr_first_admin", "first-admin", domain.RoleUser)
	second := testUser("usr_second_admin", "second-admin", domain.RoleUser)
	mustCreateUser(t, store, first)
	mustCreateUser(t, store, second)

	// Bootstrapping the first administrator from an all-user database is valid.
	if err := store.UpdateUserRole(ctx, first.ID, domain.RoleAdmin, testNow); err != nil {
		t.Fatalf("promote first administrator: %v", err)
	}
	if err := store.UpdateUserRole(ctx, first.ID, domain.RoleUser, testNow.Add(time.Second)); !errors.Is(err, ErrForbidden) {
		t.Fatalf("demote final administrator = %v, want forbidden", err)
	}
	if err := store.UpdateUserStatus(ctx, first.ID, domain.UserDisabled, testNow.Add(time.Second)); !errors.Is(err, ErrForbidden) {
		t.Fatalf("disable final administrator = %v, want forbidden", err)
	}
	if err := store.UpdateUserRole(ctx, second.ID, domain.RoleAdmin, testNow.Add(2*time.Second)); err != nil {
		t.Fatalf("promote second administrator: %v", err)
	}

	start := make(chan struct{})
	results := make(chan error, 2)
	for _, userID := range []string{first.ID, second.ID} {
		go func() {
			<-start
			results <- store.UpdateUserStatus(ctx, userID, domain.UserDisabled, testNow.Add(3*time.Second))
		}()
	}
	close(start)
	firstResult, secondResult := <-results, <-results
	successes, forbidden := 0, 0
	for _, err := range []error{firstResult, secondResult} {
		if err == nil {
			successes++
		} else if errors.Is(err, ErrForbidden) {
			forbidden++
		} else {
			t.Fatalf("unexpected concurrent status error: %v", err)
		}
	}
	if successes != 1 || forbidden != 1 {
		t.Fatalf("successes=%d forbidden=%d", successes, forbidden)
	}
	var activeAdmins int
	if err := store.db.QueryRowContext(ctx, `
		SELECT count(*) FROM users WHERE role = 'admin' AND status = 'active'`,
	).Scan(&activeAdmins); err != nil {
		t.Fatal(err)
	}
	if activeAdmins != 1 {
		t.Fatalf("active administrator count = %d, want 1", activeAdmins)
	}
}
