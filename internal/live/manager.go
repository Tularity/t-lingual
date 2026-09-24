// Package live bridges one authenticated browser audio writer to asr-factory,
// persists final transcript segments, and schedules non-blocking translations.
package live

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Tularity/t-lingual/internal/asr"
	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/id"
	"github.com/Tularity/t-lingual/internal/store"
	"github.com/Tularity/t-lingual/internal/translate"
	"github.com/coder/websocket"
)

const (
	maxAudioFrameBytes        = 256 << 10
	maxControlBytes           = 8 << 10
	helloTimeout              = 10 * time.Second
	defaultClientIdleTimeout  = 30 * time.Second
	defaultMaxLiveDuration    = 4 * time.Hour
	defaultAuthRevalidate     = 10 * time.Second
	defaultAudioBurstDuration = 2 * time.Second
	upstreamCommandTimeout    = 2 * time.Second
	browserWriteTimeout       = 2 * time.Second
	statusPersistTimeout      = time.Second
	statusPersistAttempts     = 2
	terminalDeliveryTimeout   = 150 * time.Millisecond
	readerStopWait            = time.Second
	upstreamStopWait          = 2 * time.Second
	translationTimeout        = 35 * time.Second
	translationWorkers        = 4
	translationBacklog        = 32
	translationUserBacklog    = 8
	maxGlobalLiveStreams      = 64
	maxLiveStreamsPerUser     = 2
	controlCommandsPerSecond  = 1
	controlCommandBurst       = 4
)

var (
	ErrAuthenticationRevoked = errors.New("live authentication revoked")
	ErrGlobalCapacity        = errors.New("live global capacity exhausted")
	ErrUserCapacity          = errors.New("live user capacity exhausted")
	errStreamReplaced        = errors.New("live stream replaced by a newer connection")
	errClientIdle            = errors.New("live client read timeout")
	errMaxDuration           = errors.New("live maximum duration exceeded")
	errAudioRateExceeded     = errors.New("live audio arrived faster than real time")
	errControlRateExceeded   = errors.New("live control messages arrived too quickly")
)

type Manager struct {
	ctx               context.Context
	store             *store.Store
	asr               asr.Provider
	translator        translate.Provider
	logger            *slog.Logger
	translationQueue  chan translationTask
	workerWG          sync.WaitGroup
	translationMu     sync.Mutex
	translationByUser map[string]int

	handshakeMu              sync.Mutex
	handshakes               int
	handshakesByUser         map[string]int
	admissionGatesMu         sync.Mutex
	admissionGates           map[string]*admissionGate
	mu                       sync.Mutex
	byInterpretation         map[string]*lease
	pendingByInterpretation  map[string]map[uint64]*lease
	byBrowserSession         map[string]map[uint64]*lease
	byUser                   map[string]map[uint64]*lease
	generation               atomic.Uint64
	authRevalidateInterval   time.Duration
	helloTimeout             time.Duration
	clientIdleTimeout        time.Duration
	maxLiveDuration          time.Duration
	audioBurstDuration       time.Duration
	now                      func() time.Time
	writeReady               func(context.Context, *websocket.Conn, *writeMutex, any) error
	afterHandshakeAdmission  func()
	afterPendingRegistration func()
	afterPromotion           func()

	lifecycleMu sync.Mutex
	closing     bool
	activeWG    sync.WaitGroup
}

type lease struct {
	generation        uint64
	interpretationID  string
	browserSessionID  string
	userID            string
	expiresAt         time.Time
	cancel            context.CancelCauseFunc
	done              chan struct{}
	readerStarted     atomic.Bool
	readerRelease     chan struct{}
	readerFinished    chan struct{}
	readerReleaseOnce sync.Once
	finalized         atomic.Bool
	writer            *writeMutex
}

// admissionGate serializes replacement of one interpretation without making
// an unresponsive predecessor stall admission for unrelated interpretations.
// refs includes both the holder and callers waiting to acquire the gate.
type admissionGate struct {
	mu   sync.Mutex
	refs int
}

func New(ctx context.Context, database *store.Store, asrProvider asr.Provider, translator translate.Provider, logger *slog.Logger) (*Manager, error) {
	if ctx == nil || database == nil || asrProvider == nil {
		return nil, errors.New("live context, store, and ASR provider are required")
	}
	if logger == nil {
		logger = slog.Default()
	}
	manager := &Manager{
		ctx: ctx, store: database, asr: asrProvider, translator: translator, logger: logger,
		byInterpretation:        make(map[string]*lease),
		pendingByInterpretation: make(map[string]map[uint64]*lease),
		byBrowserSession:        make(map[string]map[uint64]*lease),
		byUser:                  make(map[string]map[uint64]*lease),
		admissionGates:          make(map[string]*admissionGate),
		handshakesByUser:        make(map[string]int),
		authRevalidateInterval:  defaultAuthRevalidate,
		helloTimeout:            helloTimeout,
		clientIdleTimeout:       defaultClientIdleTimeout,
		maxLiveDuration:         defaultMaxLiveDuration,
		audioBurstDuration:      defaultAudioBurstDuration,
		now:                     func() time.Time { return time.Now().UTC() },
		writeReady:              writeJSON,
	}
	if translator != nil {
		manager.translationQueue = make(chan translationTask, translationBacklog)
		manager.translationByUser = make(map[string]int)
		manager.workerWG.Add(translationWorkers)
		for range translationWorkers {
			go manager.translationWorker()
		}
	}
	return manager, nil
}

