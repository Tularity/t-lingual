package asr

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestClientSessionLifecycle(t *testing.T) {
	t.Parallel()

	var server *httptest.Server
	var mu sync.Mutex
	var gotAudio []byte
	ended := false
	deleted := false

	handler := http.NewServeMux()
	handler.HandleFunc("GET /healthz", func(response http.ResponseWriter, request *http.Request) {
		assertBearer(t, request)
		_ = json.NewEncoder(response).Encode(map[string]any{"ready": true})
	})
	handler.HandleFunc("POST /v1/sessions", func(response http.ResponseWriter, request *http.Request) {
		assertBearer(t, request)
		var body StartRequest
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		if body.Audio.Encoding != "pcm32f" || body.Audio.SampleRate != 48000 || body.Language != "auto" {
			t.Errorf("unexpected create request: %#v", body)
		}
		response.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(response).Encode(validStartResponse("upstream-1", body.Audio))
	})
	handler.HandleFunc("GET /v1/sessions/upstream-1/audio", func(response http.ResponseWriter, request *http.Request) {
		assertBearer(t, request)
		connection, err := websocket.Accept(response, request, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer connection.CloseNow()
		_ = writeEvent(request.Context(), connection, Event{Type: "partial", Sequence: 1, Text: "hel"})
		_ = writeEvent(request.Context(), connection, Event{Type: "final", Sequence: 2, Line: 1, Text: "hello", StartMS: 0, EndMS: 500, Language: "en-US"})
		for {
			typ, payload, readErr := connection.Read(request.Context())
			if readErr != nil {
				return
			}
			if typ == websocket.MessageBinary {
				mu.Lock()
				gotAudio = append([]byte(nil), payload...)
				mu.Unlock()
				continue
			}
			var command map[string]string
			_ = json.Unmarshal(payload, &command)
			if command["type"] == "end" {
				mu.Lock()
				ended = true
				mu.Unlock()
				_ = connection.Close(websocket.StatusNormalClosure, "done")
				return
			}
		}
	})
	handler.HandleFunc("DELETE /v1/sessions/upstream-1", func(response http.ResponseWriter, request *http.Request) {
		assertBearer(t, request)
		mu.Lock()
		deleted = true
		mu.Unlock()
		_ = json.NewEncoder(response).Encode(map[string]any{"closed": true})
	})
	server = httptest.NewServer(handler)
	defer server.Close()

	base, _ := url.Parse(server.URL)
	client, err := NewClient(base, "provider-secret", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := client.Ready(ctx); err != nil {
		t.Fatal(err)
	}
	stream, err := client.Start(ctx, StartRequest{Language: "auto", Audio: AudioSpec{Encoding: "pcm32f", SampleRate: 48000, Channels: 1}})
	if err != nil {
		t.Fatal(err)
	}
	if stream.Info().SessionID != "upstream-1" {
		t.Fatalf("unexpected upstream info: %#v", stream.Info())
	}
	if err := stream.SendAudio(ctx, []byte{1, 2, 3, 4}); err != nil {
		t.Fatal(err)
	}

	partial := <-stream.Events()
	final := <-stream.Events()
	if partial.Type != "partial" || partial.Text != "hel" || !final.Final() || final.Text != "hello" {
		t.Fatalf("unexpected events: %#v %#v", partial, final)
	}
	if err := stream.End(ctx); err != nil {
		t.Fatal(err)
	}
	_ = stream.Wait()
	if err := stream.Close(ctx); err != nil {
		t.Fatal(err)
	}

	mu.Lock()
	defer mu.Unlock()
	if string(gotAudio) != string([]byte{1, 2, 3, 4}) || !ended || !deleted {
		t.Fatalf("lifecycle incomplete: audio=%v ended=%v deleted=%v", gotAudio, ended, deleted)
	}
}

func TestClientRejectsOversizedProviderEventBeforeBuffering(t *testing.T) {
	t.Parallel()
	handler := http.NewServeMux()
	handler.HandleFunc("POST /v1/sessions", func(response http.ResponseWriter, request *http.Request) {
		var input StartRequest
		_ = json.NewDecoder(request.Body).Decode(&input)
		response.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(response).Encode(validStartResponse("oversized-event", input.Audio))
	})
	handler.HandleFunc("GET /v1/sessions/oversized-event/audio", func(response http.ResponseWriter, request *http.Request) {
		connection, err := websocket.Accept(response, request, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer connection.CloseNow()
		_ = writeEvent(request.Context(), connection, Event{
			Type: "partial", Sequence: 1, Text: strings.Repeat("x", (64<<10)+1),
		})
	})
	handler.HandleFunc("DELETE /v1/sessions/oversized-event", func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusNotFound)
	})
	server := httptest.NewServer(handler)
	defer server.Close()
	base, _ := url.Parse(server.URL)
	client, err := NewClient(base, "", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	stream, err := client.Start(context.Background(), StartRequest{
		Language: "auto", Audio: AudioSpec{Encoding: "pcm32f", SampleRate: 16_000, Channels: 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	if event, open := <-stream.Events(); open {
		t.Fatalf("oversized provider event escaped validation: %#v", event)
	}
	if err := stream.Wait(); err == nil || !strings.Contains(err.Error(), "text is too large") {
		t.Fatalf("provider event validation error = %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := stream.Close(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestClientNormalizesProviderErrorEventMetadata(t *testing.T) {
	t.Parallel()
	handler := http.NewServeMux()
	handler.HandleFunc("POST /v1/sessions", func(response http.ResponseWriter, request *http.Request) {
		var input StartRequest
		_ = json.NewDecoder(request.Body).Decode(&input)
		response.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(response).Encode(validStartResponse("normalized-error", input.Audio))
	})
	handler.HandleFunc("GET /v1/sessions/normalized-error/audio", func(response http.ResponseWriter, request *http.Request) {
		connection, err := websocket.Accept(response, request, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer connection.CloseNow()
		_ = writeEvent(request.Context(), connection, Event{
			Type: "error", Code: " SLOT_BUSY ", Message: "retry\r\n\u202elater",
		})
		_ = connection.Close(websocket.StatusNormalClosure, "done")
	})
	handler.HandleFunc("DELETE /v1/sessions/normalized-error", func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusNotFound)
	})
	server := httptest.NewServer(handler)
	defer server.Close()
	base, _ := url.Parse(server.URL)
	client, _ := NewClient(base, "", server.Client())
	stream, err := client.Start(context.Background(), validStartRequest())
	if err != nil {
		t.Fatal(err)
	}
	event := <-stream.Events()
	if event.Code != "SLOT_BUSY" || event.Message != "retry later" {
		t.Fatalf("normalized event metadata = code %q message %q", event.Code, event.Message)
	}
	if err := stream.Wait(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := stream.Close(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestClientDecodesProviderError(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.WriteHeader(http.StatusTooManyRequests)
		_, _ = io.WriteString(response, `{"detail":{"error":"SLOTS_FULL","message":"retry later"}}`)
	}))
	defer server.Close()
	base, _ := url.Parse(server.URL)
	client, err := NewClient(base, "", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Start(context.Background(), StartRequest{Language: "auto", Audio: AudioSpec{Encoding: "pcm16", SampleRate: 16000, Channels: 1}})
	var providerErr *ProviderError
	if !errors.As(err, &providerErr) || providerErr.Code != "SLOTS_FULL" || !providerErr.Temporary() {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestClientNormalizesUntrustedProviderErrorMetadata(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name        string
		body        string
		wantCode    string
		wantMessage string
	}{
		{
			name:        "whitespace and controls",
			body:        `{"detail":{"error":" SLOTS_FULL ","message":"busy\r\n\u001b[31m  retry\t later"}}`,
			wantCode:    "SLOTS_FULL",
			wantMessage: "busy [31m retry later",
		},
		{
			name:        "invalid code and bounded message",
			body:        `{"error":"BAD\nCODE","message":"` + strings.Repeat("x", maxErrorMessageBytes+100) + `"}`,
			wantCode:    "",
			wantMessage: strings.Repeat("x", maxErrorMessageBytes),
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				response.WriteHeader(http.StatusServiceUnavailable)
				_, _ = io.WriteString(response, test.body)
			}))
			defer server.Close()
			base, _ := url.Parse(server.URL)
			client, _ := NewClient(base, "", server.Client())
			_, err := client.Start(context.Background(), validStartRequest())
			var providerErr *ProviderError
			if !errors.As(err, &providerErr) {
				t.Fatalf("error = %v, want ProviderError", err)
			}
			if providerErr.Code != test.wantCode || providerErr.Message != test.wantMessage {
				t.Fatalf("provider metadata = code %q message %q", providerErr.Code, providerErr.Message)
			}
			if len(providerErr.Error()) > maxErrorMessageBytes+128 {
				t.Fatalf("provider error escaped its log bound: %d bytes", len(providerErr.Error()))
			}
		})
	}
}

func TestClientDoesNotPartiallyDecodeOversizedProviderError(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(response, `{"error":"SLOTS_FULL","message":"`)
		_, _ = io.WriteString(response, strings.Repeat("x", maxProviderBody))
		_, _ = io.WriteString(response, `"}`)
	}))
	defer server.Close()
	base, _ := url.Parse(server.URL)
	client, _ := NewClient(base, "", server.Client())
	_, err := client.Start(context.Background(), validStartRequest())
	var providerErr *ProviderError
	if !errors.As(err, &providerErr) {
		t.Fatalf("error = %v, want ProviderError", err)
	}
	if providerErr.Code != "" || providerErr.Message != "" {
		t.Fatalf("oversized error was partially decoded: %#v", providerErr)
	}
	if got := providerErr.Error(); got != "ASR provider returned HTTP 503" {
		t.Fatalf("bounded error = %q", got)
	}
}

func TestClientRejectsInvalidStartResponseContract(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		mutate     func(*StartResponse)
		wantDelete bool
	}{
		{name: "unsafe session id", mutate: func(info *StartResponse) { info.SessionID = "../other/session" }},
		{name: "oversized session id", mutate: func(info *StartResponse) { info.SessionID = strings.Repeat("a", maxSessionIDBytes+1) }},
		{name: "missing chunk duration", mutate: func(info *StartResponse) { info.ChunkMS = 0 }, wantDelete: true},
		{name: "excessive chunk duration", mutate: func(info *StartResponse) { info.ChunkMS = maxChunkMS + 1 }, wantDelete: true},
		{name: "different encoding", mutate: func(info *StartResponse) { info.Audio.Encoding = "pcm16" }, wantDelete: true},
		{name: "different sample rate", mutate: func(info *StartResponse) { info.Audio.SampleRate = 8000 }, wantDelete: true},
		{name: "different channel count", mutate: func(info *StartResponse) { info.Audio.Channels = 2 }, wantDelete: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			var deleteCalls atomic.Int32
			handler := http.NewServeMux()
			handler.HandleFunc("POST /v1/sessions", func(response http.ResponseWriter, request *http.Request) {
				var input StartRequest
				_ = json.NewDecoder(request.Body).Decode(&input)
				info := validStartResponse("safe-session", input.Audio)
				test.mutate(&info)
				response.WriteHeader(http.StatusCreated)
				_ = json.NewEncoder(response).Encode(info)
			})
			handler.HandleFunc("DELETE /v1/sessions/{sessionID}", func(response http.ResponseWriter, _ *http.Request) {
				deleteCalls.Add(1)
				_ = json.NewEncoder(response).Encode(map[string]bool{"closed": true})
			})
			server := httptest.NewServer(handler)
			defer server.Close()
			base, _ := url.Parse(server.URL)
			client, _ := NewClient(base, "", server.Client())
			if _, err := client.Start(context.Background(), validStartRequest()); err == nil || !strings.Contains(err.Error(), "invalid ASR session response") {
				t.Fatalf("Start error = %v", err)
			}
			wantDeleteCalls := int32(0)
			if test.wantDelete {
				wantDeleteCalls = 1
			}
			if got := deleteCalls.Load(); got != wantDeleteCalls {
				t.Fatalf("cleanup DELETE calls = %d, want %d", got, wantDeleteCalls)
			}
		})
	}
}

