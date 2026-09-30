package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Tularity/t-lingual/internal/auth"
	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/sharing"
	"github.com/Tularity/t-lingual/internal/store"
	"github.com/Tularity/t-lingual/internal/webapi"
)

func userViewer(current identity) domain.Viewer {
	return domain.Viewer{ID: "user:" + current.User.ID, UserID: current.User.ID, BrowserSessionID: current.Session.ID, DisplayName: current.User.DisplayName}
}
func (a *API) guestCookieName() string { return a.config.SessionCookieName + "_guest" }

// Viewing authenticates either a passkey browser session or a redeemed link.
// Guest credentials never enter the account/admin authentication middleware.
func (a *API) viewing(handler func(http.ResponseWriter, *http.Request, domain.Viewer) error, streaming bool) http.HandlerFunc {
	return a.public(func(w http.ResponseWriter, r *http.Request) error {
		if a.sharing == nil {
			return store.ErrNotFound
		}
		release, rejection := a.authenticatedAdmission.acquireClient(authRateKey(a.clientAddress(r)))
		if rejection != authenticatedAdmitted {
			return authenticatedAdmissionError(w, rejection)
		}
		defer release()
		var viewer domain.Viewer
		if cookie, err := r.Cookie(a.config.SessionCookieName); err == nil && cookie.Value != "" {
			user, session, authErr := a.authenticateSession(r.Context(), cookie.Value)
			if authErr == nil {
				viewer = userViewer(identity{User: user, Session: session})
				// A signed-in recipient may use a link grant without a direct user share.
				if sessionID := r.PathValue("sessionID"); sessionID != "" {
					if _, err := a.sharing.Resolve(r.Context(), viewer, sessionID); err != nil {
						if guestCookie, err := r.Cookie(a.guestCookieName()); err == nil {
							if guest, err := a.sharing.AuthenticateGuest(r.Context(), guestCookie.Value); err == nil {
								viewer = guest
								viewer.UserID = user.ID
								viewer.BrowserSessionID = session.ID
							}
						}
					}
				}
			} else if !errors.Is(authErr, auth.ErrUnauthenticated) && !errors.Is(authErr, errUnauthenticated) {
				return authErr
			}
			// Expired/revoked account cookies must not block a separately valid
			// link credential. The fallback carries no account identity or rights.
		}
		if viewer.ID == "" {
			cookie, err := r.Cookie(a.guestCookieName())
			if err != nil || cookie.Value == "" {
				return errUnauthenticated
			}
			viewer, err = a.sharing.AuthenticateGuest(r.Context(), cookie.Value)
			if err != nil {
				return store.ErrNotFound
			}
		}
		if streaming {
			release()
		} else {
			userRelease, rejected := a.authenticatedAdmission.acquireUser(viewer.ID)
			if rejected != authenticatedAdmitted {
				return authenticatedAdmissionError(w, rejected)
			}
			defer userRelease()
		}
		return handler(w, r, viewer)
	})
}

func accessJSON(access domain.SessionAccess) map[string]any {
	return map[string]any{"viewerId": access.Viewer.ID, "displayName": access.Viewer.DisplayName, "isOwner": access.IsOwner, "permission": access.Permission, "targetLanguage": access.TargetLanguage}
}
func sessionJSON(access domain.SessionAccess) map[string]any {
	session := access.Session
	session.TargetLanguage = access.TargetLanguage
	result := map[string]any{"id": session.ID, "title": session.Title, "sourceLanguage": session.SourceLanguage, "targetLanguage": session.TargetLanguage, "status": session.Status, "createdAt": session.CreatedAt, "updatedAt": session.UpdatedAt, "startedAt": session.StartedAt, "endedAt": session.EndedAt, "archivedAt": session.ArchivedAt, "archiveReason": session.ArchiveReason, "recognitionLanguages": session.RecognitionLanguages, "diarization": session.Diarization, "isOwner": access.IsOwner, "permission": access.Permission}
	// Where a session is kept is the owner's own organisation.
	if access.IsOwner {
		result["workspaceId"] = session.WorkspaceID
	}
	return result
}