func (m *Manager) ServeLive(
	response http.ResponseWriter,
	request *http.Request,
	user domain.User,
	browserSession domain.BrowserSession,
	sessionID string,
) error {
	if err := m.beginLive(); err != nil {
		return err
	}
	defer m.activeWG.Done()
	if browserSession.ID == "" || browserSession.UserID != user.ID {
		return store.ErrNotFound
	}
	releaseHandshake, err := m.beginHandshake(user.ID)
	if err != nil {
		return err
	}
	defer releaseHandshake()
	if m.afterHandshakeAdmission != nil {
		m.afterHandshakeAdmission()
	}

	// Handshake admission deliberately precedes the first workspace lookup.
	// Otherwise a valid account could issue unbounded non-upgrade requests for
	// arbitrary session IDs and queue them all on SQLite before the WebSocket
	// capacity control had a chance to run.
	session, err := m.store.GetInterpretationSession(request.Context(), user.ID, sessionID)
	if err != nil {
		return err
	}
	if session.ArchivedAt != nil {
		return store.ErrArchived
	}

	connection, err := websocket.Accept(response, request, &websocket.AcceptOptions{
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return fmt.Errorf("accept live websocket: %w", err)
	}
	connection.SetReadLimit(maxAudioFrameBytes)
	hello, err := m.readHello(connection)
	if err != nil {
		return m.closeWithError(connection, user.ID, session.ID, err)
	}

	// The first validation prevents a stale second browser session from
	// fencing a healthy stream after it logged out while waiting on hello.
	// Serialize the full replacement handoff only for this interpretation.
	// In particular, waiting for an old upstream to stop must never retain a
	// process-wide lock and delay unrelated users or interpretations.
	releaseAdmission := m.lockInterpretationAdmission(session.ID)
	defer releaseAdmission()
	if err := m.store.ValidateBrowserSession(m.ctx, user.ID, browserSession.ID, m.now()); err != nil {
		return m.closeWithError(connection, user.ID, session.ID, ErrAuthenticationRevoked)
	}
	deadlineCtx, deadlineCancel := context.WithTimeoutCause(m.ctx, m.maxLiveDuration, errMaxDuration)
	runCtx, runCancel := context.WithCancelCause(deadlineCtx)
	current := &lease{
		generation:       m.generation.Add(1),
		interpretationID: session.ID,
		browserSessionID: browserSession.ID,
		userID:           user.ID,
		expiresAt:        browserSession.ExpiresAt,
		cancel:           runCancel,
		done:             make(chan struct{}),
		readerRelease:    make(chan struct{}),
		readerFinished:   make(chan struct{}),
		writer:           newWriteMutex(),
	}
	if err := m.registerPending(current); err != nil {
		runCancel(err)
		deadlineCancel()
		return m.closeWithError(connection, user.ID, session.ID, err)
	}
	releaseHandshake()
	if m.afterPendingRegistration != nil {
		m.afterPendingRegistration()
	}
	defer func() {
		runCancel(nil)
		deadlineCancel()
		m.release(current)
		close(current.done)
	}()

	// Registration in all revocation indexes deliberately precedes this DB
	// check. A logout/disable before registration is observed here; one after
	// registration cancels runCtx through the indexes.
	if err := m.store.ValidateBrowserSession(runCtx, user.ID, browserSession.ID, m.now()); err != nil || errors.Is(context.Cause(runCtx), ErrAuthenticationRevoked) {
		m.discardPending(current)
		if cause := context.Cause(runCtx); errors.Is(cause, ErrAuthenticationRevoked) {
			err = cause
		} else {
			err = ErrAuthenticationRevoked
		}
		return m.finishConnection(current, connection, user.ID, session, err)
	}
	old, err := m.promotePending(current)
	if err != nil {
		return m.finishConnection(current, connection, user.ID, session, err)
	}
	hadDurableLiveState := old != nil || session.Status == domain.InterpretationLive
	go m.monitorAuthorization(runCtx, current)
	if old != nil {
		old.cancel(errStreamReplaced)
	}
	if m.afterPromotion != nil {
		m.afterPromotion()
	}
	if old != nil {
		select {
		case <-old.done:
		case <-runCtx.Done():
			return m.finishBeforeClaim(current, connection, user.ID, session, hadDurableLiveState, context.Cause(runCtx))
		case <-time.After(upstreamStopWait):
		}
	}
	if err := m.store.ValidateBrowserSession(runCtx, user.ID, browserSession.ID, m.now()); err != nil {
		if cause := context.Cause(runCtx); errors.Is(cause, ErrAuthenticationRevoked) {
			err = cause
		} else {
			err = ErrAuthenticationRevoked
		}
		return m.finishBeforeClaim(current, connection, user.ID, session, hadDurableLiveState, err)
	}
	// Claim status=live and fetch metadata in one SQLite statement while this
	// interpretation's admission gate is held. PATCH/DELETE can only win before
	// the claim (and the fresh values below are used) or lose with SESSION_LIVE.
	// No upstream provider work starts before this durable boundary.
	session, err = m.claimLive(runCtx, user.ID, session.ID, current, m.now())
	if err != nil {
		return m.finishBeforeClaim(current, connection, user.ID, session, hadDurableLiveState, err)
	}
	defer func() {
		status := domain.InterpretationFailed
		if cause := context.Cause(runCtx); errors.Is(cause, context.Canceled) ||
			errors.Is(cause, ErrAuthenticationRevoked) || errors.Is(cause, errStreamReplaced) {
			status = domain.InterpretationCompleted
		}
		m.markEnded(user.ID, session, current, status)
	}()
	// The predecessor has stopped (or consumed its bounded stop budget) and
	// the promoted lease is still authorized and durably claimed. Later
	// reconnects for this same interpretation may now begin their handoff while
	// this lease serves.
	releaseAdmission()

	if err := m.serve(runCtx, connection, user, session, current, hello); err != nil {
		return m.finishConnection(current, connection, user.ID, session, err)
	}
	return m.finishConnection(current, connection, user.ID, session, nil)
}

func (m *Manager) finishBeforeClaim(
	current *lease,
	connection *websocket.Conn,
	userID string,
	session domain.InterpretationSession,
	hadDurableLiveState bool,
	err error,
) error {
	// Once a promoted candidate has fenced a predecessor, it inherits the
	// predecessor's durable live state and must terminalize it on failure. A
	// first connection that never claimed the row leaves the editable session
	// untouched and merely closes its upgraded transport.
	if hadDurableLiveState {
		return m.finishConnection(current, connection, userID, session, err)
	}
	if err != nil {
		_ = m.closeWithWriter(connection, current.writer, userID, session.ID, err)
	} else {
		_ = connection.CloseNow()
	}
	current.readerReleaseOnce.Do(func() { close(current.readerRelease) })
	return nil
}

func (m *Manager) finishConnection(
	current *lease,
	connection *websocket.Conn,
	userID string,
	session domain.InterpretationSession,
	err error,
) error {
	// A terminal browser write or close handshake must never stand between a
	// promoted stream and its durable terminal state. markEnded is
	// generation-aware and idempotent, so this also safely covers paths that
	// were already finalized inside serve.
	for attempt := 0; attempt < statusPersistAttempts; attempt++ {
		if m.markEnded(userID, session, current, terminalInterpretationStatus(err)) {
			break
		}
	}
	if err != nil {
		_ = m.closeWithWriter(connection, current.writer, userID, session.ID, err)
	} else {
		awaitTerminalDelivery(connection)
		_ = connection.CloseNow()
	}
	current.readerReleaseOnce.Do(func() { close(current.readerRelease) })
	if current.readerStarted.Load() {
		select {
		case <-current.readerFinished:
		case <-time.After(readerStopWait):
			m.logger.Warn("live websocket reader did not stop promptly", "user_id", userID, "session_id", session.ID)
		}
	}
	return nil
}

func terminalInterpretationStatus(err error) domain.InterpretationStatus {
	if err == nil ||
		errors.Is(err, context.Canceled) ||
		errors.Is(err, ErrAuthenticationRevoked) ||
		errors.Is(err, errStreamReplaced) ||
		websocket.CloseStatus(err) == websocket.StatusNormalClosure ||
		websocket.CloseStatus(err) == websocket.StatusGoingAway {
		return domain.InterpretationCompleted
	}
	return domain.InterpretationFailed
}

func (m *Manager) closeWithError(connection *websocket.Conn, userID, sessionID string, err error) error {
	return m.closeWithWriter(connection, newWriteMutex(), userID, sessionID, err)
}

func (m *Manager) closeWithWriter(connection *websocket.Conn, writer *writeMutex, userID, sessionID string, err error) error {
	if err != nil {
		m.logger.Warn("live interpretation ended with error", "error", err, "user_id", userID, "session_id", sessionID)
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		_ = writeJSON(ctx, connection, writer, map[string]any{
			"type": "error", "code": publicErrorCode(err), "message": publicErrorMessage(err),
		})
		cancel()
		awaitTerminalDelivery(connection)
	}
	// coder/websocket Close performs an internal 5s write plus 5s peer wait and
	// does not accept a caller context. The structured terminal event above is
	// the protocol signal; immediately tear down the transport so a silent peer
	// cannot retain a live slot.
	return connection.CloseNow()
}

func (m *Manager) beginLive() error {
	m.lifecycleMu.Lock()
	defer m.lifecycleMu.Unlock()
	if m.closing || m.ctx.Err() != nil {
		return errors.New("live manager is shutting down")
	}
	m.activeWG.Add(1)
	return nil
}

func (m *Manager) lockInterpretationAdmission(interpretationID string) func() {
	m.admissionGatesMu.Lock()
	gate := m.admissionGates[interpretationID]
	if gate == nil {
		gate = &admissionGate{}
		m.admissionGates[interpretationID] = gate
	}
	gate.refs++
	m.admissionGatesMu.Unlock()

	gate.mu.Lock()
	var once sync.Once
	return func() {
		once.Do(func() {
			gate.mu.Unlock()
			m.admissionGatesMu.Lock()
			gate.refs--
			if gate.refs == 0 && m.admissionGates[interpretationID] == gate {
				delete(m.admissionGates, interpretationID)
			}
			m.admissionGatesMu.Unlock()
		})
	}
}

func (m *Manager) beginHandshake(userID string) (func(), error) {
	m.handshakeMu.Lock()
	if m.handshakes >= maxGlobalLiveStreams {
		m.handshakeMu.Unlock()
		return nil, ErrGlobalCapacity
	}
	if m.handshakesByUser[userID] >= maxLiveStreamsPerUser {
		m.handshakeMu.Unlock()
		return nil, ErrUserCapacity
	}
	m.handshakes++
	m.handshakesByUser[userID]++
	m.handshakeMu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			m.handshakeMu.Lock()
			m.handshakes--
			remaining := m.handshakesByUser[userID] - 1
			if remaining <= 0 {
				delete(m.handshakesByUser, userID)
			} else {
				m.handshakesByUser[userID] = remaining
			}
			m.handshakeMu.Unlock()
		})
	}, nil
}

