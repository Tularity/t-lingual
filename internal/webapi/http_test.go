package webapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestDecodeJSONRejectsUnknownAndTrailingValues(t *testing.T) {
	tests := []string{
		`{"name":"ok","unknown":true}`,
		`{"name":"ok"} {"name":"second"}`,
	}
	for _, body := range tests {
		request := httptest.NewRequest(http.MethodPost, "/", bytes.NewBufferString(body))
		response := httptest.NewRecorder()
		var target struct {
			Name string `json:"name"`
		}
		if err := DecodeJSON(response, request, 1024, &target); err == nil || err.Code != "INVALID_JSON" {
			t.Fatalf("expected invalid JSON for %q, got %v", body, err)
		}
	}
}

func TestRequireOrigin(t *testing.T) {
	handler := RequireOrigin([]string{"https://app.example.com"})(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.WriteHeader(http.StatusNoContent)
	}))

	allowed := httptest.NewRequest(http.MethodPost, "/api/v1/settings", nil)
	allowed.Header.Set("Origin", "https://APP.example.com")
	allowedResponse := httptest.NewRecorder()
	handler.ServeHTTP(allowedResponse, allowed)
	if allowedResponse.Code != http.StatusNoContent {
		t.Fatalf("allowed origin returned %d", allowedResponse.Code)
	}

	missing := httptest.NewRequest(http.MethodPost, "/api/v1/settings", nil)
	missingResponse := httptest.NewRecorder()
	handler.ServeHTTP(missingResponse, missing)
	if missingResponse.Code != http.StatusForbidden {
		t.Fatalf("missing origin returned %d", missingResponse.Code)
	}
}

func TestMiddlewareAddsSecurityAndRequestID(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := Chain(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		WriteJSON(response, http.StatusOK, map[string]bool{"ok": true})
	}), Recovery(logger), RequestContext(logger), SecurityHeaders(true))
	request := httptest.NewRequest(http.MethodGet, "/health/live", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Header().Get("X-Request-ID") == "" || response.Header().Get("Content-Security-Policy") == "" || response.Header().Get("Strict-Transport-Security") == "" {
		t.Fatalf("missing security headers: %#v", response.Header())
	}
	if policy := response.Header().Get("Content-Security-Policy"); strings.Contains(policy, " ws:") || strings.Contains(policy, " wss:") {
		t.Fatalf("content security policy permits cross-origin websocket schemes: %q", policy)
	}
	var payload map[string]bool
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil || !payload["ok"] {
		t.Fatalf("unexpected response: %s", response.Body.String())
	}
}

func TestCheckWebSocketOrigin(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/api/v1/sessions/one/live", nil)
	request.Header.Set("Origin", "https://app.example.com")
	if err := CheckWebSocketOrigin(request, []string{"https://app.example.com"}); err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", "https://evil.example.com")
	if err := CheckWebSocketOrigin(request, []string{"https://app.example.com"}); err == nil {
		t.Fatal("expected foreign websocket origin to fail")
	}
}

func TestBodyReadGuardBoundsConcurrentSlowBodiesButSkipsGET(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	handler := BodyReadGuard(1, time.Minute)(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodGet {
			response.WriteHeader(http.StatusNoContent)
			return
		}
		once.Do(func() { close(entered) })
		<-release
		response.WriteHeader(http.StatusNoContent)
	}))

	firstDone := make(chan struct{})
	go func() {
		defer close(firstDone)
		request := httptest.NewRequest(http.MethodPost, "/", bytes.NewBufferString(`{"held":true}`))
		handler.ServeHTTP(httptest.NewRecorder(), request)
	}()
	<-entered

	second := httptest.NewRequest(http.MethodPost, "/", bytes.NewBufferString(`{"second":true}`))
	secondResponse := httptest.NewRecorder()
	handler.ServeHTTP(secondResponse, second)
	if secondResponse.Code != http.StatusServiceUnavailable {
		t.Fatalf("second slow body returned %d, want 503", secondResponse.Code)
	}

	getResponse := httptest.NewRecorder()
	handler.ServeHTTP(getResponse, httptest.NewRequest(http.MethodGet, "/live", nil))
	if getResponse.Code != http.StatusNoContent {
		t.Fatalf("GET was incorrectly admitted through body limiter: %d", getResponse.Code)
	}
	close(release)
	<-firstDone
}

