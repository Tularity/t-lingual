package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/Tularity/t-lingual/internal/admin"
	"github.com/Tularity/t-lingual/internal/api"
	"github.com/Tularity/t-lingual/internal/asr"
	"github.com/Tularity/t-lingual/internal/auth"
	"github.com/Tularity/t-lingual/internal/config"
	"github.com/Tularity/t-lingual/internal/control"
	"github.com/Tularity/t-lingual/internal/live"
	"github.com/Tularity/t-lingual/internal/processlock"
	"github.com/Tularity/t-lingual/internal/secret"
	"github.com/Tularity/t-lingual/internal/spa"
	"github.com/Tularity/t-lingual/internal/store"
	"github.com/Tularity/t-lingual/internal/translate"
	"github.com/Tularity/t-lingual/internal/webapi"
	"github.com/Tularity/t-lingual/internal/workspace"
)

var version = "development"

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	if err := run(logger); err != nil {
		logger.Error("t-lingual stopped", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("load configuration: %w", err)
	}
	dataLock, err := processlock.Acquire(cfg.DataPath)
	if err != nil {
		return fmt.Errorf("acquire data store process lock: %w", err)
	}
	defer dataLock.Close()
	if err := requireExistingMasterKey(cfg.DataPath, cfg.MasterKeyPath); err != nil {
		return err
	}
	keyring, err := secret.OpenOrCreate(cfg.MasterKeyPath)
	if err != nil {
		return err
	}
	database, err := store.Open(cfg.DataPath)
	if err != nil {
		return err
	}
	defer database.Close()
	if err := database.BindMasterKey(context.Background(), keyring.Verifier()); err != nil {
		return err
	}

	now := time.Now().UTC()
	recoveredSessions, recoveredTranslations, err := database.RecoverInterruptedInterpretations(context.Background(), now)
	if err != nil {
		return err
	}
	if recoveredSessions > 0 || recoveredTranslations > 0 {
		logger.Warn("recovered interrupted work", "sessions", recoveredSessions, "translations", recoveredTranslations)
	}

	authService, err := auth.New(cfg, database, keyring)
	if err != nil {
		return err
	}
	adminService, err := admin.New(database, keyring, cfg.InvitationTTL)
	if err != nil {
		return err
	}
	workspaceService, err := workspace.New(database)
	if err != nil {
		return err
	}

	var asrProvider asr.Provider
	if cfg.ASR.Enabled() {
		asrProvider, err = asr.NewClient(cfg.ASR.BaseURL, cfg.ASR.APIKey, nil)
		if err != nil {
			return err
		}
	}
	var translationProvider translate.Provider
	if cfg.Translator.Enabled() {
		translationProvider, err = translate.NewClient(cfg.Translator.BaseURL, cfg.Translator.APIKey, nil)
		if err != nil {
			return err
		}
	}

	rootContext, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	var liveService *live.Manager
	if asrProvider != nil {
		liveService, err = live.New(rootContext, database, asrProvider, translationProvider, logger)
		if err != nil {
			return err
		}
	}
	if err := authService.ConfigureUserRevoker(optionalAuthUserRevoker(liveService)); err != nil {
		return fmt.Errorf("configure authentication live revocation: %w", err)
	}

	applicationAPI, err := api.New(api.Dependencies{
		Config: cfg, Store: database, Auth: authService, Admin: adminService,
		Workspace: workspaceService, ASR: asrProvider, Translator: translationProvider,
		Live: liveService, Logger: logger,
	})
	if err != nil {
		return err
	}
	web, err := spa.New(cfg.WebRoot, cfg.Environment == config.Production)
	if err != nil {
		return fmt.Errorf("load web application: %w (run the frontend build or set TLINGUAL_WEB_ROOT)", err)
	}
	rootHandler := newRootHTTPHandler(applicationAPI.Handler(), web)

	adminServer, err := control.StartServer(
		cfg.AdminSocket, adminService, optionalControlUserRevoker(liveService), cfg.MaxJSONBytes,
	)
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", cfg.ListenAddr)
	if err != nil {
		shutdownContext, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
		defer cancel()
		_ = adminServer.Shutdown(shutdownContext)
		return fmt.Errorf("listen on %s: %w", cfg.ListenAddr, err)
	}

	httpServer := &http.Server{
		Handler:           rootHandler,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    32 << 10,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelError),
	}
	httpDone := make(chan error, 1)
	go func() {
		httpDone <- httpServer.Serve(listener)
	}()
	go maintain(rootContext, database, logger)

	logger.Info("t-lingual started",
		"version", version,
		"listen", listener.Addr().String(),
		"environment", cfg.Environment,
		"asr_configured", asrProvider != nil,
		"translator_configured", translationProvider != nil,
	)

	var serveErr error
	select {
	case <-rootContext.Done():
	case serveErr = <-httpDone:
		if errors.Is(serveErr, http.ErrServerClosed) {
			serveErr = nil
		}
		stopSignals()
	case <-adminServer.Done():
		serveErr = adminServer.Wait()
		if serveErr == nil {
			serveErr = errors.New("local administration server stopped unexpectedly")
		}
		stopSignals()
	}

	shutdownContext, cancelShutdown := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancelShutdown()
	httpErr := httpServer.Shutdown(shutdownContext)
	var liveErr error
	if liveService != nil {
		liveErr = liveService.Shutdown(shutdownContext)
	}
	adminErr := adminServer.Shutdown(shutdownContext)
	_, _, recoveryErr := database.RecoverInterruptedInterpretations(shutdownContext, time.Now().UTC())
	shutdownErr := errors.Join(serveErr, httpErr, liveErr, adminErr, recoveryErr)
	if shutdownErr == nil {
		logger.Info("t-lingual stopped gracefully")
	}
	return shutdownErr
}

