package api

import (
	"errors"
	"net/http"
	"time"

	"github.com/Tularity/t-lingual/internal/admin"
	"github.com/Tularity/t-lingual/internal/auth"
	"github.com/Tularity/t-lingual/internal/webapi"
)

func (a *API) redeemCode(response http.ResponseWriter, request *http.Request) error {
	if err := a.rateLimitAuth(response, request, authCode); err != nil {
		return err
	}
	var input struct {
		Code string `json:"code"`
	}
	if err := webapi.DecodeJSON(response, request, 1024, &input); err != nil {
		return err
	}
	result, err := a.auth.RedeemCode(request.Context(), input.Code,
		auth.SessionMetadata{UserAgent: request.UserAgent(), IPAddress: a.clientAddress(request)})
	if errors.Is(err, auth.ErrInvalidInvitation) || errors.Is(err, auth.ErrAccountDisabled) {
		return &webapi.Error{Status: http.StatusUnprocessableEntity, Code: "INVALID_CODE",
			Message: "The code is invalid, not yet active, expired, used, or revoked."}
	}
	if err != nil {
		return err
	}
	response.Header().Set("Cache-Control", "no-store")
	if result.Kind == "registration" {
		webapi.WriteJSON(response, http.StatusOK, map[string]any{
			"kind": "registration", "registrationTicket": result.RegistrationTicket, "expiresAt": result.ExpiresAt})
		return nil
	}
	settings, err := a.store.GetUserSettings(request.Context(), result.Login.User.ID)
	if err != nil {
		return err
	}
	a.setSessionCookie(response, result.Login.SessionToken, result.Login.Session.ExpiresAt)
	webapi.WriteJSON(response, http.StatusOK, map[string]any{
		"kind": "login", "user": result.Login.User,
		"onboardingComplete": settings.OnboardingComplete,
		"session":            map[string]any{"expiresAt": result.Login.Session.ExpiresAt},
		"recoveryAuthorization": map[string]any{"authorizationToken": result.RecoveryAuthorization.Token,
			"expiresAt": result.RecoveryAuthorization.ExpiresAt},
	})
	return nil
}

type createCodeRequest struct {
	Kind         string `json:"kind"`
	TargetUserID string `json:"targetUserId,omitempty"`
	NotBefore    string `json:"notBefore,omitempty"`
	ExpiresAt    string `json:"expiresAt,omitempty"`
	TTLSeconds   int    `json:"ttlSeconds,omitempty"`
}

func parseCodeTime(value string) (*time.Time, error) {
	if value == "" {
		return nil, nil
	}
	if len(value) > 64 {
		return nil, webapi.BadRequest("INVALID_CODE_SCHEDULE", "Use RFC3339 dates.")
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return nil, webapi.BadRequest("INVALID_CODE_SCHEDULE", "Use RFC3339 dates.")
	}
	parsed = parsed.UTC()
	return &parsed, nil
}

func (a *API) createCode(response http.ResponseWriter, request *http.Request, current identity) error {
	var input createCodeRequest
	if err := webapi.DecodeJSON(response, request, 4096, &input); err != nil {
		return err
	}
	if input.TTLSeconds < 0 || input.TTLSeconds > 30*24*3600 ||
		(input.ExpiresAt != "" && input.TTLSeconds != 0) {
		return webapi.BadRequest("INVALID_CODE_SCHEDULE", "Use either ttlSeconds or expiresAt.")
	}
	notBefore, err := parseCodeTime(input.NotBefore)
	if err != nil {
		return err
	}
	expiresAt, err := parseCodeTime(input.ExpiresAt)
	if err != nil {
		return err
	}
	scope, err := auth.AdminCodeCreateAuthorizationScope(input.Kind, input.TargetUserID,
		input.NotBefore, input.ExpiresAt, input.TTLSeconds)
	if err != nil {
		return err
	}
	if err := a.consumeAdminAuthorization(request, current, scope); err != nil {
		return err
	}
	created, err := a.admin.CreateCode(request.Context(), currentAdminAuthority(current), admin.CodeCreateInput{
		Kind: input.Kind, TargetUserID: input.TargetUserID, NotBefore: notBefore, ExpiresAt: expiresAt,
		TTL: time.Duration(input.TTLSeconds) * time.Second,
	})
	if err != nil {
		return err
	}
	response.Header().Set("Cache-Control", "no-store")
	webapi.WriteJSON(response, http.StatusCreated, map[string]any{
		"id": created.Invitation.ID, "code": created.Code, "kind": created.Invitation.Kind,
		"targetUserId": created.Invitation.TargetUserID, "notBefore": created.Invitation.NotBefore,
		"expiresAt": created.Invitation.ExpiresAt,
	})
	return nil
}
