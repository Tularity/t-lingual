package sharing

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/secret"
	"github.com/Tularity/t-lingual/internal/store"
)

func sharingFixture(t *testing.T) (*Service, *store.Store, domain.InterpretationSession, domain.User, domain.User) {
	t.Helper()
	database, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	keyring, err := secret.New(bytes.Repeat([]byte{4}, 32))
	if err != nil {
		t.Fatal(err)
	}
	service, err := New(database, keyring)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 20, 12, 0, 0, 0, time.UTC)
	service.now = func() time.Time { return now }
	owner := domain.User{ID: "usr_share_owner", WebAuthnID: bytes.Repeat([]byte{1}, 64), Username: "owner", DisplayName: "Owner", Role: domain.RoleUser, Status: domain.UserActive, CreatedAt: now, UpdatedAt: now}
	recipient := domain.User{ID: "usr_share_recipient", WebAuthnID: bytes.Repeat([]byte{2}, 64), Username: "recipient", DisplayName: "Recipient", Role: domain.RoleUser, Status: domain.UserActive, CreatedAt: now, UpdatedAt: now}
	for _, user := range []domain.User{owner, recipient} {
		if err := database.CreateUser(context.Background(), user); err != nil {
			t.Fatal(err)
		}
	}
	session := domain.InterpretationSession{ID: "session_shared", UserID: owner.ID, Title: "Team conversation", SourceLanguage: "auto", TargetLanguage: "en", RecognitionLanguages: []string{"en", "fr"}, Diarization: true,
		Status: domain.InterpretationCreated, CreatedAt: now, UpdatedAt: now}
	if err := database.CreateInterpretationSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	return service, database, session, owner, recipient
}

