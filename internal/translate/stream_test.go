package translate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func sseEvent(t *testing.T, name string, value any) string {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return "event: " + name + "\ndata: " + string(data) + "\n\n"
}

func streamServer(t *testing.T, frames string, status int, contentType string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/translate/stream" || r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("stream request route or media type = %s %s %s", r.Method, r.URL.Path, r.Header.Get("Content-Type"))
		}
		w.Header().Set("X-Request-ID", "01KSTREAM")
		w.Header().Set("Content-Type", contentType)
		w.WriteHeader(status)
		_, _ = fmt.Fprint(w, frames)
	}))
}

func streamingClient(t *testing.T, server *httptest.Server) *Client {
	t.Helper()
	base, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	client, err := NewClient(base, "", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func validStreamFrames(t *testing.T, text string) string {
	t.Helper()
	frames := sseEvent(t, "start", map[string]any{"request_id": "01KSTREAM", "source_language": "en", "target_language": "fr", "model": streamModel, "provisional": true})
	frames += ": keep-alive\n\n"
	for index, runeValue := range []rune(text) {
		frames += sseEvent(t, "delta", map[string]any{"request_id": "01KSTREAM", "index": index + 1, "text": string(runeValue), "provisional": true})
	}
	frames += sseEvent(t, "complete", map[string]any{"request_id": "01KSTREAM", "source_language": "en", "target_language": "fr", "translation": text, "model": streamModel, "usage": map[string]any{"input_tokens": 2, "output_tokens": 3}, "validated": true})
	return frames
}

func TestTranslateStreamCumulativeUnicodeAndValidatedTerminal(t *testing.T) {
	text := "é👩‍💻"
	server := streamServer(t, validStreamFrames(t, text), http.StatusOK, "text/event-stream")
	defer server.Close()
	client := streamingClient(t, server)
	var updates []StreamUpdate
	result, err := client.TranslateStream(context.Background(), Request{SourceLanguage: "en-US", TargetLanguage: "fr-FR", Text: "hello"}, func(update StreamUpdate) error {
		updates = append(updates, update)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Translation != text || result.SourceLanguage != "en" || result.TargetLanguage != "fr" || result.RequestID != "01KSTREAM" {
		t.Fatalf("terminal result = %#v", result)
	}
	want := []StreamUpdate{{"01KSTREAM", 1, "é"}, {"01KSTREAM", 2, "é👩"}, {"01KSTREAM", 3, "é👩‍"}, {"01KSTREAM", 4, text}}
	if !reflect.DeepEqual(updates, want) {
		t.Fatalf("cumulative updates = %#v, want %#v", updates, want)
	}
}

func TestTranslateStreamRejectsInvalidSequenceOrTerminal(t *testing.T) {
	start := sseEvent(t, "start", map[string]any{"request_id": "01KSTREAM", "source_language": "en", "target_language": "fr", "model": streamModel, "provisional": true})
	delta := sseEvent(t, "delta", map[string]any{"request_id": "01KSTREAM", "index": 1, "text": "B", "provisional": true})
	complete := sseEvent(t, "complete", map[string]any{"request_id": "01KSTREAM", "source_language": "en", "target_language": "fr", "translation": "B", "model": streamModel, "usage": map[string]any{"input_tokens": 2, "output_tokens": 1}, "validated": true})
	for _, test := range []struct{ name, frames, contentType string }{
		{"delta before start", delta + complete, "text/event-stream"},
		{"missing terminal", start + delta, "text/event-stream"},
		{"wrong delta index", start + strings.Replace(delta, `"index":1`, `"index":2`, 1) + complete, "text/event-stream"},
		{"wrong request", start + strings.Replace(delta, "01KSTREAM", "01KOTHER", 1) + complete, "text/event-stream"},
		{"multiple scalars", start + strings.Replace(delta, `"text":"B"`, `"text":"BB"`, 1) + complete, "text/event-stream"},
		{"unvalidated complete", start + delta + strings.Replace(complete, `"validated":true`, `"validated":false`, 1), "text/event-stream"},
		{"complete not matching delta", start + delta + strings.Replace(complete, `"translation":"B"`, `"translation":"C"`, 1), "text/event-stream"},
		{"wrong terminal target", start + delta + strings.Replace(complete, `"target_language":"fr"`, `"target_language":"de"`, 1), "text/event-stream"},
		{"duplicate terminal", start + delta + complete + complete, "text/event-stream"},
		{"wrong content type", start + delta + complete, "application/json"},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := streamServer(t, test.frames, http.StatusOK, test.contentType)
			defer server.Close()
			result, err := streamingClient(t, server).TranslateStream(context.Background(), Request{SourceLanguage: "en", TargetLanguage: "fr", Text: "hello"}, func(StreamUpdate) error { return nil })
			if err == nil || result != (Response{}) {
				t.Fatalf("invalid stream accepted: result=%#v error=%v", result, err)
			}
		})
	}
}

func TestTranslateStreamPreflightJSONAndSSEErrorAreFailures(t *testing.T) {
	preflight := `{"error":{"code":"source_language_detection_failed","message":"Provide source explicitly.","request_id":"01KSTREAM"}}`
	server := streamServer(t, preflight, http.StatusUnprocessableEntity, "application/json")
	var callbacks atomic.Int32
	result, err := streamingClient(t, server).TranslateStream(context.Background(), Request{SourceLanguage: "auto", TargetLanguage: "fr", Text: "hello"}, func(StreamUpdate) error { callbacks.Add(1); return nil })
	server.Close()
	var providerErr *ProviderError
	if !errors.As(err, &providerErr) || providerErr.StatusCode != 422 || providerErr.Code != "source_language_detection_failed" || callbacks.Load() != 0 || result != (Response{}) {
		t.Fatalf("preflight result=%#v error=%v", result, err)
	}
	frames := sseEvent(t, "start", map[string]any{"request_id": "01KSTREAM", "source_language": "en", "target_language": "fr", "model": streamModel, "provisional": true}) +
		sseEvent(t, "delta", map[string]any{"request_id": "01KSTREAM", "index": 1, "text": "B", "provisional": true}) +
		sseEvent(t, "error", map[string]any{"request_id": "01KSTREAM", "error": map[string]any{"code": "output_validation_failed", "message": "Translation failed output validation."}})
	server = streamServer(t, frames, http.StatusOK, "text/event-stream")
	defer server.Close()
	result, err = streamingClient(t, server).TranslateStream(context.Background(), Request{SourceLanguage: "en", TargetLanguage: "fr", Text: "hello"}, func(StreamUpdate) error { callbacks.Add(1); return nil })
	if !errors.As(err, &providerErr) || providerErr.Code != "output_validation_failed" || result != (Response{}) || callbacks.Load() != 1 {
		t.Fatalf("SSE error result=%#v error=%v callbacks=%d", result, err, callbacks.Load())
	}
}

func TestTranslateStreamCancellationAndInputLimit(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("X-Request-ID", "01KSTREAM")
		_, _ = fmt.Fprint(w, sseEvent(t, "start", map[string]any{"request_id": "01KSTREAM", "source_language": "en", "target_language": "fr", "model": streamModel, "provisional": true})+
			sseEvent(t, "delta", map[string]any{"request_id": "01KSTREAM", "index": 1, "text": "B", "provisional": true}))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	client := streamingClient(t, server)
	if _, err := client.TranslateStream(context.Background(), Request{SourceLanguage: "en", TargetLanguage: "fr", Text: strings.Repeat("a", streamTextMax+1)}, func(StreamUpdate) error { return nil }); err == nil || requests.Load() != 0 {
		t.Fatal("oversized input sent to provider")
	}
	stop := errors.New("stop updates")
	result, err := client.TranslateStream(context.Background(), Request{SourceLanguage: "en", TargetLanguage: "fr", Text: "hello"}, func(StreamUpdate) error { return stop })
	if !errors.Is(err, stop) || result != (Response{}) || requests.Load() != 1 {
		t.Fatalf("callback abort result=%#v error=%v requests=%d", result, err, requests.Load())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	result, err = client.TranslateStream(ctx, Request{SourceLanguage: "en", TargetLanguage: "fr", Text: "hello"}, func(StreamUpdate) error { return nil })
	if err == nil || result != (Response{}) {
		t.Fatalf("deadline result=%#v error=%v", result, err)
	}
}

func TestLargeTerminalEventWithinDocumentedOutputBoundDecodes(t *testing.T) {
	value := map[string]any{
		"request_id": "01KLARGE", "source_language": "en", "target_language": "fr",
		"translation": strings.Repeat("a", streamOutputMax), "model": streamModel,
		"usage": map[string]any{"input_tokens": 1, "output_tokens": 1}, "validated": true,
	}
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var event streamComplete
	if err := decodeStreamData(string(data), &event); err != nil || len(event.Translation) != streamOutputMax {
		t.Fatalf("documented maximum terminal event rejected: bytes=%d err=%v", len(data), err)
	}
}

func TestStreamingRequestUsesDocumentedByteLimitNotLegacyCharacterLimit(t *testing.T) {
	input := Request{SourceLanguage: "en", TargetLanguage: "fr", Text: strings.Repeat("a", 5000)}
	if err := validateStreamRequest(input); err != nil {
		t.Fatalf("valid 5000-byte GPU request rejected: %v", err)
	}
	input.Text = strings.Repeat("a", streamTextMax+1)
	if err := validateStreamRequest(input); err == nil {
		t.Fatal("GPU request above 8 KiB accepted")
	}
}

func TestAutoSourceContextMetadataAndWireShape(t *testing.T) {
	detection := SourceDetection{Method: "fasttext-lid.176", Confidence: .83, Rank: 2, Uncertain: true, ContextUsed: true}
	frames := sseEvent(t, "start", map[string]any{"request_id": "01KSTREAM", "source_language": "da", "source_detection": detection, "target_language": "en", "model": streamModel, "provisional": true})
	frames += sseEvent(t, "delta", map[string]any{"request_id": "01KSTREAM", "index": 1, "text": "T", "provisional": true})
	frames += sseEvent(t, "complete", map[string]any{"request_id": "01KSTREAM", "source_language": "da", "source_detection": detection, "target_language": "en", "translation": "T", "model": streamModel, "usage": map[string]any{"input_tokens": 2, "output_tokens": 1}, "validated": true})
	var wire Request
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&wire); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("X-Request-ID", "01KSTREAM")
		_, _ = fmt.Fprint(w, frames)
	}))
	defer server.Close()
	input := Request{SourceLanguage: "auto", TargetLanguage: "en", Text: "Tak.", SourceContext: "Denne ordre bliver leveret i morgen."}
	result, err := streamingClient(t, server).TranslateStream(context.Background(), input, func(StreamUpdate) error { return nil })
	if err != nil || result.SourceLanguage != "da" || result.SourceDetection == nil || *result.SourceDetection != detection || wire.SourceContext != input.SourceContext {
		t.Fatalf("context-assisted stream result=%#v wire=%#v error=%v", result, wire, err)
	}
}

