package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
)

func TestValidateBrowserSession(t *testing.T) {
	store, _ := newTestStore(t)
	ctx := context.Background()
	user := testUser("usr_session_validation", "session-validation", domain.RoleUser)
	mustCreateUser(t, store, user)

	const token = "browser-session-validation-token-with-high-entropy"
	session := domain.BrowserSession{
		ID:        "bs_session_validation",
		UserID:    user.ID,
		CreatedAt: testNow,
		ExpiresAt: testNow.Add(time.Hour),
		LastSeen:  testNow,
		UserAgent: "validation-test",
		IPAddress: "192.0.2.30",
	}
	if err := store.CreateBrowserSession(ctx, session, token); err != nil {
		t.Fatal(err)
	}

	if err := store.ValidateBrowserSession(ctx, user.ID, session.ID, testNow.Add(time.Minute)); err != nil {
		t.Fatalf("valid browser session = %v", err)
	}

	cases := map[string]struct {
		userID    string
		sessionID string
	}{
		"empty user id":    {sessionID: session.ID},
		"empty session id": {userID: user.ID},
		"unknown session":  {userID: user.ID, sessionID: "bs_unknown"},
		"different owner":  {userID: "usr_someone_else", sessionID: session.ID},
	}
	for name, test := range cases {
		t.Run(name, func(t *testing.T) {
			if err := store.ValidateBrowserSession(ctx, test.userID, test.sessionID, testNow.Add(time.Minute)); !errors.Is(err, ErrNotFound) {
				t.Fatalf("ValidateBrowserSession() error = %v, want ErrNotFound", err)
			}
		})
	}
}

func TestValidateBrowserSessionRejectsExpiredDeletedAndDisabled(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*testing.T, *Store, context.Context, domain.User, domain.BrowserSession, string)
		now    time.Time
	}{
		{
			name: "expired",
			now:  testNow.Add(time.Hour),
		},
		{
			name: "deleted",
			now:  testNow.Add(time.Minute),
			mutate: func(t *testing.T, store *Store, ctx context.Context, _ domain.User, _ domain.BrowserSession, token string) {
				t.Helper()
				if err := store.DeleteBrowserSession(ctx, token); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "disabled user",
			now:  testNow.Add(2 * time.Minute),
			mutate: func(t *testing.T, store *Store, ctx context.Context, user domain.User, _ domain.BrowserSession, _ string) {
				t.Helper()
				if err := store.UpdateUserStatus(ctx, user.ID, domain.UserDisabled, testNow.Add(time.Minute)); err != nil {
					t.Fatal(err)
				}
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store, _ := newTestStore(t)
			ctx := context.Background()
			user := testUser("usr_"+test.name, "validation-"+test.name, domain.RoleUser)
			mustCreateUser(t, store, user)
			token := "browser-session-token-" + test.name + "-with-high-entropy"
			session := domain.BrowserSession{
				ID:        "bs_" + test.name,
				UserID:    user.ID,
				CreatedAt: testNow,
				ExpiresAt: testNow.Add(time.Hour),
				LastSeen:  testNow,
				UserAgent: "validation-test",
				IPAddress: "192.0.2.31",
			}
			if err := store.CreateBrowserSession(ctx, session, token); err != nil {
				t.Fatal(err)
			}
			if test.mutate != nil {
				test.mutate(t, store, ctx, user, session, token)
			}

			if err := store.ValidateBrowserSession(ctx, user.ID, session.ID, test.now); !errors.Is(err, ErrNotFound) {
				t.Fatalf("ValidateBrowserSession() error = %v, want ErrNotFound", err)
			}
		})
	}
}
