package api

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/store"
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
	sessionID := request.PathValue("sessionID")
	remove := func(ctx context.Context) error { return a.workspace.Delete(ctx, current.User.ID, sessionID) }
	if a.media != nil && a.rooms != nil {
		_, err := a.rooms.UpdateIdleSession(request.Context(), userViewer(current), sessionID, func(access domain.SessionAccess) (domain.InterpretationSession, error) {
			err := a.media.DeleteSessionWithMedia(request.Context(), current.User.ID, sessionID, remove)
			return access.Session, err
		})
		if err != nil {
			return err
		}
	} else if err := remove(request.Context()); err != nil {
		return err
	}
	if a.rooms != nil {
		a.rooms.AccessChanged(sessionID)
	}
	webapi.WriteJSON(response, http.StatusNoContent, nil)
	return nil
}

func (a *API) archiveSession(response http.ResponseWriter, request *http.Request, current identity) error {
	session, err := a.workspace.Archive(request.Context(), current.User.ID, request.PathValue("sessionID"))
	if err != nil {
		return err
	}
	if a.rooms != nil {
		a.rooms.AccessChanged(session.ID)
	}
	webapi.WriteJSON(response, http.StatusOK, session)
	return nil
}

func (a *API) unarchiveSession(response http.ResponseWriter, request *http.Request, current identity) error {
	session, err := a.workspace.Unarchive(request.Context(), current.User.ID, request.PathValue("sessionID"))
	if err != nil {
		return err
	}
	if a.rooms != nil {
		a.rooms.AccessChanged(session.ID)
	}
	webapi.WriteJSON(response, http.StatusOK, session)
	return nil
}

func (a *API) listSegments(response http.ResponseWriter, request *http.Request, current identity) error {
	query, err := segmentWindowQuery(request, 100)
	if err != nil {
		return err
	}
	page, err := a.workspace.SegmentWindow(
		request.Context(), current.User.ID, request.PathValue("sessionID"), query,
	)
	if err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusOK, map[string]any{
		"items": page.Items, "nextAfter": page.NextAfter, "hasMore": page.HasMore, "limit": query.Limit,
		"hasEarlier": page.HasEarlier, "hasLater": page.HasLater,
		"firstSequence": page.FirstSequence, "lastSequence": page.LastSequence,
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
	var input struct {
		domain.UserSettings
		AutoArchiveHours  *int    `json:"autoArchiveHours"`
		InterfaceLanguage *string `json:"interfaceLanguage"`
		ThemePreference   *string `json:"themePreference"`
	}
	if err := webapi.DecodeJSON(response, request, a.config.MaxJSONBytes, &input); err != nil {
		return err
	}
	if input.AutoArchiveHours == nil {
		currentSettings, err := a.workspace.Settings(request.Context(), current.User.ID)
		if err != nil {
			return err
		}
		input.UserSettings.AutoArchiveHours = currentSettings.AutoArchiveHours
	}
	if input.AutoArchiveHours != nil {
		input.UserSettings.AutoArchiveHours = *input.AutoArchiveHours
	}
	if input.InterfaceLanguage != nil {
		input.UserSettings.InterfaceLanguage = *input.InterfaceLanguage
	}
	if input.ThemePreference != nil {
		input.UserSettings.ThemePreference = *input.ThemePreference
	}
	updated, err := a.workspace.UpdateSettings(request.Context(), current.User.ID, input.UserSettings)
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

func segmentWindowQuery(request *http.Request, defaultLimit int) (store.SegmentPageQuery, error) {
	query := store.SegmentPageQuery{Mode: store.SegmentPageAfter, Sequence: -1, Limit: defaultLimit}
	values := request.URL.Query()
	for _, key := range []string{"limit", "after", "before", "tail", "search"} {
		if len(values[key]) > 1 {
			return query, webapi.BadRequest("INVALID_PAGINATION", "Pagination parameters must appear once.")
		}
	}
	if raw, present := values["limit"]; present {
		limit, err := strconv.Atoi(raw[0])
		if err != nil || limit < 1 || limit > 200 {
			return query, webapi.BadRequest("INVALID_PAGINATION", "limit must be between 1 and 200.")
		}
		query.Limit = limit
	}
	_, afterPresent := values["after"]
	_, beforePresent := values["before"]
	_, tailPresent := values["tail"]
	if tailPresent && values.Get("tail") != "true" && values.Get("tail") != "false" {
		return query, webapi.BadRequest("INVALID_PAGINATION", "tail must be true or false.")
	}
	tail := tailPresent && values.Get("tail") == "true"
	if (afterPresent && beforePresent) || (tail && (afterPresent || beforePresent)) {
		return query, webapi.BadRequest("INVALID_PAGINATION", "Use only one of after, before, or tail=true.")
	}
	if afterPresent || beforePresent {
		key := "after"
		if beforePresent {
			key = "before"
			query.Mode = store.SegmentPageBefore
		}
		sequence, err := strconv.ParseInt(values.Get(key), 10, 64)
		if err != nil || sequence < 0 {
			return query, webapi.BadRequest("INVALID_PAGINATION", key+" must be a non-negative segment sequence.")
		}
		query.Sequence = sequence
	} else if tail {
		query.Mode = store.SegmentPageTail
		query.Sequence = 0
	}
	if raw, present := values["search"]; present {
		search := raw[0]
		if len(search) > 512 || !utf8.ValidString(search) || utf8.RuneCountInString(search) > 120 {
			return query, webapi.BadRequest("INVALID_PAGINATION", "search must be at most 120 characters and 512 bytes.")
		}
		for _, character := range search {
			if unicode.IsControl(character) {
				return query, webapi.BadRequest("INVALID_PAGINATION", "search cannot contain control characters.")
			}
		}
		query.Search = search
	}
	return query, nil
}
