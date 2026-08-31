package webapi

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"runtime/debug"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/Tularity/t-lingual/internal/id"
)

type Error struct {
	Status  int
	Code    string
	Message string
	Details any
	Cause   error
}

func (e *Error) Error() string {
	if e.Cause != nil {
		return e.Code + ": " + e.Cause.Error()
	}
	return e.Code + ": " + e.Message
}

func BadRequest(code, message string) *Error {
	return &Error{Status: http.StatusBadRequest, Code: code, Message: message}
}

func Unauthorized(message string) *Error {
	return &Error{Status: http.StatusUnauthorized, Code: "UNAUTHENTICATED", Message: message}
}

func Forbidden(code, message string) *Error {
	return &Error{Status: http.StatusForbidden, Code: code, Message: message}
}

func NotFound(code, message string) *Error {
	return &Error{Status: http.StatusNotFound, Code: code, Message: message}
}

func Conflict(code, message string) *Error {
	return &Error{Status: http.StatusConflict, Code: code, Message: message}
}

type errorEnvelope struct {
	Error errorBody `json:"error"`
}

type errorBody struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"requestId,omitempty"`
	Details   any    `json:"details,omitempty"`
}

func WriteJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	if status == http.StatusNoContent || value == nil {
		return
	}
	if err := json.NewEncoder(response).Encode(value); err != nil {
		slog.Error("write JSON response", "error", err, "request_id", RequestID(response))
	}
}

func WriteError(response http.ResponseWriter, request *http.Request, err error) {
	apiError := &Error{Status: http.StatusInternalServerError, Code: "INTERNAL_ERROR", Message: "The server could not complete the request."}
	if errors.As(err, &apiError) {
		if apiError.Status < 400 || apiError.Status > 599 {
			apiError.Status = http.StatusInternalServerError
		}
		if apiError.Code == "" {
			apiError.Code = "INTERNAL_ERROR"
		}
		if apiError.Message == "" {
			apiError.Message = http.StatusText(apiError.Status)
		}
	}
	WriteJSON(response, apiError.Status, errorEnvelope{Error: errorBody{
		Code:      apiError.Code,
		Message:   apiError.Message,
		RequestID: RequestIDFromRequest(request),
		Details:   apiError.Details,
	}})
}

func DecodeJSON(response http.ResponseWriter, request *http.Request, maxBytes int64, target any) *Error {
	if maxBytes <= 0 {
		maxBytes = 1 << 20
	}
	request.Body = http.MaxBytesReader(response, request.Body, maxBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			return &Error{Status: http.StatusRequestEntityTooLarge, Code: "REQUEST_TOO_LARGE", Message: "The request body is too large.", Cause: err}
		}
		return &Error{Status: http.StatusBadRequest, Code: "INVALID_JSON", Message: "The request body must be valid JSON with only supported fields.", Cause: err}
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return &Error{Status: http.StatusBadRequest, Code: "INVALID_JSON", Message: "The request body must contain exactly one JSON value.", Cause: err}
	}
	return nil
}

type HandlerFunc func(http.ResponseWriter, *http.Request) error

func Handle(handler HandlerFunc) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		if err := handler(response, request); err != nil {
			WriteError(response, request, err)
		}
	}
}

type Middleware func(http.Handler) http.Handler

func Chain(handler http.Handler, middleware ...Middleware) http.Handler {
	for index := len(middleware) - 1; index >= 0; index-- {
		handler = middleware[index](handler)
	}
	return handler
}

// BodyReadGuard limits concurrent body-bearing requests and installs a read
// deadline. Body-less WebSocket handshakes bypass it naturally; requests do
// not bypass it merely because their method normally has no body. This bounds
// slow-body connection and goroutine consumption even for malformed GETs.
func BodyReadGuard(maxConcurrent int, timeout time.Duration) Middleware {
	if maxConcurrent <= 0 {
		maxConcurrent = 128
	}
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	admission := make(chan struct{}, maxConcurrent)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			if request.Body == nil || request.ContentLength == 0 {
				next.ServeHTTP(response, request)
				return
			}
			select {
			case admission <- struct{}{}:
			default:
				// A rejected request may have declared a body without sending it.
				// Poison the connection's read side before Close so net/http cannot
				// perform an unbounded post-handler drain outside admission control.
				controller := http.NewResponseController(response)
				_ = controller.SetReadDeadline(time.Now())
				_ = request.Body.Close()
				response.Header().Set("Connection", "close")
				WriteError(response, request, &Error{
					Status:  http.StatusServiceUnavailable,
					Code:    "REQUEST_CAPACITY",
					Message: "The server is handling too many request bodies. Try again shortly.",
				})
				return
			}

			controller := http.NewResponseController(response)
			deadlineSet := controller.SetReadDeadline(time.Now().Add(timeout)) == nil
			defer func() {
				// Close while the deadline and admission slot are still active.
				// net/http may drain an unread request body during Close; clearing
				// the deadline first would reopen the slow-body resource leak.
				_ = request.Body.Close()
				if deadlineSet {
					_ = controller.SetReadDeadline(time.Time{})
				}
				<-admission
			}()
			next.ServeHTTP(response, request)
		})
	}
}

// ResponseWriteDeadline bounds writes without applying a server-wide
// WriteTimeout. Requests allowed by allowHijack still start with the same
// deadline; it is cleared only at the instant a server handler successfully
// takes ownership of the connection. Client-supplied Upgrade headers alone can
// therefore never bypass the deadline.
func ResponseWriteDeadline(timeout time.Duration, allowHijack func(*http.Request) bool) Middleware {
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			controller := http.NewResponseController(response)
			if controller.SetWriteDeadline(time.Now().Add(timeout)) != nil {
				next.ServeHTTP(response, request)
				return
			}
			if allowHijack != nil && allowHijack(request) {
				scoped := &writeDeadlineResponse{
					ResponseWriter: response,
					controller:     controller,
					timeout:        timeout,
					active:         true,
				}
				defer scoped.clear()
				next.ServeHTTP(scoped, request)
				return
			}
			defer func() { _ = controller.SetWriteDeadline(time.Time{}) }()
			next.ServeHTTP(response, request)
		})
	}
}

type writeDeadlineResponse struct {
	http.ResponseWriter
	controller *http.ResponseController
	timeout    time.Duration

	mu     sync.Mutex
	active bool
}

func (w *writeDeadlineResponse) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *writeDeadlineResponse) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if err := w.clear(); err != nil {
		return nil, nil, err
	}
	connection, readWriter, err := http.NewResponseController(w.ResponseWriter).Hijack()
	if err != nil {
		w.mu.Lock()
		if setErr := w.controller.SetWriteDeadline(time.Now().Add(w.timeout)); setErr == nil {
			w.active = true
		}
		w.mu.Unlock()
	}
	return connection, readWriter, err
}

func (w *writeDeadlineResponse) clear() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.active {
		return nil
	}
	if err := w.controller.SetWriteDeadline(time.Time{}); err != nil {
		return err
	}
	w.active = false
	return nil
}

type requestIDKey struct{}

type responseState struct {
	http.ResponseWriter
	status    int
	requestID string
}

// Unwrap lets http.ResponseController and WebSocket implementations reach the
// underlying writer without losing request accounting middleware.
func (r *responseState) Unwrap() http.ResponseWriter { return r.ResponseWriter }

func (r *responseState) WriteHeader(status int) {
	if r.status != 0 {
		return
	}
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

func (r *responseState) Write(payload []byte) (int, error) {
	if r.status == 0 {
		r.WriteHeader(http.StatusOK)
	}
	return r.ResponseWriter.Write(payload)
}

func RequestContext(logger *slog.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			started := time.Now()
			requestID, err := id.New("req")
			if err != nil {
				requestID = fmt.Sprintf("req_%d", started.UnixNano())
			}
			state := &responseState{ResponseWriter: response, requestID: requestID}
			state.Header().Set("X-Request-ID", requestID)
			request = request.WithContext(withRequestID(request.Context(), requestID))
			next.ServeHTTP(state, request)
			status := state.status
			if status == 0 {
				status = http.StatusOK
			}
			logger.Log(request.Context(), levelForStatus(status), "http request",
				"method", request.Method,
				"path", request.URL.Path,
				"status", status,
				"duration_ms", time.Since(started).Milliseconds(),
				"request_id", requestID,
			)
		})
	}
}

func Recovery(logger *slog.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			defer func() {
				if recovered := recover(); recovered != nil {
					logger.Error("panic serving request", "panic", recovered, "stack", string(debug.Stack()), "request_id", RequestIDFromRequest(request))
					WriteError(response, request, errors.New("handler panic"))
				}
			}()
			next.ServeHTTP(response, request)
		})
	}
}

func SecurityHeaders(production bool) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			headers := response.Header()
			headers.Set("X-Content-Type-Options", "nosniff")
			headers.Set("Referrer-Policy", "strict-origin-when-cross-origin")
			headers.Set("Permissions-Policy", "camera=(), geolocation=(), payment=(), usb=(), microphone=(self), publickey-credentials-create=(self), publickey-credentials-get=(self)")
			headers.Set("Cross-Origin-Opener-Policy", "same-origin")
			headers.Set("Cross-Origin-Resource-Policy", "same-origin")
			headers.Set("Content-Security-Policy", "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self' blob:")
			if production {
				headers.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
			}
			next.ServeHTTP(response, request)
		})
	}
}

func RequireOrigin(allowed []string) Middleware {
	normalized := make([]string, 0, len(allowed))
	for _, raw := range allowed {
		if value, err := normalizeOrigin(raw); err == nil {
			normalized = append(normalized, value)
		}
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			if request.Method == http.MethodGet || request.Method == http.MethodHead || request.Method == http.MethodOptions {
				next.ServeHTTP(response, request)
				return
			}
			origin, err := normalizeOrigin(request.Header.Get("Origin"))
			if err != nil || !slices.Contains(normalized, origin) {
				WriteError(response, request, Forbidden("ORIGIN_REJECTED", "This request did not come from an allowed application origin."))
				return
			}
			next.ServeHTTP(response, request)
		})
	}
}

func CheckWebSocketOrigin(request *http.Request, allowed []string) error {
	origin, err := normalizeOrigin(request.Header.Get("Origin"))
	if err != nil {
		return Forbidden("ORIGIN_REJECTED", "The WebSocket origin is missing or invalid.")
	}
	for _, candidate := range allowed {
		normalized, normalizeErr := normalizeOrigin(candidate)
		if normalizeErr == nil && normalized == origin {
			return nil
		}
	}
	return Forbidden("ORIGIN_REJECTED", "The WebSocket origin is not allowed.")
}

func normalizeOrigin(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed == nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil {
		return "", errors.New("invalid origin")
	}
	if parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("origin contains extra components")
	}
	return strings.ToLower(parsed.Scheme) + "://" + strings.ToLower(parsed.Host), nil
}

func levelForStatus(status int) slog.Level {
	if status >= 500 {
		return slog.LevelError
	}
	if status >= 400 {
		return slog.LevelWarn
	}
	return slog.LevelInfo
}

func RequestIDFromRequest(request *http.Request) string {
	value, _ := request.Context().Value(requestIDKey{}).(string)
	return value
}

func RequestID(response http.ResponseWriter) string {
	if state, ok := response.(*responseState); ok {
		return state.requestID
	}
	return ""
}
