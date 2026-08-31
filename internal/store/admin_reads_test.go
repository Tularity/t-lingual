package store

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
)

func TestAdministrativeReadsRequireExactLiveAdminSession(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	administrator := testUser("usr_read_admin", "read-admin", domain.RoleAdmin)
	mustCreateUser(t, database, administrator)
	session := testBrowserSession("bs_read_admin", administrator.ID)
	if err := database.CreateBrowserSession(ctx, session, "read-admin-token-with-enough-entropy"); err != nil {
		t.Fatal(err)
	}
	invitation := domain.Invitation{
		ID: "inv_read_admin", CreatedBy: &administrator.ID,
		CreatedAt: testNow, ExpiresAt: testNow.Add(time.Hour),
	}
	if err := database.CreateInvitation(ctx, invitation, bytes.Repeat([]byte{0x31}, 32)); err != nil {
		t.Fatal(err)
	}
	event := testAuditEvent(
		"aud_read_admin", &administrator.ID, "invitation.create", "invitation", invitation.ID, testNow,
	)
	if err := database.AppendAuditEvent(ctx, event); err != nil {
		t.Fatal(err)
	}

	invitations, err := database.ListInvitationsAsAdmin(
		ctx, administrator.ID, session.ID, testNow, 10, 0,
	)
	if err != nil || len(invitations) != 1 || invitations[0].ID != invitation.ID {
		t.Fatalf("authorized invitation read = %#v, %v", invitations, err)
	}
	users, err := database.ListUsersAsAdmin(ctx, administrator.ID, session.ID, testNow, 10, 0)
	if err != nil || len(users) != 1 || users[0].ID != administrator.ID {
		t.Fatalf("authorized user read = %#v, %v", users, err)
	}
	events, err := database.ListAuditEventsAsAdmin(
		ctx, administrator.ID, session.ID, testNow, 10, 0,
	)
	if err != nil || len(events) != 1 || events[0].ID != event.ID {
		t.Fatalf("authorized audit read = %#v, %v", events, err)
	}

	assertAllAdminReadsRejected(t, database, administrator.ID, session.ID, session.ExpiresAt)
	if err := database.DeleteBrowserSessionByID(ctx, administrator.ID, session.ID); err != nil {
		t.Fatal(err)
	}
	assertAllAdminReadsRejected(t, database, administrator.ID, session.ID, testNow)
}

func TestPrePromotionSessionNeverAuthorizesConcurrentAdministrativeRead(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	// A durable administrator keeps the last-admin invariant unrelated to this
	// regression and also mirrors the actor performing the promotion.
	mustCreateUser(t, database, testUser("usr_read_promoter", "read-promoter", domain.RoleAdmin))

	for iteration := 0; iteration < 24; iteration++ {
		suffix := string(rune('a' + iteration))
		target := testUser("usr_read_target_"+suffix, "read-target-"+suffix, domain.RoleUser)
		mustCreateUser(t, database, target)
		session := testBrowserSession("bs_read_target_"+suffix, target.ID)
		if err := database.CreateBrowserSession(
			ctx, session, "pre-promotion-read-token-with-entropy-"+suffix,
		); err != nil {
			t.Fatal(err)
		}

		start := make(chan struct{})
		results := make(chan error, 4)
		var workers sync.WaitGroup
		workers.Add(4)
		go func() {
			defer workers.Done()
			<-start
			role := domain.RoleAdmin
			audit := testAuditEvent(
				"aud_read_promotion_"+suffix, nil, "user.role.set", "user", target.ID,
				testNow.Add(time.Duration(iteration+1)*time.Minute),
			)
			_, err := database.UpdateUserAsTrustedControl(
				ctx, target.ID, AdminUserUpdate{Role: &role}, audit.CreatedAt, &audit, nil,
			)
			results <- err
		}()
		go func() {
			defer workers.Done()
			<-start
			_, err := database.ListInvitationsAsAdmin(ctx, target.ID, session.ID, testNow, 10, 0)
			results <- expectRejectedAdminRead(err)
		}()
		go func() {
			defer workers.Done()
			<-start
			_, err := database.ListUsersAsAdmin(ctx, target.ID, session.ID, testNow, 10, 0)
			results <- expectRejectedAdminRead(err)
		}()
		go func() {
			defer workers.Done()
			<-start
			_, err := database.ListAuditEventsAsAdmin(ctx, target.ID, session.ID, testNow, 10, 0)
			results <- expectRejectedAdminRead(err)
		}()

		close(start)
		workers.Wait()
		close(results)
		for err := range results {
			if err != nil {
				t.Fatalf("iteration %d concurrent promotion/read: %v", iteration, err)
			}
		}
	}
}

func assertAllAdminReadsRejected(
	t *testing.T,
	database *Store,
	userID string,
	browserSessionID string,
	checkedAt time.Time,
) {
	t.Helper()
	ctx := context.Background()
	if _, err := database.ListInvitationsAsAdmin(ctx, userID, browserSessionID, checkedAt, 10, 0); !errors.Is(err, ErrActiveAdminRequired) {
		t.Fatalf("invitation read = %v, want active admin required", err)
	}
	if _, err := database.ListUsersAsAdmin(ctx, userID, browserSessionID, checkedAt, 10, 0); !errors.Is(err, ErrActiveAdminRequired) {
		t.Fatalf("user read = %v, want active admin required", err)
	}
	if _, err := database.ListAuditEventsAsAdmin(ctx, userID, browserSessionID, checkedAt, 10, 0); !errors.Is(err, ErrActiveAdminRequired) {
		t.Fatalf("audit read = %v, want active admin required", err)
	}
}

func expectRejectedAdminRead(err error) error {
	if errors.Is(err, ErrActiveAdminRequired) {
		return nil
	}
	if err == nil {
		return errors.New("pre-promotion browser session gained administrative read access")
	}
	return err
}
