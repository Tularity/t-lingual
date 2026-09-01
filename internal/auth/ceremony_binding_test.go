package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/secret"
	"github.com/Tularity/t-lingual/internal/store"
	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

func TestUserBoundCeremoniesRestoreOnlyMatchingEncryptedWebAuthnHandle(t *testing.T) {
	service, database, keyring, now := newTestService(t)
	handle := bytes.Repeat([]byte{0x42}, 64)

	kinds := []string{
		store.CeremonyRegistration,
		credentialRegistration,
		credentialAuthorization,
	}
	tests := []struct {
		name          string
		pendingHandle []byte
		wantErr       error
	}{
		{name: "matching", pendingHandle: handle},
		{name: "missing", wantErr: ErrCredentialData},
		{name: "mismatched", pendingHandle: bytes.Repeat([]byte{0x24}, 64), wantErr: ErrCredentialData},
		{name: "oversized", pendingHandle: bytes.Repeat([]byte{0x42}, 65), wantErr: ErrCredentialData},
	}

	for kindIndex, kind := range kinds {
		for testIndex, test := range tests {
			t.Run(kind+"/"+test.name, func(t *testing.T) {
				ceremonyID := fmt.Sprintf("wac_binding_%d_%d", kindIndex, testIndex)
				token := fmt.Sprintf("binding-ceremony-token-with-entropy-%d-%d", kindIndex, testIndex)
				user := domain.User{
					ID: "usr_ceremony_binding", WebAuthnID: bytes.Repeat([]byte{0x99}, 64),
					Username: "ceremony-binding", DisplayName: "Ceremony Binding",
					Role: domain.RoleUser, Status: domain.UserActive, CreatedAt: now, UpdatedAt: now,
				}
				pending := pendingRegistration{
					User: user, WebAuthnID: append([]byte(nil), test.pendingHandle...),
					BrowserSessionID: "ses_ceremony_binding", CredentialName: "Passkey",
				}
				session := webauthn.SessionData{
					Challenge:        "ceremony-binding-challenge",
					UserID:           append([]byte(nil), handle...),
					Expires:          now.Add(time.Minute),
					UserVerification: protocol.VerificationRequired,
				}
				createEncryptedCeremony(t, database, keyring, now, ceremonyID, token, kind, session, &pending)

				_, restoredSession, restored, err := service.consumeCeremony(context.Background(), token, kind)
				if test.wantErr != nil {
					if !errors.Is(err, test.wantErr) {
						t.Fatalf("consumeCeremony error = %v, want %v", err, test.wantErr)
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				if !bytes.Equal(restoredSession.UserID, handle) || !bytes.Equal(restored.WebAuthnID, handle) ||
					!bytes.Equal(restored.User.WebAuthnID, handle) {
					t.Fatalf("WebAuthn handle was not restored and bound: session=%x pending=%x user=%x",
						restoredSession.UserID, restored.WebAuthnID, restored.User.WebAuthnID)
				}
				// The restored domain value must not alias the serialized binding field.
				restored.User.WebAuthnID[0] ^= 0xff
				if restored.User.WebAuthnID[0] == restored.WebAuthnID[0] {
					t.Fatal("restored domain user handle aliases pending ceremony state")
				}
			})
		}
	}
}

func TestDiscoverableAuthenticationCeremonyNeedsNoPendingUserHandle(t *testing.T) {
	service, database, keyring, now := newTestService(t)
	session := webauthn.SessionData{
		Challenge:        "discoverable-login-challenge",
		Expires:          now.Add(time.Minute),
		UserVerification: protocol.VerificationRequired,
	}
	const (
		ceremonyID = "wac_discoverable_without_pending"
		token      = "discoverable-login-ceremony-token-with-entropy"
	)
	createEncryptedCeremony(
		t, database, keyring, now, ceremonyID, token, store.CeremonyAuthentication, session, nil,
	)

	_, restored, pending, err := service.consumeCeremony(
		context.Background(), token, store.CeremonyAuthentication,
	)
	if err != nil {
		t.Fatal(err)
	}
	if restored.Challenge != session.Challenge || len(restored.UserID) != 0 || pending.User.ID != "" || len(pending.WebAuthnID) != 0 {
		t.Fatalf("unexpected discoverable ceremony state: session=%#v pending=%#v", restored, pending)
	}
}

func createEncryptedCeremony(
	t *testing.T,
	database *store.Store,
	keyring *secret.Keyring,
	now time.Time,
	ceremonyID string,
	token string,
	kind string,
	session webauthn.SessionData,
	pending *pendingRegistration,
) {
	t.Helper()
	sessionJSON, err := json.Marshal(session)
	if err != nil {
		t.Fatal(err)
	}
	sealedSession, err := keyring.Seal(ceremonySessionPurpose(ceremonyID), sessionJSON)
	if err != nil {
		t.Fatal(err)
	}
	var sealedPending []byte
	if pending != nil {
		pendingJSON, err := json.Marshal(pending)
		if err != nil {
			t.Fatal(err)
		}
		var serialized pendingRegistration
		if err := json.Unmarshal(pendingJSON, &serialized); err != nil {
			t.Fatal(err)
		}
		if len(serialized.User.WebAuthnID) != 0 {
			t.Fatal("domain.User WebAuthn handle unexpectedly serialized")
		}
		if !bytes.Equal(serialized.WebAuthnID, pending.WebAuthnID) {
			t.Fatal("explicit encrypted WebAuthn handle was not serialized")
		}
		sealedPending, err = keyring.Seal(ceremonyPendingPurpose(ceremonyID), pendingJSON)
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := database.CreateWebAuthnCeremony(context.Background(), store.WebAuthnCeremony{
		ID: ceremonyID, Kind: kind, SessionJSON: sealedSession, PendingUserJSON: sealedPending,
		CreatedAt: now, ExpiresAt: now.Add(time.Minute),
	}, token); err != nil {
		t.Fatal(err)
	}
}
