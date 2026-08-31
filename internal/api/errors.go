package api

import (
	"errors"
	"net/http"

	"github.com/Tularity/t-lingual/internal/admin"
	"github.com/Tularity/t-lingual/internal/auth"
	"github.com/Tularity/t-lingual/internal/live"
	"github.com/Tularity/t-lingual/internal/store"
	"github.com/Tularity/t-lingual/internal/webapi"
	"github.com/Tularity/t-lingual/internal/workspace"
)

var errUnauthenticated = errors.New("api: unauthenticated")

func (a *API) mapError(err error) error {
	var apiError *webapi.Error
	if errors.As(err, &apiError) {
		return apiError
	}
	switch {
	case errors.Is(err, errUnauthenticated), errors.Is(err, auth.ErrUnauthenticated):
		return webapi.Unauthorized("Sign in with a passkey to continue.")
	case errors.Is(err, auth.ErrInvalidInvitation):
		return &webapi.Error{Status: http.StatusUnprocessableEntity, Code: "INVALID_INVITATION", Message: "The invitation code is invalid, expired, used, or revoked."}
	case errors.Is(err, auth.ErrUsernameTaken):
		return webapi.Conflict("USERNAME_UNAVAILABLE", "That username is unavailable.")
	case errors.Is(err, auth.ErrInvalidCeremony):
		return webapi.BadRequest("CEREMONY_EXPIRED", "The passkey ceremony expired or was already used. Start again.")
	case errors.Is(err, auth.ErrInvalidPasskey):
		return webapi.Unauthorized("The passkey could not be verified.")
	case errors.Is(err, auth.ErrInvalidAuthorization):
		return webapi.Forbidden("PASSKEY_AUTHORIZATION_INVALID", "Complete a fresh passkey verification for this action.")
	case errors.Is(err, auth.ErrAccountDisabled):
		return webapi.Forbidden("ACCOUNT_DISABLED", "This account is disabled.")
	case errors.Is(err, auth.ErrCredentialLimit):
		return webapi.Conflict("PASSKEY_LIMIT", "This account has reached the passkey limit. Remove one before adding another.")
	case errors.Is(err, admin.ErrAdminRequired):
		return webapi.Forbidden("ADMIN_REQUIRED", "Administrator access is required.")
	case errors.Is(err, workspace.ErrSessionLive):
		return webapi.Conflict("SESSION_LIVE", "Stop the live interpretation before changing or deleting it.")
	case errors.Is(err, workspace.ErrQuota):
		return &webapi.Error{Status: http.StatusInsufficientStorage, Code: "STORAGE_LIMIT", Message: "This account has reached its workspace storage limit. Delete older sessions and try again."}
	case errors.Is(err, live.ErrGlobalCapacity):
		return &webapi.Error{Status: http.StatusServiceUnavailable, Code: "LIVE_CAPACITY", Message: "Live interpretation capacity is currently exhausted."}
	case errors.Is(err, live.ErrUserCapacity):
		return &webapi.Error{Status: http.StatusTooManyRequests, Code: "LIVE_USER_LIMIT", Message: "This account already has the maximum number of live interpretations."}
	case errors.Is(err, auth.ErrInvalidInput), errors.Is(err, workspace.ErrInvalidSession), errors.Is(err, workspace.ErrInvalidSettings):
		return &webapi.Error{Status: http.StatusUnprocessableEntity, Code: "INVALID_INPUT", Message: "One or more fields are invalid."}
	case errors.Is(err, store.ErrNotFound):
		return webapi.NotFound("NOT_FOUND", "The requested resource was not found.")
	case errors.Is(err, store.ErrConflict):
		return webapi.Conflict("CONFLICT", "The requested change conflicts with current state.")
	case errors.Is(err, store.ErrForbidden):
		return webapi.Forbidden("FORBIDDEN", "The requested operation is not allowed.")
	case errors.Is(err, store.ErrCapacity):
		return &webapi.Error{Status: http.StatusServiceUnavailable, Code: "AUTH_CAPACITY", Message: "Authentication is temporarily at capacity. Try again shortly."}
	default:
		a.logger.Error("unhandled API error", "error", err)
		return &webapi.Error{Status: http.StatusInternalServerError, Code: "INTERNAL_ERROR", Message: "The server could not complete the request.", Cause: err}
	}
}
