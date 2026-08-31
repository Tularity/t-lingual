package translate

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestClientUsesStableTranslationContract(t *testing.T) {
	t.Parallel()
	handler := http.NewServeMux()
	handler.HandleFunc("GET /health/ready", func(response http.ResponseWriter, request *http.Request) {
		_ = json.NewEncoder(response).Encode(map[string]string{"status": "ready"})
	})
	handler.HandleFunc("POST /v1/translate", func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Content-Type") != "application/json" || request.Header.Get("Authorization") != "Bearer future-key" {
			t.Errorf("unexpected headers: %#v", request.Header)
		}
		var input Request
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
			t.Error(err)
			return
		}
		if input.SourceLanguage != "zh-CN" || input.TargetLanguage != "en-US" || input.Text != "你好" {
			t.Errorf("unexpected translation input: %#v", input)
		}
		_ = json.NewEncoder(response).Encode(Response{
			RequestID:      "01KTEST",
			SourceLanguage: "zh-Hans",
			TargetLanguage: "en",
			Translation:    "Hello",
			Model:          "xiaomi-research/MiLMMT-46-4B-v1.0",
			Usage:          Usage{InputTokens: 2, OutputTokens: 1},
		})
	})
	server := httptest.NewServer(handler)
	defer server.Close()
	base, _ := url.Parse(server.URL)
	client, err := NewClient(base, "future-key", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Ready(context.Background()); err != nil {
		t.Fatal(err)
	}
	result, err := client.Translate(context.Background(), Request{SourceLanguage: "zh-CN", TargetLanguage: "en-US", Text: "你好"})
	if err != nil {
		t.Fatal(err)
	}
	if result.Translation != "Hello" || result.RequestID != "01KTEST" || result.Usage.OutputTokens != 1 {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestClientPreservesRetryMetadata(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Retry-After", "3")
		response.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(response).Encode(map[string]any{"error": map[string]string{
			"code": "capacity_exhausted", "message": "busy", "request_id": "01KBUSY",
		}})
	}))
	defer server.Close()
	base, _ := url.Parse(server.URL)
	client, _ := NewClient(base, "", server.Client())
	_, err := client.Translate(context.Background(), Request{SourceLanguage: "en-US", TargetLanguage: "fr-FR", Text: "hello"})
	var providerErr *ProviderError
	if !errors.As(err, &providerErr) || !providerErr.Temporary() || providerErr.RetryAfter != 3*time.Second || providerErr.RequestID != "01KBUSY" {
		t.Fatalf("unexpected provider error: %#v (%v)", providerErr, err)
	}
}

func TestClientDropsUntrustedErrorMetadata(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Retry-After", "999999999")
		response.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(response).Encode(map[string]any{"error": map[string]string{
			"code":       strings.Repeat("x", maxProviderCodeBytes+1),
			"message":    strings.Repeat("m", maxProviderMessageBytes+1),
			"request_id": "request\nlog-injection",
		}})
	}))
	defer server.Close()
	base, _ := url.Parse(server.URL)
	client, _ := NewClient(base, "", server.Client())
	_, err := client.Translate(context.Background(), Request{SourceLanguage: "en", TargetLanguage: "fr", Text: "hello"})
	var providerErr *ProviderError
	if !errors.As(err, &providerErr) {
		t.Fatalf("unexpected error: %v", err)
	}
	if providerErr.Code != "" || providerErr.Message != "" || providerErr.RequestID != "" || providerErr.RetryAfter != 0 {
		t.Fatalf("untrusted metadata survived: %#v", providerErr)
	}
}

func TestClientRejectsUntrustedResponseIdentityAndLanguage(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Response)
	}{
		{name: "wrong target language", mutate: func(result *Response) { result.TargetLanguage = "de" }},
		{name: "oversized request identity", mutate: func(result *Response) { result.RequestID = strings.Repeat("x", 257) }},
		{name: "zero usage", mutate: func(result *Response) { result.Usage.OutputTokens = 0 }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				result := Response{
					RequestID: "01KVALID", SourceLanguage: "en", TargetLanguage: "fr",
					Translation: "bonjour", Model: "xiaomi-research/MiLMMT-46-4B-v1.0",
					Usage: Usage{InputTokens: 2, OutputTokens: 1},
				}
				test.mutate(&result)
				_ = json.NewEncoder(response).Encode(result)
			}))
			defer server.Close()
			base, _ := url.Parse(server.URL)
			client, _ := NewClient(base, "", server.Client())
			if _, err := client.Translate(context.Background(), Request{
				SourceLanguage: "en-US", TargetLanguage: "fr-FR", Text: "hello",
			}); err == nil {
				t.Fatal("accepted an invalid translation response")
			}
		})
	}
}

func TestRequestValidationMatchesProviderLimits(t *testing.T) {
	tests := []Request{
		{SourceLanguage: "en-US", TargetLanguage: "fr-FR", Text: ""},
		{SourceLanguage: "language-tag-too-long", TargetLanguage: "fr", Text: "hello"},
		{SourceLanguage: "en", TargetLanguage: "fr", Text: string([]byte{'a', 0, 'b'})},
	}
	for _, input := range tests {
		if err := validateRequest(input); err == nil {
			t.Fatalf("expected invalid request: %#v", input)
		}
	}
}

func TestClientDoesNotFollowProviderRedirects(t *testing.T) {
	t.Parallel()
	var targetCalled atomic.Bool
	handler := http.NewServeMux()
	handler.HandleFunc("GET /health/ready", func(response http.ResponseWriter, request *http.Request) {
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