// Shutdown prevents new upgrades and waits for active streams and bounded
// translation workers after the manager context has been cancelled.
func (m *Manager) Shutdown(ctx context.Context) error {
	if ctx == nil {
		return errors.New("live shutdown context is required")
	}
	m.lifecycleMu.Lock()
	m.closing = true
	m.lifecycleMu.Unlock()
	done := make(chan struct{})
	go func() {
		m.activeWG.Wait()
		m.workerWG.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

type helloMessage struct {
	Type  string `json:"type"`
	Audio struct {
		Encoding   string `json:"encoding"`
		SampleRate int    `json:"sampleRate"`
		Channels   int    `json:"channels"`
	} `json:"audio"`
}

func (m *Manager) readHello(connection *websocket.Conn) (helloMessage, error) {
	var hello helloMessage
	helloCtx, helloCancel := context.WithTimeout(m.ctx, m.helloTimeout)
	messageType, payload, err := connection.Read(helloCtx)
	helloCause := context.Cause(helloCtx)
	helloCancel()
	if err != nil {
		if helloCause != nil && !errors.Is(helloCause, context.DeadlineExceeded) {
			return hello, helloCause
		}
		return hello, fmt.Errorf("read live hello: %w", err)
	}
	if messageType != websocket.MessageText || len(payload) > maxControlBytes {
		return hello, errors.New("live hello must be a small JSON message")
	}
	if err := json.Unmarshal(payload, &hello); err != nil || hello.Type != "start" {
		return helloMessage{}, errors.New("live hello is invalid")
	}
	if hello.Audio.Encoding != "pcm32f" || hello.Audio.Channels != 1 || hello.Audio.SampleRate < 8000 || hello.Audio.SampleRate > 192000 {
		return helloMessage{}, errors.New("live audio must be mono pcm32f at 8-192 kHz")
	}
	return hello, nil
}

func (m *Manager) serve(
	runCtx context.Context,
	connection *websocket.Conn,
	user domain.User,
	session domain.InterpretationSession,
	current *lease,
	hello helloMessage,
) error {
	upstream, err := m.asr.Start(runCtx, asr.StartRequest{
		Language: session.SourceLanguage,
		Audio: asr.AudioSpec{
			Encoding: hello.Audio.Encoding, SampleRate: hello.Audio.SampleRate, Channels: hello.Audio.Channels,
		},
		CacheLines: 1000, SpeakerEmbedding: "off",
	})
	if err != nil {
		m.markEnded(user.ID, session, current, domain.InterpretationFailed)
		return effectiveRunError(runCtx, err)
	}
	upstreamEnded := false
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), upstreamStopWait)
		if !upstreamEnded {
			_ = upstream.End(ctx)
		}
		_ = upstream.Close(ctx)
		cancel()
	}()
	finalStatus := domain.InterpretationFailed
	defer func() {
		status := finalStatus
		if cause := context.Cause(runCtx); errors.Is(cause, context.Canceled) ||
			errors.Is(cause, ErrAuthenticationRevoked) || errors.Is(cause, errStreamReplaced) {
			status = domain.InterpretationCompleted
		}
		m.markEnded(user.ID, session, current, status)
	}()

	writeMu := current.writer
	lastSequence, err := m.store.MaxSegmentSequence(runCtx, user.ID, session.ID)
	if err != nil {
		return effectiveRunError(runCtx, err)
	}
	resumeOffsetMS, err := m.store.MaxSegmentEndMS(runCtx, user.ID, session.ID)
	if err != nil {
		return effectiveRunError(runCtx, err)
	}

	clientDone := make(chan clientResult, 1)
	audioLimiter := newAudioRateLimiter(
		hello.Audio.SampleRate*hello.Audio.Channels*4,
		m.audioBurstDuration,
		m.now(),
	)
	readerStart := make(chan struct{})
	current.readerStarted.Store(true)
	go readClient(
		context.WithoutCancel(m.ctx), runCtx, connection, upstream, audioLimiter, m.clientIdleTimeout, m.now,
		readerStart, current.readerRelease, current.readerFinished, clientDone,
	)

	runID, _ := id.New("run")
	if err := m.writeReady(runCtx, connection, writeMu, map[string]any{
		"type": "ready", "sessionId": session.ID, "runId": runID, "chunkMs": upstream.Info().ChunkMS,
		"offsetMs": resumeOffsetMS,
	}); err != nil {
		close(readerStart)
		return effectiveRunError(runCtx, err)
	}
	close(readerStart)

	eventDone := make(chan error, 1)
	go m.forwardEvents(runCtx, connection, writeMu, upstream, user, session, current, &lastSequence, resumeOffsetMS, eventDone)

	graceful := false
	var runErr error
	var eventErr error
	eventFinished := false
	select {
	case result := <-clientDone:
		graceful = result.graceful
		runErr = result.err
	case eventErr = <-eventDone:
		eventFinished = true
		runErr = eventErr
		if eventErr == nil {
			graceful = true
		}
	case <-runCtx.Done():
		runErr = context.Cause(runCtx)
	}
	if cause := context.Cause(runCtx); cause != nil {
		runErr = cause
	}

	stopCtx, stopCancel := context.WithTimeout(context.Background(), upstreamStopWait)
	if graceful || errors.Is(runErr, context.Canceled) || websocket.CloseStatus(runErr) == websocket.StatusNormalClosure {
		_ = upstream.ForceEndOfUtterance(stopCtx)
		if !eventFinished {
			timer := time.NewTimer(350 * time.Millisecond)
			select {
			case <-timer.C:
			case eventErr = <-eventDone:
				eventFinished = true
			}
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
		}
		_ = upstream.End(stopCtx)
	} else {
		_ = upstream.End(stopCtx)
	}
	upstreamEnded = true
	if !eventFinished {
		select {
		case eventErr = <-eventDone:
			eventFinished = true
		case <-stopCtx.Done():
		}
	}
	if runErr == nil && eventFinished {
		runErr = eventErr
	}
	stopCancel()

	finalStatus = domain.InterpretationCompleted
	if runErr != nil &&
		!errors.Is(runErr, context.Canceled) &&
		!errors.Is(runErr, ErrAuthenticationRevoked) &&
		!errors.Is(runErr, errStreamReplaced) &&
		websocket.CloseStatus(runErr) != websocket.StatusNormalClosure &&
		websocket.CloseStatus(runErr) != websocket.StatusGoingAway {
		finalStatus = domain.InterpretationFailed
	}
	if finalStatus == domain.InterpretationFailed {
		return runErr
	}
	if errors.Is(runErr, ErrAuthenticationRevoked) || errors.Is(runErr, errStreamReplaced) {
		return runErr
	}
	// Manager cancellation is a shutdown/error path rather than a client end.
	// Return through the finalizer so the durable terminal state is committed
	// before finishConnection attempts the bounded terminal browser write.
	if errors.Is(runErr, context.Canceled) {
		return runErr
	}
	writeCtx, writeCancel := context.WithTimeout(context.Background(), time.Second)
	_ = writeJSON(writeCtx, connection, writeMu, map[string]any{"type": "stopped", "status": finalStatus})
	writeCancel()
	return nil
}

