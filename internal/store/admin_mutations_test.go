package store

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
)

func TestAdministrativeInvitationCreateAndAuditAreAtomic(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	duplicateID := "aud_duplicate_create"
	if err := database.AppendAuditEvent(ctx, testAuditEvent(
		duplicateID, nil, "seed", "test", "seed", testNow,
	)); err != nil {
		t.Fatal(err)
	}

	invitation := testAdministrativeInvitation("inv_rolled_back", nil, testNow)
	err := database.CreateInvitationAsTrustedControl(
		ctx,
		invitation,
		invitationDigest("100001"),
		7,
		testAuditEvent(duplicateID, nil, "invitation.create", "invitation", invitation.ID, testNow),
	)
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("create with failing audit = %v, want conflict", err)
	}
	if _, err := database.GetInvitationByID(ctx, invitation.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("invitation survived audit rollback: %v", err)
	}

	// Reusing the same bucket proves the failed transaction did not retain its
	// occupancy check or invitation row.
	retry := testAdministrativeInvitation("inv_retry", nil, testNow)
	if err := database.CreateInvitationAsTrustedControl(
		ctx,
		retry,
		invitationDigest("100002"),
		7,
		testAuditEvent("aud_retry", nil, "invitation.create", "invitation", retry.ID, testNow),
	); err != nil {
		t.Fatalf("create after rollback: %v", err)
	}
	if _, err := database.GetInvitationByID(ctx, retry.ID); err != nil {
		t.Fatalf("committed invitation missing: %v", err)
	}
}

func TestAdministrativeInvitationRevokeAndAuditAreAtomic(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	invitation := testAdministrativeInvitation("inv_revoke_atomic", nil, testNow)
	if err := database.CreateInvitationWithBucket(
		ctx, invitation, invitationDigest("200001"), 8,
	); err != nil {
		t.Fatal(err)
	}
	duplicateID := "aud_duplicate_revoke"
	if err := database.AppendAuditEvent(ctx, testAuditEvent(
		duplicateID, nil, "seed", "test", "seed", testNow,
	)); err != nil {
		t.Fatal(err)
	}

	err := database.RevokeInvitationAsTrustedControl(
		ctx,
		invitation.ID,
		testNow.Add(time.Minute),
		testAuditEvent(duplicateID, nil, "invitation.revoke", "invitation", invitation.ID, testNow.Add(time.Minute)),
	)
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("revoke with failing audit = %v, want conflict", err)
	}
	stored, err := database.GetInvitationByID(ctx, invitation.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.RevokedAt != nil {
		t.Fatalf("revocation survived audit rollback: %#v", stored.RevokedAt)
	}

	if err := database.RevokeInvitationAsTrustedControl(
		ctx,
		invitation.ID,
		testNow.Add(2*time.Minute),
		testAuditEvent("aud_revoke_ok", nil, "invitation.revoke", "invitation", invitation.ID, testNow.Add(2*time.Minute)),
	); err != nil {
		t.Fatalf("valid revoke after rollback: %v", err)
	}
}

