// Package api exposes the same-origin HTTP API consumed by the React client.
package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/Tularity/t-lingual/internal/admin"
	"github.com/Tularity/t-lingual/internal/asr"
	"github.com/Tularity/t-lingual/internal/auth"
	"github.com/Tularity/t-lingual/internal/config"
	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/language"
	"github.com/Tularity/t-lingual/internal/store"
	"github.com/Tularity/t-lingual/internal/translate"
	"github.com/Tularity/t-lingual/internal/webapi"
	"github.com/Tularity/t-lingual/internal/workspace"
)

type LiveHandler interface {
	ServeLive(http.ResponseWriter, *http.Request, domain.User, domain.BrowserSession, string) error
	RevokeBrowserSession(string)
	RevokeUser(string)
}

type Dependencies struct {
	Config     config.Config
	Store      *store.Store
	Auth       *auth.Service
	Admin      *admin.Service
	Workspace  *workspace.Service
	ASR        asr.Provider
	Translator translate.Provider
	Live       LiveHandler
	Logger     *slog.Logger
}

type API struct {
	config                     config.Config
	store                      *store.Store
	auth                       *auth.Service
	authenticateSession        func(context.Context, string) (domain.User, domain.BrowserSession, error)
	authenticatedAdmission     *authenticatedAdmission
	admin                      *admin.Service
	workspace                  *workspace.Service
	asr                        asr.Provider
	translator                 translate.Provider
	live                       LiveHandler
	logger                     *slog.Logger
	loginLimiter               *ipLimiter
	registrationLimiter        *ipLimiter
	authGlobalLimiter          *ipLimiter
	passkeyLimiter             *ipLimiter
	passkeyGlobalLimiter       *ipLimiter
	sessionCreateLimiter       *ipLimiter
	sessionCreateGlobalLimiter *ipLimiter
	readyMu                    sync.Mutex
	readyCache                 readinessSnapshot
	readyFlight                chan struct{}
}

func New(dependencies Dependencies) (*API, error) {
	if dependencies.Store == nil || dependencies.Auth == nil || dependencies.Admin == nil || dependencies.Workspace == nil {
		return nil, errors.New("API store, auth, admin, and workspace services are required")
	}
	if dependencies.Logger == nil {
		dependencies.Logger = slog.Default()
	}
	return &API{
		config:                 dependencies.Config,
		store:                  dependencies.Store,
		auth:                   dependencies.Auth,
		authenticateSession:    dependencies.Auth.Authenticate,
		authenticatedAdmission: newAuthenticatedAdmission(32, 8, 8, 32, 32),
		admin:                  dependencies.Admin,
		workspace:              dependencies.Workspace,
		asr:                    dependencies.ASR,
		translator:             dependencies.Translator,
		live:                   dependencies.Live,
		logger:                 dependencies.Logger,
		// Login and registration have separate client-prefix budgets so one
		// flow cannot starve the other. A global budget bounds distributed
		// address churn; durable ceremony capacity provides a second layer.
		loginLimiter:               newIPLimiter(120, time.Minute, 8192),
		registrationLimiter:        newIPLimiter(20, time.Minute, 8192),
		authGlobalLimiter:          newIPLimiter(300, time.Minute, 1),
		passkeyLimiter:             newIPLimiter(60, time.Minute, 8192),
		passkeyGlobalLimiter:       newIPLimiter(600, time.Minute, 1),
		sessionCreateLimiter:       newIPLimiter(30, time.Minute, 8192),
		sessionCreateGlobalLimiter: newIPLimiter(300, time.Minute, 1),
	}, nil
}

func (a *API) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health/live", a.public(a.liveHealth))
	mux.HandleFunc("GET /health/ready", a.public(a.readyHealth))
	mux.HandleFunc("GET /api/v1/meta", a.public(a.meta))

	mux.HandleFunc("POST /api/v1/auth/register/begin", a.public(a.beginRegistration))
	mux.HandleFunc("POST /api/v1/auth/register/finish", a.public(a.finishRegistration))
	mux.HandleFunc("POST /api/v1/auth/login/begin", a.public(a.beginLogin))
	mux.HandleFunc("POST /api/v1/auth/login/finish", a.public(a.finishLogin))
	mux.HandleFunc("POST /api/v1/auth/logout", a.authenticated(a.logout))
	mux.HandleFunc("GET /api/v1/auth/me", a.authenticated(a.me))
	mux.HandleFunc("GET /api/v1/auth/sessions", a.authenticated(a.listBrowserSessions))
	mux.HandleFunc("DELETE /api/v1/auth/sessions/{browserSessionID}", a.authenticated(a.deleteBrowserSession))
	mux.HandleFunc("POST /api/v1/auth/sessions/revoke-others", a.authenticated(a.revokeOtherBrowserSessions))

	mux.HandleFunc("GET /api/v1/passkeys", a.authenticated(a.listPasskeys))
	mux.HandleFunc("POST /api/v1/passkeys/authorize/begin", a.authenticated(a.beginPasskeyAuthorization))
	mux.HandleFunc("POST /api/v1/passkeys/authorize/finish", a.authenticated(a.finishPasskeyAuthorization))
	mux.HandleFunc("POST /api/v1/passkeys/begin", a.authenticated(a.beginPasskey))
	mux.HandleFunc("POST /api/v1/passkeys/finish", a.authenticated(a.finishPasskey))
	mux.HandleFunc("DELETE /api/v1/passkeys/{credentialID}", a.authenticated(a.deletePasskey))

	mux.HandleFunc("GET /api/v1/sessions", a.authenticated(a.listSessions))
	mux.HandleFunc("POST /api/v1/sessions", a.authenticated(a.createSession))
	mux.HandleFunc("GET /api/v1/sessions/{sessionID}", a.authenticated(a.getSession))
	mux.HandleFunc("PATCH /api/v1/sessions/{sessionID}", a.authenticated(a.updateSession))
	mux.HandleFunc("DELETE /api/v1/sessions/{sessionID}", a.authenticated(a.deleteSession))
	mux.HandleFunc("GET /api/v1/sessions/{sessionID}/segments", a.authenticated(a.listSegments))
	mux.HandleFunc("GET /api/v1/sessions/{sessionID}/live", a.authenticatedLive(a.serveLive))

	mux.HandleFunc("GET /api/v1/settings", a.authenticated(a.getSettings))
	mux.HandleFunc("PUT /api/v1/settings", a.authenticated(a.updateSettings))

	mux.HandleFunc("GET /api/v1/admin/invitations", a.authenticated(a.listInvitations))
	mux.HandleFunc("POST /api/v1/admin/invitations", a.authenticated(a.createInvitation))
	mux.HandleFunc("POST /api/v1/admin/invitations/{invitationID}/revoke", a.authenticated(a.revokeInvitation))
	mux.HandleFunc("GET /api/v1/admin/users", a.authenticated(a.listUsers))
	mux.HandleFunc("PATCH /api/v1/admin/users/{userID}", a.authenticated(a.updateUser))
	mux.HandleFunc("GET /api/v1/admin/audit", a.authenticated(a.listAudit))

	production := a.config.Environment == config.Production
	return webapi.Chain(
		mux,
		webapi.RequestContext(a.logger),
		webapi.Recovery(a.logger),
		webapi.SecurityHeaders(production),
		webapi.RequireOrigin(a.config.RPOrigins),
	)
}