func effectiveRunError(ctx context.Context, err error) error {
	if cause := context.Cause(ctx); cause != nil {
		return cause
	}
	return err
}

func awaitTerminalDelivery(connection *websocket.Conn) {
	ctx, cancel := context.WithTimeout(context.Background(), terminalDeliveryTimeout)
	defer cancel()
	// A pong confirms that an actively reading peer advanced beyond the
	// preceding terminal data frame. Silent peers only consume this fixed
	// budget; shutdown still ends with CloseNow rather than a close handshake.
	_ = connection.Ping(ctx)
}

type clientResult struct {
	graceful bool
	err      error
}

func readClient(
	readerBaseCtx context.Context,
	operationCtx context.Context,
	connection *websocket.Conn,
	upstream asr.Stream,
	audioLimiter *audioRateLimiter,
	idleTimeout time.Duration,
	now func() time.Time,
	start <-chan struct{},
	release <-chan struct{},
	finished chan<- struct{},
	done chan<- clientResult,
) {
	defer close(finished)
	type incomingMessage struct {
		messageType websocket.MessageType
		payload     []byte
		err         error
	}
	readerCtx, readerCancel := context.WithCancel(readerBaseCtx)
	defer readerCancel()
	incoming := make(chan incomingMessage)
	acknowledge := make(chan struct{})
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		for {
			messageType, payload, err := connection.Read(readerCtx)
			select {
			case incoming <- incomingMessage{messageType: messageType, payload: payload, err: err}:
			case <-readerCtx.Done():
				return
			}
			if err != nil {
				return
			}
			select {
			case <-acknowledge:
			case <-readerCtx.Done():
				return
			}
		}
	}()
	finish := func(result clientResult) {
		done <- result
		<-release
		readerCancel()
		<-readerDone
	}
	acknowledgeRead := func() bool {
		select {
		case acknowledge <- struct{}{}:
			return true
		case <-readerDone:
			return false
		}
	}
	select {
	case <-start:
	case <-operationCtx.Done():
		finish(clientResult{err: context.Cause(operationCtx)})
		return
	}
	idle := time.NewTimer(idleTimeout)
	defer idle.Stop()
	controlLimiter := newControlRateLimiter(now())
	for {
		var message incomingMessage
		select {
		case <-operationCtx.Done():
			finish(clientResult{err: context.Cause(operationCtx)})
			return
		case <-idle.C:
			finish(clientResult{err: errClientIdle})
			return
		case message = <-incoming:
		}
		if message.err != nil {
			finish(clientResult{
				graceful: websocket.CloseStatus(message.err) == websocket.StatusNormalClosure || websocket.CloseStatus(message.err) == websocket.StatusGoingAway,
				err:      message.err,
			})
			return
		}
		if cause := context.Cause(operationCtx); cause != nil {
			finish(clientResult{err: cause})
			return
		}
		switch message.messageType {
		case websocket.MessageBinary:
			payload := message.payload
			if len(payload) == 0 || len(payload) > maxAudioFrameBytes || len(payload)%4 != 0 {
				finish(clientResult{err: errors.New("audio frame size is invalid")})
				return
			}
			receivedAt := now()
			if !audioLimiter.Allow(len(payload), receivedAt) {
				finish(clientResult{err: errAudioRateExceeded})
				return
			}
			callCtx, callCancel := context.WithTimeout(operationCtx, upstreamCommandTimeout)
			err := upstream.SendAudio(callCtx, payload)
			callCancel()
			if err != nil {
				finish(clientResult{err: effectiveRunError(operationCtx, err)})
				return
			}
			if !idle.Stop() {
				select {
				case <-idle.C:
				default:
				}
			}
			idle.Reset(idleTimeout)
			if !acknowledgeRead() {
				finish(clientResult{err: effectiveRunError(operationCtx, readerBaseCtx.Err())})
				return
			}
		case websocket.MessageText:
			payload := message.payload
			if len(payload) > maxControlBytes {
				finish(clientResult{err: errors.New("control message is too large")})
				return
			}
			var control struct {
				Type string `json:"type"`
			}
			if err := json.Unmarshal(payload, &control); err != nil {
				finish(clientResult{err: errors.New("control message is invalid")})
				return
			}
			switch control.Type {
			case "end", "pause":
				finish(clientResult{graceful: true})
				return
			case "force_eou":
				if !controlLimiter.Allow(now()) {
					finish(clientResult{err: errControlRateExceeded})
					return
				}
				callCtx, callCancel := context.WithTimeout(operationCtx, upstreamCommandTimeout)
				err := upstream.ForceEndOfUtterance(callCtx)
				callCancel()
				if err != nil {
					finish(clientResult{err: effectiveRunError(operationCtx, err)})
					return
				}
			case "reset_stream":
				if !controlLimiter.Allow(now()) {
					finish(clientResult{err: errControlRateExceeded})
					return
				}
				callCtx, callCancel := context.WithTimeout(operationCtx, upstreamCommandTimeout)
				err := upstream.Reset(callCtx)
				callCancel()
				if err != nil {
					finish(clientResult{err: effectiveRunError(operationCtx, err)})
					return
				}
			case "ping":
				if !controlLimiter.Allow(now()) {
					finish(clientResult{err: errControlRateExceeded})
					return
				}
				// Browser keepalive is intentionally local. Forwarding it would let a
				// tenant amplify tiny browser frames into unbounded provider commands.
			default:
				finish(clientResult{err: errors.New("unsupported live control")})
				return
			}
			if !acknowledgeRead() {
				finish(clientResult{err: effectiveRunError(operationCtx, readerBaseCtx.Err())})
				return
			}
		}
	}
}