// sharedOnly lists only what others have shared with the viewer.
var sharedOnly = store.AccessibleSessionFilter{SharedOnly: true}

func (a *API) listViewedSessions(w http.ResponseWriter, r *http.Request, viewer domain.Viewer) error {
	limit, offset, err := pagination(r, 50)
	if err != nil {
		return err
	}
	var filter store.AccessibleSessionFilter
	query := r.URL.Query()
	if workspaceID := strings.TrimSpace(query.Get("workspace")); workspaceID != "" {
		if viewer.UserID == "" {
			return store.ErrNotFound
		}
		filter.WorkspaceID = workspaceID
	} else if query.Get("shared") == "true" {
		filter.SharedOnly = true
	}
	items, err := a.sharing.ListAccessibleSessionsIn(r.Context(), viewer, filter, limit, offset)
	if err != nil {
		return err
	}
	result := make([]map[string]any, 0, len(items))
	for _, item := range items {
		result = append(result, sessionJSON(item))
	}
	webapi.WriteJSON(w, 200, map[string]any{"items": result, "limit": limit, "offset": offset})
	return nil
}
func (a *API) getViewedSession(w http.ResponseWriter, r *http.Request, viewer domain.Viewer) error {
	id := r.PathValue("sessionID")
	access, err := a.sharing.Resolve(r.Context(), viewer, id)
	if err != nil {
		return err
	}
	page, err := a.rooms.SegmentWindow(r.Context(), viewer, id, store.SegmentPageQuery{Mode: store.SegmentPageAfter, Sequence: -1, Limit: 40})
	if err != nil {
		return err
	}
	gaps, err := a.rooms.Gaps(r.Context(), access)
	if err != nil {
		return err
	}
	webapi.WriteJSON(w, 200, map[string]any{"session": sessionJSON(access), "segments": page.Items, "segmentPage": map[string]any{"hasMore": page.HasMore, "nextAfter": page.NextAfter, "limit": 40}, "access": accessJSON(access), "recording": a.rooms.State(id, viewer), "presence": a.rooms.Presence(id, access.Viewer), "recognitionGaps": gaps, "translationConfigured": a.providers != nil && a.providers.Snapshot().Translator != nil})
	return nil
}
func (a *API) viewedSegments(w http.ResponseWriter, r *http.Request, viewer domain.Viewer) error {
	query, err := segmentWindowQuery(r, 40)
	if err != nil {
		return err
	}
	var page store.SegmentPage
	if raw := r.URL.Query().Get("atMs"); raw != "" {
		at, parseErr := strconv.ParseInt(raw, 10, 64)
		if parseErr != nil || at < 0 || at > 315360000000 || len(r.URL.Query()["atMs"]) != 1 || r.URL.Query().Has("before") || r.URL.Query().Has("after") || r.URL.Query().Has("tail") {
			return webapi.BadRequest("INVALID_POSITION", "Choose a valid audio position.")
		}
		access, accessErr := a.sharing.Resolve(r.Context(), viewer, r.PathValue("sessionID"))
		if accessErr != nil {
			return accessErr
		}
		page, err = a.store.SegmentWindowAtTime(r.Context(), access.Session.UserID, access.Session.ID, at, query.Limit)
		if err == nil {
			page.Items, err = a.rooms.PresentSegments(r.Context(), access, page.Items)
		}
	} else {
		page, err = a.rooms.SegmentWindow(r.Context(), viewer, r.PathValue("sessionID"), query)
	}
	if err != nil {
		return err
	}
	webapi.WriteJSON(w, 200, map[string]any{"items": page.Items, "nextAfter": page.NextAfter, "hasMore": page.HasMore, "limit": query.Limit, "hasEarlier": page.HasEarlier, "hasLater": page.HasLater, "firstSequence": page.FirstSequence, "lastSequence": page.LastSequence})
	return nil
}
func (a *API) setViewerLanguage(w http.ResponseWriter, r *http.Request, viewer domain.Viewer) error {
	var input struct {
		TargetLanguage string `json:"targetLanguage"`
	}
	if err := webapi.DecodeJSON(w, r, 1024, &input); err != nil {
		return err
	}
	access, err := a.sharing.SetTargetLanguage(r.Context(), viewer, r.PathValue("sessionID"), input.TargetLanguage)
	if err != nil {
		return err
	}
	a.rooms.AccessChanged(access.Session.ID)
	webapi.WriteJSON(w, 200, accessJSON(access))
	return nil
}
func (a *API) watchSession(w http.ResponseWriter, r *http.Request, viewer domain.Viewer) error {
	return a.rooms.ServeWatch(w, r, viewer, r.PathValue("sessionID"))
}
func (a *API) recordSession(w http.ResponseWriter, r *http.Request, viewer domain.Viewer) error {
	if err := webapi.CheckWebSocketOrigin(r, a.config.RPOrigins); err != nil {
		return err
	}
	return a.rooms.ServeRecord(w, r, viewer, r.PathValue("sessionID"), r.URL.Query().Get("takeover") == "true")
}
func (a *API) stopRecorder(w http.ResponseWriter, r *http.Request, viewer domain.Viewer) error {
	if err := a.rooms.StopRecorder(r.Context(), viewer, r.PathValue("sessionID")); err != nil {
		return err
	}
	webapi.WriteJSON(w, 204, nil)
	return nil
}