func TestBodyReadGuardHoldsAdmissionUntilUnreadBodyIsClosed(t *testing.T) {
	closeStarted := make(chan struct{})
	releaseClose := make(chan struct{})
	firstBody := &blockingCloseBody{started: closeStarted, release: releaseClose}
	handler := BodyReadGuard(1, time.Minute)(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusUnauthorized)
	}))

	firstResponse := httptest.NewRecorder()
	firstDone := make(chan struct{})
	go func() {
		defer close(firstDone)
		// GET bodies are malformed but legal at the HTTP layer; they must not
		// bypass the guard and reach net/http's unbounded post-handler drain.
		request := httptest.NewRequest(http.MethodGet, "/", firstBody)
		handler.ServeHTTP(firstResponse, request)
	}()
	select {
	case <-closeStarted:
	case <-time.After(time.Second):
		t.Fatal("middleware did not close the unread body")
	}

	secondResponse := httptest.NewRecorder()
	second := httptest.NewRequest(http.MethodPost, "/", bytes.NewBufferString(`{"second":true}`))
	handler.ServeHTTP(secondResponse, second)
	if secondResponse.Code != http.StatusServiceUnavailable {
		t.Fatalf("admission was released before body close: got %d, want 503", secondResponse.Code)
	}

	close(releaseClose)
	select {
	case <-firstDone:
	case <-time.After(time.Second):
		t.Fatal("first request did not finish after body close was released")
	}
	if firstResponse.Code != http.StatusUnauthorized {
		t.Fatalf("first request returned %d, want 401", firstResponse.Code)
	}

	thirdResponse := httptest.NewRecorder()
	third := httptest.NewRequest(http.MethodPost, "/", bytes.NewBufferString(`{"third":true}`))
	handler.ServeHTTP(thirdResponse, third)
	if thirdResponse.Code != http.StatusUnauthorized {
		t.Fatalf("admission slot was not released after body close: got %d, want 401", thirdResponse.Code)
	}
}

func TestBodyReadGuardRejectsMissingBodyByteWithoutPostHandlerDrain(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var enterOnce sync.Once
	handler := BodyReadGuard(1, time.Minute)(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/hold" {
			enterOnce.Do(func() { close(entered) })
			<-release
		}
		response.WriteHeader(http.StatusNoContent)
	}))
	server := httptest.NewServer(handler)
	defer server.Close()

	first, err := net.Dial("tcp", server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if _, err := io.WriteString(first, "POST /hold HTTP/1.1\r\nHost: guard.test\r\nContent-Length: 1\r\n\r\nx"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("first body did not occupy admission")
	}

	second, err := net.Dial("tcp", server.Listener.Addr().String())
	if err != nil {
		close(release)
		t.Fatal(err)
	}
	defer second.Close()
	// Deliberately omit the declared byte. Without the poison read deadline,
	// request.Body.Close or net/http's post-handler drain can wait forever.
	if _, err := io.WriteString(second, "POST /rejected HTTP/1.1\r\nHost: guard.test\r\nContent-Length: 1\r\n\r\n"); err != nil {
		close(release)
		t.Fatal(err)
	}
	if err := second.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		close(release)
		t.Fatal(err)
	}
	statusLine, err := bufio.NewReader(second).ReadString('\n')
	if err != nil {
		close(release)
		t.Fatalf("read bounded rejection: %v", err)
	}
	if !strings.Contains(statusLine, " 503 ") {
		close(release)
		t.Fatalf("rejection status line = %q, want 503", statusLine)
	}
	close(release)
}

func TestResponseWriteDeadlineBoundsBlockedClient(t *testing.T) {
	writeDone := make(chan error, 1)
	started := make(chan struct{})
	var startOnce sync.Once
	handler := ResponseWriteDeadline(75*time.Millisecond, nil)(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		startOnce.Do(func() { close(started) })
		payload := make([]byte, 1<<20)
		for {
			if _, err := response.Write(payload); err != nil {
				writeDone <- err
				return
			}
		}
	}))
	server := httptest.NewServer(handler)
	defer server.Close()

	connection, err := net.Dial("tcp", server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if _, err := io.WriteString(connection, "GET / HTTP/1.1\r\nHost: deadline.test\r\nConnection: close\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("handler did not start")
	}

	select {
	case err := <-writeDone:
		if err == nil {
			t.Fatal("blocked response write unexpectedly returned nil")
		}
	case <-time.After(2 * time.Second):
		_ = connection.Close()
		select {
		case <-writeDone:
		case <-time.After(time.Second):
		}
		t.Fatal("blocked response write outlived its scoped deadline")
	}
}