func (a *API) liveHealth(response http.ResponseWriter, _ *http.Request) error {
	response.Header().Set("Cache-Control", "no-store")
	webapi.WriteJSON(response, http.StatusOK, map[string]string{"status": "live"})
	return nil
}

type providerHealth struct {
	Configured bool   `json:"configured"`
	Ready      bool   `json:"ready"`
	Error      string `json:"error,omitempty"`
}

type readinessSnapshot struct {
	status  int
	payload map[string]any
	expires time.Time
}

func (a *API) readyHealth(response http.ResponseWriter, request *http.Request) error {
	response.Header().Set("Cache-Control", "no-store")
	snapshot := a.readiness(request.Context())
	webapi.WriteJSON(response, snapshot.status, snapshot.payload)
	return nil
}

func (a *API) readiness(waitContext context.Context) readinessSnapshot {
	for {
		now := time.Now()
		a.readyMu.Lock()
		if a.readyCache.payload != nil && now.Before(a.readyCache.expires) {
			cached := a.readyCache
			a.readyMu.Unlock()
			return cached
		}
		if a.readyFlight != nil {
			flight := a.readyFlight
			a.readyMu.Unlock()
			select {
			case <-flight:
				continue
			case <-waitContext.Done():
				return readinessSnapshot{
					status:  http.StatusServiceUnavailable,
					payload: map[string]any{"ready": false, "components": map[string]providerHealth{}},
				}
			}
		}
		flight := make(chan struct{})
		a.readyFlight = flight
		a.readyMu.Unlock()

		fresh := a.probeReadiness()
		fresh.expires = time.Now().Add(2 * time.Second)
		a.readyMu.Lock()
		a.readyCache = fresh
		a.readyFlight = nil
		close(flight)
		a.readyMu.Unlock()
		return fresh
	}
}

func (a *API) probeReadiness() readinessSnapshot {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	type result struct {
		name string
		err  error
	}
	results := make(chan result, 3)
	go func() { results <- result{name: "database", err: a.store.Ping(ctx)} }()
	if a.asr != nil {
		go func() { results <- result{name: "asr", err: a.asr.Ready(ctx)} }()
	} else {
		results <- result{name: "asr", err: asr.ErrDisabled}
	}
	if a.translator != nil {
		go func() { results <- result{name: "translator", err: a.translator.Ready(ctx)} }()
	} else {
		results <- result{name: "translator", err: translate.ErrDisabled}
	}
	health := map[string]providerHealth{}
	ready := true
	for range 3 {
		item := <-results
		configured := !errors.Is(item.err, asr.ErrDisabled) && !errors.Is(item.err, translate.ErrDisabled)
		state := providerHealth{Configured: configured, Ready: item.err == nil}
		if item.err != nil {
			state.Error = "unavailable"
			ready = false
		}
		health[item.name] = state
	}
	status := http.StatusOK
	if !ready {
		status = http.StatusServiceUnavailable
	}
	return readinessSnapshot{status: status, payload: map[string]any{"ready": ready, "components": health}}
}

func (a *API) meta(response http.ResponseWriter, _ *http.Request) error {
	response.Header().Set("Cache-Control", "public, max-age=300")
	webapi.WriteJSON(response, http.StatusOK, map[string]any{
		"product":    "t-lingual",
		"apiVersion": "v1",
		"authentication": map[string]any{
			"passkeyOnly":  true,
			"inviteLength": 6,
			"roles":        []domain.Role{domain.RoleUser, domain.RoleAdmin},
		},
		"providers": map[string]any{
			"asr":        map[string]any{"configured": a.asr != nil, "streaming": true},
			"translator": map[string]any{"configured": a.translator != nil, "streaming": false, "autoSource": false},
		},
		"languages": map[string]any{
			"supported":       language.Supported(),
			"automaticSource": true,
		},
	})
	return nil
}
