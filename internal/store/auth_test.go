package store

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
)

func testInvitation(invitationID string) domain.Invitation {
	return domain.Invitation{
		ID:        invitationID,
		CreatedAt: testNow,
		ExpiresAt: testNow.Add(time.Hour),
	}
}

func TestInvitationValidationAndConcurrentSingleUse(t *testing.T) {
	store, _ := newTestStore(t)
	ctx := context.Background()
	user := testUser("usr_consumer", "consumer", domain.RoleUser)
	mustCreateUser(t, store, user)
	digest := invitationDigest("A1B2C3")
	if err := store.CreateInvitation(ctx, testInvitation("inv_concurrent"), digest); err != nil {
		t.Fatal(err)
	}

	valid, err := store.ValidateInvitation(ctx, invitationDigestArray("A1B2C3"), testNow.Add(time.Minute))
	if err != nil || valid.ID != "inv_concurrent" || valid.UsedAt != nil {
		t.Fatalf("validate invitation = %#v, %v", valid, err)
	}
	if _, err := store.ValidateInvitation(ctx, invitationDigestArray("ZZZZZZ"), testNow); !errors.Is(err, ErrInvalidInvite) {
		t.Fatalf("unknown invitation = %v, want invalid invite", err)
	}

	const consumers = 24
	start := make(chan struct{})
	results := make(chan error, consumers)
	var wg sync.WaitGroup
	for range consumers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := store.ConsumeInvitation(ctx, digest, user.ID, testNow.Add(2*time.Minute))
			results <- err
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	successes, invalid := 0, 0
	for err := range results {
		switch {
		case err == nil:
			successes++
		case errors.Is(err, ErrInvalidInvite):
			invalid++
		default:
			t.Fatalf("unexpected consume error: %v", err)
		}
	}
	if successes != 1 || invalid != consumers-1 {
		t.Fatalf("success=%d invalid=%d", successes, invalid)
	}
	stored, err := store.GetInvitationByID(ctx, "inv_concurrent")
	if err != nil || stored.UsedBy == nil || *stored.UsedBy != user.ID || stored.UsedAt == nil {
		t.Fatalf("stored invitation = %#v, %v", stored, err)
	}
}

func TestRegistrationTransactionRollsBackAndCanRetry(t *testing.T) {
	store, _ := newTestStore(t)
	ctx := context.Background()
	existing := testUser("usr_existing", "existing", domain.RoleUser)
	mustCreateUser(t, store, existing)
	existingCredential := domain.Credential{
		ID:             "cred_existing",
		UserID:         existing.ID,
		CredentialID:   []byte("already-registered-credential"),
		Name:           "Existing",
		CredentialJSON: []byte(`{"counter":0}`),
		CreatedAt:      testNow,
	}
	if err := store.CreateCredential(ctx, existingCredential); err != nil {
		t.Fatal(err)
	}

	digest := invitationDigest("R0LLBK")
	if err := store.CreateInvitation(ctx, testInvitation("inv_rollback"), digest); err != nil {
		t.Fatal(err)
	}
	proposed := testUser("usr_proposed", "proposed", domain.RoleUser)
	credential := domain.Credential{
		ID:             "cred_proposed",
		UserID:         proposed.ID,
		CredentialID:   append([]byte(nil), existingCredential.CredentialID...),
		Name:           "New passkey",
		CredentialJSON: []byte(`{"counter":0}`),
		CreatedAt:      testNow,
	}
	if _, err := store.RegisterUserWithCredential(
		ctx, digest, testNow.Add(time.Minute), proposed, credential,
	); !errors.Is(err, ErrConflict) {
		t.Fatalf("registration error = %v, want conflict", err)
	}
	if _, err := store.GetUserByID(ctx, proposed.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("partially created user lookup = %v", err)
	}
	invitation, err := store.GetInvitationByID(ctx, "inv_rollback")
	if err != nil || invitation.UsedAt != nil || invitation.UsedBy != nil {
		t.Fatalf("invitation was consumed on rollback: %#v, %v", invitation, err)
	}

	credential.CredentialID = []byte("fresh-registration-credential")
	consumed, err := store.RegisterUserWithCredential(
		ctx, digest, testNow.Add(2*time.Minute), proposed, credential,
	)
	if err != nil {
		t.Fatalf("retry registration: %v", err)
	}
	if consumed.UsedBy == nil || *consumed.UsedBy != proposed.ID {
		t.Fatalf("consumed invitation = %#v", consumed)
	}
	if _, err := store.GetCredentialByCredentialID(ctx, credential.CredentialID); err != nil {
		t.Fatalf("registered credential missing: %v", err)
	}
	if _, err := store.RegisterUserWithCredential(
		ctx, digest, testNow.Add(3*time.Minute), testUser("usr_replay", "replay", domain.RoleUser),
		domain.Credential{
			ID: "cred_replay", UserID: "usr_replay", CredentialID: []byte("replay-credential"),
			Name: "Replay", CredentialJSON: []byte(`{}`), CreatedAt: testNow,
		},
	); !errors.Is(err, ErrInvalidInvite) {
		t.Fatalf("replayed registration = %v, want invalid invite", err)
	}
}