func TestAdministrativeUserUpdateRollsBackRoleStatusSessionsAndAuditsTogether(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	administrator := testUser("usr_atomic_admin", "atomic-admin", domain.RoleAdmin)
	target := testUser("usr_atomic_target", "atomic-target", domain.RoleUser)
	mustCreateUser(t, database, administrator)
	mustCreateUser(t, database, target)
	token := "opaque-session-token-for-atomic-test"
	if err := database.CreateBrowserSession(ctx, domain.BrowserSession{
		ID:        "browser_atomic",
		UserID:    target.ID,
		CreatedAt: testNow,
		ExpiresAt: testNow.Add(time.Hour),
		LastSeen:  testNow,
	}, token); err != nil {
		t.Fatal(err)
	}

	duplicateID := "aud_duplicate_status"
	if err := database.AppendAuditEvent(ctx, testAuditEvent(
		duplicateID, nil, "seed", "test", "seed", testNow,
	)); err != nil {
		t.Fatal(err)
	}
	role, status := domain.RoleAdmin, domain.UserDisabled
	roleAudit := testAuditEvent(
		"aud_role_should_rollback", nil, "user.role.set", "user", target.ID, testNow.Add(time.Minute),
	)
	statusAudit := testAuditEvent(
		duplicateID, nil, "user.status.set", "user", target.ID, testNow.Add(time.Minute),
	)
	_, err := database.UpdateUserAsTrustedControl(
		ctx,
		target.ID,
		AdminUserUpdate{Role: &role, Status: &status},
		testNow.Add(time.Minute),
		&roleAudit,
		&statusAudit,
	)
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("combined update with failing second audit = %v, want conflict", err)
	}
	stored, err := database.GetUserByID(ctx, target.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Role != domain.RoleUser || stored.Status != domain.UserActive {
		t.Fatalf("partial user update survived rollback: %#v", stored)
	}
	if _, err := database.LookupBrowserSession(ctx, token, testNow.Add(time.Second)); err != nil {
		t.Fatalf("browser session was deleted by rolled-back update: %v", err)
	}
	var rolledBackAuditCount int
	if err := database.db.QueryRowContext(
		ctx, "SELECT count(*) FROM audit_events WHERE id = ?", roleAudit.ID,
	).Scan(&rolledBackAuditCount); err != nil {
		t.Fatal(err)
	}
	if rolledBackAuditCount != 0 {
		t.Fatalf("first audit survived second audit failure: count=%d", rolledBackAuditCount)
	}

	roleAudit = testAuditEvent(
		"aud_role_committed", nil, "user.role.set", "user", target.ID, testNow.Add(2*time.Minute),
	)
	statusAudit = testAuditEvent(
		"aud_status_committed", nil, "user.status.set", "user", target.ID, testNow.Add(2*time.Minute),
	)
	updated, err := database.UpdateUserAsTrustedControl(
		ctx,
		target.ID,
		AdminUserUpdate{Role: &role, Status: &status},
		testNow.Add(2*time.Minute),
		&roleAudit,
		&statusAudit,
	)
	if err != nil {
		t.Fatalf("valid combined update: %v", err)
	}
	if updated.Role != role || updated.Status != status {
		t.Fatalf("combined update result = %#v", updated)
	}
	var sessionCount, auditCount int
	if err := database.db.QueryRowContext(
		ctx, "SELECT count(*) FROM browser_sessions WHERE user_id = ?", target.ID,
	).Scan(&sessionCount); err != nil {
		t.Fatal(err)
	}
	if err := database.db.QueryRowContext(
		ctx, "SELECT count(*) FROM audit_events WHERE id IN (?, ?)", roleAudit.ID, statusAudit.ID,
	).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if sessionCount != 0 || auditCount != 2 {
		t.Fatalf("sessionCount=%d auditCount=%d, want 0 and 2", sessionCount, auditCount)
	}
}

func TestAdministrativePromotionRevokesSessionsAtomically(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	target := testUser("usr_promotion_target", "promotion-target", domain.RoleUser)
	mustCreateUser(t, database, target)
	token := "opaque-pre-promotion-token"
	if err := database.CreateBrowserSession(ctx, domain.BrowserSession{
		ID:        "ses_pre_promotion",
		UserID:    target.ID,
		CreatedAt: testNow,
		ExpiresAt: testNow.Add(time.Hour),
		LastSeen:  testNow,
	}, token); err != nil {
		t.Fatal(err)
	}

	duplicateID := "aud_promotion_duplicate"
	if err := database.AppendAuditEvent(ctx, testAuditEvent(
		duplicateID, nil, "seed", "test", "seed", testNow,
	)); err != nil {
		t.Fatal(err)
	}
	adminRole := domain.RoleAdmin
	failingAudit := testAuditEvent(
		duplicateID, nil, "user.role.set", "user", target.ID, testNow.Add(time.Minute),
	)
	_, err := database.UpdateUserAsTrustedControl(
		ctx,
		target.ID,
		AdminUserUpdate{Role: &adminRole},
		testNow.Add(time.Minute),
		&failingAudit,
		nil,
	)
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("promotion with failing audit = %v, want conflict", err)
	}
	stored, err := database.GetUserByID(ctx, target.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Role != domain.RoleUser {
		t.Fatalf("failed promotion changed role: %#v", stored)
	}
	if _, err := database.LookupBrowserSession(ctx, token, testNow.Add(time.Second)); err != nil {
		t.Fatalf("failed promotion deleted session: %v", err)
	}

	successAudit := testAuditEvent(
		"aud_promotion_success", nil, "user.role.set", "user", target.ID, testNow.Add(2*time.Minute),
	)
	result, err := database.UpdateUserAsTrustedControl(
		ctx,
		target.ID,
		AdminUserUpdate{Role: &adminRole},
		testNow.Add(2*time.Minute),
		&successAudit,
		nil,
	)
	if err != nil {
		t.Fatalf("valid promotion: %v", err)
	}
	if result.Role != domain.RoleAdmin || !result.PromotedToAdmin {
		t.Fatalf("promotion result = %#v", result)
	}
	if _, err := database.LookupBrowserSession(ctx, token, testNow.Add(3*time.Minute)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("pre-promotion token survived: %v", err)
	}
	var auditCount int
	if err := database.db.QueryRowContext(
		ctx, "SELECT count(*) FROM audit_events WHERE id = ?", successAudit.ID,
	).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if auditCount != 1 {
		t.Fatalf("promotion audit count = %d, want 1", auditCount)
	}

	// Reapplying admin is not a privilege transition and should not log out a
	// legitimately authenticated administrator.
	postToken := "opaque-post-promotion-token"
	if err := database.CreateBrowserSession(ctx, domain.BrowserSession{
		ID:        "ses_post_promotion",
		UserID:    target.ID,
		CreatedAt: testNow.Add(3 * time.Minute),
		ExpiresAt: testNow.Add(time.Hour),
		LastSeen:  testNow.Add(3 * time.Minute),
	}, postToken); err != nil {
		t.Fatal(err)
	}
	idempotentAudit := testAuditEvent(
		"aud_promotion_idempotent", nil, "user.role.set", "user", target.ID, testNow.Add(4*time.Minute),
	)
	result, err = database.UpdateUserAsTrustedControl(
		ctx,
		target.ID,
		AdminUserUpdate{Role: &adminRole},
		testNow.Add(4*time.Minute),
		&idempotentAudit,
		nil,
	)
	if err != nil {
		t.Fatalf("idempotent admin update: %v", err)
	}
	if result.PromotedToAdmin {
		t.Fatal("idempotent admin update reported a promotion")
	}
	if _, err := database.LookupBrowserSession(ctx, postToken, testNow.Add(5*time.Minute)); err != nil {
		t.Fatalf("idempotent admin update deleted session: %v", err)
	}
}

