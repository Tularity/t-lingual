package store

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
)

func TestActionGrantIsSessionBoundOpaqueAndSingleUse(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	user := testUser("usr_action_grant", "action-grant", domain.RoleUser)
	mustCreateUser(t, database, user)
	first := testBrowserSession("bs_action_first", user.ID)
	second := testBrowserSession("bs_action_second", user.ID)
	if err := database.CreateBrowserSession(ctx, first, "first-browser-token-with-enough-entropy"); err != nil {
		t.Fatal(err)
	}
	if err := database.CreateBrowserSession(ctx, second, "second-browser-token-with-enough-entropy"); err != nil {
		t.Fatal(err)
	}
	const token = "one-time-action-grant-token-with-enough-entropy"
	grant := ActionGrant{
		ID: "grant_one", UserID: user.ID, BrowserSessionID: first.ID,
		Action: ActionPasskeyManagement, CreatedAt: testNow,
		ExpiresAt: testNow.Add(2 * time.Minute),
	}
	if err := database.CreateActionGrant(ctx, grant, token); err != nil {
		t.Fatal(err)
	}
	if err := database.ConsumeActionGrant(
		ctx, token, user.ID, second.ID, ActionPasskeyManagement, testNow.Add(time.Minute),
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-session grant consume = %v", err)
	}

	const consumers = 20
	start := make(chan struct{})
	results := make(chan error, consumers)
	var wg sync.WaitGroup
	for range consumers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			results <- database.ConsumeActionGrant(
				ctx, token, user.ID, first.ID, ActionPasskeyManagement, testNow.Add(time.Minute),
			)
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	successes := 0
	for err := range results {
		if err == nil {
			successes++
		} else if !errors.Is(err, ErrNotFound) {
			t.Fatalf("unexpected grant consume error: %v", err)
		}
	}
	if successes != 1 {
		t.Fatalf("grant successes = %d, want 1", successes)
	}
}

func TestNewActionGrantReplacesPriorGrantForSameSession(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	user := testUser("usr_action_replace", "action-replace", domain.RoleUser)
	mustCreateUser(t, database, user)
	session := testBrowserSession("bs_action_replace", user.ID)
	if err := database.CreateBrowserSession(ctx, session, "replace-browser-token-with-enough-entropy"); err != nil {
		t.Fatal(err)
	}
	first := ActionGrant{
		ID: "grant_replace_first", UserID: user.ID, BrowserSessionID: session.ID,
		Action: ActionPasskeyManagement, CreatedAt: testNow, ExpiresAt: testNow.Add(time.Minute),
	}
	second := first
	second.ID = "grant_replace_second"
	second.CreatedAt = testNow.Add(time.Second)
	second.ExpiresAt = testNow.Add(2 * time.Minute)
	const firstToken = "first-replaced-action-token-with-enough-entropy"
	const secondToken = "second-action-token-with-enough-entropy"
	if err := database.CreateActionGrant(ctx, first, firstToken); err != nil {
		t.Fatal(err)
	}
	if err := database.CreateActionGrant(ctx, second, secondToken); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := database.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM action_grants WHERE browser_session_id = ?", session.ID,
	).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("replacement left %d action grants", count)
	}
	if err := database.ConsumeActionGrant(
		ctx, firstToken, user.ID, session.ID, ActionPasskeyManagement, testNow.Add(10*time.Second),
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("replaced grant remained usable: %v", err)
	}
	if err := database.ConsumeActionGrant(
		ctx, secondToken, user.ID, session.ID, ActionPasskeyManagement, testNow.Add(10*time.Second),
	); err != nil {
		t.Fatalf("replacement grant was not usable: %v", err)
	}
}