func TestSourceContextPreflightRejectsMisuseBeforeNetwork(t *testing.T) {
	for _, input := range []Request{
		{SourceLanguage: "en", TargetLanguage: "fr", Text: "hello", SourceContext: "More English text."},
		{SourceLanguage: "auto", TargetLanguage: "fr", Text: strings.Repeat("a", 33), SourceContext: "English context."},
		{SourceLanguage: "auto", TargetLanguage: "fr", Text: "OK", SourceContext: strings.Repeat("界", 171)},
		{SourceLanguage: "auto", TargetLanguage: "fr", Text: "OK", SourceContext: " \n"},
	} {
		if err := validateStreamRequest(input); err == nil {
			t.Fatalf("invalid source context accepted: %#v", input)
		}
	}
}

func TestAutoStreamRejectsMissingOrChangedDetection(t *testing.T) {
	good := SourceDetection{Method: "fasttext-lid.176", Confidence: .8, Rank: 1, Uncertain: false, ContextUsed: false}
	start := sseEvent(t, "start", map[string]any{"request_id": "01KSTREAM", "source_language": "en", "source_detection": good, "target_language": "fr", "model": streamModel, "provisional": true})
	delta := sseEvent(t, "delta", map[string]any{"request_id": "01KSTREAM", "index": 1, "text": "B", "provisional": true})
	complete := sseEvent(t, "complete", map[string]any{"request_id": "01KSTREAM", "source_language": "en", "source_detection": good, "target_language": "fr", "translation": "B", "model": streamModel, "usage": map[string]any{"input_tokens": 2, "output_tokens": 1}, "validated": true})
	for _, frames := range []string{
		strings.Replace(start, `"source_detection":{`, `"source_detection_missing":{`, 1) + delta + complete,
		start + delta + strings.Replace(complete, `"rank":1`, `"rank":2`, 1),
		start + delta + strings.Replace(complete, `"source_language":"en"`, `"source_language":"auto"`, 1),
	} {
		server := streamServer(t, frames, http.StatusOK, "text/event-stream")
		result, err := streamingClient(t, server).TranslateStream(context.Background(), Request{SourceLanguage: "auto", TargetLanguage: "fr", Text: "hello"}, func(StreamUpdate) error { return nil })
		server.Close()
		if err == nil || result != (Response{}) {
			t.Fatalf("invalid detection accepted: %#v %v", result, err)
		}
	}
}

