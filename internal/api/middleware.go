package api

import (
	"context"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/webapi"
)

type identity struct {
	User         domain.User
	Session      domain.BrowserSession
	SessionToken string
}

type identityKey struct{}

func (a *API) public(handler webapi.HandlerFunc) http.HandlerFunc {
	return webapi.Handle(func(response http.ResponseWriter, request *http.Request) error {
		response.Header().Set("Cache-Control", "no-store")
		if err := handler(response, request); err != nil {
			return a.mapError(err)
		}
		return nil
	})
}

func (a *API) authenticated(handler func(http.ResponseWriter, *http.Request, identity) error) http.HandlerFunc {
	return a.authenticatedRequest(handler, false)
}

// authenticatedLive releases the general HTTP admission immediately after a
// successful cookie lookup. A live WebSocket has its own handshake and active
// session capacity controls and may remain open for hours, so it must not pin a
// general SQLite/HTTP slot for its lifetime. Invalid cookies still pass through
// the same pre-lookup client and global admission as every other request.
func (a *API) authenticatedLive(handler func(http.ResponseWriter, *http.Request, identity) error) http.HandlerFunc {
	return a.authenticatedRequest(handler, true)
}

func (a *API) authenticatedRequest(
	handler func(http.ResponseWriter, *http.Request, identity) error,
	releaseAfterAuthentication bool,
) http.HandlerFunc {
	return webapi.Handle(func(response http.ResponseWriter, request *http.Request) error {
		response.Header().Set("Cache-Control", "no-store")
		cookie, err := request.Cookie(a.config.SessionCookieName)
		if err != nil || cookie.Value == "" {
			return a.mapError(errUnauthenticated)
		}
		clientRelease, rejection := a.authenticatedAdmission.acquireClient(
			authRateKey(a.clientAddress(request)),
		)
		if rejection != authenticatedAdmitted {
			return authenticatedAdmissionError(response, rejection)
		}
		// This defer is intentionally installed before Authenticate. It releases
		// capacity if Authenticate or any later handler panics as well as on all
		// ordinary error paths. The release function is idempotent for live's
		// deliberate early release.
		defer clientRelease()

		user, session, err := a.authenticateSession(request.Context(), cookie.Value)
		if err != nil {
			return a.mapError(err)
		}
		current := identity{User: user, Session: session, SessionToken: cookie.Value}
		request = request.WithContext(context.WithValue(request.Context(), identityKey{}, current))
		if releaseAfterAuthentication {
			clientRelease()
		} else {
			userRelease, userRejection := a.authenticatedAdmission.acquireUser(user.ID)
			if userRejection != authenticatedAdmitted {
				return authenticatedAdmissionError(response, userRejection)
			}
			defer userRelease()
		}
		if err := handler(response, request, current); err != nil {
			return a.mapError(err)
		}
		return nil
	})
}

func authenticatedAdmissionError(response http.ResponseWriter, rejection authenticatedAdmissionRejection) error {
	// One second is a delta-seconds Retry-After value. Admission is based on
	// concurrency rather than a fixed window, so capacity may become available
	// earlier and clients may retry on their next bounded backoff step.
	response.Header().Set("Retry-After", "1")
	if rejection == authenticatedClientBusy || rejection == authenticatedUserBusy {
		return &webapi.Error{
			Status:  http.StatusTooManyRequests,
			Code:    "AUTH_CONCURRENCY_LIMIT",
			Message: "Too many concurrent authenticated requests. Try again shortly.",
		}
	}
	return &webapi.Error{
		Status:  http.StatusServiceUnavailable,
		Code:    "AUTH_SERVICE_BUSY",
		Message: "Authentication is temporarily busy. Try again shortly.",
	}
}

type ipEntry struct {
	count int
	start time.Time
	seen  time.Time
}

type ipLimiter struct {
	mu       sync.Mutex
	items    map[string]ipEntry
	limit    int
	window   time.Duration
	maxItems int
}

func newIPLimiter(limit int, window time.Duration, maxItems int) *ipLimiter {
	if limit <= 0 {
		limit = 1
	}
	if window <= 0 {
		window = time.Minute
	}
	if maxItems <= 0 {
		maxItems = 8192
	}
	return &ipLimiter{items: make(map[string]ipEntry), limit: limit, window: window, maxItems: maxItems}
}

func (l *ipLimiter) Allow(key string, now time.Time) (bool, time.Duration) {
	return l.AllowWithLimit(key, now, l.limit)
}

// AllowWithLimit applies the current policy to the existing fixed-window
// counters. Changing a site's budget never resets or replaces this map.
func (l *ipLimiter) AllowWithLimit(key string, now time.Time, limit int) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if limit < 1 {
		limit = 1
	}
	if key == "" {
		key = "unknown"
	}
	entry, exists := l.items[key]
	if !exists && len(l.items) >= l.maxItems {
		for candidate, value := range l.items {
			if now.Sub(value.start) >= l.window {
				delete(l.items, candidate)
			}
		}
		if len(l.items) >= l.maxItems {
			// Eviction prevents an address-cardinality attack from permanently
			// locking out every previously unseen client. The separate global
			// limiter still caps aggregate work when churn defeats this layer.
			var oldestKey string
			var oldest time.Time
			for candidate, value := range l.items {
				if oldestKey == "" || value.seen.Before(oldest) {
					oldestKey, oldest = candidate, value.seen
				}
			}
			delete(l.items, oldestKey)
		}
	}
	if entry.start.IsZero() || now.Sub(entry.start) >= l.window {
		entry = ipEntry{start: now, seen: now}
	}
	entry.seen = now
	if entry.count >= limit {
		l.items[key] = entry
		retryAfter := l.window - now.Sub(entry.start)
		if retryAfter < time.Second {
			retryAfter = time.Second
		}
		return false, retryAfter
	}
	entry.count++
	l.items[key] = entry
	return true, 0
}