func TestResponseWriteDeadlineIsScopedAndFakeUpgradeCannotBypass(t *testing.T) {
	handler := Chain(
		http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
			response.WriteHeader(http.StatusNoContent)
		}),
		ResponseWriteDeadline(time.Minute, func(*http.Request) bool { return true }),
		BodyReadGuard(1, time.Minute),
	)

	ordinaryWriter := newRecordingDeadlineWriter()
	handler.ServeHTTP(ordinaryWriter, httptest.NewRequest(http.MethodGet, "/", nil))
	writeDeadlines, readDeadlines := ordinaryWriter.snapshot()
	if len(writeDeadlines) != 2 || writeDeadlines[0].IsZero() || !writeDeadlines[1].IsZero() {
		t.Fatalf("ordinary response deadlines = %v, want nonzero then cleared", writeDeadlines)
	}
	if len(readDeadlines) != 0 {
		t.Fatalf("bodyless ordinary request got read deadlines: %v", readDeadlines)
	}

	webSocketWriter := newRecordingDeadlineWriter()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/sessions/one/live", nil)
	request.Header.Set("Connection", "keep-alive, Upgrade")
	request.Header.Set("Upgrade", "websocket")
	handler.ServeHTTP(webSocketWriter, request)
	writeDeadlines, readDeadlines = webSocketWriter.snapshot()
	if len(writeDeadlines) != 2 || writeDeadlines[0].IsZero() || !writeDeadlines[1].IsZero() {
		t.Fatalf("fake upgrade bypassed write deadline: %v", writeDeadlines)
	}
	if len(readDeadlines) != 0 {
		t.Fatalf("bodyless fake upgrade got read deadlines: %v", readDeadlines)
	}
}

func TestResponseWriteDeadlineClearsOnlyWhenAllowedHandlerHijacks(t *testing.T) {
	var hijackErr error
	handler := ResponseWriteDeadline(time.Minute, func(*http.Request) bool { return true })(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusSwitchingProtocols)
		connection, _, err := response.(http.Hijacker).Hijack()
		hijackErr = err
		if connection != nil {
			_ = connection.Close()
		}
	}))
	writer := newRecordingHijackWriter()
	defer writer.closePeer()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/sessions/one/live", nil)
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", "websocket")
	handler.ServeHTTP(writer, request)
	if hijackErr != nil {
		t.Fatalf("allowed hijack failed: %v", hijackErr)
	}
	writeDeadlines, _ := writer.snapshot()
	if len(writeDeadlines) != 2 || writeDeadlines[0].IsZero() || !writeDeadlines[1].IsZero() {
		t.Fatalf("successful hijack deadlines = %v, want nonzero then cleared", writeDeadlines)
	}
}

func TestResponseWriteDeadlineDoesNotOutliveWebSocketHijack(t *testing.T) {
	writeResult := make(chan error, 1)
	handler := ResponseWriteDeadline(30*time.Millisecond, func(*http.Request) bool { return true })(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		connection, err := websocket.Accept(response, request, nil)
		if err != nil {
			writeResult <- err
			return
		}
		defer connection.CloseNow()
		time.Sleep(75 * time.Millisecond)
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		writeResult <- connection.Write(ctx, websocket.MessageText, []byte("still-live"))
	}))
	server := httptest.NewServer(handler)
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	connection, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.CloseNow()
	messageType, payload, err := connection.Read(ctx)
	if err != nil {
		t.Fatalf("read after HTTP write deadline elapsed: %v", err)
	}
	if messageType != websocket.MessageText || string(payload) != "still-live" {
		t.Fatalf("unexpected WebSocket message type=%v payload=%q", messageType, payload)
	}
	if err := <-writeResult; err != nil {
		t.Fatalf("WebSocket write inherited HTTP deadline: %v", err)
	}
}

type blockingCloseBody struct {
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func (b *blockingCloseBody) Read([]byte) (int, error) { return 0, io.EOF }

func (b *blockingCloseBody) Close() error {
	b.once.Do(func() { close(b.started) })
	<-b.release
	return nil
}

type recordingDeadlineWriter struct {
	*httptest.ResponseRecorder
	mu             sync.Mutex
	writeDeadlines []time.Time
	readDeadlines  []time.Time
}

func newRecordingDeadlineWriter() *recordingDeadlineWriter {
	return &recordingDeadlineWriter{ResponseRecorder: httptest.NewRecorder()}
}

func (r *recordingDeadlineWriter) SetWriteDeadline(deadline time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.writeDeadlines = append(r.writeDeadlines, deadline)
	return nil
}

func (r *recordingDeadlineWriter) SetReadDeadline(deadline time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.readDeadlines = append(r.readDeadlines, deadline)
	return nil
}

func (r *recordingDeadlineWriter) snapshot() ([]time.Time, []time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]time.Time(nil), r.writeDeadlines...), append([]time.Time(nil), r.readDeadlines...)
}

type recordingHijackWriter struct {
	*recordingDeadlineWriter
	peer net.Conn
}

func newRecordingHijackWriter() *recordingHijackWriter {
	return &recordingHijackWriter{recordingDeadlineWriter: newRecordingDeadlineWriter()}
}

func (r *recordingHijackWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	connection, peer := net.Pipe()
	r.peer = peer
	return connection, bufio.NewReadWriter(bufio.NewReader(connection), bufio.NewWriter(connection)), nil
}

func (r *recordingHijackWriter) closePeer() {
	if r.peer != nil {
		_ = r.peer.Close()
	}
}