func TestAdministrativeUserUpdateProtectsLastAdminConcurrently(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	first := testUser("usr_atomic_first", "atomic-first", domain.RoleAdmin)
	second := testUser("usr_atomic_second", "atomic-second", domain.RoleAdmin)
	mustCreateUser(t, database, first)
	mustCreateUser(t, database, second)
	for index, user := range []domain.User{first, second} {
		if err := database.CreateBrowserSession(ctx, domain.BrowserSession{
			ID:        "ses_concurrent_" + string(rune('a'+index)),
			UserID:    user.ID,
			CreatedAt: testNow,
			ExpiresAt: testNow.Add(time.Hour),
			LastSeen:  testNow,
		}, "opaque-concurrent-token-"+string(rune('a'+index))); err != nil {
			t.Fatal(err)
		}
	}

	start := make(chan struct{})
	results := make(chan error, 2)
	var workers sync.WaitGroup
	for index, user := range []domain.User{first, second} {
		index, user := index, user
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			status := domain.UserDisabled
			actorID := user.ID
			audit := testAuditEvent(
				"aud_concurrent_"+string(rune('a'+index)),
				&actorID,
				"user.status.set",
				"user",
				user.ID,
				testNow.Add(time.Minute),
			)
			_, err := database.UpdateUserAsAdmin(
				ctx,
				user.ID,
				"ses_concurrent_"+string(rune('a'+index)),
				testNow,
				user.ID,
				AdminUserUpdate{Status: &status},
				testNow.Add(time.Minute),
				nil,
				&audit,
			)
			results <- err
		}()
	}
	close(start)
	workers.Wait()
	close(results)

	successes, forbidden := 0, 0
	for err := range results {
		switch {
		case err == nil:
			successes++
		case errors.Is(err, ErrForbidden):
			forbidden++
		default:
			t.Fatalf("unexpected concurrent update error: %v", err)
		}
	}
	if successes != 1 || forbidden != 1 {
		t.Fatalf("successes=%d forbidden=%d, want one each", successes, forbidden)
	}
	var activeAdmins, auditCount int
	if err := database.db.QueryRowContext(ctx, `
		SELECT count(*) FROM users WHERE role = 'admin' AND status = 'active'`,
	).Scan(&activeAdmins); err != nil {
		t.Fatal(err)
	}
	if err := database.db.QueryRowContext(ctx, `
		SELECT count(*) FROM audit_events WHERE action = 'user.status.set'`,
	).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if activeAdmins != 1 || auditCount != 1 {
		t.Fatalf("activeAdmins=%d auditCount=%d, want 1 and 1", activeAdmins, auditCount)
	}
}

func TestAdministrativeMutationCancellationRollsBack(t *testing.T) {
	database, _ := newTestStore(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	invitation := testAdministrativeInvitation("inv_cancelled", nil, testNow)
	err := database.CreateInvitationAsTrustedControl(
		ctx,
		invitation,
		invitationDigest("300001"),
		9,
		testAuditEvent("aud_cancelled", nil, "invitation.create", "invitation", invitation.ID, testNow),
	)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled mutation = %v, want context cancellation", err)
	}
	if _, err := database.GetInvitationByID(context.Background(), invitation.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cancelled invitation survived: %v", err)
	}
}

func testAdministrativeInvitation(id string, creator *string, now time.Time) domain.Invitation {
	return domain.Invitation{
		ID:        id,
		CreatedBy: creator,
		CreatedAt: now,
		ExpiresAt: now.Add(time.Hour),
	}
}

func testAuditEvent(
	id string,
	actor *string,
	action string,
	targetType string,
	targetID string,
	now time.Time,
) AuditEvent {
	return AuditEvent{
		ID:          id,
		ActorUserID: actor,
		Action:      action,
		TargetType:  targetType,
		TargetID:    targetID,
		Metadata:    json.RawMessage("{}"),
		CreatedAt:   now,
	}
}
