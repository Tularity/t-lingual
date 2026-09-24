package store

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
)

func codeFixture(t *testing.T, kind string, notBefore time.Time) (*Store, domain.User, domain.Invitation, [sha256.Size]byte) {
	t.Helper()
	database, _ := newTestStore(t)
	user := testUser("usr_code_target", "code-target", domain.RoleUser)
	mustCreateUser(t, database, user)
	invitation := domain.Invitation{ID: "inv_code_target", Kind: kind, CreatedAt: testNow,
		NotBefore: notBefore, ExpiresAt: notBefore.Add(10 * time.Minute)}
	if kind == "login" {
		invitation.TargetUserID = user.ID
	}
	digest := sha256.Sum256([]byte("keyed-test-digest"))
	if err := database.CreateInvitationWithBucket(context.Background(), invitation, digest[:], 37); err != nil {
		t.Fatal(err)
	}
	return database, user, invitation, digest
}

func redeemTestCode(database *Store, digest [sha256.Size]byte, now time.Time, index int) (domain.Invitation, error) {
	session := domain.BrowserSession{ID: fmt.Sprintf("ses_code_%d", index), CreatedAt: now,
		ExpiresAt: now.Add(time.Hour), LastSeen: now}
	return database.RedeemOneTimeCode(context.Background(), digest, 37, now, session,
		fmt.Sprintf("browser-token-%d", index), fmt.Sprintf("aud_code_%d", index),
		fmt.Sprintf("agr_code_%d", index), fmt.Sprintf("add-only-grant-%d", index), now.Add(2*time.Minute))
}

func TestScheduledLoginCodeIsAtomicSingleUseWithItsSessionAndRecoveryGrant(t *testing.T) {
	start := testNow.Add(10 * time.Minute)
	database, user, invitation, digest := codeFixture(t, "login", start)
	if _, err := redeemTestCode(database, digest, start.Add(-time.Second), 100); !errors.Is(err, ErrInvalidInvite) {
		t.Fatalf("premature login = %v", err)
	}
	const contenders = 16
	results := make(chan error, contenders)
	var wait sync.WaitGroup
	for index := range contenders {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, err := redeemTestCode(database, digest, start, index)
			results <- err
		}()
	}
	wait.Wait()
	close(results)
	success, rejected := 0, 0
	for err := range results {
		switch {
		case err == nil:
			success++
		case errors.Is(err, ErrInvalidInvite):
			rejected++
		default:
			t.Fatalf("unexpected contender error: %v", err)
		}
	}
	if success != 1 || rejected != contenders-1 {
		t.Fatalf("single-use results success=%d rejected=%d", success, rejected)
	}
	stored, err := database.GetInvitationByID(context.Background(), invitation.ID)
	if err != nil || stored.UsedAt == nil || stored.UsedBy == nil || *stored.UsedBy != user.ID || stored.Kind != "login" {
		t.Fatalf("login code state = %#v %v", stored, err)
	}
	var sessions, grants int
	if err := database.db.QueryRow(`SELECT COUNT(*) FROM browser_sessions WHERE user_id=? AND id LIKE 'ses_code_%'`, user.ID).Scan(&sessions); err != nil {
		t.Fatal(err)
	}
	if err := database.db.QueryRow(`SELECT COUNT(*) FROM action_grants WHERE user_id=? AND id LIKE 'agr_code_%'`, user.ID).Scan(&grants); err != nil {
		t.Fatal(err)
	}
	if sessions != 1 || grants != 1 {
		t.Fatalf("atomic session/grant counts = %d/%d", sessions, grants)
	}
}

