package api

import (
	"net/http"
	"strings"
	"time"

	"github.com/Tularity/t-lingual/internal/auth"
	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/webapi"
)

type browserSessionResponse struct {
	ID        string    `json:"id"`
	CreatedAt time.Time `json:"createdAt"`
	ExpiresAt time.Time `json:"expiresAt"`
	LastSeen  time.Time `json:"lastSeen"`
	UserAgent string    `json:"userAgent"`
	IPAddress string    `json:"ipAddress"`
	Current   bool      `json:"current"`
}

func browserSessionPayload(session domain.BrowserSession, currentBrowserSessionID string) browserSessionResponse {
	return browserSessionResponse{
		ID: session.ID, CreatedAt: session.CreatedAt, ExpiresAt: session.ExpiresAt,
		LastSeen: session.LastSeen, UserAgent: session.UserAgent, IPAddress: session.IPAddress,
		Current: session.ID == currentBrowserSessionID,
	}
}

func (a *API) listBrowserSessions(
	response http.ResponseWriter,
	request *http.Request,
	current identity,
) error {
	sessions, err := a.auth.ListBrowserSessions(request.Context(), current.User.ID)
	if err != nil {
		return err
	}
	items := make([]browserSessionResponse, 0, len(sessions))
	for _, session := range sessions {
		items = append(items, browserSessionPayload(session, current.Session.ID))
	}
	webapi.WriteJSON(response, http.StatusOK, map[string]any{"items": items})
	return nil
}

func (a *API) deleteBrowserSession(
	response http.ResponseWriter,
	request *http.Request,
	current identity,
) error {
	browserSessionID := strings.TrimSpace(request.PathValue("browserSessionID"))
	authorizationToken := strings.TrimSpace(request.Header.Get(passkeyAuthorizationHeader))
	if browserSessionID != current.Session.ID && authorizationToken == "" {
		return auth.ErrInvalidAuthorization
	}
	if err := a.auth.RevokeBrowserSession(
		request.Context(), current.User.ID, current.Session.ID,
		browserSessionID, authorizationToken,
	); err != nil {
		return err
	}
	if a.live != nil {
		a.live.RevokeBrowserSession(browserSessionID)
	}
	if browserSessionID == current.Session.ID {
		a.clearSessionCookie(response)
	}
	webapi.WriteJSON(response, http.StatusNoContent, nil)
	return nil
}

func (a *API) revokeOtherBrowserSessions(
	response http.ResponseWriter,
	request *http.Request,
	current identity,
) error {
	authorizationToken := strings.TrimSpace(request.Header.Get(passkeyAuthorizationHeader))
	if authorizationToken == "" {
		return auth.ErrInvalidAuthorization
	}
	deleted, err := a.auth.RevokeOtherBrowserSessions(
		request.Context(), current.User.ID, current.Session.ID, authorizationToken,
	)
	if err != nil {
		return err
	}
	if a.live != nil {
		for _, browserSessionID := range deleted {
			a.live.RevokeBrowserSession(browserSessionID)
		}
	}
	webapi.WriteJSON(response, http.StatusOK, map[string]any{"revoked": len(deleted)})
	return nil
}