func TestClientRejectsProviderJSONBeyondByteLimit(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(response, `{"ready":true,"padding":"`)
		_, _ = io.WriteString(response, strings.Repeat("x", maxProviderBody))
		_, _ = io.WriteString(response, `"}`)
	}))
	defer server.Close()
	base, _ := url.Parse(server.URL)
	client, _ := NewClient(base, "", server.Client())
	if err := client.Ready(context.Background()); err == nil || !strings.Contains(err.Error(), "response exceeded the byte limit") {
		t.Fatalf("Ready error = %v", err)
	}
}

func TestSessionCloseDoesNotWaitForPeerCloseHandshake(t *testing.T) {
	t.Parallel()

	releasePeer := make(chan struct{})
	handler := http.NewServeMux()
	handler.HandleFunc("POST /v1/sessions", func(response http.ResponseWriter, request *http.Request) {
		var input StartRequest
		_ = json.NewDecoder(request.Body).Decode(&input)
		response.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(response).Encode(validStartResponse("silent-close-peer", input.Audio))
	})
	handler.HandleFunc("GET /v1/sessions/silent-close-peer/audio", func(response http.ResponseWriter, request *http.Request) {
		connection, err := websocket.Accept(response, request, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer connection.CloseNow()
		// Deliberately never read the client's close frame. coder/websocket.Close
		// would wait five seconds for this peer; CloseNow must not.
		<-releasePeer
	})
	handler.HandleFunc("DELETE /v1/sessions/silent-close-peer", func(response http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(response).Encode(map[string]any{"closed": true})
	})
	server := httptest.NewServer(handler)
	defer server.Close()
	defer close(releasePeer)

	base, _ := url.Parse(server.URL)
	client, err := NewClient(base, "", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	stream, err := client.Start(context.Background(), StartRequest{
		Language: "auto", Audio: AudioSpec{Encoding: "pcm32f", SampleRate: 16_000, Channels: 1},
	})
	if err != nil {
		t.Fatal(err)
	}

	started := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := stream.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("Close waited for a peer close handshake: %s", elapsed)
	}
}

func TestSessionDeleteRetriesIndependentlyOfFirstCloseCaller(t *testing.T) {
	t.Parallel()

	var deleteCalls atomic.Int32
	handler := http.NewServeMux()
	handler.HandleFunc("POST /v1/sessions", func(response http.ResponseWriter, request *http.Request) {
		var input StartRequest
		_ = json.NewDecoder(request.Body).Decode(&input)
		response.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(response).Encode(validStartResponse("retry-delete", input.Audio))
	})
	handler.HandleFunc("GET /v1/sessions/retry-delete/audio", func(response http.ResponseWriter, request *http.Request) {
		connection, err := websocket.Accept(response, request, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer connection.CloseNow()
		_, _, _ = connection.Read(context.Background())
	})
	handler.HandleFunc("DELETE /v1/sessions/retry-delete", func(response http.ResponseWriter, request *http.Request) {
		if deleteCalls.Add(1) == 1 {
			// Return a transient provider failure after the first Close caller's
			// deadline. The independent cleanup must keep ownership and retry.
			timer := time.NewTimer(100 * time.Millisecond)
			defer timer.Stop()
			select {
			case <-timer.C:
				response.WriteHeader(http.StatusServiceUnavailable)
				_, _ = io.WriteString(response, `{"error":"TEMPORARY","message":"retry"}`)
			case <-request.Context().Done():
			}
			return
		}
		response.WriteHeader(http.StatusNotFound)
	})
	server := httptest.NewServer(handler)
	defer server.Close()

	base, _ := url.Parse(server.URL)
	client, err := NewClient(base, "", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	stream, err := client.Start(context.Background(), StartRequest{
		Language: "auto", Audio: AudioSpec{Encoding: "pcm32f", SampleRate: 16_000, Channels: 1},
	})
	if err != nil {
		t.Fatal(err)
	}

	firstCtx, firstCancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	started := time.Now()
	err = stream.Close(firstCtx)
	firstCancel()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("first Close error = %v, want deadline exceeded", err)
	}
	if elapsed := time.Since(started); elapsed > 250*time.Millisecond {
		t.Fatalf("first Close exceeded its caller deadline: %s", elapsed)
	}

	retryCtx, retryCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer retryCancel()
	if err := stream.Close(retryCtx); err != nil {
		t.Fatalf("Close did not observe successful background DELETE retry: %v", err)
	}
	if calls := deleteCalls.Load(); calls != 2 {
		t.Fatalf("DELETE calls = %d, want 2", calls)
	}
}

func TestStartValidation(t *testing.T) {
	base, _ := url.Parse("http://localhost:8300")
	client, err := NewClient(base, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Start(context.Background(), StartRequest{Language: "auto", Audio: AudioSpec{Encoding: "float32", SampleRate: 48000, Channels: 1}})
	if err == nil {
		t.Fatal("expected legacy float32 encoding to be rejected")
	}
	_, err = client.Start(context.Background(), StartRequest{Language: "auto", CacheLines: -1, Audio: AudioSpec{Encoding: "pcm32f", SampleRate: 48000, Channels: 1}})
	if err == nil {
		t.Fatal("expected negative cache size to be rejected before calling upstream")
	}
	_, err = client.Start(context.Background(), StartRequest{Language: "en-US\nforged", Audio: AudioSpec{Encoding: "pcm32f", SampleRate: 48000, Channels: 1}})
	if err == nil {
		t.Fatal("expected unsafe language to be rejected before calling upstream")
	}
}

func TestClientDoesNotFollowProviderRedirects(t *testing.T) {
	t.Parallel()
	var targetCalled atomic.Bool
	handler := http.NewServeMux()
	handler.HandleFunc("GET /healthz", func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer provider-secret" {
			t.Error("initial provider request omitted authorization")
		}
		http.Redirect(response, request, "/captured", http.StatusTemporaryRedirect)
	})
	handler.HandleFunc("GET /captured", func(response http.ResponseWriter, _ *http.Request) {
		targetCalled.Store(true)
		response.WriteHeader(http.StatusOK)
	})
	server := httptest.NewServer(handler)
	defer server.Close()

	httpClient := server.Client()
	base, _ := url.Parse(server.URL)
	client, err := NewClient(base, "provider-secret", httpClient)
	if err != nil {
		t.Fatal(err)
	}
	if httpClient.CheckRedirect != nil {
		t.Fatal("NewClient mutated the caller-owned HTTP client")
	}
	if err := client.Ready(context.Background()); err == nil {
		t.Fatal("expected redirect response to be rejected")
	}
	if targetCalled.Load() {
		t.Fatal("provider redirect was followed")
	}
}

func assertBearer(t *testing.T, request *http.Request) {
	t.Helper()
	if request.Header.Get("Authorization") != "Bearer provider-secret" {
		t.Errorf("missing provider authorization header on %s %s", request.Method, request.URL.Path)
	}
}

func writeEvent(ctx context.Context, connection *websocket.Conn, event Event) error {
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	return connection.Write(ctx, websocket.MessageText, payload)
}

func validStartRequest() StartRequest {
	return StartRequest{
		Language: "auto",
		Audio:    AudioSpec{Encoding: "pcm32f", SampleRate: 16_000, Channels: 1},
	}
}

func validStartResponse(sessionID string, audio AudioSpec) StartResponse {
	return StartResponse{
		SessionID:    sessionID,
		WebSocketURL: "ws://provider.invalid/v1/sessions/" + sessionID + "/audio",
		CreatedAt:    float64(time.Now().Unix()),
		Language:     "auto",
		CacheLines:   1000,
		Audio:        audio,
		ChunkMS:      80,
	}
}