func (a *API) shareJSON(r *http.Request, owner string, item domain.SessionShare) (map[string]any, error) {
	result := map[string]any{"id": item.ID, "sessionId": item.SessionID, "type": item.Kind, "permission": item.Permission, "createdAt": item.CreatedAt, "expiresAt": item.ExpiresAt, "revokedAt": item.RevokedAt}
	if item.RecipientUserID != nil {
		result["userId"] = *item.RecipientUserID
		if user, err := a.store.GetUserByID(r.Context(), *item.RecipientUserID); err == nil {
			result["displayName"] = user.DisplayName
			result["avatarVersion"] = user.AvatarVersion
		}
	}
	if item.Kind == domain.ShareLink {
		result["audience"] = item.Audience
		members, err := a.sharing.Members(r.Context(), owner, item.SessionID, item.ID)
		if err != nil {
			return nil, err
		}
		people := make([]map[string]any, 0, len(members))
		for _, member := range members {
			people = append(people, personJSON(member))
		}
		result["members"] = people
	}
	if item.Kind == domain.ShareLink && item.RevokedAt == nil && (item.ExpiresAt == nil || item.ExpiresAt.After(time.Now())) {
		token, err := a.sharing.LinkToken(r.Context(), owner, item.SessionID, item.ID)
		if err != nil {
			return nil, err
		}
		result["token"] = token
	}
	return result, nil
}
func (a *API) listShares(w http.ResponseWriter, r *http.Request, current identity) error {
	items, err := a.sharing.List(r.Context(), current.User.ID, r.PathValue("sessionID"))
	if err != nil {
		return err
	}
	result := make([]map[string]any, 0, len(items))
	for _, item := range items {
		value, err := a.shareJSON(r, current.User.ID, item)
		if err != nil {
			return err
		}
		result = append(result, value)
	}
	webapi.WriteJSON(w, 200, map[string]any{"items": result})
	return nil
}

// personJSON is how one person is shown to another: a name and a picture.
func personJSON(user domain.User) map[string]any {
	return map[string]any{"id": user.ID, "username": user.Username, "displayName": user.DisplayName, "avatarVersion": user.AvatarVersion}
}

