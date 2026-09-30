package api

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/Tularity/t-lingual/internal/auth"
	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/store"
	"github.com/Tularity/t-lingual/internal/webapi"
)

// An administrator's own passkeys and browsers are managed where every
// account manages its own, with that account's own verification.
var errOwnSignIn = webapi.Forbidden("MANAGE_IN_SETTINGS", "Manage your own passkeys and signed-in browsers in your settings.")

// adminUserSecurity lists how one account signs in: its passkeys and the
// browsers signed in with it. Secrets and session tokens are never included.
func (a *API) adminUserSecurity(response http.ResponseWriter, request *http.Request, current identity) error {
	if err := a.requireAdmin(request, current); err != nil {
		return err
	}
	userID := request.PathValue("userID")
	if _, err := a.store.GetUserByID(request.Context(), userID); err != nil {
		return err
	}
	passkeys, err := a.auth.ListCredentials(request.Context(), userID)
	if err != nil {
		return err
	}
	sessions, err := a.auth.ListBrowserSessions(request.Context(), userID)
	if err != nil {
		return err
	}
	browsers := make([]browserSessionResponse, 0, len(sessions))
	for _, session := range sessions {
		browsers = append(browsers, browserSessionPayload(session, current.Session.ID))
	}
	if passkeys == nil {
		passkeys = []domain.Credential{}
	}
	webapi.WriteJSON(response, http.StatusOK, map[string]any{"passkeys": passkeys, "sessions": browsers})
	return nil
}

// consumeTargetAuthorization consumes the passkey authorization given for
// removing exactly this one passkey or browser of exactly this account.
func (a *API) consumeTargetAuthorization(request *http.Request, current identity, kind, userID, target string) error {
	digest := sha256.Sum256([]byte(target))
	scope, err := auth.AdminUserChangeAuthorizationScope(kind, userID, hex.EncodeToString(digest[:]))
	if err != nil {
		return err
	}
	return a.consumeAdminAuthorization(request, current, scope)
}

// deleteUserPasskeyAsAdmin removes one passkey from an account, as when its
// device is lost. As when the owner removes one, every browser the account
// is signed in with is signed out. It may be the account's last passkey: the
// owner then needs a sign-in code from an administrator to add another.
func (a *API) deleteUserPasskeyAsAdmin(response http.ResponseWriter, request *http.Request, current identity) error {
	userID := request.PathValue("userID")
	encoded := strings.TrimSpace(request.PathValue("credentialID"))
	if userID == current.User.ID {
		return errOwnSignIn
	}
	if err := a.requireAdmin(request, current); err != nil {
		return err
	}
	if err := a.consumeTargetAuthorization(request, current, "passkey", userID, encoded); err != nil {
		return err
	}
	credentialID, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(credentialID) == 0 {
		return store.ErrNotFound
	}
	passkeys, err := a.auth.ListCredentials(request.Context(), userID)
	if err != nil {
		return err
	}
	name, remaining := "", 0
	for _, passkey := range passkeys {
		if passkey.ID == encoded {
			name = passkey.Name
		} else if passkey.CompromisedAt == nil {
			remaining++
		}
	}
	ended, err := a.store.DeleteCredentialAndBrowserSessions(request.Context(), userID, credentialID, true)
	if err != nil {
		return err
	}
	if a.live != nil {
		a.live.RevokeUser(userID)
	}
	if err := a.adminAudit(request.Context(), current, "user.passkey.delete", userID, map[string]any{
		"name": name, "remaining": remaining, "signedOut": ended,
	}); err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusNoContent, nil)
	return nil
}

// revokeUserSessionAsAdmin signs one browser out of an account.
func (a *API) revokeUserSessionAsAdmin(response http.ResponseWriter, request *http.Request, current identity) error {
	userID := request.PathValue("userID")
	browserSessionID := strings.TrimSpace(request.PathValue("browserSessionID"))
	if userID == current.User.ID {
		return errOwnSignIn
	}
	if err := a.requireAdmin(request, current); err != nil {
		return err
	}
	if err := a.consumeTargetAuthorization(request, current, "session", userID, browserSessionID); err != nil {
		return err
	}
	sessions, err := a.auth.ListBrowserSessions(request.Context(), userID)
	if err != nil {
		return err
	}
	agent := ""
	for _, session := range sessions {
		if session.ID == browserSessionID {
			agent = session.UserAgent
		}
	}
	if len(agent) > 160 {
		agent = agent[:160]
	}
	if err := a.store.DeleteBrowserSessionByID(request.Context(), userID, browserSessionID); err != nil {
		return err
	}
	if a.live != nil {
		a.live.RevokeBrowserSession(browserSessionID)
	}
	if err := a.adminAudit(request.Context(), current, "user.session.revoke", userID, map[string]any{"userAgent": agent}); err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusNoContent, nil)
	return nil
}

