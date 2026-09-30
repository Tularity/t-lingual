package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Tularity/t-lingual/internal/auth"
	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/id"
	"github.com/Tularity/t-lingual/internal/profile"
	"github.com/Tularity/t-lingual/internal/store"
	"github.com/Tularity/t-lingual/internal/webapi"
)

// maxAdminChangeBytes bounds a step-up-authorized change to an account.
const maxAdminChangeBytes = 16 << 10

// requireAdmin rechecks, from the durable records, that the caller is still
// an active administrator in this browser session.
func (a *API) requireAdmin(request *http.Request, current identity) error {
	return a.store.RequireActiveAdmin(request.Context(), current.User.ID, current.Session.ID, time.Now().UTC())
}

// authorizedChange reads a change to one account and consumes the passkey
// authorization given for exactly that change: the scope names the kind of
// change, the account and the SHA-256 of the body, so an authorization for
// one change can never carry another. The body is then decoded strictly.
func (a *API) authorizedChange(response http.ResponseWriter, request *http.Request, current identity, kind string, target any) (string, error) {
	userID := request.PathValue("userID")
	err := a.authorizedBody(response, request, current, func(digest string) (string, error) {
		return auth.AdminUserChangeAuthorizationScope(kind, userID, digest)
	}, target)
	return userID, err
}

// authorizedBody reads a request body, consumes the passkey authorization
// whose scope names that body's SHA-256, then decodes the body strictly.
func (a *API) authorizedBody(response http.ResponseWriter, request *http.Request, current identity,
	scopeOf func(digest string) (string, error), target any) error {
	raw, err := io.ReadAll(http.MaxBytesReader(response, request.Body, maxAdminChangeBytes))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return &webapi.Error{Status: http.StatusRequestEntityTooLarge, Code: "REQUEST_TOO_LARGE", Message: "The request body is too large.", Cause: err}
		}
		return webapi.BadRequest("INVALID_JSON", "The request body could not be read.")
	}
	digest := sha256.Sum256(raw)
	scope, err := scopeOf(hex.EncodeToString(digest[:]))
	if err != nil {
		return err
	}
	if err := a.consumeAdminAuthorization(request, current, scope); err != nil {
		return err
	}
	request.Body = io.NopCloser(bytes.NewReader(raw))
	if err := webapi.DecodeJSON(response, request, maxAdminChangeBytes, target); err != nil {
		return err
	}
	return nil
}

// adminAudit records who changed an account, and how.
func (a *API) adminAudit(ctx context.Context, current identity, action, userID string, metadata any) error {
	eventID, err := newAuditID()
	if err != nil {
		return err
	}
	encoded, err := jsonRaw(metadata)
	if err != nil {
		return err
	}
	actor := current.User.ID
	return a.store.AppendAuditEvent(ctx, store.AuditEvent{ID: eventID, ActorUserID: &actor, Action: action,
		TargetType: "user", TargetID: userID, Metadata: encoded, CreatedAt: time.Now().UTC()})
}

type limitsView struct {
	Effective domain.UserLimits     `json:"effective"`
	Overrides domain.LimitOverrides `json:"overrides"`
	Defaults  domain.UserLimits     `json:"defaults"`
}

func (a *API) limitsOf(ctx context.Context, userID string) (limitsView, error) {
	overrides, err := a.store.GetLimitOverrides(ctx, userID)
	if err != nil {
		return limitsView{}, err
	}
	defaults, err := a.store.DefaultLimits(ctx)
	if err != nil {
		return limitsView{}, err
	}
	return limitsView{Effective: overrides.Apply(defaults), Overrides: overrides, Defaults: defaults}, nil
}

// accountStanding is one account's use measured against its limits.
type accountStanding struct {
	MonthRecordedSeconds float64    `json:"monthRecordedSeconds"`
	StorageBytes         int64      `json:"storageBytes"`
	ActiveRecordings     int        `json:"activeRecordings"`
	Sessions             int        `json:"sessions"`
	Workspaces           int        `json:"workspaces"`
	LastSeen             *time.Time `json:"lastSeen"`
}

func (a *API) standingOf(ctx context.Context, userID string) (accountStanding, error) {
	month, err := a.store.RecordedMillisecondsSince(ctx, userID, store.MonthStart(time.Now()))
	if err != nil {
		return accountStanding{}, err
	}
	storage, err := a.store.StorageBytes(ctx, userID)
	if err != nil {
		return accountStanding{}, err
	}
	sessions, workspaces, lastSeen, err := a.store.AccountCounts(ctx, userID)
	if err != nil {
		return accountStanding{}, err
	}
	standing := accountStanding{MonthRecordedSeconds: float64(month) / 1000, StorageBytes: storage,
		Sessions: sessions, Workspaces: workspaces, LastSeen: lastSeen}
	if a.rooms != nil {
		standing.ActiveRecordings = a.rooms.OwnerRecordings(userID)
	}
	return standing, nil
}

