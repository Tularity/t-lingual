package admin

import (
	"bytes"
	"context"
	"errors"
	"regexp"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/secret"
	"github.com/Tularity/t-lingual/internal/store"
)

func newTestAdmin(t *testing.T) (*Service, *store.Store, *secret.Keyring, time.Time) {
	t.Helper()
	database, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	keyring, _ := secret.New(bytes.Repeat([]byte{3}, 32))
	service, err := New(database, keyring, 24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, time.September, 1, 4, 0, 0, 0, time.UTC)
	service.now = func() time.Time { return now }
	return service, database, keyring, now
}

func TestCLIInvitationIsSixDigitsAndStoredAsKeyedDigest(t *testing.T) {
	service, database, keyring, now := newTestAdmin(t)
	result, err := service.CreateInvitationAsTrustedControl(context.Background(), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^[0-9]{6}$`).MatchString(result.Code) {
		t.Fatalf("invalid invitation code %q", result.Code)
	}
	if !result.Invitation.ExpiresAt.Equal(now.Add(time.Hour)) || result.Invitation.CreatedBy != nil {
		t.Fatalf("unexpected CLI invitation: %#v", result.Invitation)
	}
	digest := keyring.InvitationDigest(result.Code)
	if _, err := database.ValidateInvitation(context.Background(), digest, now); err != nil {
		t.Fatalf("created invitation is not valid: %v", err)
	}
	wrongKey, _ := secret.New(bytes.Repeat([]byte{4}, 32))
	wrongDigest := wrongKey.InvitationDigest(result.Code)
	if _, err := database.ValidateInvitation(context.Background(), wrongDigest, now); !errors.Is(err, store.ErrInvalidInvite) {
		t.Fatalf("invite was not bound to its keyed digest: %v", err)
	}
}

func TestWebAdminAuthorizationAndAudit(t *testing.T) {
	service, database, _, now := newTestAdmin(t)
	ordinary := createTestUser(t, database, now, "usr_user", domain.RoleUser)
	ordinaryAuthority := createTestWebAuthority(t, database, ordinary, now, "ordinary")
	if _, err := service.CreateInvitation(context.Background(), ordinaryAuthority, time.Hour); !errors.Is(err, ErrAdminRequired) {
		t.Fatalf("ordinary user created invite: %v", err)
	}
	administrator := createTestUser(t, database, now, "usr_admin", domain.RoleAdmin)
	administratorAuthority := createTestWebAuthority(t, database, administrator, now, "administrator")
	result, err := service.CreateInvitation(context.Background(), administratorAuthority, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	invitations, err := service.ListInvitations(context.Background(), administratorAuthority, 20, 0)
	if err != nil || len(invitations) != 1 || invitations[0].ID != result.Invitation.ID {
		t.Fatalf("authorized invitation list = %#v, %v", invitations, err)
	}
	users, err := service.ListUsers(context.Background(), administratorAuthority, 20, 0)
	if err != nil || len(users) != 2 {
		t.Fatalf("authorized user list = %#v, %v", users, err)
	}
	events, err := service.ListAuditEvents(context.Background(), administratorAuthority, 20, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Action != "invitation.create" || events[0].TargetID != result.Invitation.ID {
		t.Fatalf("unexpected audit history: %#v", events)
	}
}

func TestCannotRemoveOnlyActiveAdmin(t *testing.T) {
	service, database, _, now := newTestAdmin(t)
	administrator := createTestUser(t, database, now, "usr_only_admin", domain.RoleAdmin)
	role := domain.RoleUser
	if _, err := service.UpdateUserAsTrustedControl(
		context.Background(), administrator.ID, UserUpdate{Role: &role},
	); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("last admin was demoted: %v", err)
	}
	status := domain.UserDisabled
	if _, err := service.UpdateUserAsTrustedControl(
		context.Background(), administrator.ID, UserUpdate{Status: &status},
	); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("last admin was disabled: %v", err)
	}
	second := createTestUser(t, database, now, "usr_second", domain.RoleUser)
	adminRole := domain.RoleAdmin
	if _, err := service.UpdateUserAsTrustedControl(
		context.Background(), second.ID, UserUpdate{Role: &adminRole},
	); err != nil {
		t.Fatal(err)
	}
	if _, err := service.UpdateUserAsTrustedControl(
		context.Background(), administrator.ID, UserUpdate{Role: &role},
	); err != nil {
		t.Fatalf("admin demotion with replacement failed: %v", err)
	}
}

func TestStaleAdministratorSnapshotCannotMutateAfterDemotion(t *testing.T) {
	service, database, _, now := newTestAdmin(t)
	stale := createTestUser(t, database, now, "usr_stale_demoted", domain.RoleAdmin)
	staleAuthority := createTestWebAuthority(t, database, stale, now, "stale-demoted")
	createTestUser(t, database, now, "usr_demotion_backup", domain.RoleAdmin)
	if err := database.UpdateUserRole(
		context.Background(), stale.ID, domain.RoleUser, now.Add(time.Minute),
	); err != nil {
		t.Fatal(err)
	}

	if _, err := service.CreateInvitation(
		context.Background(), staleAuthority, time.Hour,
	); !errors.Is(err, ErrAdminRequired) {
		t.Fatalf("stale demoted actor created invitation: %v", err)
	}
	invitations, err := database.ListInvitationsAsTrustedControl(context.Background(), 100, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(invitations) != 0 {
		t.Fatalf("demoted actor left invitations: %#v", invitations)
	}
}

func TestStaleAdministratorSnapshotCannotMutateAfterDisable(t *testing.T) {
	service, database, _, now := newTestAdmin(t)
	stale := createTestUser(t, database, now, "usr_stale_disabled", domain.RoleAdmin)
	staleAuthority := createTestWebAuthority(t, database, stale, now, "stale-disabled")
	backup := createTestUser(t, database, now, "usr_disable_backup", domain.RoleAdmin)
	backupAuthority := createTestWebAuthority(t, database, backup, now, "disable-backup")
	target := createTestUser(t, database, now, "usr_disable_target", domain.RoleUser)
	if err := database.UpdateUserStatus(
		context.Background(), stale.ID, domain.UserDisabled, now.Add(time.Minute),
	); err != nil {
		t.Fatal(err)
	}

	role := domain.RoleAdmin
	if _, err := service.UpdateUser(
		context.Background(), staleAuthority, target.ID, UserUpdate{Role: &role},
	); !errors.Is(err, ErrAdminRequired) {
		t.Fatalf("stale disabled actor updated user: %v", err)
	}
	stored, err := database.GetUserByID(context.Background(), target.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Role != domain.RoleUser {
		t.Fatalf("stale actor partially promoted user: %#v", stored)
	}
	events, err := service.ListAuditEvents(context.Background(), backupAuthority, 100, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 0 {
		t.Fatalf("rejected stale mutation wrote audits: %#v", events)
	}
}

func TestCombinedUserUpdatePrevalidatesEveryField(t *testing.T) {
	service, database, _, now := newTestAdmin(t)
	administrator := createTestUser(t, database, now, "usr_validation_admin", domain.RoleAdmin)
	administratorAuthority := createTestWebAuthority(t, database, administrator, now, "validation")
	target := createTestUser(t, database, now, "usr_validation_target", domain.RoleUser)
	role := domain.RoleAdmin
	invalidStatus := domain.UserStatus("pending")

	if _, err := service.UpdateUser(
		context.Background(),
		administratorAuthority,
		target.ID,
		UserUpdate{Role: &role, Status: &invalidStatus},
	); err == nil {
		t.Fatal("combined update accepted an invalid status")
	}
	stored, err := database.GetUserByID(context.Background(), target.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Role != domain.RoleUser || stored.Status != domain.UserActive {
		t.Fatalf("valid field was applied before invalid field rejection: %#v", stored)
	}
	events, err := service.ListAuditEvents(context.Background(), administratorAuthority, 100, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 0 {
		t.Fatalf("invalid combined update wrote audit events: %#v", events)
	}
}

func TestRevokedAdministratorSessionCannotPerformAnyMutation(t *testing.T) {
	service, database, _, now := newTestAdmin(t)
	administrator := createTestUser(t, database, now, "usr_revoked_session_admin", domain.RoleAdmin)
	authority := createTestWebAuthority(t, database, administrator, now, "revoked-admin")
	target := createTestUser(t, database, now, "usr_revoked_session_target", domain.RoleUser)
	invitation := domain.Invitation{
		ID: "inv_revoked_session", CreatedAt: now, ExpiresAt: now.Add(time.Hour),
	}
	if err := database.CreateInvitation(
		context.Background(), invitation, bytes.Repeat([]byte{9}, 32),
	); err != nil {
		t.Fatal(err)
	}
	if _, err := database.DeleteUserBrowserSessions(context.Background(), administrator.ID); err != nil {
		t.Fatal(err)
	}

	if _, err := service.CreateInvitation(
		context.Background(), authority, time.Hour,
	); !errors.Is(err, ErrAdminRequired) {
		t.Fatalf("revoked session created invitation: %v", err)
	}
	if _, err := service.ListInvitations(context.Background(), authority, 100, 0); !errors.Is(err, ErrAdminRequired) {
		t.Fatalf("revoked session listed invitations: %v", err)
	}
	if _, err := service.ListUsers(context.Background(), authority, 100, 0); !errors.Is(err, ErrAdminRequired) {
		t.Fatalf("revoked session listed users: %v", err)
	}
	if _, err := service.ListAuditEvents(context.Background(), authority, 100, 0); !errors.Is(err, ErrAdminRequired) {
		t.Fatalf("revoked session listed audit events: %v", err)
	}
	if err := service.RevokeInvitation(
		context.Background(), authority, invitation.ID,
	); !errors.Is(err, ErrAdminRequired) {
		t.Fatalf("revoked session revoked invitation: %v", err)
	}
	role := domain.RoleAdmin
	if _, err := service.UpdateUser(
		context.Background(), authority, target.ID, UserUpdate{Role: &role},
	); !errors.Is(err, ErrAdminRequired) {
		t.Fatalf("revoked session promoted user: %v", err)
	}

	storedInvitation, err := database.GetInvitationByID(context.Background(), invitation.ID)
	if err != nil {
		t.Fatal(err)
	}
	storedTarget, err := database.GetUserByID(context.Background(), target.ID)
	if err != nil {
		t.Fatal(err)
	}
	allInvitations, err := database.ListInvitationsAsTrustedControl(context.Background(), 100, 0)
	if err != nil {
		t.Fatal(err)
	}
	if storedInvitation.RevokedAt != nil || storedTarget.Role != domain.RoleUser || len(allInvitations) != 1 {
		t.Fatalf(
			"revoked session changed state: invitation=%#v target=%#v invitations=%d",
			storedInvitation, storedTarget, len(allInvitations),
		)
	}
}

func TestExpiredAdministratorSessionCannotMutate(t *testing.T) {
	service, database, _, now := newTestAdmin(t)
	administrator := createTestUser(t, database, now, "usr_expired_session_admin", domain.RoleAdmin)
	authority := createTestWebAuthority(t, database, administrator, now, "expired-admin")
	authority.CheckedAt = now.Add(2 * time.Hour)

	if _, err := service.CreateInvitation(
		context.Background(), authority, time.Hour,
	); !errors.Is(err, ErrAdminRequired) {
		t.Fatalf("expired session created invitation: %v", err)
	}
	if _, err := service.ListInvitations(context.Background(), authority, 100, 0); !errors.Is(err, ErrAdminRequired) {
		t.Fatalf("expired session listed invitations: %v", err)
	}
	if _, err := service.ListUsers(context.Background(), authority, 100, 0); !errors.Is(err, ErrAdminRequired) {
		t.Fatalf("expired session listed users: %v", err)
	}
	if _, err := service.ListAuditEvents(context.Background(), authority, 100, 0); !errors.Is(err, ErrAdminRequired) {
		t.Fatalf("expired session listed audit events: %v", err)
	}
}

func createTestWebAuthority(
	t *testing.T,
	database *store.Store,
	user domain.User,
	now time.Time,
	suffix string,
) WebAuthority {
	t.Helper()
	sessionID := "ses_" + suffix
	if err := database.CreateBrowserSession(context.Background(), domain.BrowserSession{
		ID:        sessionID,
		UserID:    user.ID,
		CreatedAt: now,
		ExpiresAt: now.Add(time.Hour),
		LastSeen:  now,
	}, "opaque-test-session-token-"+suffix); err != nil {
		t.Fatal(err)
	}
	return WebAuthority{UserID: user.ID, BrowserSessionID: sessionID, CheckedAt: now}
}

func createTestUser(t *testing.T, database *store.Store, now time.Time, userID string, role domain.Role) domain.User {
	t.Helper()
	user := domain.User{
		ID:          userID,
		WebAuthnID:  bytes.Repeat([]byte(userID), 64)[:64],
		Username:    userID,
		DisplayName: userID,
		Role:        role,
		Status:      domain.UserActive,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if err := database.CreateUser(context.Background(), user); err != nil {
		t.Fatal(err)
	}
	return user
}
