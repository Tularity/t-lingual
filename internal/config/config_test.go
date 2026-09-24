package config

import "testing"

func lookup(values map[string]string) func(string) (string, bool) {
	return func(key string) (string, bool) {
		value, ok := values[key]
		return value, ok
	}
}

func TestDevelopmentDefaults(t *testing.T) {
	config, err := FromLookup(lookup(nil))
	if err != nil {
		t.Fatal(err)
	}
	if config.RPID != "localhost" || config.ListenAddr != "127.0.0.1:8088" || config.CookieSecure || config.SessionCookieName != "tlingual_session" || config.SessionTTL.Hours() != 168 {
		t.Fatalf("unexpected defaults: %#v", config)
	}
}

func TestProductionRequiresHTTPS(t *testing.T) {
	_, err := FromLookup(lookup(map[string]string{
		"TLINGUAL_ENV":        "production",
		"TLINGUAL_PUBLIC_URL": "http://localhost:8080",
	}))
	if err == nil {
		t.Fatal("expected insecure production URL to fail")
	}
}

func TestProductionCanStartBeforeProviderEndpointsAreConfigured(t *testing.T) {
	base := map[string]string{
		"TLINGUAL_ENV":                 "production",
		"TLINGUAL_PUBLIC_URL":          "https://lingual.example.com",
		"TLINGUAL_TRUSTED_PROXY_CIDRS": "172.20.0.1/32",
	}
	if cfg, err := FromLookup(lookup(base)); err != nil || cfg.ASR.Enabled() || cfg.Translator.Enabled() {
		t.Fatalf("empty production provider config = %#v, %v", cfg, err)
	}
	base["TLINGUAL_ASR_BASE_URL"] = "https://asr.example.com"
	if cfg, err := FromLookup(lookup(base)); err != nil || !cfg.ASR.Enabled() || cfg.Translator.Enabled() {
		t.Fatalf("ASR-only production provider config = %#v, %v", cfg, err)
	}
	base["TLINGUAL_TRANSLATOR_BASE_URL"] = "https://translator.example.com"
	if _, err := FromLookup(lookup(base)); err != nil {
		t.Fatalf("complete production provider config failed: %v", err)
	}
}

func TestNonLoopbackRequiresHTTPS(t *testing.T) {
	_, err := FromLookup(lookup(map[string]string{"TLINGUAL_PUBLIC_URL": "http://example.com"}))
	if err == nil {
		t.Fatal("expected insecure non-loopback URL to fail")
	}
}

func TestProviderRejectsEmbeddedCredentials(t *testing.T) {
	_, err := FromLookup(lookup(map[string]string{"TLINGUAL_ASR_BASE_URL": "https://user:secret@example.com"}))
	if err == nil {
		t.Fatal("expected provider URL credentials to fail")
	}
}

func TestProductionProvidersRequireTLSUnlessExplicitlyAllowed(t *testing.T) {
	base := map[string]string{
		"TLINGUAL_ENV":                 "production",
		"TLINGUAL_PUBLIC_URL":          "https://lingual.example.com",
		"TLINGUAL_TRUSTED_PROXY_CIDRS": "172.20.0.1/32",
		"TLINGUAL_ASR_BASE_URL":        "http://asr.internal:8300",
		"TLINGUAL_TRANSLATOR_BASE_URL": "http://translator.internal:8080",
	}
	if _, err := FromLookup(lookup(base)); err == nil {
		t.Fatal("expected plaintext production provider to fail closed")
	}

	base["TLINGUAL_ALLOW_INSECURE_PROVIDERS"] = "true"
	config, err := FromLookup(lookup(base))
	if err != nil {
		t.Fatal(err)
	}
	if !config.AllowInsecureProviders || config.ASR.BaseURL == nil || config.ASR.BaseURL.Scheme != "http" {
		t.Fatalf("insecure provider opt-in was not preserved: %#v", config)
	}
}

func TestProductionAcceptsTLSProviders(t *testing.T) {
	config, err := FromLookup(lookup(map[string]string{
		"TLINGUAL_ENV":                 "production",
		"TLINGUAL_PUBLIC_URL":          "https://lingual.example.com",
		"TLINGUAL_TRUSTED_PROXY_CIDRS": "172.20.0.1/32",
		"TLINGUAL_ASR_BASE_URL":        "https://asr.example.com",
		"TLINGUAL_TRANSLATOR_BASE_URL": "https://translator.example.com",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if config.AllowInsecureProviders {
		t.Fatal("TLS providers unexpectedly enabled insecure transport")
	}
}

func TestInsecureProviderOptInMustBeBoolean(t *testing.T) {
	_, err := FromLookup(lookup(map[string]string{"TLINGUAL_ALLOW_INSECURE_PROVIDERS": "sometimes"}))
	if err == nil {
		t.Fatal("expected invalid insecure-provider opt-in to fail")
	}
}

func TestTrustedProxyCIDRsAreExplicitAndValidated(t *testing.T) {
	config, err := FromLookup(lookup(map[string]string{
		"TLINGUAL_TRUSTED_PROXY_CIDRS": "127.0.0.1/32, 172.16.0.0/12,2001:db8:1::/48",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if len(config.TrustedProxyCIDRs) != 3 || config.TrustedProxyCIDRs[1].String() != "172.16.0.0/12" {
		t.Fatalf("unexpected trusted proxy prefixes: %#v", config.TrustedProxyCIDRs)
	}
	if _, err := FromLookup(lookup(map[string]string{
		"TLINGUAL_TRUSTED_PROXY_CIDRS": "not-a-network",
	})); err == nil {
		t.Fatal("expected invalid trusted proxy CIDR to fail")
	}
	for _, wildcard := range []string{"0.0.0.0/0", "::/0"} {
		if _, err := FromLookup(lookup(map[string]string{
			"TLINGUAL_TRUSTED_PROXY_CIDRS": wildcard,
		})); err == nil {
			t.Fatalf("expected wildcard trusted proxy CIDR %q to fail", wildcard)
		}
	}
}

func TestProductionRequiresTrustedReverseProxyNetwork(t *testing.T) {
	_, err := FromLookup(lookup(map[string]string{
		"TLINGUAL_ENV":        "production",
		"TLINGUAL_PUBLIC_URL": "https://lingual.example.com",
	}))
	if err == nil {
		t.Fatal("expected production without a trusted proxy network to fail")
	}
}

func TestOriginsAreValidated(t *testing.T) {
	_, err := FromLookup(lookup(map[string]string{"TLINGUAL_RP_ORIGINS": "https://example.com/path"}))
	if err == nil {
		t.Fatal("expected origin path to fail")
	}
}

func TestAdditionalOriginsKeepPublicOriginAndAreDeduplicated(t *testing.T) {
	config, err := FromLookup(lookup(map[string]string{
		"TLINGUAL_PUBLIC_URL": "https://lingual.example.com",
		"TLINGUAL_RP_ORIGINS": "https://preview.example.com, https://lingual.example.com,https://preview.example.com/",
	}))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"https://lingual.example.com", "https://preview.example.com"}
	if len(config.RPOrigins) != len(want) {
		t.Fatalf("unexpected origins: %#v", config.RPOrigins)
	}
	for i := range want {
		if config.RPOrigins[i] != want[i] {
			t.Fatalf("origin %d = %q, want %q", i, config.RPOrigins[i], want[i])
		}
	}
}