func TestDisabledTargetAndUnstartedCodeCannotBeRedeemedOrBurnedByUnknownGuess(t *testing.T) {
	start := testNow.Add(10 * time.Minute)
	database, user, invitation, digest := codeFixture(t, "login", start)
	unknown := sha256.Sum256([]byte("another-code"))
	for index := range 6 {
		if _, err := redeemTestCode(database, unknown, start.Add(-time.Minute), index+100); !errors.Is(err, ErrInvalidInvite) {
			t.Fatalf("unknown guess = %v", err)
		}
	}
	stored, err := database.GetInvitationByID(context.Background(), invitation.ID)
	if err != nil || stored.RevokedAt != nil || stored.UsedAt != nil {
		t.Fatalf("future code was burned by guesses: %#v %v", stored, err)
	}
	if _, err := database.db.Exec(`UPDATE users SET status='disabled' WHERE id=?`, user.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := redeemTestCode(database, digest, start, 200); !errors.Is(err, ErrInvalidInvite) {
		t.Fatalf("disabled target login = %v", err)
	}
	stored, _ = database.GetInvitationByID(context.Background(), invitation.ID)
	if stored.UsedAt != nil {
		t.Fatal("disabled target consumed code")
	}
	if _, err := database.db.Exec(`UPDATE users SET status='active' WHERE id=?`, user.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := redeemTestCode(database, digest, start, 201); err != nil {
		t.Fatalf("enabled target could not redeem valid code: %v", err)
	}
}

func TestRegistrationCodeEntryLeavesInvitationUnconsumedAndLoginCodeCannotRegister(t *testing.T) {
	database, _, invitation, digest := codeFixture(t, "registration", testNow)
	for index := range 2 {
		result, err := redeemTestCode(database, digest, testNow.Add(time.Minute), index)
		if err != nil || result.Kind != "registration" {
			t.Fatalf("registration preview %d = %#v %v", index, result, err)
		}
	}
	stored, err := database.GetInvitationByID(context.Background(), invitation.ID)
	if err != nil || stored.UsedAt != nil {
		t.Fatalf("registration code consumed at entry: %#v %v", stored, err)
	}
	loginDB, _, _, loginDigest := codeFixture(t, "login", testNow)
	if _, err := loginDB.ValidateInvitation(context.Background(), loginDigest, testNow.Add(time.Minute)); !errors.Is(err, ErrInvalidInvite) {
		t.Fatalf("login code accepted as registration invitation: %v", err)
	}
}

func TestConcurrentTicketBackedRegistrationsConsumeOnlyOneInvitation(t *testing.T) {
	database, _, invitation, digest := codeFixture(t, "registration", testNow)
	// Separate valid tickets can be issued for the same code. The passkey
	// completion transaction, not ticket issuance, is the single-use boundary.
	for index := range 2 {
		if _, err := redeemTestCode(database, digest, testNow.Add(time.Minute), index+400); err != nil {
			t.Fatal(err)
		}
	}
	const contenders = 12
	results := make(chan error, contenders)
	var wait sync.WaitGroup
	for index := range contenders {
		wait.Add(1)
		go func() {
			defer wait.Done()
			user := testUser(fmt.Sprintf("usr_ticket_%d", index), fmt.Sprintf("ticket-user-%d", index), domain.RoleUser)
			credential := domain.Credential{ID: fmt.Sprintf("cred_ticket_%d", index), UserID: user.ID,
				CredentialID: []byte(fmt.Sprintf("credential-ticket-%d", index)), Name: "Passkey",
				CredentialJSON: []byte(`{"counter":0}`), CreatedAt: testNow}
			_, err := database.CompleteRegistration(context.Background(), digest[:], 37, testNow.Add(2*time.Minute),
				user, credential, 5, fmt.Sprintf("aud_ticket_%d", index))
			results <- err
		}()
	}
	wait.Wait()
	close(results)
	success, rejected := 0, 0
	for err := range results {
		switch {
		case err == nil:
			success++
		case errors.Is(err, ErrInvalidInvite):
			rejected++
		default:
			t.Fatalf("unexpected registration contender result: %v", err)
		}
	}
	if success != 1 || rejected != contenders-1 {
		t.Fatalf("registration completions = %d success, %d rejected", success, rejected)
	}
	stored, err := database.GetInvitationByID(context.Background(), invitation.ID)
	if err != nil || stored.UsedBy == nil || stored.UsedAt == nil {
		t.Fatalf("completed registration did not consume invitation: %#v %v", stored, err)
	}
}

func TestRegistrationSessionFailureRollsBackUserPasskeyAndCode(t *testing.T) {
	database, existing, invitation, digest := codeFixture(t, "registration", testNow)
	ctx := context.Background()
	duplicate := domain.BrowserSession{ID: "ses_existing", UserID: existing.ID, CreatedAt: testNow,
		ExpiresAt: testNow.Add(time.Hour), LastSeen: testNow}
	if err := database.CreateBrowserSession(ctx, duplicate, "existing-token"); err != nil {
		t.Fatal(err)
	}
	user := testUser("usr_new_registration", "new-registration", domain.RoleUser)
	credential := domain.Credential{ID: "cred_new_registration", UserID: user.ID,
		CredentialID: []byte("new-registration-credential"), Name: "First passkey",
		CredentialJSON: []byte(`{"counter":0}`), CreatedAt: testNow}
	firstSession := duplicate
	firstSession.UserID = user.ID
	if _, err := database.CompleteRegistrationWithSession(ctx, digest[:], 37, testNow.Add(time.Minute),
		user, credential, 5, "aud_registration_duplicate", firstSession, "new-token"); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate browser session did not fail registration: %v", err)
	}
	stored, err := database.GetInvitationByID(ctx, invitation.ID)
	if err != nil || stored.UsedAt != nil {
		t.Fatalf("failed session consumed invitation: %#v %v", stored, err)
	}
	if _, err := database.GetUserByID(ctx, user.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("failed session left registered user: %v", err)
	}
	firstSession.ID = "ses_new_registration"
	if _, err := database.CompleteRegistrationWithSession(ctx, digest[:], 37, testNow.Add(time.Minute),
		user, credential, 5, "aud_registration_retry", firstSession, "new-token"); err != nil {
		t.Fatalf("valid registration retry = %v", err)
	}
	if browser, err := database.LookupBrowserSession(ctx, "new-token", testNow.Add(2*time.Minute)); err != nil || browser.UserID != user.ID {
		t.Fatalf("first browser session missing: %#v %v", browser, err)
	}
}

func TestRolePromotionRevokesPreviouslyIssuedLoginCodeAtomically(t *testing.T) {
	database, user, code, digest := codeFixture(t, "login", testNow)
	ctx := context.Background()
	adminRole := domain.RoleAdmin
	unchangedRole := domain.RoleUser
	_, err := database.UpdateUserAsTrustedControl(ctx, user.ID,
		AdminUserUpdate{Role: &unchangedRole}, testNow.Add(time.Minute),
		ptrAudit(testAuditEvent("aud_unchanged_code_role", nil, "user.role.set", "user", user.ID, testNow.Add(time.Minute))), nil)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := database.GetInvitationByID(ctx, code.ID)
	if err != nil || stored.RevokedAt != nil {
		t.Fatalf("no-op role update revoked code: %#v %v", stored, err)
	}
	_, err = database.UpdateUserAsTrustedControl(ctx, user.ID,
		AdminUserUpdate{Role: &adminRole}, testNow.Add(2*time.Minute),
		ptrAudit(testAuditEvent("aud_promote_code", nil, "user.role.set", "user", user.ID, testNow.Add(2*time.Minute))), nil)
	if err != nil {
		t.Fatal(err)
	}
	stored, err = database.GetInvitationByID(ctx, code.ID)
	if err != nil || stored.RevokedAt == nil || stored.UsedAt != nil {
		t.Fatalf("promoted user retained prior code: %#v %v", stored, err)
	}
	if _, err := redeemTestCode(database, digest, testNow.Add(3*time.Minute), 301); !errors.Is(err, ErrInvalidInvite) {
		t.Fatalf("pre-promotion code minted admin session: %v", err)
	}
}

func TestDisableThenReenableCannotResurrectPriorLoginCode(t *testing.T) {
	database, user, code, digest := codeFixture(t, "login", testNow)
	ctx := context.Background()
	disabled, active := domain.UserDisabled, domain.UserActive
	for index, status := range []domain.UserStatus{disabled, active} {
		at := testNow.Add(time.Duration(index+1) * time.Minute)
		_, err := database.UpdateUserAsTrustedControl(ctx, user.ID,
			AdminUserUpdate{Status: &status}, at, nil,
			ptrAudit(testAuditEvent(fmt.Sprintf("aud_status_code_%d", index), nil, "user.status.set", "user", user.ID, at)))
		if err != nil {
			t.Fatal(err)
		}
	}
	stored, err := database.GetInvitationByID(ctx, code.ID)
	if err != nil || stored.RevokedAt == nil || stored.UsedAt != nil {
		t.Fatalf("reenabled account retained old code: %#v %v", stored, err)
	}
	if _, err := redeemTestCode(database, digest, testNow.Add(3*time.Minute), 302); !errors.Is(err, ErrInvalidInvite) {
		t.Fatalf("stale login code revived: %v", err)
	}
}

func TestFailedRoleAuditRollsBackLoginCodeRevocation(t *testing.T) {
	database, user, code, _ := codeFixture(t, "login", testNow)
	ctx := context.Background()
	duplicate := testAuditEvent("aud_duplicate_code", nil, "seed", "test", "seed", testNow)
	if err := database.AppendAuditEvent(ctx, duplicate); err != nil {
		t.Fatal(err)
	}
	adminRole := domain.RoleAdmin
	_, err := database.UpdateUserAsTrustedControl(ctx, user.ID, AdminUserUpdate{Role: &adminRole}, testNow.Add(time.Minute),
		ptrAudit(testAuditEvent(duplicate.ID, nil, "user.role.set", "user", user.ID, testNow.Add(time.Minute))), nil)
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("failed audit did not fail transaction: %v", err)
	}
	stored, err := database.GetInvitationByID(ctx, code.ID)
	if err != nil || stored.RevokedAt != nil {
		t.Fatalf("failed role update partially revoked code: %#v %v", stored, err)
	}
	fresh, err := database.GetUserByID(ctx, user.ID)
	if err != nil || fresh.Role != domain.RoleUser {
		t.Fatalf("failed role update partially promoted user: %#v %v", fresh, err)
	}
}