func (a *API) createShare(w http.ResponseWriter, r *http.Request, current identity) error {
	var input struct {
		Type       domain.ShareKind       `json:"type"`
		Audience   domain.ShareAudience   `json:"audience"`
		UserID     string                 `json:"userId"`
		Permission domain.SharePermission `json:"permission"`
		ExpiresAt  *time.Time             `json:"expiresAt"`
	}
	if err := webapi.DecodeJSON(w, r, 4096, &input); err != nil {
		return err
	}
	created, err := a.sharing.Create(r.Context(), current.User.ID, r.PathValue("sessionID"), sharing.CreateInput{Kind: input.Type, Audience: input.Audience, RecipientUserID: input.UserID, Permission: input.Permission, ExpiresAt: input.ExpiresAt})
	if err != nil {
		return err
	}
	value, err := a.shareJSON(r, current.User.ID, created.Share)
	if err != nil {
		return err
	}
	webapi.WriteJSON(w, 201, value)
	return nil
}
func (a *API) updateShare(w http.ResponseWriter, r *http.Request, current identity) error {
	var input sharing.UpdateInput
	if err := webapi.DecodeJSON(w, r, 4096, &input); err != nil {
		return err
	}
	value, err := a.sharing.Update(r.Context(), current.User.ID, r.PathValue("sessionID"), r.PathValue("shareID"), input)
	if err != nil {
		return err
	}
	a.rooms.AccessChanged(value.SessionID)
	result, err := a.shareJSON(r, current.User.ID, value)
	if err != nil {
		return err
	}
	webapi.WriteJSON(w, 200, result)
	return nil
}
func (a *API) revokeShare(w http.ResponseWriter, r *http.Request, current identity) error {
	value, err := a.sharing.Revoke(r.Context(), current.User.ID, r.PathValue("sessionID"), r.PathValue("shareID"))
	if err != nil {
		return err
	}
	a.rooms.AccessChanged(value.SessionID)
	webapi.WriteJSON(w, 204, nil)
	return nil
}
func (a *API) shareRecipients(w http.ResponseWriter, r *http.Request, current identity) error {
	users, err := a.sharing.SearchUsers(r.Context(), current.User.ID, r.URL.Query().Get("q"))
	if err != nil {
		return err
	}
	result := make([]map[string]any, 0, len(users))
	for _, user := range users {
		result = append(result, personJSON(user))
	}
	webapi.WriteJSON(w, 200, map[string]any{"items": result})
	return nil
}
func (a *API) redeemShare(w http.ResponseWriter, r *http.Request) error {
	if allowed, _ := a.registrationLimiter.Allow(authRateKey(a.clientAddress(r)), time.Now()); !allowed {
		return &webapi.Error{Status: 429, Code: "RATE_LIMITED", Message: "Try again shortly."}
	}
	var input struct {
		Token    string `json:"token"`
		Language string `json:"language"`
	}
	if err := webapi.DecodeJSON(w, r, 2048, &input); err != nil {
		return err
	}
	result, err := a.sharing.Redeem(r.Context(), input.Token, "Guest", input.Language)
	if err != nil {
		return err
	}
	cookie := &http.Cookie{Name: a.guestCookieName(), Value: result.CookieToken, Path: "/api/v1", HttpOnly: true, Secure: a.config.CookieSecure, SameSite: http.SameSiteStrictMode, Expires: result.Guest.ExpiresAt}
	// Browsers require Path=/ (and no Domain) for every __Host- cookie.
	// The guest name inherits this prefix from the production account cookie.
	if strings.HasPrefix(cookie.Name, "__Host-") {
		cookie.Path = "/"
	}
	http.SetCookie(w, cookie)
	webapi.WriteJSON(w, 200, map[string]string{"sessionId": result.Guest.SessionID})
	return nil
}

// joinShare lets the signed-in caller in through a link as themselves.
func (a *API) joinShare(w http.ResponseWriter, r *http.Request, current identity) error {
	var input struct {
		Token string `json:"token"`
	}
	if err := webapi.DecodeJSON(w, r, 2048, &input); err != nil {
		return err
	}
	sessionID, err := a.sharing.Join(r.Context(), current.User.ID, input.Token)
	if err != nil {
		return err
	}
	webapi.WriteJSON(w, 200, map[string]string{"sessionId": sessionID})
	return nil
}
