package config

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Environment string

const (
	Development Environment = "development"
	Production  Environment = "production"
)

type Provider struct {
	BaseURL *url.URL
	APIKey  string
}

func (p Provider) Enabled() bool { return p.BaseURL != nil }

type Config struct {
	Environment            Environment
	ListenAddr             string
	PublicURL              *url.URL
	RPID                   string
	RPDisplayName          string
	RPOrigins              []string
	DataPath               string
	MasterKeyPath          string
	AdminSocket            string
	WebRoot                string
	SessionCookieName      string
	CookieSecure           bool
	SessionTTL             time.Duration
	CeremonyTTL            time.Duration
	InvitationTTL          time.Duration
	ShutdownTimeout        time.Duration
	MaxJSONBytes           int64
	AllowInsecureProviders bool
	TrustedProxyCIDRs      []netip.Prefix
	ASR                    Provider
	Translator             Provider
}

func Load() (Config, error) { return FromLookup(os.LookupEnv) }

func FromLookup(lookup func(string) (string, bool)) (Config, error) {
	get := func(key, fallback string) string {
		if value, ok := lookup(key); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
		return fallback
	}

	environment := Environment(strings.ToLower(get("TLINGUAL_ENV", string(Development))))
	if environment != Development && environment != Production {
		return Config{}, fmt.Errorf("TLINGUAL_ENV must be %q or %q", Development, Production)
	}

	publicURL, err := parsePublicURL(get("TLINGUAL_PUBLIC_URL", "http://localhost:8088"))
	if err != nil {
		return Config{}, err
	}
	if publicURL.Scheme != "https" && !isLoopbackHost(publicURL.Hostname()) {
		return Config{}, errors.New("TLINGUAL_PUBLIC_URL must use https outside loopback development")
	}
	if environment == Production && publicURL.Scheme != "https" {
		return Config{}, errors.New("production requires an https TLINGUAL_PUBLIC_URL")
	}

	rpID := get("TLINGUAL_RP_ID", publicURL.Hostname())
	if net.ParseIP(rpID) == nil && strings.Contains(rpID, ":") {
		return Config{}, errors.New("TLINGUAL_RP_ID must be a hostname without a port")
	}
	primaryOrigin := origin(publicURL)
	origins := []string{primaryOrigin}
	if raw, ok := lookup("TLINGUAL_RP_ORIGINS"); ok {
		origins = appendUnique(origins, splitNonEmpty(raw)...)
	}
	for _, value := range origins {
		parsed, parseErr := parsePublicURL(value)
		if parseErr != nil || origin(parsed) != value {
			return Config{}, fmt.Errorf("invalid WebAuthn origin %q", value)
		}
	}

	sessionTTL, err := duration(get("TLINGUAL_SESSION_TTL", "168h"), "TLINGUAL_SESSION_TTL")
	if err != nil {
		return Config{}, err
	}
	ceremonyTTL, err := duration(get("TLINGUAL_CEREMONY_TTL", "5m"), "TLINGUAL_CEREMONY_TTL")
	if err != nil {
		return Config{}, err
	}
	invitationTTL, err := duration(get("TLINGUAL_INVITATION_TTL", "168h"), "TLINGUAL_INVITATION_TTL")
	if err != nil {
		return Config{}, err
	}
	shutdownTimeout, err := duration(get("TLINGUAL_SHUTDOWN_TIMEOUT", "15s"), "TLINGUAL_SHUTDOWN_TIMEOUT")
	if err != nil {
		return Config{}, err
	}
	maxJSONBytes, err := strconv.ParseInt(get("TLINGUAL_MAX_JSON_BYTES", "1048576"), 10, 64)
	if err != nil || maxJSONBytes < 1024 {
		return Config{}, errors.New("TLINGUAL_MAX_JSON_BYTES must be an integer of at least 1024")
	}
	allowInsecureProviders, err := strconv.ParseBool(get("TLINGUAL_ALLOW_INSECURE_PROVIDERS", "false"))
	if err != nil {
		return Config{}, errors.New("TLINGUAL_ALLOW_INSECURE_PROVIDERS must be a boolean")
	}
	trustedProxyCIDRs, err := parsePrefixes(get("TLINGUAL_TRUSTED_PROXY_CIDRS", ""))
	if err != nil {
		return Config{}, err
	}
	if environment == Production && len(trustedProxyCIDRs) == 0 {
		return Config{}, errors.New("production requires TLINGUAL_TRUSTED_PROXY_CIDRS for the HTTPS reverse proxy")
	}

	asr, err := provider(lookup, "TLINGUAL_ASR")
	if err != nil {
		return Config{}, err
	}
	translator, err := provider(lookup, "TLINGUAL_TRANSLATOR")
	if err != nil {
		return Config{}, err
	}
	if environment == Production && (!asr.Enabled() || !translator.Enabled()) {
		return Config{}, errors.New("production requires both TLINGUAL_ASR_BASE_URL and TLINGUAL_TRANSLATOR_BASE_URL")
	}
	if environment == Production && !allowInsecureProviders {
		for name, providerConfig := range map[string]Provider{"ASR": asr, "translator": translator} {
			if providerConfig.Enabled() && providerConfig.BaseURL.Scheme != "https" {
				return Config{}, fmt.Errorf("production %s provider must use https or TLINGUAL_ALLOW_INSECURE_PROVIDERS=true", name)
			}
		}
	}

	cookieSecure := publicURL.Scheme == "https"
	if raw, ok := lookup("TLINGUAL_COOKIE_SECURE"); ok && strings.TrimSpace(raw) != "" {
		cookieSecure, err = strconv.ParseBool(strings.TrimSpace(raw))
		if err != nil {
			return Config{}, errors.New("TLINGUAL_COOKIE_SECURE must be a boolean")
		}
	}
	if environment == Production && !cookieSecure {
		return Config{}, errors.New("production session cookies must be secure")
	}
	cookieNameDefault := "tlingual_session"
	if cookieSecure {
		cookieNameDefault = "__Host-tlingual_session"
	}

	dataPath := filepath.Clean(get("TLINGUAL_DATA_PATH", filepath.Join("data", "t-lingual.db")))
	masterKeyPath := filepath.Clean(get("TLINGUAL_MASTER_KEY_PATH", filepath.Join(filepath.Dir(dataPath), "master.key")))
	adminSocket := filepath.Clean(get("TLINGUAL_ADMIN_SOCKET", filepath.Join(filepath.Dir(dataPath), "admin.sock")))
	webRoot := filepath.Clean(get("TLINGUAL_WEB_ROOT", filepath.Join("frontend", "dist")))

	return Config{
		Environment:            environment,
		ListenAddr:             get("TLINGUAL_LISTEN_ADDR", "127.0.0.1:8088"),
		PublicURL:              publicURL,
		RPID:                   rpID,
		RPDisplayName:          get("TLINGUAL_RP_DISPLAY_NAME", "t-lingual"),
		RPOrigins:              origins,
		DataPath:               dataPath,
		MasterKeyPath:          masterKeyPath,
		AdminSocket:            adminSocket,
		WebRoot:                webRoot,
		SessionCookieName:      get("TLINGUAL_SESSION_COOKIE", cookieNameDefault),
		CookieSecure:           cookieSecure,
		SessionTTL:             sessionTTL,
		CeremonyTTL:            ceremonyTTL,
		InvitationTTL:          invitationTTL,
		ShutdownTimeout:        shutdownTimeout,
		MaxJSONBytes:           maxJSONBytes,
		AllowInsecureProviders: allowInsecureProviders,
		TrustedProxyCIDRs:      trustedProxyCIDRs,
		ASR:                    asr,
		Translator:             translator,
	}, nil
}

