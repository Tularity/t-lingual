package control

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Tularity/t-lingual/internal/admin"
	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/store"
)

type handler struct {
	admin        *admin.Service
	revokeUser   RevokeUserFunc
	maxJSONBytes int64
}

// RevokeUserFunc disconnects all live work owned by a user after a committed
// local administrative privilege or status change. A nil callback is valid.
type RevokeUserFunc func(userID string)

// NewHandler builds the local control-plane handler. The returned handler has
// no application authentication middleware because access is authorized by
// the mode-0600 Unix socket. Do not mount it on the public HTTP server.
func NewHandler(
	service *admin.Service,
	revokeUser RevokeUserFunc,
	maxJSONBytes int64,
) (http.Handler, error) {
	if service == nil {
		return nil, errors.New("control: admin service is required")
	}
	if maxJSONBytes <= 0 {
		return nil, errors.New("control: positive JSON body limit is required")
	}
	return &handler{admin: service, revokeUser: revokeUser, maxJSONBytes: maxJSONBytes}, nil
}

func (h *handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("X-Content-Type-Options", "nosniff")

	switch request.URL.Path {
	case StatusPath:
		h.route(response, request, http.MethodGet, h.status)
	case InvitationsPath:
		switch request.Method {
		case http.MethodGet:
			h.listInvitations(response, request)
		case http.MethodPost:
			h.createInvitation(response, request)
		default:
			h.methodNotAllowed(response, http.MethodGet+", "+http.MethodPost)
		}
	case CodesPath:
		h.route(response, request, http.MethodPost, h.createCode)
	case InvitationRevokePath:
		h.route(response, request, http.MethodPost, h.revokeInvitation)
	case UsersPath:
		h.route(response, request, http.MethodGet, h.listUsers)
	case UserRolePath:
		h.route(response, request, http.MethodPost, h.setUserRole)
	case UserStatusPath:
		h.route(response, request, http.MethodPost, h.setUserStatus)
	default:
		writeError(response, http.StatusNotFound, "ROUTE_NOT_FOUND", "The control endpoint does not exist.")
	}
}

func (h *handler) route(
	response http.ResponseWriter,
	request *http.Request,
	method string,
	next func(http.ResponseWriter, *http.Request),
) {
	if request.Method != method {
		h.methodNotAllowed(response, method)
		return
	}
	next(response, request)
}

func (h *handler) methodNotAllowed(response http.ResponseWriter, allow string) {
	response.Header().Set("Allow", allow)
	writeError(response, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "The control endpoint does not accept this HTTP method.")
}

func (h *handler) status(response http.ResponseWriter, request *http.Request) {
	if !requireNoQuery(response, request) {
		return
	}
	writeJSON(response, http.StatusOK, StatusResponse{Status: "ok", APIVersion: "v1"})
}

func (h *handler) createInvitation(response http.ResponseWriter, request *http.Request) {
	if !requireNoQuery(response, request) {
		return
	}
	var body CreateInvitationRequest
	if !h.decodeJSON(response, request, &body) {
		return
	}

	var ttl time.Duration
	if body.TTL != "" {
		parsed, err := time.ParseDuration(body.TTL)
		if err != nil || parsed < time.Minute || parsed > 30*24*time.Hour {
			writeError(response, http.StatusBadRequest, "INVALID_TTL", "ttl must be a duration between 1m and 720h.")
			return
		}
		ttl = parsed
	}
	result, err := h.admin.CreateInvitationAsTrustedControl(request.Context(), ttl)
	if err != nil {
		h.writeServiceError(response, request, err)
		return
	}
	writeJSON(response, http.StatusCreated, CreateInvitationResponse{
		Invitation: result.Invitation,
		Code:       result.Code,
	})
}

