package store

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/id"
)

func recoveryGrantFixture(t *testing.T) (*Store, domain.User, domain.BrowserSession, string, []byte) {
	t.Helper()
	database, _ := newTestStore(t)
	user := testUser("usr_recovery_grant", "recovery-grant", domain.RoleUser)
	mustCreateUser(t, database, user)
	session := domain.BrowserSession{ID: "ses_recovery_grant", UserID: user.ID,
		CreatedAt: testNow, LastSeen: testNow, ExpiresAt: testNow.Add(time.Hour)}
	if err := database.CreateBrowserSession(context.Background(), session, "browser-recovery-token"); err != nil {
		t.Fatal(err)
	}
	token := "scoped-recovery-token"
	if err := database.CreateActionGrant(context.Background(), ActionGrant{
		ID: "agr_recovery_grant", UserID: user.ID, BrowserSessionID: session.ID,
		Action: ActionPasskeyManagement, CreatedAt: testNow, ExpiresAt: testNow.Add(2 * time.Minute),
	}, token); err != nil {
		t.Fatal(err)
	}
	digest := id.HashSecret(token)
	return database, user, session, token, digest[:]
}

func recoveryCredential(userID string, index int) domain.Credential {
	return domain.Credential{ID: fmt.Sprintf("cred_recovery_%d", index), UserID: userID,
		CredentialID: []byte(fmt.Sprintf("recovery-id-%d", index)), Name: "Recovered key",
		CredentialJSON: []byte(`{"counter":0}`), CreatedAt: testNow.Add(time.Minute)}
}

func TestRecoveryGrantCanRetryBeginButTwoConcurrentFinishesCommitAtMostOne(t *testing.T) {
	database, user, session, token, digest := recoveryGrantFixture(t)
	ctx := context.Background()
	for range 3 {
		if err := database.ValidateRecoveryAddGrant(ctx, token, user.ID, session.ID, testNow.Add(time.Minute)); err != nil {
			t.Fatalf("read-only begin spent grant: %v", err)
		}
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	var wait sync.WaitGroup
	for index := range 2 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			results <- database.CreateCredentialWithRecoveryGrant(ctx, recoveryCredential(user.ID, index),
				session.ID, digest, testNow.Add(time.Minute))
		}()
	}
	close(start)
	wait.Wait()
	close(results)
	success, rejected := 0, 0
	for err := range results {
		switch {
		case err == nil:
			success++
		case errors.Is(err, ErrNotFound):
			rejected++
		default:
			t.Fatalf("unexpected finish result: %v", err)
		}
	}
	if success != 1 || rejected != 1 {
		t.Fatalf("concurrent finish success=%d rejected=%d", success, rejected)
	}
	credentials, err := database.ListCredentials(ctx, user.ID)
	if err != nil || len(credentials) != 1 {
		t.Fatalf("recovery created more than one key: %#v %v", credentials, err)
	}
	if err := database.ValidateRecoveryAddGrant(ctx, token, user.ID, session.ID, testNow.Add(time.Minute)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("successful recovery left grant reusable: %v", err)
	}
}

func TestFailedRecoveryCredentialInsertLeavesGrantForRetryWithinExpiry(t *testing.T) {
	database, user, session, token, digest := recoveryGrantFixture(t)
	ctx := context.Background()
	if err := database.CreateCredential(ctx, recoveryCredential(user.ID, 10)); err != nil {
		t.Fatal(err)
	}
	if err := database.CreateCredentialWithRecoveryGrant(ctx, recoveryCredential(user.ID, 10),
		session.ID, digest, testNow.Add(time.Minute)); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate credential was committed: %v", err)
	}
	if err := database.ValidateRecoveryAddGrant(ctx, token, user.ID, session.ID, testNow.Add(time.Minute)); err != nil {
		t.Fatalf("failed credential insert consumed grant: %v", err)
	}
	if err := database.CreateCredentialWithRecoveryGrant(ctx, recoveryCredential(user.ID, 11),
		"ses_other", digest, testNow.Add(time.Minute)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign session consumed recovery grant: %v", err)
	}
	if err := database.CreateCredentialWithRecoveryGrant(ctx, recoveryCredential(user.ID, 11),
		session.ID, digest, testNow.Add(time.Minute)); err != nil {
		t.Fatalf("valid retry after failed insert: %v", err)
	}
}

func TestRecoveryCeremonyCannotExtendExpiredGrantAtFinish(t *testing.T) {
	database, user, session, token, digest := recoveryGrantFixture(t)
	ctx := context.Background()
	if err := database.ValidateRecoveryAddGrant(ctx, token, user.ID, session.ID,
		testNow.Add(2*time.Minute-time.Nanosecond)); err != nil {
		t.Fatalf("grant expired too early: %v", err)
	}
	if err := database.ValidateRecoveryAddGrant(ctx, token, user.ID, session.ID,
		testNow.Add(2*time.Minute)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expired grant admitted new begin: %v", err)
	}
	if err := database.CreateCredentialWithRecoveryGrant(ctx, recoveryCredential(user.ID, 20),
		session.ID, digest, testNow.Add(2*time.Minute)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("old ceremony extended grant at finish: %v", err)
	}
	credentials, err := database.ListCredentials(ctx, user.ID)
	if err != nil || len(credentials) != 0 {
		t.Fatalf("expired recovery created a credential: %#v %v", credentials, err)
	}
}