func TestConcurrentCodeRedemptionAndRolePromotionNeverLeaveAdminCodeSession(t *testing.T) {
	for iteration := range 12 {
		database, user, code, digest := codeFixture(t, "login", testNow)
		start := make(chan struct{})
		results := make(chan error, 2)
		var wait sync.WaitGroup
		wait.Add(2)
		go func() {
			defer wait.Done()
			<-start
			_, err := redeemTestCode(database, digest, testNow.Add(time.Minute), iteration+600)
			results <- err
		}()
		go func() {
			defer wait.Done()
			<-start
			role := domain.RoleAdmin
			at := testNow.Add(time.Minute)
			_, err := database.UpdateUserAsTrustedControl(context.Background(), user.ID,
				AdminUserUpdate{Role: &role}, at,
				ptrAudit(testAuditEvent(fmt.Sprintf("aud_promote_race_%d", iteration), nil,
					"user.role.set", "user", user.ID, at)), nil)
			results <- err
		}()
		close(start)
		wait.Wait()
		close(results)
		for err := range results {
			if err != nil && !errors.Is(err, ErrInvalidInvite) {
				t.Fatalf("iteration %d unexpected race error: %v", iteration, err)
			}
		}
		var active int
		if err := database.db.QueryRow(`SELECT COUNT(*) FROM browser_sessions WHERE user_id=? AND id LIKE 'ses_code_%'`, user.ID).Scan(&active); err != nil {
			t.Fatal(err)
		}
		if active != 0 {
			t.Fatalf("iteration %d retained pre-promotion login session", iteration)
		}
		stored, err := database.GetInvitationByID(context.Background(), code.ID)
		if err != nil || (stored.RevokedAt == nil && stored.UsedAt == nil) {
			t.Fatalf("iteration %d code escaped privilege change: %#v %v", iteration, stored, err)
		}
	}
}

func ptrAudit(value AuditEvent) *AuditEvent { return &value }
