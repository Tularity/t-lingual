package admin

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/store"
)

func TestCodeCreationRequiresActiveTargetAndHonorsDelayedActivation(t *testing.T) {
	service, database, keyring, now := newTestAdmin(t)
	user := createTestUser(t, database, now, "usr_recovery_target", domain.RoleUser)
	start := now.Add(2 * time.Hour)
	created, err := service.CreateCodeAsTrustedControl(context.Background(), CodeCreateInput{
		Kind: "login", TargetUserID: user.ID, NotBefore: &start,
	})
	if err != nil || created.Invitation.Kind != "login" || created.Invitation.TargetUserID != user.ID ||
		!created.Invitation.NotBefore.Equal(start) || !created.Invitation.ExpiresAt.Equal(start.Add(10*time.Minute)) {
		t.Fatalf("scheduled login code = %#v %v", created, err)
	}
	digest := keyring.InvitationDigest(created.Code)
	if _, err := database.ValidateInvitation(context.Background(), digest, start); !errors.Is(err, store.ErrInvalidInvite) {
		t.Fatalf("login code acted as registration: %v", err)
	}
	past := now.Add(-time.Minute)
	immediate, err := service.CreateCodeAsTrustedControl(context.Background(), CodeCreateInput{
		Kind: "login", TargetUserID: user.ID, NotBefore: &past, TTL: 5 * time.Minute,
	})
	if err != nil || !immediate.Invitation.NotBefore.Equal(now) {
		t.Fatalf("past notBefore did not become immediately active: %#v %v", immediate, err)
	}
	if _, err := service.CreateCodeAsTrustedControl(context.Background(), CodeCreateInput{
		Kind: "login", TargetUserID: user.ID, TTL: 16 * time.Minute,
	}); err == nil {
		t.Fatal("login code exceeded maximum valid lifetime")
	}
	if _, err := service.CreateCodeAsTrustedControl(context.Background(), CodeCreateInput{
		Kind: "registration", TargetUserID: user.ID,
	}); err == nil {
		t.Fatal("registration code accepted target user")
	}
	status := domain.UserDisabled
	if _, err := service.UpdateUserAsTrustedControl(context.Background(), user.ID, UserUpdate{Status: &status}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.CreateCodeAsTrustedControl(context.Background(), CodeCreateInput{
		Kind: "login", TargetUserID: user.ID,
	}); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("disabled target received code: %v", err)
	}
}

func TestOrdinaryUserCannotCreateCodeWhileAdminCan(t *testing.T) {
	service, database, _, now := newTestAdmin(t)
	ordinary := createTestUser(t, database, now, "usr_code_ordinary", domain.RoleUser)
	adminUser := createTestUser(t, database, now, "usr_code_admin", domain.RoleAdmin)
	ordinaryAuthority := createTestWebAuthority(t, database, ordinary, now, "code-ordinary")
	adminAuthority := createTestWebAuthority(t, database, adminUser, now, "code-admin")
	input := CodeCreateInput{Kind: "login", TargetUserID: ordinary.ID}
	if _, err := service.CreateCode(context.Background(), ordinaryAuthority, input); !errors.Is(err, ErrAdminRequired) {
		t.Fatalf("ordinary user created login code: %v", err)
	}
	created, err := service.CreateCode(context.Background(), adminAuthority, input)
	if err != nil || created.Invitation.CreatedBy == nil || *created.Invitation.CreatedBy != adminUser.ID {
		t.Fatalf("admin code creation = %#v %v", created, err)
	}
}