func TestBrowserSessionsAndCeremoniesAreOpaqueAndOneTime(t *testing.T) {
	store, path := newTestStore(t)
	ctx := context.Background()
	user := testUser("usr_auth", "auth-user", domain.RoleUser)
	mustCreateUser(t, store, user)

	code := "K9P4Q2"
	invite := testInvitation("inv_auth")
	digest := invitationDigest(code)
	if err := store.CreateInvitation(ctx, invite, digest); err != nil {
		t.Fatal(err)
	}
	browserToken := "browser-token-with-distinct-high-entropy-material-4c4bb11f"
	browser := domain.BrowserSession{
		ID: "bs_auth", UserID: user.ID, CreatedAt: testNow,
		ExpiresAt: testNow.Add(time.Hour), LastSeen: testNow,
		UserAgent: "test-agent", IPAddress: "192.0.2.10",
	}
	if err := store.CreateBrowserSession(ctx, browser, browserToken); err != nil {
		t.Fatal(err)
	}
	lookedUp, err := store.LookupBrowserSession(ctx, browserToken, testNow.Add(time.Minute))
	if err != nil || lookedUp.ID != browser.ID {
		t.Fatalf("lookup browser session = %#v, %v", lookedUp, err)
	}
	if err := store.TouchBrowserSession(ctx, browserToken, testNow.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}

	ceremonyToken := "ceremony-token-with-distinct-high-entropy-material-f167b2e0"
	ceremony := WebAuthnCeremony{
		ID: "cer_auth", Kind: CeremonyRegistration,
		SessionJSON:     []byte(`{"challenge":"opaque"}`),
		PendingUserJSON: []byte(`{"username":"auth-user"}`),
		InvitationID:    &invite.ID, CreatedAt: testNow,
		ExpiresAt: testNow.Add(5 * time.Minute),
	}
	if err := store.CreateWebAuthnCeremony(ctx, ceremony, ceremonyToken); err != nil {
		t.Fatal(err)
	}
	consumed, err := store.ConsumeWebAuthnCeremony(ctx, ceremonyToken, testNow.Add(time.Minute))
	if err != nil || consumed.ID != ceremony.ID || consumed.InvitationID == nil || *consumed.InvitationID != invite.ID {
		t.Fatalf("consume ceremony = %#v, %v", consumed, err)
	}
	if _, err := store.ConsumeWebAuthnCeremony(ctx, ceremonyToken, testNow.Add(time.Minute)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("ceremony replay = %v, want not found", err)
	}

	expired := WebAuthnCeremony{
		ID: "cer_expired", Kind: CeremonyAuthentication, SessionJSON: []byte(`{}`),
		CreatedAt: testNow, ExpiresAt: testNow.Add(time.Minute),
	}
	if err := store.CreateWebAuthnCeremony(ctx, expired, "expired-ceremony-token-with-enough-entropy"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ConsumeWebAuthnCeremony(
		ctx, "expired-ceremony-token-with-enough-entropy", testNow.Add(2*time.Minute),
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expired ceremony consume = %v", err)
	}
	deleted, err := store.DeleteExpiredWebAuthnCeremonies(ctx, testNow.Add(2*time.Minute))
	if err != nil || deleted != 1 {
		t.Fatalf("delete expired = %d, %v", deleted, err)
	}

	var storedCode, storedBrowserToken []byte
	if err := store.db.QueryRowContext(ctx,
		"SELECT code_hash FROM invitations WHERE id = ?", invite.ID,
	).Scan(&storedCode); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRowContext(ctx,
		"SELECT token_hash FROM browser_sessions WHERE id = ?", browser.ID,
	).Scan(&storedBrowserToken); err != nil {
		t.Fatal(err)
	}
	if len(storedCode) != sha256.Size || len(storedBrowserToken) != sha256.Size ||
		bytes.Equal(storedCode, []byte(code)) || bytes.Equal(storedBrowserToken, []byte(browserToken)) {
		t.Fatalf("secrets were not stored as fixed-size digests")
	}
	if _, err := store.db.ExecContext(ctx, "PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
		t.Fatal(err)
	}
	for _, candidate := range []string{path, path + "-wal"} {
		contents, err := os.ReadFile(candidate)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		for label, secret := range map[string]string{
			"invitation code": code, "browser token": browserToken, "ceremony token": ceremonyToken,
		} {
			if bytes.Contains(contents, []byte(secret)) {
				t.Errorf("%s appears in SQLite file %s", label, candidate)
			}
		}
	}

	if err := store.UpdateUserStatus(ctx, user.ID, domain.UserDisabled, testNow.Add(3*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.LookupBrowserSession(ctx, browserToken, testNow.Add(4*time.Minute)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("disabled user session lookup = %v", err)
	}
	count, err := store.DeleteUserBrowserSessions(ctx, user.ID)
	if err != nil || count != 1 {
		t.Fatalf("delete user sessions = %d, %v", count, err)
	}
}

func TestBoundedWebAuthnCeremoniesAreAtomicAndExpireBeforeAdmission(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	const (
		capacity   = 3
		contenders = 24
	)
	start := make(chan struct{})
	results := make(chan error, contenders)
	var wait sync.WaitGroup
	for index := range contenders {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			ceremony := WebAuthnCeremony{
				ID:          fmt.Sprintf("cer_bounded_%02d", index),
				Kind:        CeremonyAuthentication,
				SessionJSON: []byte(`{}`),
				CreatedAt:   testNow,
				ExpiresAt:   testNow.Add(time.Minute),
			}
			results <- database.CreateWebAuthnCeremonyBounded(
				ctx, ceremony, fmt.Sprintf("bounded-token-%02d-with-enough-entropy", index), capacity, 2, 1,
			)
		}()
	}
	close(start)
	wait.Wait()
	close(results)
	succeeded, rejected := 0, 0
	for err := range results {
		switch {
		case err == nil:
			succeeded++
		case errors.Is(err, ErrCapacity):
			rejected++
		default:
			t.Fatalf("unexpected bounded ceremony result: %v", err)
		}
	}
	if succeeded != capacity || rejected != contenders-capacity {
		t.Fatalf("bounded ceremony results: succeeded=%d rejected=%d", succeeded, rejected)
	}

	replacement := WebAuthnCeremony{
		ID:          "cer_after_expiry",
		Kind:        CeremonyAuthentication,
		SessionJSON: []byte(`{}`),
		CreatedAt:   testNow.Add(2 * time.Minute),
		ExpiresAt:   testNow.Add(3 * time.Minute),
	}
	if err := database.CreateWebAuthnCeremonyBounded(
		ctx, replacement, "replacement-token-with-enough-entropy", capacity, 2, 1,
	); err != nil {
		t.Fatalf("expired ceremonies did not release durable capacity: %v", err)
	}
	var count int
	if err := database.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM webauthn_ceremonies").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("expired ceremony cleanup left %d rows, want 1", count)
	}
}

func TestOwnedWebAuthnCeremoniesAreSessionBoundAndCannotConsumePublicCapacity(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	user := testUser("usr_owned_ceremony", "owned-ceremony", domain.RoleUser)
	mustCreateUser(t, database, user)
	session := testBrowserSession("bs_owned_ceremony", user.ID)
	const browserToken = "owned-ceremony-browser-token-with-enough-entropy"
	if err := database.CreateBrowserSession(ctx, session, browserToken); err != nil {
		t.Fatal(err)
	}
	owned := func(index int) WebAuthnCeremony {
		return WebAuthnCeremony{
			ID:               fmt.Sprintf("cer_owned_%d", index),
			Kind:             "credential_authorization",
			SessionJSON:      []byte(`{}`),
			OwnerUserID:      user.ID,
			BrowserSessionID: session.ID,
			CreatedAt:        testNow,
			ExpiresAt:        testNow.Add(5 * time.Minute),
		}
	}
	for index := range 2 {
		if err := database.CreateWebAuthnCeremonyBounded(
			ctx, owned(index), fmt.Sprintf("owned-token-%d-with-enough-entropy", index), 10, 4, 2,
		); err != nil {
			t.Fatal(err)
		}
	}
	if err := database.CreateWebAuthnCeremonyBounded(
		ctx, owned(2), "owned-token-over-capacity-with-enough-entropy", 10, 4, 2,
	); !errors.Is(err, ErrCapacity) {
		t.Fatalf("per-owner ceremony capacity = %v, want capacity error", err)
	}

	public := WebAuthnCeremony{
		ID: "cer_public_reserved", Kind: CeremonyAuthentication, SessionJSON: []byte(`{}`),
		CreatedAt: testNow, ExpiresAt: testNow.Add(5 * time.Minute),
	}
	if err := database.CreateWebAuthnCeremonyBounded(
		ctx, public, "public-token-with-enough-entropy", 10, 4, 2,
	); err != nil {
		t.Fatalf("owner cap starved public ceremony: %v", err)
	}
	consumed, err := database.ConsumeWebAuthnCeremony(
		ctx, "owned-token-0-with-enough-entropy", testNow.Add(time.Minute),
	)
	if err != nil || consumed.OwnerUserID != user.ID || consumed.BrowserSessionID != session.ID {
		t.Fatalf("owned ceremony identity = %#v, %v", consumed, err)
	}

	if err := database.DeleteBrowserSession(ctx, browserToken); err != nil {
		t.Fatal(err)
	}
	if err := database.CreateWebAuthnCeremonyBounded(
		ctx, owned(3), "owned-token-after-logout-with-enough-entropy", 10, 4, 2,
	); !errors.Is(err, ErrForbidden) {
		t.Fatalf("revoked browser session created an owned ceremony: %v", err)
	}
	var ownedRows int
	if err := database.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM webauthn_ceremonies WHERE owner_user_id = ?", user.ID,
	).Scan(&ownedRows); err != nil {
		t.Fatal(err)
	}
	if ownedRows != 0 {
		t.Fatalf("browser session revocation left %d owned ceremonies", ownedRows)
	}
}