func TestActionGrantAndCredentialCreationRequireActiveSession(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	user := testUser("usr_action_active", "action-active", domain.RoleUser)
	mustCreateUser(t, database, user)
	session := testBrowserSession("bs_action_active", user.ID)
	const browserToken = "active-browser-token-with-enough-entropy"
	if err := database.CreateBrowserSession(ctx, session, browserToken); err != nil {
		t.Fatal(err)
	}
	credential := domain.Credential{
		ID: "cred_active_session", UserID: user.ID,
		CredentialID: []byte("active-session-credential"), Name: "New passkey",
		CredentialJSON: []byte(`{"counter":0}`), CreatedAt: testNow.Add(time.Minute),
	}
	if err := database.CreateCredentialForActiveSession(ctx, credential, session.ID, testNow.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := database.DeleteBrowserSession(ctx, browserToken); err != nil {
		t.Fatal(err)
	}
	credential.ID = "cred_after_logout"
	credential.CredentialID = []byte("credential-after-logout")
	if err := database.CreateCredentialForActiveSession(ctx, credential, session.ID, testNow.Add(time.Minute)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("logged-out session created credential: %v", err)
	}
	grant := ActionGrant{
		ID: "grant_after_logout", UserID: user.ID, BrowserSessionID: session.ID,
		Action: ActionPasskeyManagement, CreatedAt: testNow.Add(time.Minute),
		ExpiresAt: testNow.Add(2 * time.Minute),
	}
	if err := database.CreateActionGrant(ctx, grant, "grant-after-logout-with-enough-entropy"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("logged-out session created grant: %v", err)
	}
}

func TestCredentialDeletionLogsOutAllSessionsAtomically(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	user := testUser("usr_credential_logout", "credential-logout", domain.RoleUser)
	mustCreateUser(t, database, user)
	credentials := []domain.Credential{
		{ID: "cred_keep", UserID: user.ID, CredentialID: []byte("credential-keep"), Name: "Keep", CredentialJSON: []byte(`{"counter":0}`), CreatedAt: testNow},
		{ID: "cred_remove", UserID: user.ID, CredentialID: []byte("credential-remove"), Name: "Remove", CredentialJSON: []byte(`{"counter":0}`), CreatedAt: testNow.Add(time.Second)},
	}
	for _, credential := range credentials {
		if err := database.CreateCredential(ctx, credential); err != nil {
			t.Fatal(err)
		}
	}
	for index := range 3 {
		session := testBrowserSession("bs_delete_"+string(rune('a'+index)), user.ID)
		if err := database.CreateBrowserSession(ctx, session, "delete-browser-token-with-entropy-"+string(rune('a'+index))); err != nil {
			t.Fatal(err)
		}
	}
	deleted, err := database.DeleteCredentialAndBrowserSessions(ctx, user.ID, credentials[1].CredentialID, false)
	if err != nil || deleted != 3 {
		t.Fatalf("credential deletion removed %d sessions: %v", deleted, err)
	}
	if _, err := database.GetCredentialByCredentialID(ctx, credentials[1].CredentialID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("removed credential lookup = %v", err)
	}
	if _, err := database.GetCredentialByCredentialID(ctx, credentials[0].CredentialID); err != nil {
		t.Fatalf("remaining credential missing: %v", err)
	}
}

func TestDisabledUserCannotCreateLatentBrowserSession(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	user := testUser("usr_no_latent_session", "no-latent-session", domain.RoleUser)
	mustCreateUser(t, database, user)
	if err := database.UpdateUserStatus(ctx, user.ID, domain.UserDisabled, testNow.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	session := testBrowserSession("bs_latent_rejected", user.ID)
	if err := database.CreateBrowserSession(ctx, session, "latent-session-token-with-enough-entropy"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("disabled user created a latent browser session: %v", err)
	}
}

func TestCloneWarningRevokesSessionsAndCreatesSystemAudit(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	administrator := testUser("usr_clone_admin", "clone-admin", domain.RoleAdmin)
	user := testUser("usr_clone_target", "clone-target", domain.RoleUser)
	mustCreateUser(t, database, administrator)
	mustCreateUser(t, database, user)
	credential := domain.Credential{
		ID: "cred_clone_warning", UserID: user.ID, CredentialID: []byte("clone-warning-credential"),
		Name: "Passkey", CredentialJSON: []byte(`{"counter":9}`), CreatedAt: testNow,
	}
	if err := database.CreateCredential(ctx, credential); err != nil {
		t.Fatal(err)
	}
	session := testBrowserSession("bs_clone_warning", user.ID)
	if err := database.CreateBrowserSession(ctx, session, "clone-warning-browser-token-with-entropy"); err != nil {
		t.Fatal(err)
	}
	if err := database.HandleCredentialCloneWarning(
		ctx, user.ID, credential.ID, "aud_clone_warning", testNow.Add(time.Minute),
	); err != nil {
		t.Fatal(err)
	}
	var sessions int
	if err := database.db.QueryRowContext(ctx,
		"SELECT count(*) FROM browser_sessions WHERE user_id = ?", user.ID,
	).Scan(&sessions); err != nil {
		t.Fatal(err)
	}
	if sessions != 0 {
		t.Fatalf("clone warning left %d browser sessions", sessions)
	}
	quarantined, err := database.GetCredentialByCredentialID(ctx, credential.CredentialID)
	if err != nil || quarantined.CompromisedAt == nil || !quarantined.CompromisedAt.Equal(testNow.Add(time.Minute)) {
		t.Fatalf("clone warning did not quarantine credential: %#v, %v", quarantined, err)
	}
	events, err := database.ListAuditEventsAsTrustedControl(ctx, 10, 0)
	if err != nil || len(events) != 1 || events[0].Action != "credential.clone_warning" || events[0].ActorUserID != nil {
		t.Fatalf("clone warning audit = %#v, %v", events, err)
	}
}

func TestCompromisedCredentialCannotMakeHealthyCredentialDeletable(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	user := testUser("usr_compromised_final", "compromised-final", domain.RoleUser)
	mustCreateUser(t, database, user)
	healthy := domain.Credential{
		ID: "cred_healthy_final", UserID: user.ID, CredentialID: []byte("healthy-final-credential"),
		Name: "Healthy passkey", CredentialJSON: []byte(`{"counter":4}`), CreatedAt: testNow,
	}
	compromised := domain.Credential{
		ID: "cred_compromised_other", UserID: user.ID, CredentialID: []byte("compromised-other-credential"),
		Name: "Cloned passkey", CredentialJSON: []byte(`{"counter":9}`), CreatedAt: testNow.Add(time.Second),
	}
	for _, credential := range []domain.Credential{healthy, compromised} {
		if err := database.CreateCredential(ctx, credential); err != nil {
			t.Fatal(err)
		}
	}
	if err := database.HandleCredentialCloneWarning(
		ctx, user.ID, compromised.ID, "aud_compromised_final", testNow.Add(time.Minute),
	); err != nil {
		t.Fatal(err)
	}
	if err := database.DeleteCredential(ctx, user.ID, healthy.CredentialID, false); !errors.Is(err, ErrForbidden) {
		t.Fatalf("healthy final credential deletion = %v, want forbidden", err)
	}
	credentials, err := database.ListCredentials(ctx, user.ID)
	if err != nil || len(credentials) != 2 {
		t.Fatalf("blocked final-credential deletion changed credentials: %#v, %v", credentials, err)
	}
	if credentials[0].CompromisedAt != nil || credentials[1].CompromisedAt == nil {
		t.Fatalf("unexpected credential health after blocked deletion: %#v", credentials)
	}
}

func TestCredentialQuarantineAndLoginSessionInsertionCannotRace(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	const iterations = 32
	for iteration := range iterations {
		user := testUser(
			fmt.Sprintf("usr_quarantine_race_%02d", iteration),
			fmt.Sprintf("quarantine-race-%02d", iteration),
			domain.RoleUser,
		)
		mustCreateUser(t, database, user)
		credential := domain.Credential{
			ID: fmt.Sprintf("cred_quarantine_race_%02d", iteration), UserID: user.ID,
			CredentialID: []byte(fmt.Sprintf("credential-quarantine-race-%02d", iteration)),
			Name:         "Passkey", CredentialJSON: []byte(`{"counter":7}`), CreatedAt: testNow,
		}
		if err := database.CreateCredential(ctx, credential); err != nil {
			t.Fatal(err)
		}
		session := testBrowserSession(fmt.Sprintf("bs_quarantine_race_%02d", iteration), user.ID)
		token := fmt.Sprintf("quarantine-race-token-%02d-with-enough-entropy", iteration)

		start := make(chan struct{})
		loginResult := make(chan error, 1)
		quarantineResult := make(chan error, 1)
		go func() {
			<-start
			loginResult <- database.CreateBrowserSessionForCredential(
				ctx, session, token, credential.CredentialID,
			)
		}()
		go func() {
			<-start
			quarantineResult <- database.HandleCredentialCloneWarning(
				ctx, user.ID, credential.ID,
				fmt.Sprintf("aud_quarantine_race_%02d", iteration),
				testNow.Add(time.Minute),
			)
		}()
		close(start)
		loginErr := <-loginResult
		quarantineErr := <-quarantineResult
		if loginErr != nil && !errors.Is(loginErr, ErrNotFound) {
			t.Fatalf("iteration %d login result: %v", iteration, loginErr)
		}
		if quarantineErr != nil {
			t.Fatalf("iteration %d quarantine result: %v", iteration, quarantineErr)
		}
		if _, err := database.LookupBrowserSession(ctx, token, testNow.Add(time.Minute)); !errors.Is(err, ErrNotFound) {
			t.Fatalf("iteration %d left post-quarantine session: %v", iteration, err)
		}
		var sessions int
		if err := database.db.QueryRowContext(ctx,
			"SELECT COUNT(*) FROM browser_sessions WHERE user_id = ?", user.ID,
		).Scan(&sessions); err != nil {
			t.Fatal(err)
		}
		if sessions != 0 {
			t.Fatalf("iteration %d left %d browser sessions", iteration, sessions)
		}
		stored, err := database.GetCredentialByCredentialID(ctx, credential.CredentialID)
		if err != nil || stored.CompromisedAt == nil {
			t.Fatalf("iteration %d credential not quarantined: %#v, %v", iteration, stored, err)
		}
	}
}

func testBrowserSession(sessionID, userID string) domain.BrowserSession {
	return domain.BrowserSession{
		ID: sessionID, UserID: userID, CreatedAt: testNow,
		ExpiresAt: testNow.Add(time.Hour), LastSeen: testNow,
		UserAgent: "test", IPAddress: "192.0.2.44",
	}
}
