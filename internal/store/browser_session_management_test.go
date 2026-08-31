package store

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
)

func TestActiveBrowserSessionManagementIsOwnerScoped(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	alice := testUser("usr_browser_manager_alice", "browser-manager-alice", domain.RoleUser)
	bob := testUser("usr_browser_manager_bob", "browser-manager-bob", domain.RoleUser)
	mustCreateUser(t, database, alice)
	mustCreateUser(t, database, bob)

	create := func(session domain.BrowserSession, token string) {
		t.Helper()
		if err := database.CreateBrowserSession(ctx, session, token); err != nil {
			t.Fatal(err)
		}
	}
	current := testBrowserSession("bs_manager_current", alice.ID)
	current.LastSeen = testNow.Add(3 * time.Minute)
	newer := testBrowserSession("bs_manager_newer", alice.ID)
	newer.CreatedAt = testNow.Add(time.Minute)
	newer.LastSeen = testNow.Add(5 * time.Minute)
	newer.ExpiresAt = testNow.Add(2 * time.Hour)
	expired := testBrowserSession("bs_manager_expired", alice.ID)
	expired.CreatedAt = testNow.Add(-2 * time.Hour)
	expired.LastSeen = testNow.Add(-time.Hour)
	expired.ExpiresAt = testNow.Add(-time.Minute)
	bobs := testBrowserSession("bs_manager_bob", bob.ID)
	create(current, "manager-current-browser-token-with-entropy")
	create(newer, "manager-newer-browser-token-with-entropy")
	create(expired, "manager-expired-browser-token-with-entropy")
	create(bobs, "manager-bob-browser-token-with-entropy")

	listed, err := database.ListActiveBrowserSessions(ctx, alice.ID, testNow)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 2 || listed[0].ID != newer.ID || listed[1].ID != current.ID {
		t.Fatalf("active ordered sessions = %#v", listed)
	}
	for _, session := range listed {
		if session.UserID != alice.ID {
			t.Fatalf("cross-owner session leaked into list: %#v", session)
		}
	}

	if err := database.DeleteBrowserSessionByID(ctx, alice.ID, bobs.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-owner session deletion = %v, want not found", err)
	}
	if _, err := database.LookupBrowserSession(
		ctx, "manager-bob-browser-token-with-entropy", testNow,
	); err != nil {
		t.Fatalf("cross-owner deletion removed Bob's session: %v", err)
	}
	if err := database.DeleteBrowserSessionByID(ctx, alice.ID, newer.ID); err != nil {
		t.Fatalf("delete owned browser session: %v", err)
	}
	if _, err := database.LookupBrowserSession(
		ctx, "manager-newer-browser-token-with-entropy", testNow,
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted owned session lookup = %v", err)
	}
}

func TestDeleteOtherBrowserSessionsPreservesCurrentAndOtherOwners(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	alice := testUser("usr_browser_others_alice", "browser-others-alice", domain.RoleUser)
	bob := testUser("usr_browser_others_bob", "browser-others-bob", domain.RoleUser)
	mustCreateUser(t, database, alice)
	mustCreateUser(t, database, bob)
	create := func(id, owner, token string, expiresAt time.Time) {
		t.Helper()
		session := testBrowserSession(id, owner)
		if !expiresAt.After(session.CreatedAt) {
			session.CreatedAt = expiresAt.Add(-time.Hour)
			session.LastSeen = session.CreatedAt
		}
		session.ExpiresAt = expiresAt
		if err := database.CreateBrowserSession(ctx, session, token); err != nil {
			t.Fatal(err)
		}
	}
	create("bs_others_current", alice.ID, "others-current-token-with-enough-entropy", testNow.Add(time.Hour))
	create("bs_others_active", alice.ID, "others-active-token-with-enough-entropy", testNow.Add(time.Hour))
	create("bs_others_expired", alice.ID, "others-expired-token-with-enough-entropy", testNow.Add(-time.Minute))
	create("bs_others_bob", bob.ID, "others-bob-token-with-enough-entropy", testNow.Add(time.Hour))

	if _, err := database.DeleteOtherBrowserSessions(
		ctx, alice.ID, "bs_others_bob", testNow,
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign current session authorized delete-others: %v", err)
	}
	var before int
	if err := database.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM browser_sessions WHERE user_id = ?", alice.ID,
	).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if before != 3 {
		t.Fatalf("failed owner check deleted sessions: %d remain", before)
	}

	deleted, err := database.DeleteOtherBrowserSessions(
		ctx, alice.ID, "bs_others_current", testNow,
	)
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(deleted)
	if !slices.Equal(deleted, []string{"bs_others_active", "bs_others_expired"}) {
		t.Fatalf("deleted session IDs = %#v", deleted)
	}
	if _, err := database.LookupBrowserSession(
		ctx, "others-current-token-with-enough-entropy", testNow,
	); err != nil {
		t.Fatalf("current session was not preserved: %v", err)
	}
	if _, err := database.LookupBrowserSession(
		ctx, "others-bob-token-with-enough-entropy", testNow,
	); err != nil {
		t.Fatalf("other owner's session was removed: %v", err)
	}
}