// adminUserDetail is everything the people page's side panel shows.
func (a *API) adminUserDetail(response http.ResponseWriter, request *http.Request, current identity) error {
	if err := a.requireAdmin(request, current); err != nil {
		return err
	}
	userID := request.PathValue("userID")
	user, err := a.store.GetUserByID(request.Context(), userID)
	if err != nil {
		return err
	}
	limits, err := a.limitsOf(request.Context(), userID)
	if err != nil {
		return err
	}
	settings, err := a.workspace.Settings(request.Context(), userID)
	if err != nil {
		return err
	}
	standing, err := a.standingOf(request.Context(), userID)
	if err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusOK, map[string]any{"user": user, "limits": limits, "settings": settings, "standing": standing})
	return nil
}

// setUserLimits sets an account apart from the default limits, or back.
func (a *API) setUserLimits(response http.ResponseWriter, request *http.Request, current identity) error {
	var overrides domain.LimitOverrides
	userID, err := a.authorizedChange(response, request, current, "limits", &overrides)
	if err != nil {
		return err
	}
	if !overrides.Valid() {
		return &webapi.Error{Status: http.StatusUnprocessableEntity, Code: "INVALID_LIMITS", Message: "Choose limits within the allowed range."}
	}
	eventID, err := newAuditID()
	if err != nil {
		return err
	}
	metadata, err := jsonRaw(overrides)
	if err != nil {
		return err
	}
	actor := current.User.ID
	now := time.Now().UTC()
	event := store.AuditEvent{ID: eventID, ActorUserID: &actor, Action: "user.limits.set", TargetType: "user",
		TargetID: userID, Metadata: metadata, CreatedAt: now}
	if err := a.store.SetLimitOverridesAsAdmin(request.Context(), current.User.ID, current.Session.ID, now, userID, overrides, event, now); err != nil {
		return err
	}
	limits, err := a.limitsOf(request.Context(), userID)
	if err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusOK, limits)
	return nil
}

type adminProfileChange struct {
	DisplayName  *string `json:"displayName"`
	Discoverable *bool   `json:"discoverable"`
	RemoveAvatar bool    `json:"removeAvatar"`
}

// updateUserProfileAsAdmin changes how an account is shown: its name, whether
// it can be found, or its picture taken down.
func (a *API) updateUserProfileAsAdmin(response http.ResponseWriter, request *http.Request, current identity) error {
	var change adminProfileChange
	userID, err := a.authorizedChange(response, request, current, "profile", &change)
	if err != nil {
		return err
	}
	if change.DisplayName == nil && change.Discoverable == nil && !change.RemoveAvatar {
		return webapi.BadRequest("INVALID_INPUT", "Choose something to change.")
	}
	if err := a.requireAdmin(request, current); err != nil {
		return err
	}
	now := time.Now().UTC()
	update := store.ProfileUpdate{Discoverable: change.Discoverable}
	if change.DisplayName != nil {
		name, err := profile.DisplayName(*change.DisplayName)
		if err != nil {
			return err
		}
		update.DisplayName = &name
	}
	var user domain.User
	if update.DisplayName != nil || update.Discoverable != nil {
		if user, err = a.store.UpdateProfile(request.Context(), userID, update, now); err != nil {
			return err
		}
	}
	if change.RemoveAvatar {
		if user, err = a.store.DeleteUserAvatar(request.Context(), userID, now); err != nil {
			return err
		}
	}
	if err := a.adminAudit(request.Context(), current, "user.profile.update", userID, map[string]any{
		"displayName": change.DisplayName != nil, "discoverable": change.Discoverable, "removeAvatar": change.RemoveAvatar,
	}); err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusOK, user)
	return nil
}

// updateUserSettingsAsAdmin changes an account's own preferences, with the
// same checks as when its owner does.
func (a *API) updateUserSettingsAsAdmin(response http.ResponseWriter, request *http.Request, current identity) error {
	var settings domain.UserSettings
	userID, err := a.authorizedChange(response, request, current, "settings", &settings)
	if err != nil {
		return err
	}
	if err := a.requireAdmin(request, current); err != nil {
		return err
	}
	if _, err := a.store.GetUserByID(request.Context(), userID); err != nil {
		return err
	}
	existing, err := a.workspace.Settings(request.Context(), userID)
	if err != nil {
		return err
	}
	// Whether the owner has finished setting up, and the language and theme
	// their own screens use, are theirs to say.
	settings.OnboardingComplete = existing.OnboardingComplete
	settings.InterfaceLanguage, settings.ThemePreference = existing.InterfaceLanguage, existing.ThemePreference
	updated, err := a.workspace.UpdateSettings(request.Context(), userID, settings)
	if err != nil {
		return err
	}
	if err := a.adminAudit(request.Context(), current, "user.settings.update", userID, map[string]any{}); err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusOK, updated)
	return nil
}

