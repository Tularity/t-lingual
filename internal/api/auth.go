package api

import (
	"encoding/base64"
	"net/http"
	"strings"
	"time"

	"github.com/Tularity/t-lingual/internal/auth"
	"github.com/Tularity/t-lingual/internal/webapi"
)

const (
	ceremonyHeader             = "X-WebAuthn-Ceremony"
	passkeyAuthorizationHeader = "X-Passkey-Authorization"
)

type beginRegistrationRequest struct {
	InvitationCode string `json:"invitationCode"`
	Username       string `json:"username"`
	DisplayName    string `json:"displayName"`
	CredentialName string `json:"credentialName,omitempty"`
}

func (a *API) beginRegistration(response http.ResponseWriter, request *http.Request) error {
	if err := a.rateLimitAuth(response, request, authRegistration); err != nil {
		return err
	}
	var input beginRegistrationRequest
	if err := webapi.DecodeJSON(response, request, a.config.MaxJSONBytes, &input); err != nil {
		return err
	}
	result, err := a.auth.BeginRegistration(request.Context(), auth.RegistrationInput{
		InvitationCode: input.InvitationCode,
		Username:       input.Username,
		DisplayName:    input.DisplayName,
		CredentialName: input.CredentialName,
	})
	if err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusOK, map[string]any{
		"ceremonyToken": result.CeremonyToken,
		"expiresAt":     result.ExpiresAt,
		"options":       result.Options,
	})
	return nil
}

func (a *API) finishRegistration(response http.ResponseWriter, request *http.Request) error {
	if err := a.rateLimitAuth(response, request, authRegistration); err != nil {
		return err
	}
	return a.finishAuthentication(response, request, true)
}

func (a *API) beginLogin(response http.ResponseWriter, request *http.Request) error {
	if err := a.rateLimitAuth(response, request, authLogin); err != nil {
		return err
	}
	if request.ContentLength > 0 {
		var empty struct{}
		if err := webapi.DecodeJSON(response, request, 1024, &empty); err != nil {
			return err
		}
	}
	result, err := a.auth.BeginLogin(request.Context())
	if err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusOK, map[string]any{
		"ceremonyToken": result.CeremonyToken,
		"expiresAt":     result.ExpiresAt,
		"options":       result.Options,
	})
	return nil
}

func (a *API) finishLogin(response http.ResponseWriter, request *http.Request) error {
	if err := a.rateLimitAuth(response, request, authLogin); err != nil {
		return err
	}
	return a.finishAuthentication(response, request, false)
}

func (a *API) finishAuthentication(response http.ResponseWriter, request *http.Request, registration bool) error {
	ceremonyToken := strings.TrimSpace(request.Header.Get(ceremonyHeader))
	if ceremonyToken == "" {
		return webapi.BadRequest("CEREMONY_REQUIRED", "The passkey ceremony token is required.")
	}
	if contentType := strings.ToLower(strings.TrimSpace(strings.Split(request.Header.Get("Content-Type"), ";")[0])); contentType != "application/json" {
		return &webapi.Error{Status: http.StatusUnsupportedMediaType, Code: "UNSUPPORTED_MEDIA_TYPE", Message: "Content-Type must be application/json."}
	}
	request.Body = http.MaxBytesReader(response, request.Body, a.config.MaxJSONBytes)
	metadata := auth.SessionMetadata{UserAgent: request.UserAgent(), IPAddress: a.clientAddress(request)}
	var result auth.LoginResult
	var err error
	if registration {
		result, err = a.auth.FinishRegistration(request.Context(), ceremonyToken, request, metadata)
	} else {
		result, err = a.auth.FinishLogin(request.Context(), ceremonyToken, request, metadata)
	}
	if err != nil {
		return err
	}
	a.setSessionCookie(response, result.SessionToken, result.Session.ExpiresAt)
	webapi.WriteJSON(response, http.StatusOK, map[string]any{
		"user": result.User,
		"session": map[string]any{
			"expiresAt": result.Session.ExpiresAt,
		},
	})
	return nil
}

func (a *API) me(response http.ResponseWriter, _ *http.Request, current identity) error {
	webapi.WriteJSON(response, http.StatusOK, map[string]any{
		"user": current.User,
		"session": map[string]any{
			"createdAt": current.Session.CreatedAt,
			"expiresAt": current.Session.ExpiresAt,
		},
	})
	return nil
}

func (a *API) logout(response http.ResponseWriter, request *http.Request, current identity) error {
	if err := a.auth.Logout(request.Context(), current.SessionToken); err != nil {
		return err
	}
	if a.live != nil {
		a.live.RevokeBrowserSession(current.Session.ID)
	}
	a.clearSessionCookie(response)
	webapi.WriteJSON(response, http.StatusNoContent, nil)
	return nil
}

type beginPasskeyRequest struct {
	Name string `json:"name"`
}

type beginPasskeyAuthorizationRequest struct {
	Scope string `json:"scope,omitempty"`
}

func (a *API) listPasskeys(response http.ResponseWriter, request *http.Request, current identity) error {
	credentials, err := a.auth.ListCredentials(request.Context(), current.User.ID)
	if err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusOK, map[string]any{"items": credentials})
	return nil
}