type authFlow uint8

const (
	authLogin authFlow = iota
	authRegistration
	authCode
)

func (a *API) clientAddress(request *http.Request) string {
	peer, ok := parseIPAddress(request.RemoteAddr)
	if !ok {
		return strings.TrimSpace(request.RemoteAddr)
	}
	if !a.trustedProxy(peer) {
		return peer.String()
	}
	raw := strings.Join(request.Header.Values("X-Forwarded-For"), ",")
	if raw == "" || len(raw) > 4096 {
		return peer.String()
	}
	parts := strings.Split(raw, ",")
	if len(parts) > 16 {
		return peer.String()
	}
	forwarded := make([]netip.Addr, 0, len(parts))
	for _, part := range parts {
		address, valid := parseIPAddress(strings.TrimSpace(part))
		if !valid {
			return peer.String()
		}
		forwarded = append(forwarded, address)
	}
	current := peer
	for index := len(forwarded) - 1; index >= 0 && a.trustedProxy(current); index-- {
		current = forwarded[index]
	}
	return current.String()
}

func parseIPAddress(value string) (netip.Addr, bool) {
	value = strings.TrimSpace(value)
	if addressPort, err := netip.ParseAddrPort(value); err == nil {
		return addressPort.Addr().Unmap(), true
	}
	address, err := netip.ParseAddr(value)
	if err != nil {
		return netip.Addr{}, false
	}
	return address.Unmap(), true
}

func (a *API) trustedProxy(address netip.Addr) bool {
	for _, prefix := range a.config.TrustedProxyCIDRs {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}

func authRateKey(address string) string {
	parsed, ok := parseIPAddress(address)
	if !ok {
		return strings.ToLower(strings.TrimSpace(address))
	}
	if parsed.Is6() {
		return netip.PrefixFrom(parsed, 64).Masked().String()
	}
	return parsed.String()
}

func (a *API) rateLimitAuth(response http.ResponseWriter, request *http.Request, flow authFlow) error {
	now := time.Now()
	limiter := a.loginLimiter
	limit := 0
	key := authRateKey(a.clientAddress(request))
	if flow == authRegistration {
		limiter = a.registrationLimiter
	} else if flow == authCode {
		limiter = a.codeLimiter
		settings, err := a.store.GetSiteSettings(request.Context())
		if err != nil {
			return err
		}
		limit = settings.CodeAttemptsPerMinute
		// The code budget is per resolved client IP. Authentication already
		// applies the configured trusted-proxy chain in clientAddress.
		key = a.clientAddress(request)
		if parsed, err := netip.ParseAddr(key); err != nil {
			key = "unknown"
		} else {
			key = parsed.Unmap().String()
		}
	}
	var allowed bool
	var retryAfter time.Duration
	if flow == authCode {
		allowed, retryAfter = limiter.AllowWithLimit(key, now, limit)
	} else {
		allowed, retryAfter = limiter.Allow(key, now)
	}
	if allowed {
		// Only work admitted by the client-prefix layer consumes the global
		// budget; repeated cheap local rejections cannot starve every client.
		global := a.authGlobalLimiter
		if flow == authCode {
			global = a.codeGlobalLimiter
		}
		allowed, retryAfter = global.Allow("global", now)
	}
	if !allowed {
		seconds := int((retryAfter + time.Second - 1) / time.Second)
		if seconds < 1 {
			seconds = 1
		}
		response.Header().Set("Retry-After", strconv.Itoa(seconds))
		return &webapi.Error{Status: http.StatusTooManyRequests, Code: "RATE_LIMITED", Message: "Too many authentication attempts. Try again later."}
	}
	return nil
}

func (a *API) rateLimitPasskey(response http.ResponseWriter, userID string) error {
	now := time.Now()
	allowed, retryAfter := a.passkeyLimiter.Allow(userID, now)
	if allowed {
		allowed, retryAfter = a.passkeyGlobalLimiter.Allow("global", now)
	}
	if allowed {
		return nil
	}
	seconds := int((retryAfter + time.Second - 1) / time.Second)
	if seconds < 1 {
		seconds = 1
	}
	response.Header().Set("Retry-After", strconv.Itoa(seconds))
	return &webapi.Error{Status: http.StatusTooManyRequests, Code: "RATE_LIMITED", Message: "Too many passkey operations. Try again later."}
}

func (a *API) rateLimitSessionCreate(response http.ResponseWriter, userID string) error {
	now := time.Now()
	allowed, retryAfter := a.sessionCreateLimiter.Allow(userID, now)
	if allowed {
		allowed, retryAfter = a.sessionCreateGlobalLimiter.Allow("global", now)
	}
	if allowed {
		return nil
	}
	seconds := int((retryAfter + time.Second - 1) / time.Second)
	if seconds < 1 {
		seconds = 1
	}
	response.Header().Set("Retry-After", strconv.Itoa(seconds))
	return &webapi.Error{Status: http.StatusTooManyRequests, Code: "RATE_LIMITED", Message: "Too many sessions were created. Try again later."}
}
