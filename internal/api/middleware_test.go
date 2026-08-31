package api

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/config"
)

func TestClientAddressOnlyTrustsConfiguredProxyChain(t *testing.T) {
	server := &API{config: config.Config{TrustedProxyCIDRs: []netip.Prefix{
		netip.MustParsePrefix("10.0.0.0/8"),
		netip.MustParsePrefix("fd00::/8"),
	}}}

	trusted := httptest.NewRequest(http.MethodPost, "/", nil)
	trusted.RemoteAddr = "10.1.2.3:4321"
	trusted.Header.Set("X-Forwarded-For", "198.51.100.44, 10.2.3.4")
	if got := server.clientAddress(trusted); got != "198.51.100.44" {
		t.Fatalf("trusted proxy chain resolved %q", got)
	}

	untrusted := httptest.NewRequest(http.MethodPost, "/", nil)
	untrusted.RemoteAddr = "203.0.113.8:4321"
	untrusted.Header.Set("X-Forwarded-For", "198.51.100.44")
	if got := server.clientAddress(untrusted); got != "203.0.113.8" {
		t.Fatalf("untrusted peer spoofed forwarded address: %q", got)
	}

	malformed := httptest.NewRequest(http.MethodPost, "/", nil)
	malformed.RemoteAddr = "10.1.2.3:4321"
	malformed.Header.Set("X-Forwarded-For", "198.51.100.44, not-an-address")
	if got := server.clientAddress(malformed); got != "10.1.2.3" {
		t.Fatalf("malformed trusted chain did not fail closed to peer: %q", got)
	}
}

func TestAuthRateKeyNormalizesIPv6Prefix(t *testing.T) {
	first := authRateKey("2001:db8:abcd:12::1")
	second := authRateKey("[2001:db8:abcd:12::ffff]:443")
	other := authRateKey("2001:db8:abcd:13::1")
	if first != "2001:db8:abcd:12::/64" || first != second || first == other {
		t.Fatalf("unexpected IPv6 rate keys: first=%q second=%q other=%q", first, second, other)
	}
	if got := authRateKey("::ffff:192.0.2.8"); got != "192.0.2.8" {
		t.Fatalf("IPv4-mapped address key = %q", got)
	}
}

func TestPerClientRejectionDoesNotConsumeGlobalAuthBudget(t *testing.T) {
	server := &API{
		loginLimiter:        newIPLimiter(1, time.Minute, 16),
		registrationLimiter: newIPLimiter(1, time.Minute, 16),
		authGlobalLimiter:   newIPLimiter(2, time.Minute, 1),
	}
	request := func(remote string) *http.Request {
		result := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login/begin", nil)
		result.RemoteAddr = remote
		return result
	}

	if err := server.rateLimitAuth(httptest.NewRecorder(), request("192.0.2.1:1000"), authLogin); err != nil {
		t.Fatalf("first client was rejected: %v", err)
	}
	rejected := httptest.NewRecorder()
	if err := server.rateLimitAuth(rejected, request("192.0.2.1:1001"), authLogin); err == nil {
		t.Fatal("client prefix budget did not reject the second request")
	}
	if rejected.Header().Get("Retry-After") == "" {
		t.Fatal("rate-limited response omitted Retry-After")
	}
	if err := server.rateLimitAuth(httptest.NewRecorder(), request("192.0.2.2:1000"), authLogin); err != nil {
		t.Fatalf("local rejection consumed global budget: %v", err)
	}
	if err := server.rateLimitAuth(httptest.NewRecorder(), request("192.0.2.3:1000"), authLogin); err == nil {
		t.Fatal("global budget did not bound distinct-client churn")
	}
	if err := server.rateLimitAuth(httptest.NewRecorder(), request("192.0.2.1:1002"), authRegistration); err == nil {
		t.Fatal("registration unexpectedly bypassed the exhausted global budget")
	}
}
