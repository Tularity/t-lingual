// Package providers maintains immutable provider snapshots for new recordings.
package providers

import (
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/Tularity/t-lingual/internal/asr"
	"github.com/Tularity/t-lingual/internal/config"
	"github.com/Tularity/t-lingual/internal/translate"
)

type Endpoints struct {
	ASRURL        string `json:"asrUrl"`
	TranslatorURL string `json:"translatorUrl"`
}

type Status struct {
	Endpoints
	ASRConfigured           bool   `json:"asrConfigured"`
	TranslatorConfigured    bool   `json:"translatorConfigured"`
	ASRHasCredential        bool   `json:"asrHasCredential"`
	TranslatorHasCredential bool   `json:"translatorHasCredential"`
	Generation              uint64 `json:"generation"`
}

type Snapshot struct {
	ASR        asr.Provider
	Translator translate.Provider
	Status     Status
}

type Registry struct {
	mu      sync.RWMutex
	config  config.Config
	current Snapshot
}

func New(cfg config.Config) (*Registry, error) {
	r := &Registry{config: cfg}
	initial := Endpoints{}
	if cfg.ASR.BaseURL != nil {
		initial.ASRURL = cfg.ASR.BaseURL.String()
	}
	if cfg.Translator.BaseURL != nil {
		initial.TranslatorURL = cfg.Translator.BaseURL.String()
	}
	if _, err := r.Update(initial); err != nil {
		return nil, err
	}
	return r, nil
}

// Validate allows the caller to persist a candidate before publishing it.
// It has no network side effects and never returns configured API keys.
func (r *Registry) Validate(endpoints Endpoints) error {
	_, err := r.build(endpoints)
	return err
}

func (r *Registry) Update(endpoints Endpoints) (Status, error) {
	next, err := r.build(endpoints)
	if err != nil {
		return Status{}, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.current.Status.Endpoints == next.Status.Endpoints && r.current.Status.Generation != 0 {
		return r.current.Status, nil
	}
	next.Status.Generation = r.current.Status.Generation + 1
	r.current = next
	return next.Status, nil
}

func (r *Registry) Snapshot() Snapshot {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.current
}

func (r *Registry) Endpoints() Status { return r.Snapshot().Status }

func (r *Registry) build(endpoints Endpoints) (Snapshot, error) {
	asrURL, err := parseEndpoint(endpoints.ASRURL, r.config)
	if err != nil {
		return Snapshot{}, fmt.Errorf("invalid ASR endpoint: %w", err)
	}
	translatorURL, err := parseEndpoint(endpoints.TranslatorURL, r.config)
	if err != nil {
		return Snapshot{}, fmt.Errorf("invalid translator endpoint: %w", err)
	}
	status := Status{
		Endpoints:     Endpoints{ASRURL: endpointString(asrURL), TranslatorURL: endpointString(translatorURL)},
		ASRConfigured: asrURL != nil, TranslatorConfigured: translatorURL != nil,
		ASRHasCredential: r.config.ASR.APIKey != "", TranslatorHasCredential: r.config.Translator.APIKey != "",
	}
	next := Snapshot{Status: status}
	if asrURL != nil {
		client, err := asr.NewClient(asrURL, r.config.ASR.APIKey, nil)
		if err != nil {
			return Snapshot{}, fmt.Errorf("configure ASR provider: %w", err)
		}
		next.ASR = client
	}
	if translatorURL != nil {
		client, err := translate.NewClient(translatorURL, r.config.Translator.APIKey, nil)
		if err != nil {
			return Snapshot{}, fmt.Errorf("configure translator provider: %w", err)
		}
		next.Translator = client
	}
	return next, nil
}

func endpointString(value *url.URL) string {
	if value == nil {
		return ""
	}
	return value.String()
}

func parseEndpoint(raw string, cfg config.Config) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	parsed, err := url.Parse(raw)
	if err != nil || strings.Contains(raw, "#") || parsed.Opaque != "" || (parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.Host == "" || parsed.Hostname() == "" || parsed.User != nil || parsed.RawQuery != "" ||
		parsed.ForceQuery || parsed.Fragment != "" || parsed.RawFragment != "" {
		return nil, errors.New("endpoint must be an absolute http(s) URL without credentials, query, or fragment")
	}
	if parsed.Scheme == "http" && !cfg.AllowInsecureProviders &&
		(cfg.Environment != config.Development || !privateHost(parsed.Hostname())) {
		return nil, errors.New("plain HTTP requires a local development host or explicit insecure-provider opt-in")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	parsed.RawPath = ""
	return parsed, nil
}

func privateHost(host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if ip, err := netip.ParseAddr(host); err == nil {
		return ip.IsPrivate() || ip.IsLoopback()
	}
	return host == "localhost" || strings.HasSuffix(host, ".localhost") ||
		strings.HasSuffix(host, ".internal") || strings.HasSuffix(host, ".local") ||
		(host != "" && !strings.Contains(host, "."))
}

// Health is the latest word on whether a provider can take more work, as a
// monitor last sampled it. Known is false until a sample has succeeded, so
// "no data" is never read as "idle".
type Health struct {
	Known bool
	Ready bool
	// CanAccept: there is room for new work now.
	CanAccept bool
	// Elevated: the provider reports it is under pressure; background work
	// such as filling gaps should wait.
	Elevated bool
	// Room is how much more it would take now: free recognition slots, or
	// free translation admission.
	Room int
	At   time.Time
}

// HealthSource is anything that keeps provider health current.
type HealthSource interface {
	ASRHealth() Health
	TranslatorHealth() Health
}
