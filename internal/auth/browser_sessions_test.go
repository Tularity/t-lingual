package auth

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/store"
)

func TestBrowserSessionServiceListsAndRevokesOnlyOwnedSessions(t *testing.T) {
	service, database, _, now := newTestService(t)
	ctx := context.Background()
	alice := domain.User{
		ID: "usr_session_service_alice", WebAuthnID: []byte("session-service-alice"),
		Username: "session-service-alice", DisplayName: "Alice", Role: domain.RoleUser,
		Status: domain.UserActive, CreatedAt: now, UpdatedAt: now,
	}
	bob := domain.User{
		ID: "usr_session_service_bob", WebAuthnID: []byte("session-service-bob"),
		Username: "session-service-bob", DisplayName: "Bob", Role: domain.RoleUser,
		Status: domain.UserActive, CreatedAt: now, UpdatedAt: now,
	}
	for _, user := range []domain.User{alice, bob} {
		if err := database.CreateUser(ctx, user); err != nil {
			t.Fatal(err)
		}
	}
	create := func(session domain.BrowserSession, token string) {
		t.Helper()
		if err := database.CreateBrowserSession(ctx, session, token); err != nil {
			t.Fatal(err)
		}
	}
	current := domain.BrowserSession{
		ID: "bs_service_current", UserID: alice.ID, CreatedAt: now,
		ExpiresAt: now.Add(time.Hour), LastSeen: now.Add(time.Minute),
	}
	other := domain.BrowserSession{
		ID: "bs_service_other", UserID: alice.ID, CreatedAt: now,
		ExpiresAt: now.Add(time.Hour), LastSeen: now.Add(2 * time.Minute),
	}
	expired := domain.BrowserSession{
		ID: "bs_service_expired", UserID: alice.ID, CreatedAt: now.Add(-2 * time.Hour),
		ExpiresAt: now.Add(-time.Minute), LastSeen: now.Add(-time.Hour),
	}
	bobs := domain.BrowserSession{
		ID: "bs_service_bob", UserID: bob.ID, CreatedAt: now,
		ExpiresAt: now.Add(time.Hour), LastSeen: now,
	}
	create(current, "service-current-browser-token-with-entropy")
	create(other, "service-other-browser-token-with-entropy")
	create(expired, "service-expired-browser-token-with-entropy")
	create(bobs, "service-bob-browser-token-with-entropy")

	listed, err := service.ListBrowserSessions(ctx, alice.ID)
	if err != nil || len(listed) != 2 || listed[0].ID != other.ID || listed[1].ID != current.ID {
		t.Fatalf("listed sessions = %#v, %v", listed, err)
	}
	if err := service.RevokeBrowserSession(
		ctx, alice.ID, current.ID, bobs.ID, "",
	); !errors.Is(err, ErrInvalidAuthorization) {
		t.Fatalf("stolen cookie revoked another browser = %v, want invalid authorization", err)
	}
	const authorizationToken = "service-single-revoke-grant-token-with-entropy"
	if err := database.CreateActionGrant(ctx, store.ActionGrant{
		ID: "grant_service_single_revoke", UserID: alice.ID, BrowserSessionID: current.ID,
		Action: store.ActionPasskeyManagement, CreatedAt: now, ExpiresAt: now.Add(time.Minute),
	}, authorizationToken); err != nil {
		t.Fatal(err)
	}
	if err := service.RevokeBrowserSession(
		ctx, alice.ID, current.ID, other.ID, authorizationToken,
	); err != nil {
		t.Fatalf("owned service revocation: %v", err)
	}
	listed, err = service.ListBrowserSessions(ctx, alice.ID)
	if err != nil || len(listed) != 1 || listed[0].ID != current.ID {
		t.Fatalf("sessions after revocation = %#v, %v", listed, err)
	}
	if err := service.RevokeBrowserSession(
		ctx, alice.ID, current.ID, current.ID, "",
	); err != nil {
		t.Fatalf("current browser could not sign itself out: %v", err)
	}
}

func TestRevokeOtherBrowserSessionsConsumesCurrentSessionGrant(t *testing.T) {
	service, database, _, now := newTestService(t)
	ctx := context.Background()
	user := domain.User{
		ID: "usr_revoke_other_service", WebAuthnID: []byte("revoke-other-service"),
		Username: "revoke-other-service", DisplayName: "Session owner", Role: domain.RoleUser,
		Status: domain.UserActive, CreatedAt: now, UpdatedAt: now,
	}
	if err := database.CreateUser(ctx, user); err != nil {
		t.Fatal(err)
	}
	sessions := []domain.BrowserSession{
		{ID: "bs_revoke_current", UserID: user.ID, CreatedAt: now, ExpiresAt: now.Add(time.Hour), LastSeen: now},
		{ID: "bs_revoke_other_a", UserID: user.ID, CreatedAt: now, ExpiresAt: now.Add(time.Hour), LastSeen: now},
		{ID: "bs_revoke_other_b", UserID: user.ID, CreatedAt: now, ExpiresAt: now.Add(time.Hour), LastSeen: now},
	}
	tokens := []string{
		"revoke-current-browser-token-with-entropy",
		"revoke-other-a-browser-token-with-entropy",
		"revoke-other-b-browser-token-with-entropy",
	}
	for index, session := range sessions {
		if err := database.CreateBrowserSession(ctx, session, tokens[index]); err != nil {
			t.Fatal(err)
		}
	}
	const authorizationToken = "revoke-other-action-grant-token-with-entropy"
	if err := database.CreateActionGrant(ctx, store.ActionGrant{
		ID: "grant_revoke_other", UserID: user.ID, BrowserSessionID: sessions[0].ID,
		Action: store.ActionPasskeyManagement, CreatedAt: now, ExpiresAt: now.Add(time.Minute),
	}, authorizationToken); err != nil {
		t.Fatal(err)
	}
	if _, err := service.RevokeOtherBrowserSessions(
		ctx, user.ID, sessions[1].ID, authorizationToken,
	); !errors.Is(err, ErrInvalidAuthorization) {
		t.Fatalf("grant used from another browser = %v, want invalid authorization", err)
	}

	deleted, err := service.RevokeOtherBrowserSessions(
		ctx, user.ID, sessions[0].ID, authorizationToken,
	)
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(deleted)
	if !slices.Equal(deleted, []string{sessions[1].ID, sessions[2].ID}) {
		t.Fatalf("deleted sessions = %#v", deleted)
	}
	if _, err := database.LookupBrowserSession(ctx, tokens[0], now); err != nil {
		t.Fatalf("current session was revoked: %v", err)
	}
	for _, token := range tokens[1:] {
		if _, err := database.LookupBrowserSession(ctx, token, now); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("other session remained active: %v", err)
		}
	}
	if _, err := service.RevokeOtherBrowserSessions(
		ctx, user.ID, sessions[0].ID, authorizationToken,
	); !errors.Is(err, ErrInvalidAuthorization) {
		t.Fatalf("action grant replay = %v, want invalid authorization", err)
	}
}