func optionalControlUserRevoker(manager *live.Manager) control.RevokeUserFunc {
	if manager == nil {
		return nil
	}
	return manager.RevokeUser
}

func optionalAuthUserRevoker(manager *live.Manager) auth.UserRevokeFunc {
	if manager == nil {
		return nil
	}
	return manager.RevokeUser
}

const (
	rootMaxConcurrentBodies  = 128
	rootBodyReadTimeout      = 15 * time.Second
	rootResponseWriteTimeout = 10 * time.Second
)

func newRootHTTPHandler(apiHandler, webHandler http.Handler) http.Handler {
	return newRootHTTPHandlerWithLimits(
		apiHandler,
		webHandler,
		rootMaxConcurrentBodies,
		rootBodyReadTimeout,
		rootResponseWriteTimeout,
	)
}

func newRootHTTPHandlerWithLimits(apiHandler, webHandler http.Handler, maxConcurrentBodies int, bodyReadTimeout, responseWriteTimeout time.Duration) http.Handler {
	routes := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/api" || strings.HasPrefix(request.URL.Path, "/api/") ||
			request.URL.Path == "/health" || strings.HasPrefix(request.URL.Path, "/health/") {
			apiHandler.ServeHTTP(response, request)
			return
		}
		webHandler.ServeHTTP(response, request)
	})
	return webapi.Chain(
		routes,
		webapi.ResponseWriteDeadline(responseWriteTimeout, isLiveWebSocketEndpoint),
		webapi.BodyReadGuard(maxConcurrentBodies, bodyReadTimeout),
	)
}

func isLiveWebSocketEndpoint(request *http.Request) bool {
	if request.Method != http.MethodGet {
		return false
	}
	segments := strings.Split(strings.TrimPrefix(request.URL.Path, "/"), "/")
	return len(segments) == 5 &&
		segments[0] == "api" &&
		segments[1] == "v1" &&
		segments[2] == "sessions" &&
		segments[3] != "" &&
		segments[4] == "live"
}

func requireExistingMasterKey(databasePath, keyPath string) error {
	databaseInfo, databaseErr := os.Stat(databasePath)
	if databaseErr != nil && !errors.Is(databaseErr, os.ErrNotExist) {
		return fmt.Errorf("inspect existing database: %w", databaseErr)
	}
	if databaseErr != nil || databaseInfo.Size() == 0 {
		return nil
	}
	if _, keyErr := os.Stat(keyPath); errors.Is(keyErr, os.ErrNotExist) {
		return errors.New("master key is missing for an existing database; restore the original key instead of generating a replacement")
	} else if keyErr != nil {
		return fmt.Errorf("inspect master key: %w", keyErr)
	}
	return nil
}

func maintain(ctx context.Context, database *store.Store, logger *slog.Logger) {
	cleanup := func() {
		cleanupContext, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		now := time.Now().UTC()
		ceremonies, ceremonyErr := database.DeleteExpiredWebAuthnCeremonies(cleanupContext, now)
		sessions, sessionErr := database.DeleteExpiredBrowserSessions(cleanupContext, now)
		grants, grantErr := database.DeleteExpiredActionGrants(cleanupContext, now)
		if err := errors.Join(ceremonyErr, sessionErr, grantErr); err != nil && ctx.Err() == nil {
			logger.Error("delete expired authentication state", "error", err)
		} else if ceremonies+sessions+grants > 0 {
			logger.Info("deleted expired authentication state", "ceremonies", ceremonies, "sessions", sessions, "grants", grants)
		}
	}
	cleanup()
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cleanup()
		}
	}
}
