package api

import (
	"net/http"
	"strings"
	"time"

	"github.com/Tularity/t-lingual/internal/admin"
	"github.com/Tularity/t-lingual/internal/auth"
	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/webapi"
)

func (a *API) listInvitations(response http.ResponseWriter, request *http.Request, current identity) error {
	limit, offset, err := pagination(request, 50)
	if err != nil {
		return err
	}
	items, err := a.admin.ListInvitations(request.Context(), currentAdminAuthority(current), limit, offset)
	if err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusOK, map[string]any{"items": items, "offset": offset, "limit": limit})
	return nil
}

type createInvitationRequest struct {
	ExpiresInHours int `json:"expiresInHours,omitempty"`
}

func (a *API) createInvitation(response http.ResponseWriter, request *http.Request, current identity) error {
	var input createInvitationRequest
	if request.ContentLength != 0 {
		if err := webapi.DecodeJSON(response, request, 4096, &input); err != nil {
			return err
		}
	}
	var ttl time.Duration
	if input.ExpiresInHours != 0 {
		if input.ExpiresInHours < 1 || input.ExpiresInHours > 720 {
			return webapi.BadRequest("INVALID_EXPIRY", "expiresInHours must be between 1 and 720.")
		}
		ttl = time.Duration(input.ExpiresInHours) * time.Hour
	}
	scope, err := auth.AdminInvitationCreateAuthorizationScope(input.ExpiresInHours)
	if err != nil {
		return err
	}
	if err := a.consumeAdminAuthorization(request, current, scope); err != nil {
		return err
	}
	created, err := a.admin.CreateInvitation(request.Context(), currentAdminAuthority(current), ttl)
	if err != nil {
		return err
	}
	response.Header().Set("Cache-Control", "no-store")
	webapi.WriteJSON(response, http.StatusCreated, created)
	return nil
}

func (a *API) revokeInvitation(response http.ResponseWriter, request *http.Request, current identity) error {
	if request.ContentLength != 0 {
		var empty struct{}
		if err := webapi.DecodeJSON(response, request, 1024, &empty); err != nil {
			return err
		}
	}
	invitationID := request.PathValue("invitationID")
	scope, err := auth.AdminInvitationRevokeAuthorizationScope(invitationID)
	if err != nil {
		return err
	}
	if err := a.consumeAdminAuthorization(request, current, scope); err != nil {
		return err
	}
	if err := a.admin.RevokeInvitation(
		request.Context(), currentAdminAuthority(current), invitationID,
	); err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusNoContent, nil)
	return nil
}

func (a *API) listUsers(response http.ResponseWriter, request *http.Request, current identity) error {
	limit, offset, err := pagination(request, 50)
	if err != nil {
		return err
	}
	items, err := a.admin.ListUsers(request.Context(), currentAdminAuthority(current), limit, offset)
	if err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusOK, map[string]any{"items": items, "offset": offset, "limit": limit})
	return nil
}

type updateUserRequest struct {
	Role   *domain.Role       `json:"role,omitempty"`
	Status *domain.UserStatus `json:"status,omitempty"`
}

func (a *API) updateUser(response http.ResponseWriter, request *http.Request, current identity) error {
	var input updateUserRequest
	if err := webapi.DecodeJSON(response, request, 4096, &input); err != nil {
		return err
	}
	if input.Role == nil && input.Status == nil {
		return webapi.BadRequest("EMPTY_UPDATE", "Provide role or status.")
	}
	if input.Role != nil && !input.Role.Valid() {
		return webapi.BadRequest("INVALID_ROLE", "role must be user or admin.")
	}
	if input.Status != nil && *input.Status != domain.UserActive && *input.Status != domain.UserDisabled {
		return webapi.BadRequest("INVALID_STATUS", "status must be active or disabled.")
	}
	userID := request.PathValue("userID")
	scope, err := auth.AdminUserUpdateAuthorizationScope(userID, input.Role, input.Status)
	if err != nil {
		return err
	}
	if err := a.consumeAdminAuthorization(request, current, scope); err != nil {
		return err
	}
	updated, err := a.admin.UpdateUser(request.Context(), currentAdminAuthority(current), userID, admin.UserUpdate{
		Role: input.Role, Status: input.Status,
	})
	if err != nil {
		return err
	}
	if updated.Status == domain.UserDisabled || updated.PromotedToAdmin {
		if a.live != nil {
			a.live.RevokeUser(userID)
		}
	}
	webapi.WriteJSON(response, http.StatusOK, updated.User)
	return nil
}

func (a *API) consumeAdminAuthorization(request *http.Request, current identity, scope string) error {
	token := strings.TrimSpace(request.Header.Get(passkeyAuthorizationHeader))
	if token == "" {
		return auth.ErrInvalidAuthorization
	}
	return a.auth.ConsumeCredentialAuthorization(
		request.Context(), current.User.ID, current.Session.ID, token, scope,
	)
}

// currentAdminAuthority is captured immediately before the service call. The
// store rechecks this exact browser session in the same transaction as every
// administrative read or mutation.
func currentAdminAuthority(current identity) admin.WebAuthority {
	return admin.WebAuthority{
		UserID:           current.User.ID,
		BrowserSessionID: current.Session.ID,
		CheckedAt:        time.Now().UTC(),
	}
}

func (a *API) listAudit(response http.ResponseWriter, request *http.Request, current identity) error {
	limit, offset, err := pagination(request, 50)
	if err != nil {
		return err
	}
	items, err := a.admin.ListAuditEvents(request.Context(), currentAdminAuthority(current), limit, offset)
	if err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusOK, map[string]any{"items": items, "offset": offset, "limit": limit})
	return nil
}