func (h *handler) createCode(response http.ResponseWriter, request *http.Request) {
	if !requireNoQuery(response, request) {
		return
	}
	var body CreateCodeRequest
	if !h.decodeJSON(response, request, &body) {
		return
	}
	var input admin.CodeCreateInput
	input.Kind, input.TargetUserID = body.Kind, body.TargetUserID
	for _, field := range []struct {
		value  string
		target **time.Time
	}{{body.NotBefore, &input.NotBefore}, {body.ExpiresAt, &input.ExpiresAt}} {
		if field.value == "" {
			continue
		}
		parsed, err := time.Parse(time.RFC3339Nano, field.value)
		if err != nil {
			writeError(response, http.StatusBadRequest, "INVALID_CODE_SCHEDULE", "Dates must be RFC3339.")
			return
		}
		parsed = parsed.UTC()
		*field.target = &parsed
	}
	if body.TTL != "" {
		duration, err := time.ParseDuration(body.TTL)
		if err != nil {
			writeError(response, http.StatusBadRequest, "INVALID_CODE_SCHEDULE", "ttl must be a duration.")
			return
		}
		input.TTL = duration
	}
	result, err := h.admin.CreateCodeAsTrustedControl(request.Context(), input)
	if err != nil {
		h.writeServiceError(response, request, err)
		return
	}
	writeJSON(response, http.StatusCreated, CreateCodeResponse{Invitation: result.Invitation, Code: result.Code})
}

func (h *handler) listInvitations(response http.ResponseWriter, request *http.Request) {
	limit, offset, ok := pagination(response, request)
	if !ok {
		return
	}
	items, err := h.admin.ListInvitationsAsTrustedControl(request.Context(), limit, offset)
	if err != nil {
		h.writeServiceError(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, InvitationListResponse{Invitations: items})
}

func (h *handler) revokeInvitation(response http.ResponseWriter, request *http.Request) {
	if !requireNoQuery(response, request) {
		return
	}
	var body RevokeInvitationRequest
	if !h.decodeJSON(response, request, &body) {
		return
	}
	body.ID = strings.TrimSpace(body.ID)
	if body.ID == "" {
		writeError(response, http.StatusBadRequest, "INVALID_INVITATION_ID", "id is required.")
		return
	}
	if err := h.admin.RevokeInvitationAsTrustedControl(request.Context(), body.ID); err != nil {
		h.writeServiceError(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, OperationResponse{Status: "ok"})
}

func (h *handler) listUsers(response http.ResponseWriter, request *http.Request) {
	limit, offset, ok := pagination(response, request)
	if !ok {
		return
	}
	users, err := h.admin.ListUsersAsTrustedControl(request.Context(), limit, offset)
	if err != nil {
		h.writeServiceError(response, request, err)
		return
	}
	writeJSON(response, http.StatusOK, UserListResponse{Users: users})
}

func (h *handler) setUserRole(response http.ResponseWriter, request *http.Request) {
	if !requireNoQuery(response, request) {
		return
	}
	var body SetUserRoleRequest
	if !h.decodeJSON(response, request, &body) {
		return
	}
	body.ID = strings.TrimSpace(body.ID)
	if body.ID == "" || !body.Role.Valid() {
		writeError(response, http.StatusBadRequest, "INVALID_USER_ROLE", "id and a role of user or admin are required.")
		return
	}
	result, err := h.admin.UpdateUserAsTrustedControl(
		request.Context(), body.ID, admin.UserUpdate{Role: &body.Role},
	)
	if err != nil {
		h.writeServiceError(response, request, err)
		return
	}
	if result.PromotedToAdmin && h.revokeUser != nil {
		h.revokeUser(body.ID)
	}
	writeJSON(response, http.StatusOK, OperationResponse{Status: "ok"})
}

func (h *handler) setUserStatus(response http.ResponseWriter, request *http.Request) {
	if !requireNoQuery(response, request) {
		return
	}
	var body SetUserStatusRequest
	if !h.decodeJSON(response, request, &body) {
		return
	}
	body.ID = strings.TrimSpace(body.ID)
	if body.ID == "" || (body.Status != domain.UserActive && body.Status != domain.UserDisabled) {
		writeError(response, http.StatusBadRequest, "INVALID_USER_STATUS", "id and a status of active or disabled are required.")
		return
	}
	result, err := h.admin.UpdateUserAsTrustedControl(
		request.Context(), body.ID, admin.UserUpdate{Status: &body.Status},
	)
	if err != nil {
		h.writeServiceError(response, request, err)
		return
	}
	if result.Status == domain.UserDisabled && h.revokeUser != nil {
		h.revokeUser(body.ID)
	}
	writeJSON(response, http.StatusOK, OperationResponse{Status: "ok"})
}

func (h *handler) decodeJSON(response http.ResponseWriter, request *http.Request, target any) bool {
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeError(response, http.StatusUnsupportedMediaType, "JSON_REQUIRED", "Content-Type must be application/json.")
		return false
	}
	request.Body = http.MaxBytesReader(response, request.Body, h.maxJSONBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(response, http.StatusRequestEntityTooLarge, "REQUEST_TOO_LARGE", "The JSON request body is too large.")
		} else {
			writeError(response, http.StatusBadRequest, "INVALID_JSON", "The request body must contain one valid JSON object with only supported fields.")
		}
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(response, http.StatusRequestEntityTooLarge, "REQUEST_TOO_LARGE", "The JSON request body is too large.")
		} else {
			writeError(response, http.StatusBadRequest, "INVALID_JSON", "The request body must contain exactly one JSON object.")
		}
		return false
	}
	return true
}