func provider(lookup func(string) (string, bool), prefix string) (Provider, error) {
	raw, ok := lookup(prefix + "_BASE_URL")
	if !ok || strings.TrimSpace(raw) == "" {
		return Provider{}, nil
	}
	parsed, err := url.Parse(strings.TrimRight(strings.TrimSpace(raw), "/"))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil {
		return Provider{}, fmt.Errorf("%s_BASE_URL must be an absolute http(s) URL without credentials", prefix)
	}
	apiKey, _ := lookup(prefix + "_API_KEY")
	return Provider{BaseURL: parsed, APIKey: strings.TrimSpace(apiKey)}, nil
}

func parsePublicURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimRight(strings.TrimSpace(raw), "/"))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil {
		return nil, errors.New("TLINGUAL_PUBLIC_URL must be an absolute http(s) URL without credentials")
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return nil, errors.New("TLINGUAL_PUBLIC_URL cannot contain a path, query, or fragment")
	}
	parsed.Path = ""
	return parsed, nil
}

func origin(value *url.URL) string { return value.Scheme + "://" + value.Host }

func splitNonEmpty(value string) []string {
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			result = append(result, strings.TrimRight(trimmed, "/"))
		}
	}
	return result
}

func appendUnique(values []string, candidates ...string) []string {
	seen := make(map[string]struct{}, len(values)+len(candidates))
	for _, value := range values {
		seen[value] = struct{}{}
	}
	for _, candidate := range candidates {
		if _, exists := seen[candidate]; exists {
			continue
		}
		seen[candidate] = struct{}{}
		values = append(values, candidate)
	}
	return values
}

func parsePrefixes(value string) ([]netip.Prefix, error) {
	parts := splitNonEmpty(value)
	prefixes := make([]netip.Prefix, 0, len(parts))
	for _, part := range parts {
		prefix, err := netip.ParsePrefix(part)
		if err != nil {
			return nil, fmt.Errorf("TLINGUAL_TRUSTED_PROXY_CIDRS contains invalid CIDR %q", part)
		}
		if prefix.Bits() == 0 {
			return nil, fmt.Errorf("TLINGUAL_TRUSTED_PROXY_CIDRS cannot trust every address in %q", part)
		}
		prefixes = append(prefixes, prefix.Masked())
	}
	return prefixes, nil
}

func duration(raw, name string) (time.Duration, error) {
	value, err := time.ParseDuration(raw)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be a positive duration", name)
	}
	return value, nil
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
