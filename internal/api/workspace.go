package api

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/webapi"
	"github.com/Tularity/t-lingual/internal/workspace"
)

func (a *API) listSessions(response http.ResponseWriter, request *http.Request, current identity) error {
	limit, offset, err := pagination(request, 50)
	if err != nil {
		return err
	}
	var status *domain.InterpretationStatus
	if raw := strings.TrimSpace(request.URL.Query().Get("status")); raw != "" {
		parsed := domain.InterpretationStatus(raw)
		switch parsed {
		case domain.InterpretationCreated, domain.InterpretationLive, domain.InterpretationCompleted, domain.InterpretationFailed:
		default:
			return webapi.BadRequest("INVALID_STATUS", "status must be created, live, completed, or failed.")
		}
		status = &parsed
	}
	items, err := a.workspace.List(request.Context(), current.User.ID, status, limit, offset)
	if err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusOK, map[string]any{"items": items, "offset": offset, "limit": limit})
	return nil
}

func (a *API) createSession(response http.ResponseWriter, request *http.Request, current identity) error {
	var input workspace.CreateInput
	if err := webapi.DecodeJSON(response, request, a.config.MaxJSONBytes, &input); err != nil {
		return err
	}
	if err := a.rateLimitSessionCreate(response, current.User.ID); err != nil {
		return err
	}
	created, err := a.workspace.Create(request.Context(), current.User.ID, input)
	if err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusCreated, created)
	return nil
}

func (a *API) getSession(response http.ResponseWriter, request *http.Request, current identity) error {
	sessionID := request.PathValue("sessionID")
	session, err := a.workspace.Get(request.Context(), current.User.ID, sessionID)
	if err != nil {
		return err
	}
	page, err := a.workspace.SegmentPage(request.Context(), current.User.ID, sessionID, -1, 50)
	if err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusOK, map[string]any{
		"session":     session,
		"segments":    page.Items,
		"segmentPage": map[string]any{"nextAfter": page.NextAfter, "hasMore": page.HasMore, "limit": 50},
	})
	return nil
}

func (a *API) updateSession(response http.ResponseWriter, request *http.Request, current identity) error {
	var input workspace.UpdateInput
	if err := webapi.DecodeJSON(response, request, a.config.MaxJSONBytes, &input); err != nil {
		return err
	}
	updated, err := a.workspace.Update(request.Context(), current.User.ID, request.PathValue("sessionID"), input)
	if err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusOK, updated)
	return nil
}

func (a *API) deleteSession(response http.ResponseWriter, request *http.Request, current identity) error {
	if err := a.workspace.Delete(request.Context(), current.User.ID, request.PathValue("sessionID")); err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusNoContent, nil)
	return nil
}

func (a *API) listSegments(response http.ResponseWriter, request *http.Request, current identity) error {
	after, limit, err := segmentPagination(request, 100)
	if err != nil {
		return err
	}
	page, err := a.workspace.SegmentPage(
		request.Context(), current.User.ID, request.PathValue("sessionID"), after, limit,
	)
	if err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusOK, map[string]any{
		"items": page.Items, "nextAfter": page.NextAfter, "hasMore": page.HasMore, "limit": limit,
	})
	return nil
}

func (a *API) getSettings(response http.ResponseWriter, request *http.Request, current identity) error {
	settings, err := a.workspace.Settings(request.Context(), current.User.ID)
	if err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusOK, settings)
	return nil
}

func (a *API) updateSettings(response http.ResponseWriter, request *http.Request, current identity) error {
	var settings domain.UserSettings
	if err := webapi.DecodeJSON(response, request, a.config.MaxJSONBytes, &settings); err != nil {
		return err
	}
	updated, err := a.workspace.UpdateSettings(request.Context(), current.User.ID, settings)
	if err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusOK, updated)
	return nil
}

func (a *API) serveLive(response http.ResponseWriter, request *http.Request, current identity) error {
	if err := webapi.CheckWebSocketOrigin(request, a.config.RPOrigins); err != nil {
		return err
	}
	if a.live == nil {
		return &webapi.Error{Status: http.StatusServiceUnavailable, Code: "LIVE_UNAVAILABLE", Message: "Live interpretation is not configured."}
	}
	return a.live.ServeLive(response, request, current.User, current.Session, request.PathValue("sessionID"))
}

func pagination(request *http.Request, defaultLimit int) (int, int, error) {
	limit := defaultLimit
	offset := 0
	var err error
	if raw := request.URL.Query().Get("limit"); raw != "" {
		limit, err = strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > 200 {
			return 0, 0, webapi.BadRequest("INVALID_PAGINATION", "limit must be between 1 and 200.")
		}
	}
	if raw := request.URL.Query().Get("offset"); raw != "" {
		offset, err = strconv.Atoi(raw)
		if err != nil || offset < 0 || offset > 1_000_000 {
			return 0, 0, webapi.BadRequest("INVALID_PAGINATION", "offset must be between 0 and 1000000.")
		}
	}
	return limit, offset, nil
}

func segmentPagination(request *http.Request, defaultLimit int) (int64, int, error) {
	limit := defaultLimit
	after := int64(-1)
	var err error
	if raw := request.URL.Query().Get("limit"); raw != "" {
		limit, err = strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > 200 {
			return 0, 0, webapi.BadRequest("INVALID_PAGINATION", "limit must be between 1 and 200.")
		}
	}
	if raw := request.URL.Query().Get("after"); raw != "" {
		after, err = strconv.ParseInt(raw, 10, 64)
		if err != nil || after < 0 {
			return 0, 0, webapi.BadRequest("INVALID_PAGINATION", "after must be a non-negative segment sequence.")
		}
	}
	return after, limit, nil
}