type controlRateLimiter struct {
	tokens float64
	last   time.Time
}

func newControlRateLimiter(now time.Time) *controlRateLimiter {
	return &controlRateLimiter{tokens: controlCommandBurst, last: now}
}

func (l *controlRateLimiter) Allow(now time.Time) bool {
	if elapsed := now.Sub(l.last).Seconds(); elapsed > 0 {
		l.tokens = min(controlCommandBurst, l.tokens+elapsed*controlCommandsPerSecond)
		l.last = now
	}
	if l.tokens < 1 {
		return false
	}
	l.tokens--
	return true
}

type audioRateLimiter struct {
	bytesPerSecond float64
	capacity       float64
	tokens         float64
	last           time.Time
}

func newAudioRateLimiter(bytesPerSecond int, burst time.Duration, now time.Time) *audioRateLimiter {
	rate := float64(bytesPerSecond)
	capacity := rate * burst.Seconds()
	if capacity < rate/10 {
		capacity = rate / 10
	}
	return &audioRateLimiter{
		bytesPerSecond: rate,
		capacity:       capacity,
		tokens:         capacity,
		last:           now,
	}
}

func (l *audioRateLimiter) Allow(size int, now time.Time) bool {
	if size < 1 || l == nil {
		return false
	}
	if elapsed := now.Sub(l.last).Seconds(); elapsed > 0 {
		l.tokens = min(l.capacity, l.tokens+elapsed*l.bytesPerSecond)
		l.last = now
	}
	if float64(size) > l.tokens {
		return false
	}
	l.tokens -= float64(size)
	return true
}