// usageRange reads days (1–366) and the reader's UTC offset in minutes, and
// returns the range as whole local days ending today.
func usageRange(request *http.Request) (time.Time, time.Time, int, error) {
	query := request.URL.Query()
	days := 30
	if raw := query.Get("days"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > 366 {
			return time.Time{}, time.Time{}, 0, webapi.BadRequest("INVALID_RANGE", "Choose between 1 and 366 days.")
		}
		days = value
	}
	offset := 0
	if raw := query.Get("offset"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < -14*60 || value > 14*60 {
			return time.Time{}, time.Time{}, 0, webapi.BadRequest("INVALID_RANGE", "Give a valid time zone offset.")
		}
		offset = value
	}
	now := time.Now().UTC()
	local := now.Add(time.Duration(offset) * time.Minute)
	todayStart := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.UTC).Add(-time.Duration(offset) * time.Minute)
	from := todayStart.AddDate(0, 0, -(days - 1))
	return from, todayStart.Add(24 * time.Hour), offset, nil
}

// accountUsage is the caller's own use, with their limits and standing.
func (a *API) accountUsage(response http.ResponseWriter, request *http.Request, current identity) error {
	from, to, offset, err := usageRange(request)
	if err != nil {
		return err
	}
	workspaceID := strings.TrimSpace(request.URL.Query().Get("workspace"))
	if workspaceID != "" {
		if _, err := a.store.GetWorkspace(request.Context(), current.User.ID, workspaceID); err != nil {
			return err
		}
	}
	report, err := a.store.Usage(request.Context(), store.UsageQuery{UserID: current.User.ID, WorkspaceID: workspaceID,
		From: from, To: to, OffsetMinutes: offset})
	if err != nil {
		return err
	}
	limits, err := a.store.EffectiveLimits(request.Context(), current.User.ID)
	if err != nil {
		return err
	}
	standing, err := a.standingOf(request.Context(), current.User.ID)
	if err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusOK, map[string]any{"report": report, "limits": limits, "standing": standing})
	return nil
}

// adminUsage is everyone's use, or one account's when user is given.
func (a *API) adminUsage(response http.ResponseWriter, request *http.Request, current identity) error {
	if err := a.requireAdmin(request, current); err != nil {
		return err
	}
	from, to, offset, err := usageRange(request)
	if err != nil {
		return err
	}
	userID := strings.TrimSpace(request.URL.Query().Get("user"))
	result := map[string]any{}
	if userID != "" {
		user, err := a.store.GetUserByID(request.Context(), userID)
		if err != nil {
			return err
		}
		limits, err := a.store.EffectiveLimits(request.Context(), userID)
		if err != nil {
			return err
		}
		standing, err := a.standingOf(request.Context(), userID)
		if err != nil {
			return err
		}
		result["user"], result["limits"], result["standing"] = user, limits, standing
	}
	report, err := a.store.Usage(request.Context(), store.UsageQuery{UserID: userID, From: from, To: to, OffsetMinutes: offset})
	if err != nil {
		return err
	}
	result["report"] = report
	webapi.WriteJSON(response, http.StatusOK, result)
	return nil
}

// adminOperations is the monitor's picture of the providers, with this
// service's own backlog of work waiting on them.
func (a *API) adminOperations(response http.ResponseWriter, request *http.Request, current identity) error {
	if err := a.requireAdmin(request, current); err != nil {
		return err
	}
	if a.operations == nil {
		return &webapi.Error{Status: http.StatusServiceUnavailable, Code: "MONITORING_UNAVAILABLE", Message: "Monitoring is not running."}
	}
	pending, filling, failed, err := a.store.CountRecognitionGaps(request.Context())
	if err != nil {
		return err
	}
	retrying, err := a.store.CountRetryingTranslations(request.Context(), retryableTranslationCodes, 6)
	if err != nil {
		return err
	}
	response.Header().Set("Cache-Control", "no-store")
	webapi.WriteJSON(response, http.StatusOK, map[string]any{"snapshot": a.operations.Snapshot(), "backlog": map[string]any{
		"gapsPending": pending, "gapsFilling": filling, "gapsFailed": failed, "translationsRetrying": retrying,
	}})
	return nil
}

// retryableTranslationCodes mirrors the translations rooms asks for again.
var retryableTranslationCodes = []string{"translator_unavailable", "capacity_exhausted", "engine_unavailable",
	"language_detector_unavailable", "busy", "unavailable", "translation_persistence_failed", "interrupted"}

func newAuditID() (string, error) { return id.New("aud") }

func jsonRaw(value any) (json.RawMessage, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return encoded, nil
}
