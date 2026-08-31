package api

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/config"
	"github.com/Tularity/t-lingual/internal/domain"
)

func TestForgedCookieAuthenticationAdmissionIsFailFastAndFair(t *testing.T) {
	admission := newAuthenticatedAdmission(2, 1, 2, 2, 2)
	entered := make(chan string, 3)
	release := make(chan struct{})
	var calls atomic.Int32
	server := newAdmissionTestAPI(admission, func(_ context.Context, token string) (domain.User, domain.BrowserSession, error) {
		calls.Add(1)
		entered <- token
		<-release
		return domain.User{}, domain.BrowserSession{}, errUnauthenticated
	})
	handler := server.authenticated(func(http.ResponseWriter, *http.Request, identity) error {
		t.Fatal("a forged cookie reached the authenticated handler")
		return nil
	})

	// Cookie-less traffic is rejected before admission and before any database
	// lookup. A syntactically valid but forged cookie must enter bounded work.
	missing := serveAdmissionRequest(handler, "192.0.2.1:1000", "")
	if missing.Code != http.StatusUnauthorized || calls.Load() != 0 {
		t.Fatalf("missing cookie response=%d authenticate calls=%d", missing.Code, calls.Load())
	}
	assertAdmissionEmpty(t, admission)

	type result struct {
		response *httptest.ResponseRecorder
	}
	results := make(chan result, 2)
	start := func(remote, cookie string) {
		go func() {
			results <- result{response: serveAdmissionRequest(handler, remote, cookie)}
		}()
	}

	start("192.0.2.1:1001", "forged-cookie-a")
	if token := awaitAdmissionValue(t, entered); token != "forged-cookie-a" {
		t.Fatalf("first lookup token = %q", token)
	}

	// The same source cannot consume the second global slot. A different
	// source still gets fair access to it.
	sameSource := serveAdmissionRequest(handler, "192.0.2.1:1002", "forged-cookie-a2")
	assertAdmissionError(t, sameSource, http.StatusTooManyRequests, "AUTH_CONCURRENCY_LIMIT")
	start("192.0.2.2:1001", "forged-cookie-b")
	if token := awaitAdmissionValue(t, entered); token != "forged-cookie-b" {
		t.Fatalf("second lookup token = %q", token)
	}

	distributed := serveAdmissionRequest(handler, "192.0.2.3:1001", "forged-cookie-c")
	assertAdmissionError(t, distributed, http.StatusServiceUnavailable, "AUTH_SERVICE_BUSY")
	if got := calls.Load(); got != 2 {
		t.Fatalf("Authenticate calls while saturated = %d, want 2", got)
	}

	close(release)
	for range 2 {
		select {
		case completed := <-results:
			if completed.response.Code != http.StatusUnauthorized {
				t.Fatalf("forged lookup response=%d body=%s", completed.response.Code, completed.response.Body.String())
			}
		case <-time.After(2 * time.Second):
			t.Fatal("blocked authentication request did not finish")
		}
	}

	// Slots and active-only map entries are reusable immediately; this is not a
	// fixed-window request counter.
	recovered := serveAdmissionRequest(handler, "192.0.2.3:1002", "forged-cookie-after-release")
	if recovered.Code != http.StatusUnauthorized {
		t.Fatalf("request after release=%d body=%s", recovered.Code, recovered.Body.String())
	}
	assertAdmissionEmpty(t, admission)
}

func TestAuthenticatedAdmissionLimitsOneUserAcrossClientPrefixes(t *testing.T) {
	admission := newAuthenticatedAdmission(3, 2, 1, 3, 3)
	user := domain.User{ID: "usr_one", Status: domain.UserActive}
	session := domain.BrowserSession{ID: "ses_one", UserID: user.ID}
	server := newAdmissionTestAPI(admission, func(context.Context, string) (domain.User, domain.BrowserSession, error) {
		return user, session, nil
	})
	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	handler := server.authenticated(func(response http.ResponseWriter, _ *http.Request, _ identity) error {
		entered <- struct{}{}
		<-release
		response.WriteHeader(http.StatusNoContent)
		return nil
	})
	firstResult := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		firstResult <- serveAdmissionRequest(handler, "192.0.2.10:1000", "valid-cookie-one")
	}()
	awaitAdmissionValue(t, entered)

	// The same valid account cannot evade its concurrency limit by changing IP.
	second := serveAdmissionRequest(handler, "198.51.100.20:1000", "valid-cookie-two")
	assertAdmissionError(t, second, http.StatusTooManyRequests, "AUTH_CONCURRENCY_LIMIT")
	close(release)
	select {
	case first := <-firstResult:
		if first.Code != http.StatusNoContent {
			t.Fatalf("first valid response=%d body=%s", first.Code, first.Body.String())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("first valid request did not finish")
	}

	third := serveAdmissionRequest(handler, "198.51.100.20:1001", "valid-cookie-three")
	if third.Code != http.StatusNoContent {
		t.Fatalf("valid request after release=%d body=%s", third.Code, third.Body.String())
	}
	assertAdmissionEmpty(t, admission)
}

func TestAuthenticatedAdmissionReleasesOnPanic(t *testing.T) {
	admission := newAuthenticatedAdmission(1, 1, 1, 1, 1)
	user := domain.User{ID: "usr_panic", Status: domain.UserActive}
	server := newAdmissionTestAPI(admission, func(context.Context, string) (domain.User, domain.BrowserSession, error) {
		return user, domain.BrowserSession{ID: "ses_panic", UserID: user.ID}, nil
	})
	handler := server.authenticated(func(http.ResponseWriter, *http.Request, identity) error {
		panic("test panic")
	})

	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("handler did not panic")
			}
		}()
		serveAdmissionRequest(handler, "192.0.2.30:1000", "valid-cookie")
	}()
	assertAdmissionEmpty(t, admission)

	serverHandler := server.authenticated(func(response http.ResponseWriter, _ *http.Request, _ identity) error {
		response.WriteHeader(http.StatusNoContent)
		return nil
	})
	if response := serveAdmissionRequest(serverHandler, "192.0.2.30:1001", "valid-cookie"); response.Code != http.StatusNoContent {
		t.Fatalf("request after panic=%d body=%s", response.Code, response.Body.String())
	}
}