// This is never run in normal CI. Set an exact local GPU gateway URL only for
// a deliberate one-request smoke; do not use a real service in regression tests.
func TestOptInRealStreamingSmoke(t *testing.T) {
	raw := os.Getenv("TLINGUAL_TRANSLATOR_SMOKE_URL")
	if raw == "" {
		t.Skip("requires an explicitly selected local translator endpoint")
	}
	base, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	client, err := NewClient(base, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var updates int
	result, err := client.TranslateStream(ctx, Request{SourceLanguage: "en", TargetLanguage: "fr", Text: "The service is ready."}, func(update StreamUpdate) error {
		updates++
		if update.Index != uint64(updates) {
			return errors.New("non-contiguous stream update")
		}
		return nil
	})
	if err != nil || result.Translation != "Le service est prêt." || updates == 0 {
		t.Fatalf("bounded real stream smoke: update count=%d result=%#v err=%v", updates, result, err)
	}
}

func TestOptInRealAutoStreamingSmoke(t *testing.T) {
	raw := os.Getenv("TLINGUAL_TRANSLATOR_SMOKE_URL")
	if raw == "" {
		t.Skip("requires an explicitly selected local translator endpoint")
	}
	base, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	client, err := NewClient(base, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	result, err := client.TranslateStream(ctx, Request{SourceLanguage: "auto", TargetLanguage: "fr", Text: "The service is ready."}, func(StreamUpdate) error { return nil })
	if err != nil || result.SourceLanguage != "en" || result.Translation != "Le service est prêt." ||
		result.SourceDetection == nil || result.SourceDetection.Method != "fasttext-lid.176" || result.SourceDetection.ContextUsed {
		t.Fatalf("real auto streaming response=%#v err=%v", result, err)
	}
}