func TestInvitationExpiryRevocationAndDigestValidation(t *testing.T) {
	store, _ := newTestStore(t)
	ctx := context.Background()
	user := testUser("usr_invite", "invite-user", domain.RoleUser)
	mustCreateUser(t, store, user)

	if err := store.CreateInvitation(ctx, testInvitation("bad_digest"), []byte("short")); !errors.Is(err, ErrInvalidInvite) {
		t.Fatalf("short digest = %v", err)
	}
	expired := testInvitation("inv_expired")
	expired.ExpiresAt = testNow.Add(time.Minute)
	if err := store.CreateInvitation(ctx, expired, invitationDigest("EXPIRE")); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ConsumeInvitation(
		ctx, invitationDigest("EXPIRE"), user.ID, testNow.Add(2*time.Minute),
	); !errors.Is(err, ErrInvalidInvite) {
		t.Fatalf("expired invitation = %v", err)
	}

	revokedDigest := invitationDigest("REVOKE")
	if err := store.CreateInvitation(ctx, testInvitation("inv_revoked"), revokedDigest); err != nil {
		t.Fatal(err)
	}
	if err := store.RevokeInvitation(ctx, "inv_revoked", testNow.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ConsumeInvitation(
		ctx, revokedDigest, user.ID, testNow.Add(2*time.Minute),
	); !errors.Is(err, ErrInvalidInvite) {
		t.Fatalf("revoked invitation = %v", err)
	}
	if err := store.RevokeInvitation(ctx, "inv_revoked", testNow.Add(3*time.Minute)); !errors.Is(err, ErrConflict) {
		t.Fatalf("second revoke = %v", err)
	}
	if err := store.RevokeInvitation(ctx, "does-not-exist", testNow); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing revoke = %v", err)
	}
	revoked, err := store.GetInvitationByID(ctx, "inv_revoked")
	if err != nil || revoked.RevocationReason != "administrator" {
		t.Fatalf("manual revocation reason = %#v, %v", revoked, err)
	}
}

