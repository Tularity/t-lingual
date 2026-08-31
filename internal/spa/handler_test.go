package spa

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHandlerServesAssetsAndClientRoutes(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "assets"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "index.html"), []byte("<main>app</main>"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "assets", "app-abc.js"), []byte("export{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	handler, err := New(root, true)
	if err != nil {
		t.Fatal(err)
	}

	for _, route := range []string{"/", "/sessions/one", "/admin"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, route, nil))
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "app") {
			t.Fatalf("route %s: status=%d body=%q", route, response.Code, response.Body.String())
		}
		if response.Header().Get("Strict-Transport-Security") == "" {
			t.Fatalf("route %s omitted HSTS", route)
		}
		policy := response.Header().Get("Content-Security-Policy")
		if !strings.Contains(policy, "connect-src 'self'") || strings.Contains(policy, "ws:") || strings.Contains(policy, "wss:") {
			t.Fatalf("route %s has an over-broad connection policy %q", route, policy)
		}
	}

	asset := httptest.NewRecorder()
	handler.ServeHTTP(asset, httptest.NewRequest(http.MethodGet, "/assets/app-abc.js", nil))
	if asset.Code != http.StatusOK || !strings.Contains(asset.Header().Get("Cache-Control"), "immutable") {
		t.Fatalf("asset: status=%d cache=%q", asset.Code, asset.Header().Get("Cache-Control"))
	}

	missing := httptest.NewRecorder()
	handler.ServeHTTP(missing, httptest.NewRequest(http.MethodGet, "/assets/missing.js", nil))
	if missing.Code != http.StatusNotFound || strings.Contains(missing.Body.String(), "<main>") {
		t.Fatalf("missing asset returned %d %q", missing.Code, missing.Body.String())
	}
}

func TestHandlerRejectsMutationAndMissingRoot(t *testing.T) {
	if _, err := New(t.TempDir(), false); err == nil {
		t.Fatal("expected missing index to fail")
	}
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "index.html"), []byte("index"), 0o600); err != nil {
		t.Fatal(err)
	}
	handler, err := New(root, false)
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/", nil))
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("got %d", response.Code)
	}
}