func (m *Manager) forwardEvents(
	ctx context.Context,
	connection *websocket.Conn,
	writeMu *writeMutex,
	upstream asr.Stream,
	user domain.User,
	session domain.InterpretationSession,
	current *lease,
	lastSequence *int64,
	resumeOffsetMS int64,
	done chan<- error,
) {
	for event := range upstream.Events() {
		switch event.Type {
		case "partial":
			if !m.isCurrent(session.ID, current) {
				continue
			}
			_ = writeJSON(ctx, connection, writeMu, map[string]any{
				"type": "partial", "text": event.Text, "upstreamSequence": event.Sequence, "language": event.Language,
			})
		case "final":
			if event.Text == "" {
				continue
			}
			// A predecessor may still be draining after a replacement timed out.
			// Serialize its last write against the next run's durable resume cursor.
			releaseAdmission := m.lockInterpretationAdmission(session.ID)
			if !m.isCurrent(session.ID, current) {
				releaseAdmission()
				done <- errStreamReplaced
				return
			}
			(*lastSequence)++
			segmentID, err := id.New("seg")
			if err != nil {
				releaseAdmission()
				done <- err
				return
			}
			translationStatus := domain.TranslationNotRequested
			if m.translator != nil {
				translationStatus = domain.TranslationPending
			}
			segment := domain.Segment{
				ID: segmentID, SessionID: session.ID, UserID: user.ID, Sequence: *lastSequence,
				SourceText: event.Text, TranslationStatus: translationStatus, Final: true,
				StartMS: resumeOffsetMS + event.StartMS, EndMS: resumeOffsetMS + event.EndMS, CreatedAt: time.Now().UTC(),
			}
			if err := m.store.AppendSegment(ctx, user.ID, segment); err != nil {
				releaseAdmission()
				done <- err
				return
			}
			releaseAdmission()
			_ = writeJSON(ctx, connection, writeMu, map[string]any{
				"type": "final", "segment": segment, "upstreamSequence": event.Sequence, "detectedLanguage": event.Language,
			})
			if m.translator != nil {
				task := translationTask{connection: connection, writeMu: writeMu, user: user, session: session, segment: segment, detectedLanguage: event.Language}
				if !m.reserveTranslation(user.ID) {
					m.finishTranslation(connection, writeMu, user, session, segment, domain.TranslationFailed, "", "capacity_exhausted", "")
					continue
				}
				select {
				case m.translationQueue <- task:
				default:
					m.releaseTranslation(user.ID)
					m.finishTranslation(connection, writeMu, user, session, segment, domain.TranslationFailed, "", "capacity_exhausted", "")
				}
			}
		case "error":
			_ = writeJSON(ctx, connection, writeMu, map[string]any{"type": "provider_error", "provider": "asr", "code": event.Code})
		}
	}
	done <- upstream.Wait()
}

type translationTask struct {
	connection       *websocket.Conn
	writeMu          *writeMutex
	user             domain.User
	session          domain.InterpretationSession
	segment          domain.Segment
	detectedLanguage string
}

func (m *Manager) translationWorker() {
	defer m.workerWG.Done()
	for {
		select {
		case <-m.ctx.Done():
			return
		case task := <-m.translationQueue:
			m.translateSegment(task.connection, task.writeMu, task.user, task.session, task.segment, task.detectedLanguage)
			m.releaseTranslation(task.user.ID)
		}
	}
}

func (m *Manager) reserveTranslation(userID string) bool {
	m.translationMu.Lock()
	defer m.translationMu.Unlock()
	if m.translationByUser[userID] >= translationUserBacklog {
		return false
	}
	m.translationByUser[userID]++
	return true
}

func (m *Manager) releaseTranslation(userID string) {
	m.translationMu.Lock()
	defer m.translationMu.Unlock()
	remaining := m.translationByUser[userID] - 1
	if remaining <= 0 {
		delete(m.translationByUser, userID)
		return
	}
	m.translationByUser[userID] = remaining
}

func (m *Manager) translateSegment(connection *websocket.Conn, writeMu *writeMutex, user domain.User, session domain.InterpretationSession, segment domain.Segment, detectedLanguage string) {
	sourceLanguage, ok := translationSourceLanguage(session.SourceLanguage, detectedLanguage)
	if !ok {
		m.finishTranslation(connection, writeMu, user, session, segment, domain.TranslationFailed, "", "source_language_detection_failed", "")
		return
	}
	ctx, cancel := context.WithTimeout(m.ctx, translationTimeout)
	result, err := m.translator.Translate(ctx, translate.Request{
		SourceLanguage: sourceLanguage, TargetLanguage: session.TargetLanguage, Text: segment.SourceText,
	})
	cancel()
	if err != nil {
		code := "translator_unavailable"
		requestID := ""
		var providerErr *translate.ProviderError
		if errors.As(err, &providerErr) {
			if providerErr.Code != "" {
				code = providerErr.Code
			}
			requestID = providerErr.RequestID
		}
		m.finishTranslation(connection, writeMu, user, session, segment, domain.TranslationFailed, "", code, requestID)
		return
	}
	m.finishTranslation(connection, writeMu, user, session, segment, domain.TranslationSucceeded, result.Translation, "", result.RequestID)
}