func (h *handler) writeServiceError(response http.ResponseWriter, request *http.Request, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(response, http.StatusNotFound, "NOT_FOUND", "The requested resource does not exist.")
	case errors.Is(err, store.ErrConflict):
		writeError(response, http.StatusConflict, "CONFLICT", "The requested operation conflicts with the current resource state.")
	case errors.Is(err, store.ErrForbidden):
		writeError(response, http.StatusConflict, "SAFETY_CONFLICT", "The operation would violate an administrative safety rule.")
	case errors.Is(err, admin.ErrAdminRequired):
		writeError(response, http.StatusForbidden, "ADMIN_REQUIRED", "An active administrator is required.")
	case errors.Is(err, admin.ErrInvalidCode):
		writeError(response, http.StatusBadRequest, "INVALID_CODE_SCHEDULE", "Check the code type, target, and activation window.")
	default:
		slog.ErrorContext(request.Context(), "local admin control request failed", "path", request.URL.Path, "error", err)
		writeError(response, http.StatusInternalServerError, "INTERNAL_ERROR", "The running server could not complete the administrative operation.")
	}
}

func requireNoQuery(response http.ResponseWriter, request *http.Request) bool {
	if request.URL.RawQuery != "" {
		writeError(response, http.StatusBadRequest, "INVALID_QUERY", "This endpoint does not accept query parameters.")
		return false
	}
	return true
}

func pagination(response http.ResponseWriter, request *http.Request) (int, int, bool) {
	values := request.URL.Query()
	for key, entries := range values {
		if (key != "limit" && key != "offset") || len(entries) != 1 {
			writeError(response, http.StatusBadRequest, "INVALID_PAGINATION", "Only one limit and one offset query parameter are supported.")
			return 0, 0, false
		}
	}
	limit := 100
	offset := 0
	var err error
	if raw, exists := values["limit"]; exists {
		limit, err = strconv.Atoi(raw[0])
		if err != nil || limit < 1 || limit > 500 {
			writeError(response, http.StatusBadRequest, "INVALID_PAGINATION", "limit must be an integer between 1 and 500.")
			return 0, 0, false
		}
	}
	if raw, exists := values["offset"]; exists {
		offset, err = strconv.Atoi(raw[0])
		if err != nil || offset < 0 {
			writeError(response, http.StatusBadRequest, "INVALID_PAGINATION", "offset must be a non-negative integer.")
			return 0, 0, false
		}
	}
	return limit, offset, true
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	writeJSON(response, status, errorEnvelope{Error: errorBody{Code: code, Message: message}})
}