func TestInvitationFailureBucketsAreExclusiveWhileActive(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	first := testInvitation("inv_bucket_first")
	if err := database.CreateInvitationWithBucket(ctx, first, invitationDigest("100001"), 7); err != nil {
		t.Fatal(err)
	}
	second := testInvitation("inv_bucket_second")
	if err := database.CreateInvitationWithBucket(ctx, second, invitationDigest("100002"), 7); !errors.Is(err, ErrConflict) {
		t.Fatalf("active bucket collision = %v, want conflict", err)
	}
	if err := database.CreateInvitationWithBucket(ctx, second, invitationDigest("100002"), 4096); err == nil {
		t.Fatal("out-of-range bucket was accepted")
	}
	if err := database.RevokeInvitation(ctx, first.ID, testNow.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := database.CreateInvitationWithBucket(ctx, second, invitationDigest("100002"), 7); err != nil {
		t.Fatalf("released bucket could not be reused: %v", err)
	}
}

func TestExpiredInvitationBucketCanBeReusedWithoutChargingHistoricalCode(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	const bucket = uint16(3071)
	historicalDigest := invitationDigest("710001")
	historical := testInvitation("inv_expired_bucket_historical")
	historical.ExpiresAt = testNow.Add(time.Minute)
	if err := database.CreateInvitationWithBucket(ctx, historical, historicalDigest, bucket); err != nil {
		t.Fatal(err)
	}

	activeDigest := invitationDigest("710002")
	active := testInvitation("inv_after_expired_bucket")
	active.CreatedAt = historical.ExpiresAt.Add(time.Minute)
	active.ExpiresAt = active.CreatedAt.Add(time.Hour)
	if err := database.CreateInvitationWithBucket(ctx, active, activeDigest, bucket); err != nil {
		t.Fatalf("expired invitation kept its failure bucket occupied: %v", err)
	}
	retired, err := database.GetInvitationByID(ctx, historical.ID)
	if err != nil || retired.RevokedAt == nil || !retired.RevokedAt.Equal(historical.ExpiresAt) {
		t.Fatalf("expired bucket occupant was not durably retired: %#v, %v", retired, err)
	}

	proposed := testUser("usr_expired_bucket_proposed", "expired-bucket-proposed", domain.RoleUser)
	proposed.CreatedAt = active.CreatedAt.Add(time.Minute)
	proposed.UpdatedAt = proposed.CreatedAt
	credential := domain.Credential{
		ID: "cred_expired_bucket_proposed", UserID: proposed.ID,
		CredentialID: []byte("credential-expired-bucket-proposed"), Name: "Passkey",
		CredentialJSON: []byte(`{"counter":0}`), CreatedAt: proposed.CreatedAt,
	}
	for attempt := range 8 {
		if _, err := database.CompleteRegistration(
			ctx, historicalDigest, bucket, proposed.CreatedAt, proposed, credential,
			5, fmt.Sprintf("aud_expired_historical_%d", attempt),
		); !errors.Is(err, ErrInvalidInvite) {
			t.Fatalf("historical expired code attempt %d = %v", attempt, err)
		}
	}
	var failures int
	if err := database.db.QueryRowContext(ctx,
		"SELECT failed_attempts FROM invitations WHERE id = ?", active.ID,
	).Scan(&failures); err != nil {
		t.Fatal(err)
	}
	storedActive, err := database.GetInvitationByID(ctx, active.ID)
	if err != nil {
		t.Fatal(err)
	}
	if failures != 0 || storedActive.RevokedAt != nil {
		t.Fatalf("historical expired code charged replacement: failures=%d invitation=%#v", failures, storedActive)
	}
	if _, err := database.ValidateInvitation(
		ctx, invitationDigestArray("710002"), proposed.CreatedAt,
	); err != nil {
		t.Fatalf("replacement invitation was not active after historical attempts: %v", err)
	}
}

func TestInvalidInvitationAttemptsAutoRevokeAndAuditAtomically(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	administrator := testUser("usr_failure_auditor", "failure-auditor", domain.RoleAdmin)
	mustCreateUser(t, database, administrator)
	invitation := testInvitation("inv_failure_budget")
	const bucket = uint16(19)
	if err := database.CreateInvitationWithBucket(ctx, invitation, invitationDigest("222222"), bucket); err != nil {
		t.Fatal(err)
	}

	if revoked, err := database.RecordInvalidInvitationAttempt(ctx, bucket+1, testNow.Add(time.Minute), 5, "aud_empty"); err != nil || revoked {
		t.Fatalf("unoccupied bucket = revoked %v, error %v", revoked, err)
	}

	const attempts = 24
	start := make(chan struct{})
	type result struct {
		revoked bool
		err     error
	}
	results := make(chan result, attempts)
	var wg sync.WaitGroup
	for index := range attempts {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			revoked, err := database.RecordInvalidInvitationAttempt(
				ctx, bucket, testNow.Add(2*time.Minute), 5, fmt.Sprintf("aud_failure_%02d", index),
			)
			results <- result{revoked: revoked, err: err}
		}()
	}
	close(start)
	wg.Wait()
	close(results)

	revocations := 0
	for result := range results {
		if result.err != nil {
			t.Fatalf("record failure: %v", result.err)
		}
		if result.revoked {
			revocations++
		}
	}
	if revocations != 1 {
		t.Fatalf("auto-revocation count = %d, want 1", revocations)
	}
	stored, err := database.GetInvitationByID(ctx, invitation.ID)
	if err != nil || stored.RevokedAt == nil || stored.RevocationReason != "failed_attempts" {
		t.Fatalf("auto-revoked invitation = %#v, %v", stored, err)
	}
	var failures int
	if err := database.db.QueryRowContext(ctx,
		"SELECT failed_attempts FROM invitations WHERE id = ?", invitation.ID,
	).Scan(&failures); err != nil {
		t.Fatal(err)
	}
	if failures != 5 {
		t.Fatalf("failed attempts = %d, want threshold 5", failures)
	}
	events, err := database.ListAuditEventsAsTrustedControl(ctx, 20, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Action != "invitation.auto_revoke" ||
		events[0].TargetID != invitation.ID || events[0].ActorUserID != nil ||
		!bytes.Contains(events[0].Metadata, []byte(`"failedAttempts":5`)) {
		t.Fatalf("auto-revocation audit = %#v", events)
	}
	if _, err := database.ValidateInvitation(ctx, invitationDigestArray("222222"), testNow.Add(3*time.Minute)); !errors.Is(err, ErrInvalidInvite) {
		t.Fatalf("auto-revoked invitation remained valid: %v", err)
	}
}

func TestCompleteRegistrationOnlyChargesTrulyUnknownCodes(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	consumer := testUser("usr_historical_consumer", "historical-consumer", domain.RoleUser)
	mustCreateUser(t, database, consumer)
	const bucket = uint16(11)
	historicalDigest := invitationDigest("333333")
	historical := testInvitation("inv_historical")
	if err := database.CreateInvitationWithBucket(ctx, historical, historicalDigest, bucket); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ConsumeInvitation(ctx, historicalDigest, consumer.ID, testNow.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	future := testInvitation("inv_future_same_bucket")
	if err := database.CreateInvitationWithBucket(ctx, future, invitationDigest("444444"), bucket); err != nil {
		t.Fatal(err)
	}

	proposed := testUser("usr_proposed_historical", "proposed-historical", domain.RoleUser)
	credential := domain.Credential{
		ID: "cred_proposed_historical", UserID: proposed.ID,
		CredentialID: []byte("credential-proposed-historical"), Name: "Passkey",
		CredentialJSON: []byte(`{"counter":0}`), CreatedAt: testNow.Add(2 * time.Minute),
	}
	for attempt := range 8 {
		if _, err := database.CompleteRegistration(
			ctx, historicalDigest, bucket, testNow.Add(2*time.Minute), proposed, credential,
			5, fmt.Sprintf("aud_known_%d", attempt),
		); !errors.Is(err, ErrInvalidInvite) {
			t.Fatalf("historical attempt %d = %v", attempt, err)
		}
	}
	var failures int
	if err := database.db.QueryRowContext(ctx,
		"SELECT failed_attempts FROM invitations WHERE id = ?", future.ID,
	).Scan(&failures); err != nil {
		t.Fatal(err)
	}
	if failures != 0 {
		t.Fatalf("known historical code charged a future bucket occupant %d times", failures)
	}

	unknownDigest := invitationDigest("555555")
	if _, err := database.CompleteRegistration(
		ctx, unknownDigest, bucket, testNow.Add(3*time.Minute), proposed, credential,
		5, "aud_unknown_once",
	); !errors.Is(err, ErrInvalidInvite) {
		t.Fatalf("unknown code completion = %v", err)
	}
	if err := database.db.QueryRowContext(ctx,
		"SELECT failed_attempts FROM invitations WHERE id = ?", future.ID,
	).Scan(&failures); err != nil {
		t.Fatal(err)
	}
	if failures != 1 {
		t.Fatalf("unknown code failure count = %d, want 1", failures)
	}
}

func TestCompleteRegistrationConsumesExactActiveInvite(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	const bucket = uint16(4)
	digest := invitationDigest("666666")
	invitation := testInvitation("inv_complete_registration")
	if err := database.CreateInvitationWithBucket(ctx, invitation, digest, bucket); err != nil {
		t.Fatal(err)
	}
	user := testUser("usr_completed", "completed-user", domain.RoleUser)
	credential := domain.Credential{
		ID: "cred_completed", UserID: user.ID, CredentialID: []byte("credential-completed"),
		Name: "Passkey", CredentialJSON: []byte(`{"counter":0}`), CreatedAt: testNow,
	}
	consumed, err := database.CompleteRegistration(
		ctx, digest, bucket, testNow.Add(time.Minute), user, credential, 5, "aud_unused_valid",
	)
	if err != nil || consumed.UsedBy == nil || *consumed.UsedBy != user.ID {
		t.Fatalf("completed registration = %#v, %v", consumed, err)
	}
	if _, err := database.GetUserByID(ctx, user.ID); err != nil {
		t.Fatalf("registered user missing: %v", err)
	}
}

func TestBrowserSessionQuotaRetainsTwentyMostRecent(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	user := testUser("usr_browser_quota", "browser-quota", domain.RoleUser)
	mustCreateUser(t, database, user)

	const total = maxBrowserSessionsPerUser + 5
	tokens := make([]string, total)
	for index := range total {
		moment := testNow.Add(time.Duration(index) * time.Second)
		session := domain.BrowserSession{
			ID: fmt.Sprintf("bs_quota_%02d", index), UserID: user.ID,
			CreatedAt: moment, ExpiresAt: moment.Add(time.Hour), LastSeen: moment,
			UserAgent: fmt.Sprintf("test-device-%02d", index), IPAddress: "192.0.2.55",
		}
		tokens[index] = fmt.Sprintf("browser-quota-token-%02d-with-enough-entropy", index)
		if err := database.CreateBrowserSession(ctx, session, tokens[index]); err != nil {
			t.Fatalf("create browser session %d: %v", index, err)
		}
	}

	var count int
	if err := database.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM browser_sessions WHERE user_id = ?", user.ID,
	).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != maxBrowserSessionsPerUser {
		t.Fatalf("browser session count = %d, want %d", count, maxBrowserSessionsPerUser)
	}
	lookupAt := testNow.Add(time.Minute)
	for index, token := range tokens {
		session, err := database.LookupBrowserSession(ctx, token, lookupAt)
		if index < total-maxBrowserSessionsPerUser {
			if !errors.Is(err, ErrNotFound) {
				t.Fatalf("evicted browser session %d lookup = %#v, %v", index, session, err)
			}
			continue
		}
		if err != nil || session.ID != fmt.Sprintf("bs_quota_%02d", index) {
			t.Fatalf("retained browser session %d lookup = %#v, %v", index, session, err)
		}
	}
}

func TestCredentialQuotaIsAtomicAndAppliesToSessionBoundCreation(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	user := testUser("usr_credential_quota", "credential-quota", domain.RoleUser)
	mustCreateUser(t, database, user)
	for index := range maxCredentialsPerUser - 1 {
		credential := domain.Credential{
			ID: fmt.Sprintf("cred_quota_seed_%02d", index), UserID: user.ID,
			CredentialID: []byte(fmt.Sprintf("credential-quota-seed-%02d", index)),
			Name:         "Passkey", CredentialJSON: []byte(`{"counter":0}`),
			CreatedAt: testNow.Add(time.Duration(index) * time.Second),
		}
		if err := database.CreateCredential(ctx, credential); err != nil {
			t.Fatal(err)
		}
	}

	const contenders = 16
	start := make(chan struct{})
	results := make(chan error, contenders)
	var wait sync.WaitGroup
	for index := range contenders {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			results <- database.CreateCredential(ctx, domain.Credential{
				ID: fmt.Sprintf("cred_quota_contender_%02d", index), UserID: user.ID,
				CredentialID: []byte(fmt.Sprintf("credential-quota-contender-%02d", index)),
				Name:         "Contender", CredentialJSON: []byte(`{"counter":0}`),
				CreatedAt: testNow.Add(time.Minute + time.Duration(index)*time.Second),
			})
		}()
	}
	close(start)
	wait.Wait()
	close(results)
	succeeded, rejected := 0, 0
	for err := range results {
		switch {
		case err == nil:
			succeeded++
		case errors.Is(err, ErrCapacity):
			rejected++
		default:
			t.Fatalf("unexpected credential quota result: %v", err)
		}
	}
	if succeeded != 1 || rejected != contenders-1 {
		t.Fatalf("credential quota successes=%d rejections=%d", succeeded, rejected)
	}
	var count int
	if err := database.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM webauthn_credentials WHERE user_id = ?", user.ID,
	).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != maxCredentialsPerUser {
		t.Fatalf("credential count = %d, want %d", count, maxCredentialsPerUser)
	}

	session := testBrowserSession("bs_credential_quota", user.ID)
	if err := database.CreateBrowserSession(
		ctx, session, "credential-quota-browser-token-with-enough-entropy",
	); err != nil {
		t.Fatal(err)
	}
	overflow := domain.Credential{
		ID: "cred_quota_session_bound_overflow", UserID: user.ID,
		CredentialID: []byte("credential-quota-session-bound-overflow"),
		Name:         "Overflow", CredentialJSON: []byte(`{"counter":0}`),
		CreatedAt: testNow.Add(2 * time.Minute),
	}
	if err := database.CreateCredentialForActiveSession(
		ctx, overflow, session.ID, testNow.Add(time.Minute),
	); !errors.Is(err, ErrCapacity) {
		t.Fatalf("session-bound credential over quota = %v, want capacity", err)
	}
}