func (a *API) beginPasskeyAuthorization(response http.ResponseWriter, request *http.Request, current identity) error {
	if err := a.rateLimitPasskey(response, current.User.ID); err != nil {
		return err
	}
	var input beginPasskeyAuthorizationRequest
	if request.ContentLength != 0 {
		if err := webapi.DecodeJSON(response, request, 1024, &input); err != nil {
			return err
		}
	}
	result, err := a.auth.BeginCredentialAuthorizationForScope(
		request.Context(), current.User.ID, current.Session.ID, input.Scope,
	)
	if err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusOK, map[string]any{
		"ceremonyToken": result.CeremonyToken,
		"expiresAt":     result.ExpiresAt,
		"options":       result.Options,
	})
	return nil
}

func (a *API) finishPasskeyAuthorization(response http.ResponseWriter, request *http.Request, current identity) error {
	if err := a.rateLimitPasskey(response, current.User.ID); err != nil {
		return err
	}
	ceremonyToken := strings.TrimSpace(request.Header.Get(ceremonyHeader))
	if ceremonyToken == "" {
		return webapi.BadRequest("CEREMONY_REQUIRED", "The passkey ceremony token is required.")
	}
	if contentType := strings.ToLower(strings.TrimSpace(strings.Split(request.Header.Get("Content-Type"), ";")[0])); contentType != "application/json" {
		return &webapi.Error{Status: http.StatusUnsupportedMediaType, Code: "UNSUPPORTED_MEDIA_TYPE", Message: "Content-Type must be application/json."}
	}
	request.Body = http.MaxBytesReader(response, request.Body, a.config.MaxJSONBytes)
	result, err := a.auth.FinishCredentialAuthorization(
		request.Context(), current.User.ID, current.Session.ID, ceremonyToken, request,
	)
	if err != nil {
		return err
	}
	response.Header().Set("Cache-Control", "no-store")
	webapi.WriteJSON(response, http.StatusOK, map[string]any{
		"authorizationToken": result.Token,
		"expiresAt":          result.ExpiresAt,
	})
	return nil
}

func (a *API) beginPasskey(response http.ResponseWriter, request *http.Request, current identity) error {
	if err := a.rateLimitPasskey(response, current.User.ID); err != nil {
		return err
	}
	authorizationToken := strings.TrimSpace(request.Header.Get(passkeyAuthorizationHeader))
	if authorizationToken == "" {
		return auth.ErrInvalidAuthorization
	}
	var input beginPasskeyRequest
	if err := webapi.DecodeJSON(response, request, 4096, &input); err != nil {
		return err
	}
	result, err := a.auth.BeginAddCredential(
		request.Context(), current.User.ID, current.Session.ID, authorizationToken, input.Name,
	)
	if err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusOK, map[string]any{
		"ceremonyToken": result.CeremonyToken,
		"expiresAt":     result.ExpiresAt,
		"options":       result.Options,
	})
	return nil
}

func (a *API) finishPasskey(response http.ResponseWriter, request *http.Request, current identity) error {
	if err := a.rateLimitPasskey(response, current.User.ID); err != nil {
		return err
	}
	ceremonyToken := strings.TrimSpace(request.Header.Get(ceremonyHeader))
	if ceremonyToken == "" {
		return webapi.BadRequest("CEREMONY_REQUIRED", "The passkey ceremony token is required.")
	}
	if contentType := strings.ToLower(strings.TrimSpace(strings.Split(request.Header.Get("Content-Type"), ";")[0])); contentType != "application/json" {
		return &webapi.Error{Status: http.StatusUnsupportedMediaType, Code: "UNSUPPORTED_MEDIA_TYPE", Message: "Content-Type must be application/json."}
	}
	request.Body = http.MaxBytesReader(response, request.Body, a.config.MaxJSONBytes)
	credential, err := a.auth.FinishAddCredential(
		request.Context(), current.User.ID, current.Session.ID, ceremonyToken, request,
	)
	if err != nil {
		return err
	}
	credential.ID = base64.RawURLEncoding.EncodeToString(credential.CredentialID)
	credential.CredentialID = nil
	credential.CredentialJSON = nil
	webapi.WriteJSON(response, http.StatusCreated, credential)
	return nil
}

func (a *API) deletePasskey(response http.ResponseWriter, request *http.Request, current identity) error {
	if err := a.rateLimitPasskey(response, current.User.ID); err != nil {
		return err
	}
	authorizationToken := strings.TrimSpace(request.Header.Get(passkeyAuthorizationHeader))
	if authorizationToken == "" {
		return auth.ErrInvalidAuthorization
	}
	if err := a.auth.DeleteCredential(
		request.Context(), current.User.ID, current.Session.ID,
		authorizationToken, request.PathValue("credentialID"),
	); err != nil {
		return err
	}
	if a.live != nil {
		a.live.RevokeUser(current.User.ID)
	}
	a.clearSessionCookie(response)
	webapi.WriteJSON(response, http.StatusNoContent, nil)
	return nil
}

func (a *API) setSessionCookie(response http.ResponseWriter, token string, expires time.Time) {
	maxAge := int(time.Until(expires).Seconds())
	if maxAge < 1 {
		maxAge = 1
	}
	http.SetCookie(response, &http.Cookie{
		Name:     a.config.SessionCookieName,
		Value:    token,
		Path:     "/",
		Expires:  expires,
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   a.config.CookieSecure,
		SameSite: http.SameSiteStrictMode,
	})
}

func (a *API) clearSessionCookie(response http.ResponseWriter) {
	http.SetCookie(response, &http.Cookie{
		Name:     a.config.SessionCookieName,
		Value:    "",
		Path:     "/",
		Expires:  time.Unix(1, 0),
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   a.config.CookieSecure,
		SameSite: http.SameSiteStrictMode,
	})
}
