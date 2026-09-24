package providers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/Tularity/t-lingual/internal/config"
	"github.com/Tularity/t-lingual/internal/translate"
)

func endpoint(raw string) *url.URL {
	parsed, err := url.Parse(raw)
	if err != nil {
		panic(err)
	}
	return parsed
}

func TestRegistryPinsSnapshotsAndNeverReturnsCredentials(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/healthz" || request.Header.Get("Authorization") != "Bearer asr-private-key" {
			t.Errorf("ASR request path=%s auth=%q", request.URL.Path, request.Header.Get("Authorization"))
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"ready":true}`))
	}))
	defer server.Close()
	cfg := config.Config{
		Environment: config.Production, AllowInsecureProviders: true,
		ASR:        config.Provider{BaseURL: endpoint(server.URL), APIKey: "asr-private-key"},
		Translator: config.Provider{BaseURL: endpoint("https://translator.example.test"), APIKey: "translator-private-key"},
	}
	registry, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	first := registry.Snapshot()
	if first.ASR == nil || first.Translator == nil || first.Status.Generation != 1 {
		t.Fatalf("initial snapshot = %#v", first.Status)
	}
	if _, ok := first.Translator.(translate.StreamingProvider); !ok {
		t.Fatal("registry snapshot lost the translator streaming capability")
	}
	if err := first.ASR.Ready(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := registry.Validate(Endpoints{ASRURL: server.URL, TranslatorURL: "https://next.example.test"}); err != nil {
		t.Fatal(err)
	}
	if registry.Endpoints().Generation != 1 {
		t.Fatal("validation published a provider")
	}
	status, err := registry.Update(Endpoints{ASRURL: server.URL, TranslatorURL: "https://next.example.test"})
	if err != nil {
		t.Fatal(err)
	}
	second := registry.Snapshot()
	if status.Generation != 2 || first.Translator == second.Translator || first.Status.TranslatorURL != "https://translator.example.test" || second.Status.TranslatorURL != "https://next.example.test" {
		t.Fatalf("provider snapshot changed in place: first=%#v second=%#v", first.Status, second.Status)
	}
	if first.ASR != second.ASR {
		// Rebuilding the same endpoint is allowed, but the old snapshot remains usable.
		if err := first.ASR.Ready(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	encoded, err := json.Marshal(status)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "private-key") || !status.ASRHasCredential || !status.TranslatorHasCredential {
		t.Fatalf("status leaked or obscured credential presence: %s", encoded)
	}
	if unchanged, err := registry.Update(status.Endpoints); err != nil || unchanged.Generation != 2 {
		t.Fatalf("same endpoint update = %#v, %v", unchanged, err)
	}
}

func TestRegistryValidationAndAtomicFailure(t *testing.T) {
	registry, err := New(config.Config{Environment: config.Development})
	if err != nil {
		t.Fatal(err)
	}
	valid := Endpoints{ASRURL: "http://10.130.40.22:8300", TranslatorURL: "https://translator.example.test"}
	if _, err := registry.Update(valid); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{
		"http://example.com:8300", "http://169.254.169.254/latest", "ftp://localhost", "https://user:secret@example.com",
		"https://example.com?key=secret", "https://example.com/#secret", "https://example.com#", "//example.com",
	} {
		t.Run(raw, func(t *testing.T) {
			if _, err := registry.Update(Endpoints{ASRURL: raw, TranslatorURL: valid.TranslatorURL}); err == nil {
				t.Fatal("unsafe endpoint accepted")
			}
			if registry.Endpoints().Endpoints != valid {
				t.Fatalf("invalid update mutated endpoints: %#v", registry.Endpoints())
			}
		})
	}
}

func TestRegistryProductionHTTPRequiresPrivateOptIn(t *testing.T) {
	cfg := config.Config{Environment: config.Production, ASR: config.Provider{BaseURL: endpoint("http://10.203.0.4:8300")}, Translator: config.Provider{BaseURL: endpoint("https://translator.example.test")}}
	if _, err := New(cfg); err == nil {
		t.Fatal("production accepted insecure provider without opt-in")
	}
	cfg.AllowInsecureProviders = true
	if _, err := New(cfg); err != nil {
		t.Fatal(err)
	}
	if registry, err := New(config.Config{Environment: config.Production, AllowInsecureProviders: true, ASR: cfg.ASR}); err != nil || registry.Endpoints().TranslatorConfigured {
		t.Fatalf("ASR-only production registry = %#v, %v", registry, err)
	}
	if _, err := New(config.Config{Environment: config.Production, AllowInsecureProviders: true, ASR: config.Provider{BaseURL: endpoint("http://asr.example.com")}}); err != nil {
		t.Fatalf("explicit insecure opt-in rejected an administrator URL: %v", err)
	}
}

func TestRegistryConcurrentSnapshotsAndUpdates(t *testing.T) {
	registry, err := New(config.Config{Environment: config.Development})
	if err != nil {
		t.Fatal(err)
	}
	var workers sync.WaitGroup
	for index := 0; index < 4; index++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for count := 0; count < 50; count++ {
				_, _ = registry.Update(Endpoints{ASRURL: "http://localhost:8300", TranslatorURL: "https://translator.example.test"})
				_ = registry.Snapshot()
			}
		}()
	}
	workers.Wait()
	if registry.Endpoints().Generation != 2 {
		t.Fatalf("concurrent identical updates = %#v", registry.Endpoints())
	}
}