func TestLiveRouteReleasesGeneralAdmissionAfterAuthentication(t *testing.T) {
	admission := newAuthenticatedAdmission(1, 1, 1, 1, 1)
	user := domain.User{ID: "usr_live", Status: domain.UserActive}
	session := domain.BrowserSession{ID: "ses_live", UserID: user.ID}
	server := newAdmissionTestAPI(admission, func(context.Context, string) (domain.User, domain.BrowserSession, error) {
		return user, session, nil
	})
	live := &blockingAdmissionLiveHandler{entered: make(chan struct{}), release: make(chan struct{})}
	server.live = live
	handler := server.Handler()

	liveResult := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		request := admissionRequest("192.0.2.40:1000", "valid-live-cookie")
		request.URL.Path = "/api/v1/sessions/int_one/live"
		request.Header.Set("Origin", server.config.RPOrigins[0])
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		liveResult <- response
	}()
	awaitAdmissionValue(t, live.entered)
	assertAdmissionEmpty(t, admission)

	// A long-running live connection from the same prefix and user must not pin
	// the single general slot. Live has separate handshake/active capacity.
	request := admissionRequest("192.0.2.40:1001", "valid-http-cookie")
	request.URL.Path = "/api/v1/auth/me"
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("ordinary request alongside live=%d body=%s", response.Code, response.Body.String())
	}

	close(live.release)
	select {
	case completed := <-liveResult:
		if completed.Code != http.StatusNoContent {
			t.Fatalf("live response=%d body=%s", completed.Code, completed.Body.String())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("live request did not finish")
	}
	assertAdmissionEmpty(t, admission)
}

func TestAuthenticatedAdmissionBoundsAndCleansKeyMaps(t *testing.T) {
	admission := newAuthenticatedAdmission(3, 2, 2, 1, 1)
	releaseClient, rejection := admission.acquireClient("client-one")
	if rejection != authenticatedAdmitted {
		t.Fatalf("first client rejection=%v", rejection)
	}
	if _, rejection = admission.acquireClient("client-two"); rejection != authenticatedServiceBusy {
		t.Fatalf("client map capacity rejection=%v", rejection)
	}
	releaseClient()

	releaseClient, rejection = admission.acquireClient("client-two")
	if rejection != authenticatedAdmitted {
		t.Fatalf("client after cleanup rejection=%v", rejection)
	}
	releaseUser, rejection := admission.acquireUser("user-one")
	if rejection != authenticatedAdmitted {
		t.Fatalf("first user rejection=%v", rejection)
	}
	if _, rejection = admission.acquireUser("user-two"); rejection != authenticatedServiceBusy {
		t.Fatalf("user map capacity rejection=%v", rejection)
	}
	releaseUser()
	releaseClient()
	assertAdmissionEmpty(t, admission)
}

type blockingAdmissionLiveHandler struct {
	entered chan struct{}
	release chan struct{}
}

func (handler *blockingAdmissionLiveHandler) ServeLive(
	response http.ResponseWriter,
	_ *http.Request,
	_ domain.User,
	_ domain.BrowserSession,
	_ string,
) error {
	close(handler.entered)
	<-handler.release
	response.WriteHeader(http.StatusNoContent)
	return nil
}

func (*blockingAdmissionLiveHandler) RevokeBrowserSession(string) {}

func (*blockingAdmissionLiveHandler) RevokeUser(string) {}

func newAdmissionTestAPI(
	admission *authenticatedAdmission,
	authenticate func(context.Context, string) (domain.User, domain.BrowserSession, error),
) *API {
	return &API{
		config: config.Config{
			Environment:       config.Development,
			SessionCookieName: "tlingual_session",
			RPOrigins:         []string{"http://localhost:8080"},
		},
		authenticateSession:    authenticate,
		authenticatedAdmission: admission,
		logger:                 slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

func admissionRequest(remote, cookie string) *http.Request {
	request := httptest.NewRequest(http.MethodGet, "http://localhost:8080/api/v1/auth/me", nil)
	request.RemoteAddr = remote
	if cookie != "" {
		request.AddCookie(&http.Cookie{Name: "tlingual_session", Value: cookie})
	}
	return request
}

func serveAdmissionRequest(handler http.Handler, remote, cookie string) *httptest.ResponseRecorder {
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, admissionRequest(remote, cookie))
	return response
}

func awaitAdmissionValue[T any](t *testing.T, values <-chan T) T {
	t.Helper()
	select {
	case value := <-values:
		return value
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for admission barrier")
		var zero T
		return zero
	}
}

func assertAdmissionError(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if response.Code != status || response.Header().Get("Retry-After") != "1" ||
		!strings.Contains(response.Body.String(), `"code":"`+code+`"`) {
		t.Fatalf("admission response=%d retry-after=%q body=%s", response.Code, response.Header().Get("Retry-After"), response.Body.String())
	}
}

func assertAdmissionEmpty(t *testing.T, admission *authenticatedAdmission) {
	t.Helper()
	admission.mu.Lock()
	defer admission.mu.Unlock()
	if admission.globalActive != 0 || len(admission.clients) != 0 || len(admission.users) != 0 {
		t.Fatalf("admission leaked state: global=%d clients=%v users=%v", admission.globalActive, admission.clients, admission.users)
	}
}