// deleteUserAsAdmin removes an account for good: its recordings stop, its
// sessions go with their audio and transcripts, then the account itself with
// everything else it holds. An administrator cannot delete their own account,
// nor the last active administrator. The passkey authorization names the
// account, so it deletes that one only.
func (a *API) deleteUserAsAdmin(response http.ResponseWriter, request *http.Request, current identity) error {
	userID := request.PathValue("userID")
	if userID == current.User.ID {
		return webapi.Forbidden("CANNOT_DELETE_SELF", "You can't delete your own account.")
	}
	if err := a.requireAdmin(request, current); err != nil {
		return err
	}
	scope, err := auth.AdminUserDeleteAuthorizationScope(userID)
	if err != nil {
		return err
	}
	if err := a.consumeAdminAuthorization(request, current, scope); err != nil {
		return err
	}
	ctx := request.Context()
	user, err := a.store.GetUserByID(ctx, userID)
	if err != nil {
		return err
	}
	held, err := a.store.AccountStorageOf(ctx, userID)
	if err != nil {
		return err
	}
	// Nobody records into its sessions any longer, and its own browsers are cut off.
	if a.rooms != nil {
		stopCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		err := a.rooms.EndOwnerRecordings(stopCtx, userID)
		cancel()
		if err != nil {
			return &webapi.Error{Status: http.StatusConflict, Code: "RECORDING_ENDING", Message: "A recording in this account's sessions is still ending. Try again in a moment."}
		}
	}
	if a.live != nil {
		a.live.RevokeUser(userID)
	}
	sessionIDs, err := a.store.UserSessionIDs(ctx, userID)
	if err != nil {
		return err
	}
	for _, sessionID := range sessionIDs {
		remove := func(ctx context.Context) error {
			return a.store.DeleteInterpretationSessionIfNotLive(ctx, userID, sessionID)
		}
		if a.media != nil {
			err = a.media.DeleteSessionWithMedia(ctx, userID, sessionID, remove)
		} else {
			err = remove(ctx)
		}
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			if errors.Is(err, store.ErrConflict) {
				return &webapi.Error{Status: http.StatusConflict, Code: "SESSION_BUSY", Message: "One of this account's sessions is being recorded or exported. Try again in a moment."}
			}
			return err
		}
	}
	eventID, err := newAuditID()
	if err != nil {
		return err
	}
	metadata, err := jsonRaw(map[string]any{"username": user.Username, "displayName": user.DisplayName,
		"sessions": len(sessionIDs), "storageBytes": held.AudioBytes + held.TranscriptBytes})
	if err != nil {
		return err
	}
	actor := current.User.ID
	now := time.Now().UTC()
	event := store.AuditEvent{ID: eventID, ActorUserID: &actor, Action: "user.delete", TargetType: "user", TargetID: userID,
		Metadata: metadata, CreatedAt: now}
	if err := a.store.DeleteUserAsAdmin(ctx, current.User.ID, current.Session.ID, now, userID, event, now); err != nil {
		return err
	}
	if a.live != nil {
		a.live.RevokeUser(userID)
	}
	webapi.WriteJSON(response, http.StatusNoContent, nil)
	return nil
}

type defaultLimitsView struct {
	Defaults domain.UserLimits `json:"defaults"`
	BuiltIn  domain.UserLimits `json:"builtIn"`
}

// adminDefaultLimits reads the limits of every account not set apart, and the
// built-in ones they started as.
func (a *API) adminDefaultLimits(response http.ResponseWriter, request *http.Request, current identity) error {
	if err := a.requireAdmin(request, current); err != nil {
		return err
	}
	defaults, err := a.store.DefaultLimits(request.Context())
	if err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusOK, defaultLimitsView{Defaults: defaults, BuiltIn: domain.DefaultUserLimits})
	return nil
}

// setAdminDefaultLimits replaces the default limits, with a passkey
// authorization for exactly the body sent.
func (a *API) setAdminDefaultLimits(response http.ResponseWriter, request *http.Request, current identity) error {
	var limits domain.UserLimits
	if err := a.authorizedBody(response, request, current, auth.AdminDefaultLimitsAuthorizationScope, &limits); err != nil {
		return err
	}
	if !limits.Valid() {
		return &webapi.Error{Status: http.StatusUnprocessableEntity, Code: "INVALID_LIMITS", Message: "Choose limits within the allowed range."}
	}
	eventID, err := newAuditID()
	if err != nil {
		return err
	}
	metadata, err := jsonRaw(limits)
	if err != nil {
		return err
	}
	actor := current.User.ID
	now := time.Now().UTC()
	event := store.AuditEvent{ID: eventID, ActorUserID: &actor, Action: "limits.defaults.set", TargetType: "site",
		TargetID: "default_limits", Metadata: metadata, CreatedAt: now}
	if err := a.store.SetDefaultLimitsAsAdmin(request.Context(), current.User.ID, current.Session.ID, now, limits, event, now); err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusOK, defaultLimitsView{Defaults: limits, BuiltIn: domain.DefaultUserLimits})
	return nil
}