func translationSourceLanguage(configured, detected string) (string, bool) {
	if configured != "auto" {
		return configured, configured != ""
	}
	if detected == "" || detected == "auto" {
		return "", false
	}
	return detected, true
}

func (m *Manager) finishTranslation(connection *websocket.Conn, writeMu *writeMutex, user domain.User, session domain.InterpretationSession, segment domain.Segment, status domain.TranslationStatus, text, code, requestID string) {
	persistCtx, persistCancel := context.WithTimeout(m.ctx, 5*time.Second)
	err := m.store.UpdateSegmentTranslation(persistCtx, user.ID, session.ID, segment.ID, status, text, code, requestID, time.Now().UTC())
	persistCancel()
	if err != nil {
		fallbackCode := "translation_persistence_failed"
		if errors.Is(err, store.ErrCapacity) {
			fallbackCode = "storage_limit"
		}
		fallbackCtx, fallbackCancel := context.WithTimeout(m.ctx, 2*time.Second)
		fallbackErr := m.store.FailPendingSegmentTranslation(
			fallbackCtx, user.ID, session.ID, segment.ID, fallbackCode, time.Now().UTC(),
		)
		fallbackCancel()
		if fallbackErr != nil {
			m.logger.Error("persist translation result and terminal fallback", "error", err, "fallback_error", fallbackErr, "segment_id", segment.ID)
			return
		}
		m.logger.Warn("translation result replaced with terminal failure", "error", err, "code", fallbackCode, "segment_id", segment.ID)
		status, text, code, requestID = domain.TranslationFailed, "", fallbackCode, ""
	}
	writeCtx, writeCancel := context.WithTimeout(m.ctx, browserWriteTimeout)
	defer writeCancel()
	_ = writeJSON(writeCtx, connection, writeMu, map[string]any{
		"type": "translation", "segmentId": segment.ID, "status": status,
		"translation": text, "error": code, "requestId": requestID,
	})
}

func (m *Manager) registerPending(current *lease) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	interpretationExists := m.byInterpretation[current.interpretationID] != nil || len(m.pendingByInterpretation[current.interpretationID]) > 0
	if !interpretationExists && m.distinctInterpretationsLocked() >= maxGlobalLiveStreams {
		return ErrGlobalCapacity
	}
	userInterpretations := m.userInterpretationsLocked(current.userID)
	if _, exists := userInterpretations[current.interpretationID]; !exists && len(userInterpretations) >= maxLiveStreamsPerUser {
		return ErrUserCapacity
	}
	items := m.pendingByInterpretation[current.interpretationID]
	if items == nil {
		items = make(map[uint64]*lease)
		m.pendingByInterpretation[current.interpretationID] = items
	}
	items[current.generation] = current
	m.replaceIndex(m.byBrowserSession, current.browserSessionID, current)
	m.replaceIndex(m.byUser, current.userID, current)
	return nil
}

func (m *Manager) promotePending(current *lease) (*lease, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	items := m.pendingByInterpretation[current.interpretationID]
	if !sameLease(items[current.generation], current) {
		return nil, errStreamReplaced
	}
	delete(items, current.generation)
	if len(items) == 0 {
		delete(m.pendingByInterpretation, current.interpretationID)
	}
	old := m.byInterpretation[current.interpretationID]
	m.byInterpretation[current.interpretationID] = current
	if old != nil {
		m.removeIndexIfCurrent(m.byBrowserSession, old.browserSessionID, old)
		m.removeIndexIfCurrent(m.byUser, old.userID, old)
	}
	return old, nil
}

func (m *Manager) discardPending(current *lease) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.removePendingIfCurrent(current)
	m.removeIndexIfCurrent(m.byBrowserSession, current.browserSessionID, current)
	m.removeIndexIfCurrent(m.byUser, current.userID, current)
}

func (m *Manager) distinctInterpretationsLocked() int {
	seen := make(map[string]struct{}, len(m.byInterpretation)+len(m.pendingByInterpretation))
	for interpretationID := range m.byInterpretation {
		seen[interpretationID] = struct{}{}
	}
	for interpretationID := range m.pendingByInterpretation {
		seen[interpretationID] = struct{}{}
	}
	return len(seen)
}

func (m *Manager) userInterpretationsLocked(userID string) map[string]struct{} {
	seen := make(map[string]struct{})
	for _, current := range m.byUser[userID] {
		seen[current.interpretationID] = struct{}{}
	}
	return seen
}

func (m *Manager) replaceIndex(index map[string]map[uint64]*lease, ownerID string, current *lease) {
	items := index[ownerID]
	if items == nil {
		items = make(map[uint64]*lease)
		index[ownerID] = items
	}
	items[current.generation] = current
}

func (m *Manager) removeIndexIfCurrent(index map[string]map[uint64]*lease, ownerID string, current *lease) {
	items := index[ownerID]
	if items == nil || !sameLease(items[current.generation], current) {
		return
	}
	delete(items, current.generation)
	if len(items) == 0 {
		delete(index, ownerID)
	}
}

func (m *Manager) removePendingIfCurrent(current *lease) {
	items := m.pendingByInterpretation[current.interpretationID]
	if items == nil || !sameLease(items[current.generation], current) {
		return
	}
	delete(items, current.generation)
	if len(items) == 0 {
		delete(m.pendingByInterpretation, current.interpretationID)
	}
}

func (m *Manager) release(current *lease) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if sameLease(m.byInterpretation[current.interpretationID], current) {
		delete(m.byInterpretation, current.interpretationID)
	}
	m.removePendingIfCurrent(current)
	m.removeIndexIfCurrent(m.byBrowserSession, current.browserSessionID, current)
	m.removeIndexIfCurrent(m.byUser, current.userID, current)
}

func (m *Manager) isCurrent(sessionID string, current *lease) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return sameLease(m.byInterpretation[sessionID], current) &&
		sameLease(m.byBrowserSession[current.browserSessionID][current.generation], current) &&
		sameLease(m.byUser[current.userID][current.generation], current)
}