func TestUserShareViewerDefaultsAndRevocation(t *testing.T) {
	service, database, session, owner, recipient := sharingFixture(t)
	ctx := context.Background()
	settings := domain.DefaultUserSettings(recipient.ID)
	settings.DefaultSourceLanguage, settings.DefaultTargetLanguage = "auto", "ja"
	if err := database.UpsertUserSettings(ctx, settings); err != nil {
		t.Fatal(err)
	}
	viewer := domain.Viewer{UserID: recipient.ID, BrowserSessionID: "browser_recipient"}
	if _, err := service.Resolve(ctx, viewer, session.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unshared session resolved: %v", err)
	}
	created, err := service.Create(ctx, owner.ID, session.ID, CreateInput{Kind: domain.ShareUser, Permission: domain.ShareView, RecipientUserID: recipient.ID})
	if err != nil || created.Token != "" {
		t.Fatalf("user share = %#v, %v", created, err)
	}
	access, err := service.Resolve(ctx, viewer, session.ID)
	if err != nil || access.Permission != domain.ShareView || access.IsOwner || access.TargetLanguage != "ja" || access.Viewer.ID != "user:"+recipient.ID || access.ShareID != created.Share.ID {
		t.Fatalf("registered viewer access = %#v, %v", access, err)
	}
	ownerAccess, err := service.Resolve(ctx, domain.Viewer{UserID: owner.ID}, session.ID)
	if err != nil || !ownerAccess.IsOwner || ownerAccess.Permission != domain.ShareRecord || ownerAccess.TargetLanguage != "en" {
		t.Fatalf("owner access = %#v, %v", ownerAccess, err)
	}
	accessible, err := service.ListAccessibleSessions(ctx, viewer, 20, 0)
	if err != nil || len(accessible) != 1 || accessible[0].Session.ID != session.ID {
		t.Fatalf("accessible list = %#v, %v", accessible, err)
	}
	access, err = service.SetTargetLanguage(ctx, viewer, session.ID, "zh-CN")
	if err != nil || access.TargetLanguage != "zh-Hans" {
		t.Fatalf("viewer language update = %#v, %v", access, err)
	}
	updated, err := service.Update(ctx, owner.ID, session.ID, created.Share.ID, UpdateInput{Permission: domain.ShareRecord})
	if err != nil || updated.Permission != domain.ShareRecord {
		t.Fatalf("share permission update = %#v, %v", updated, err)
	}
	access, err = service.Resolve(ctx, viewer, session.ID)
	if err != nil || access.Permission != domain.ShareRecord || access.TargetLanguage != "zh-Hans" {
		t.Fatalf("updated viewer access = %#v, %v", access, err)
	}
	if _, err := service.List(ctx, recipient.ID, session.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("recipient listed owner shares: %v", err)
	}
	if _, err := service.Revoke(ctx, recipient.ID, session.ID, created.Share.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("recipient revoked owner share: %v", err)
	}
	if _, err := service.Revoke(ctx, owner.ID, session.ID, created.Share.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Resolve(ctx, viewer, session.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("revoked user share still resolved: %v", err)
	}
	if items, err := service.ListAccessibleSessions(ctx, viewer, 20, 0); err != nil || len(items) != 0 {
		t.Fatalf("revoked viewer list = %#v, %v", items, err)
	}
	if _, err := service.Resolve(ctx, domain.Viewer{UserID: owner.ID}, session.ID); err != nil {
		t.Fatalf("share revocation affected owner: %v", err)
	}
}

func TestLinkRedeemCookieExpiryAndOwnerRecovery(t *testing.T) {
	service, database, session, owner, recipient := sharingFixture(t)
	ctx := context.Background()
	expires := service.now().Add(2 * time.Hour)
	created, err := service.Create(ctx, owner.ID, session.ID, CreateInput{Kind: domain.ShareLink, Permission: domain.ShareRecord, ExpiresAt: &expires})
	if err != nil || len(created.Token) != 43 {
		t.Fatalf("link share = %#v, %v", created, err)
	}
	token, err := service.LinkToken(ctx, owner.ID, session.ID, created.Share.ID)
	if err != nil || token != created.Token {
		t.Fatalf("owner token recovery = %q, %v", token, err)
	}
	if _, err := service.LinkToken(ctx, "usr_foreign", session.ID, created.Share.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("foreign token recovery = %v", err)
	}
	if _, err := service.Redeem(ctx, "bad-token", "Guest", "fr"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("invalid link redemption = %v", err)
	}
	redeemed, err := service.Redeem(ctx, created.Token, "Guest A", "fr-FR")
	if err != nil || len(redeemed.CookieToken) != 43 || redeemed.Guest.TargetLanguage != "fr" || redeemed.Access.Permission != domain.ShareRecord {
		t.Fatalf("guest redemption = %#v, %v", redeemed, err)
	}
	viewer, err := service.AuthenticateGuest(ctx, redeemed.CookieToken)
	if err != nil || viewer.GuestID != redeemed.Guest.ID || viewer.ID != "guest:"+redeemed.Guest.ID {
		t.Fatalf("guest authentication = %#v, %v", viewer, err)
	}
	access, err := service.SetTargetLanguage(ctx, viewer, session.ID, "de")
	if err != nil || access.TargetLanguage != "de" {
		t.Fatalf("guest preference = %#v, %v", access, err)
	}
	settings := domain.DefaultUserSettings(recipient.ID)
	settings.DefaultSourceLanguage, settings.DefaultTargetLanguage = "auto", "ja"
	if err := database.UpsertUserSettings(ctx, settings); err != nil {
		t.Fatal(err)
	}
	registered := domain.Viewer{UserID: recipient.ID, BrowserSessionID: "bs_recipient", GuestID: redeemed.Guest.ID}
	access, err = service.Resolve(ctx, registered, session.ID)
	if err != nil || access.Viewer.ID != "user:"+recipient.ID || access.TargetLanguage != "ja" || access.Permission != domain.ShareRecord || access.ShareID != created.Share.ID {
		t.Fatalf("signed-in link access = %#v, %v", access, err)
	}
	access, err = service.SetTargetLanguage(ctx, registered, session.ID, "zh-CN")
	if err != nil || access.TargetLanguage != "zh-Hans" {
		t.Fatalf("registered per-session language = %#v, %v", access, err)
	}
	guestAccess, err := service.Resolve(ctx, viewer, session.ID)
	if err != nil || guestAccess.TargetLanguage != "de" {
		t.Fatalf("registered language overwrote guest preference: %#v, %v", guestAccess, err)
	}
	registeredSessions, err := service.ListAccessibleSessions(ctx, registered, 20, 0)
	if err != nil || len(registeredSessions) != 1 {
		t.Fatalf("signed-in link list = %#v, %v", registeredSessions, err)
	}
	if _, err := service.Revoke(ctx, owner.ID, session.ID, created.Share.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.AuthenticateGuest(ctx, redeemed.CookieToken); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("revoked guest cookie authenticated: %v", err)
	}
	if _, err := service.Resolve(ctx, viewer, session.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("revoked guest resolved: %v", err)
	}
	if _, err := service.Resolve(ctx, registered, session.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("signed-in link viewer survived revocation: %v", err)
	}
	if _, err := service.Resolve(ctx, domain.Viewer{UserID: owner.ID, GuestID: redeemed.Guest.ID}, session.ID); err != nil {
		t.Fatalf("link revocation removed owner's direct access: %v", err)
	}
	if _, err := service.LinkToken(ctx, owner.ID, session.ID, created.Share.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("revoked link token recovered: %v", err)
	}
	permanent, err := service.Create(ctx, owner.ID, session.ID, CreateInput{Kind: domain.ShareLink, Permission: domain.ShareView})
	if err != nil || permanent.Share.ExpiresAt != nil {
		t.Fatalf("permanent link = %#v, %v", permanent, err)
	}
	service.now = func() time.Time { return expires.Add(time.Minute) }
	if _, err := service.Redeem(ctx, created.Token, "Late", "en"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("expired link redeemed: %v", err)
	}
	if fresh, err := service.Redeem(ctx, permanent.Token, "", ""); err != nil || fresh.Guest.DisplayName != "Guest" || fresh.Guest.TargetLanguage != "en" {
		t.Fatalf("permanent link defaults = %#v, %v", fresh, err)
	}
}

func TestShareExpiryDisabledAccountsAndBoundedRecipientSearch(t *testing.T) {
	service, database, session, owner, recipient := sharingFixture(t)
	ctx := context.Background()
	expires := service.now().Add(time.Minute)
	share, err := service.Create(ctx, owner.ID, session.ID, CreateInput{
		Kind: domain.ShareUser, Permission: domain.ShareView, RecipientUserID: recipient.ID, ExpiresAt: &expires,
	})
	if err != nil {
		t.Fatal(err)
	}
	viewer := domain.Viewer{UserID: recipient.ID}
	if _, err := service.Resolve(ctx, viewer, session.ID); err != nil {
		t.Fatal(err)
	}
	service.now = func() time.Time { return expires.Add(time.Second) }
	if _, err := service.Resolve(ctx, viewer, session.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("expired user share resolved: %v", err)
	}
	if _, err := service.Update(ctx, owner.ID, session.ID, share.Share.ID, UpdateInput{Permission: domain.ShareRecord}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Resolve(ctx, viewer, session.ID); err != nil {
		t.Fatalf("permanent user share was not restored: %v", err)
	}
	if err := database.UpdateUserStatus(ctx, recipient.ID, domain.UserDisabled, service.now()); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Resolve(ctx, viewer, session.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("disabled recipient resolved share: %v", err)
	}
	if err := database.UpdateUserStatus(ctx, recipient.ID, domain.UserActive, service.now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := database.UpdateUserStatus(ctx, owner.ID, domain.UserDisabled, service.now().Add(2*time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Resolve(ctx, viewer, session.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("disabled owner shared access: %v", err)
	}
	if _, err := service.Resolve(ctx, domain.Viewer{UserID: owner.ID}, session.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("disabled owner resolved own session: %v", err)
	}
	if _, err := service.SearchUsers(ctx, recipient.ID, " "); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("empty user search = %v", err)
	}
	percent := domain.User{ID: "usr_percent", WebAuthnID: bytes.Repeat([]byte{3}, 64), Username: "percent", DisplayName: "Literal % mark", Role: domain.RoleUser,
		Status: domain.UserActive, CreatedAt: service.now(), UpdatedAt: service.now()}
	if err := database.CreateUser(ctx, percent); err != nil {
		t.Fatal(err)
	}
	for index := range 23 {
		user := domain.User{ID: fmt.Sprintf("usr_many_%02d", index), WebAuthnID: bytes.Repeat([]byte{byte(index + 4)}, 64),
			Username: fmt.Sprintf("person-%02d", index), DisplayName: "Person", Role: domain.RoleUser, Status: domain.UserActive,
			CreatedAt: service.now(), UpdatedAt: service.now()}
		if err := database.CreateUser(ctx, user); err != nil {
			t.Fatal(err)
		}
	}
	results, err := service.SearchUsers(ctx, recipient.ID, "%")
	if err != nil || len(results) != 1 || results[0].ID != percent.ID {
		t.Fatalf("literal wildcard search = %#v, %v", results, err)
	}
	results, err = service.SearchUsers(ctx, recipient.ID, "Person")
	if err != nil || len(results) != 20 {
		t.Fatalf("bounded recipient search = %d, %v", len(results), err)
	}
}
