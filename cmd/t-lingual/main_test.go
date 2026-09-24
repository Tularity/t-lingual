package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/live"
)

func TestOptionalUserRevokersAreNilSafe(t *testing.T) {
	if handler := optionalLiveHandler(nil); handler != nil {
		t.Fatal("unconfigured ASR produced a non-nil live API handler")
	}
	manager := &live.Manager{}
	if handler := optionalLiveHandler(manager); handler != manager {
		t.Fatal("configured ASR did not preserve its live API handler")
	}
	if callback := optionalControlUserRevoker(nil); callback != nil {
		t.Fatal("nil live manager produced a control callback")
	}
	if callback := optionalControlUserRevoker(&live.Manager{}); callback == nil {
		t.Fatal("configured live manager did not produce a control callback")
	}
	if callback := optionalAuthUserRevoker(nil); callback != nil {
		t.Fatal("nil live manager produced an authentication callback")
	}
	if callback := optionalAuthUserRevoker(&live.Manager{}); callback == nil {
		t.Fatal("configured live manager did not produce an authentication callback")
	}
}

func TestRequireExistingMasterKey(t *testing.T) {
	root := t.TempDir()
	databasePath := filepath.Join(root, "state.db")
	keyPath := filepath.Join(root, "master.key")
	if err := requireExistingMasterKey(databasePath, keyPath); err != nil {
		t.Fatalf("new installation failed: %v", err)
	}
	if err := os.WriteFile(databasePath, []byte("sqlite-state"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := requireExistingMasterKey(databasePath, keyPath); err == nil {
		t.Fatal("existing database without key was accepted")
	}
	if err := os.WriteFile(keyPath, []byte("key-placeholder"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := requireExistingMasterKey(databasePath, keyPath); err != nil {
		t.Fatalf("existing database with key failed: %v", err)
	}
}

func TestRootHTTPHandlerGuardsSPASlowBodies(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	webHandler := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/held" {
			close(entered)
			<-release
		}
		response.WriteHeader(http.StatusNoContent)
	})
	apiHandler := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("SPA request was routed to the API handler")
	})
	handler := newRootHTTPHandlerWithLimits(apiHandler, webHandler, 1, time.Minute, time.Minute)

	firstResponse := newDeadlineRecorder()
	firstDone := make(chan struct{})
	go func() {
		defer close(firstDone)
		request := httptest.NewRequest(http.MethodGet, "/held", bytes.NewBufferString("slow GET body"))
		handler.ServeHTTP(firstResponse, request)
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("SPA handler did not receive the guarded GET body")
	}

	secondResponse := httptest.NewRecorder()
	second := httptest.NewRequest(http.MethodPost, "/other", bytes.NewBufferString("slow POST body"))
	handler.ServeHTTP(secondResponse, second)
	if secondResponse.Code != http.StatusServiceUnavailable {
		t.Fatalf("second SPA body returned %d, want 503", secondResponse.Code)
	}

	bodylessResponse := httptest.NewRecorder()
	handler.ServeHTTP(bodylessResponse, httptest.NewRequest(http.MethodGet, "/other", nil))
	if bodylessResponse.Code != http.StatusNoContent {
		t.Fatalf("bodyless SPA GET returned %d, want 204", bodylessResponse.Code)
	}

	close(release)
	select {
	case <-firstDone:
	case <-time.After(time.Second):
		t.Fatal("guarded SPA request did not finish")
	}
	if !firstResponse.sawNonzeroReadDeadline() {
		t.Fatal("root guard did not install a read deadline for the SPA body")
	}
}

func TestRootHTTPHandlerFakeUpgradeCannotBypassSPAWriteDeadline(t *testing.T) {
	webHandler := http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusNoContent)
	})
	handler := newRootHTTPHandlerWithLimits(http.NotFoundHandler(), webHandler, 1, time.Minute, time.Minute)
	response := newDeadlineRecorder()
	request := httptest.NewRequest(http.MethodGet, "/assets/application.js", nil)
	request.Header.Set("Connection", "keep-alive, Upgrade")
	request.Header.Set("Upgrade", "websocket")
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("fake upgrade returned %d, want 204", response.Code)
	}
	if !response.sawScopedWriteDeadline() {
		t.Fatal("fake SPA upgrade bypassed the write deadline")
	}
}

func TestLiveWebSocketEndpointIsExact(t *testing.T) {
	tests := []struct {
		method string
		path   string
		want   bool
	}{
		{http.MethodGet, "/api/v1/sessions/session_one/live", true},
		{http.MethodPost, "/api/v1/sessions/session_one/live", false},
		{http.MethodGet, "/api/v1/sessions//live", false},
		{http.MethodGet, "/api/v1/sessions/session_one/live/extra", false},
		{http.MethodGet, "/assets/application.js", false},
	}
	for _, test := range tests {
		request := httptest.NewRequest(test.method, test.path, nil)
		if got := isLiveWebSocketEndpoint(request); got != test.want {
			t.Errorf("isLiveWebSocketEndpoint(%s %s) = %v, want %v", test.method, test.path, got, test.want)
		}
	}
}

type deadlineRecorder struct {
	*httptest.ResponseRecorder
	mu             sync.Mutex
	readDeadlines  []time.Time
	writeDeadlines []time.Time
}

func newDeadlineRecorder() *deadlineRecorder {
	return &deadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
}

func (r *deadlineRecorder) SetReadDeadline(deadline time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.readDeadlines = append(r.readDeadlines, deadline)
	return nil
}

func (r *deadlineRecorder) SetWriteDeadline(deadline time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.writeDeadlines = append(r.writeDeadlines, deadline)
	return nil
}

func (r *deadlineRecorder) sawNonzeroReadDeadline() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, deadline := range r.readDeadlines {
		if !deadline.IsZero() {
			return true
		}
	}
	return false
}

func (r *deadlineRecorder) sawScopedWriteDeadline() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.writeDeadlines) == 2 && !r.writeDeadlines[0].IsZero() && r.writeDeadlines[1].IsZero()
}