func sameLease(indexed, expected *lease) bool {
	return indexed != nil && expected != nil && indexed == expected && indexed.generation == expected.generation
}

func (m *Manager) RevokeBrowserSession(browserSessionID string) {
	m.cancelIndexed(m.byBrowserSession, browserSessionID)
}

func (m *Manager) RevokeUser(userID string) {
	m.cancelIndexed(m.byUser, userID)
}

func (m *Manager) cancelIndexed(index map[string]map[uint64]*lease, ownerID string) {
	if ownerID == "" {
		return
	}
	m.mu.Lock()
	items := index[ownerID]
	leases := make([]*lease, 0, len(items))
	for _, current := range items {
		leases = append(leases, current)
	}
	m.mu.Unlock()
	for _, current := range leases {
		current.cancel(ErrAuthenticationRevoked)
	}
}

func (m *Manager) monitorAuthorization(ctx context.Context, current *lease) {
	delay := current.expiresAt.Sub(m.now())
	if delay <= 0 {
		current.cancel(ErrAuthenticationRevoked)
		return
	}
	expiry := time.NewTimer(delay)
	defer expiry.Stop()
	ticker := time.NewTicker(m.authRevalidateInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-expiry.C:
			current.cancel(ErrAuthenticationRevoked)
			return
		case <-ticker.C:
			if err := m.store.ValidateBrowserSession(ctx, current.userID, current.browserSessionID, m.now()); err != nil {
				if ctx.Err() == nil {
					m.logger.Warn("live browser session validation failed", "user_id", current.userID, "session_id", current.browserSessionID, "error", err)
					current.cancel(ErrAuthenticationRevoked)
				}
				return
			}
		}
	}
}

func (m *Manager) markEnded(ownerID string, session domain.InterpretationSession, current *lease, status domain.InterpretationStatus) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !sameLease(m.byInterpretation[session.ID], current) || !current.finalized.CompareAndSwap(false, true) {
		return true
	}
	now := time.Now().UTC()
	persistCtx, cancel := context.WithTimeout(context.Background(), statusPersistTimeout)
	defer cancel()
	if err := m.store.UpdateInterpretationSessionStatus(persistCtx, ownerID, session.ID, status, session.StartedAt, &now, now); err != nil {
		current.finalized.Store(false)
		m.logger.Error("update live session status", "error", err, "session_id", session.ID, "status", status)
		return false
	}
	return true
}

// claimLive is called only while the interpretation admission gate is held.
// The gate prevents a newer generation from being promoted between the
// generation check and the atomic store claim.
func (m *Manager) claimLive(
	ctx context.Context,
	ownerID string,
	sessionID string,
	current *lease,
	now time.Time,
) (domain.InterpretationSession, error) {
	m.mu.Lock()
	isCurrent := sameLease(m.byInterpretation[sessionID], current)
	m.mu.Unlock()
	if !isCurrent {
		return domain.InterpretationSession{}, errStreamReplaced
	}
	if cause := context.Cause(ctx); cause != nil {
		return domain.InterpretationSession{}, cause
	}
	return m.store.ClaimInterpretationSessionLive(ctx, ownerID, sessionID, now)
}

type writeMutex struct {
	semaphore chan struct{}
	timeout   time.Duration
}

func newWriteMutex() *writeMutex {
	semaphore := make(chan struct{}, 1)
	semaphore <- struct{}{}
	return &writeMutex{semaphore: semaphore, timeout: browserWriteTimeout}
}

func (m *writeMutex) lock(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return context.Cause(ctx)
	case <-m.semaphore:
		return nil
	}
}

func (m *writeMutex) unlock() {
	m.semaphore <- struct{}{}
}

func writeJSON(ctx context.Context, connection *websocket.Conn, mu *writeMutex, value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	timeout := mu.timeout
	if timeout <= 0 || timeout > browserWriteTimeout {
		timeout = browserWriteTimeout
	}
	writeCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if err := mu.lock(writeCtx); err != nil {
		return err
	}
	defer mu.unlock()
	return connection.Write(writeCtx, websocket.MessageText, payload)
}

func publicErrorCode(err error) string {
	switch {
	case errors.Is(err, ErrAuthenticationRevoked):
		return "AUTH_REVOKED"
	case errors.Is(err, ErrGlobalCapacity):
		return "LIVE_CAPACITY"
	case errors.Is(err, ErrUserCapacity):
		return "LIVE_USER_LIMIT"
	case errors.Is(err, errStreamReplaced):
		return "SESSION_REPLACED"
	case errors.Is(err, errClientIdle):
		return "CLIENT_IDLE"
	case errors.Is(err, errMaxDuration):
		return "LIVE_DURATION_EXCEEDED"
	case errors.Is(err, errAudioRateExceeded):
		return "AUDIO_RATE_EXCEEDED"
	case errors.Is(err, errControlRateExceeded):
		return "CONTROL_RATE_EXCEEDED"
	}
	var providerErr *asr.ProviderError
	if errors.As(err, &providerErr) && providerErr.Code != "" {
		return providerErr.Code
	}
	return "LIVE_STOPPED"
}

func publicErrorMessage(err error) string {
	switch {
	case errors.Is(err, ErrAuthenticationRevoked):
		return "Authentication was revoked. Sign in again to continue."
	case errors.Is(err, ErrGlobalCapacity), errors.Is(err, ErrUserCapacity):
		return "Live interpretation capacity is currently exhausted."
	case errors.Is(err, errStreamReplaced):
		return "This live interpretation continued in a newer connection."
	case errors.Is(err, errClientIdle):
		return "The live connection stopped sending audio."
	case errors.Is(err, errMaxDuration):
		return "The maximum live interpretation duration was reached."
	case errors.Is(err, errAudioRateExceeded):
		return "Audio was sent substantially faster than real time."
	case errors.Is(err, errControlRateExceeded):
		return "Live control messages were sent too quickly."
	default:
		return "The live interpretation stopped."
	}
}
