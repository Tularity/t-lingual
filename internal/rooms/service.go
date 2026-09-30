// Package rooms owns collaborative interpretation broadcasts, recording leases,
// and language-specific translation work for each interpretation session.
package rooms

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

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/providers"
	"github.com/Tularity/t-lingual/internal/store"
	"github.com/coder/websocket"
)

const (
	watchTailLimit       = 40
	watchQueueLimit      = 64
	watchRevalidateEvery = 10 * time.Second
	watchHeartbeatEvery  = 15 * time.Second
	watchWriteTimeout    = 5 * time.Second
	maxGlobalWatchers    = 2048
	maxRoomWatchers      = 256
	maxViewerWatchers    = 8
	maxRecordings        = 64
)

var (
	ErrOccupied      = errors.New("room recorder is occupied")
	ErrAuthRevoked   = errors.New("room browser authentication revoked")
	ErrAccessRevoked = errors.New("room access revoked")
	ErrReplaced      = errors.New("room recorder replaced")
	ErrStopped       = errors.New("room recording stopped by owner")
	ErrNoAudio       = errors.New("room recorder stopped sending audio")
	ErrWatchCapacity = errors.New("room watcher capacity exhausted")
	// ErrRecordingLimit: the owner's sessions are already recording as many
	// times at once as the owner may.
	ErrRecordingLimit = errors.New("room owner recording limit reached")
	// ErrRecordingQuota: the owner has used a limit that ends recording.
	ErrRecordingQuota = errors.New("room owner recording quota used")
)

type AccessResolver interface {
	Resolve(context.Context, domain.Viewer, string) (domain.SessionAccess, error)
}

type providerSource interface {
	Snapshot() providers.Snapshot
}

type Service struct {
	store           *store.Store
	access          AccessResolver
	providers       providerSource
	logger          *slog.Logger
	ctx             context.Context
	cancel          context.CancelFunc
	mu              sync.Mutex
	rooms           map[string]*room
	watchCount      int
	watchesByViewer map[string]int
	nextID          atomic.Uint64
	closing         bool
	active          sync.WaitGroup
	jobs            chan translationTask
	workers         sync.WaitGroup
	jobMu           sync.Mutex
	inFlight        map[translationKey]struct{}
	progressMu      sync.Mutex
	progress        map[translationKey]translationProgress
	draftMu         sync.Mutex
	drafts          map[translationKey]*draftTranslationState
	draftSlots      chan struct{}
	// draftInterval is the least time from one draft translation request to
	// the next for the same line, in nanoseconds.
	draftInterval  atomic.Int64
	draftWG        sync.WaitGroup
	noAudioTimeout time.Duration
	// reattachGrace is how long a recording whose connection dropped waits
	// for its browser to come back and go on with the same run. Zero ends
	// the run with its connection.
	reattachGrace time.Duration
	// health, when set, is the monitor's word on the providers; without it
	// they are asked directly.
	health  providers.HealthSource
	gapWake chan struct{}
}

type room struct {
	gate     sync.Mutex
	watches  map[uint64]*watcher
	recorder *recordLease
}

type watcher struct {
	id       uint64
	viewer   domain.Viewer
	access   domain.SessionAccess
	queue    chan roomEvent
	presence chan struct{}
	cancel   context.CancelFunc
}

type roomEvent struct {
	data   any
	target string
}

type recordLease struct {
	id uint64
	// recognitionPaused: recognition is unavailable; the audio is still saved.
	recognitionPaused atomic.Bool
	// recognitionCatchingUp: recognition was paused for audio that waited,
	// not because it went away.
	recognitionCatchingUp atomic.Bool
	viewer                domain.Viewer
	access                domain.SessionAccess
	ctx                   context.Context
	cancel                context.CancelCauseFunc
	done                  chan struct{}
	provider              providers.Snapshot
	conn                  *websocket.Conn
	writeMu               sync.Mutex
	room                  *room
	claimed               bool
	// sampleRate is the recording's audio rate: a connection that comes back
	// to the run must send the same.
	sampleRate int
	// attach hands the run a returning recorder's new connection.
	attach chan recordAttachment
	// detached: the run's connection dropped and it waits for the recorder.
	detached atomic.Bool
	// looping: the run is recording and can take a returning connection.
	looping atomic.Bool
	// closed is closed once the run has said its last word to its connection.
	closed chan struct{}
}

// recordAttachment is a returning recorder's new connection to a run in
// progress. done is closed when the run has let go of it.
type recordAttachment struct {
	conn  *websocket.Conn
	hello audioHello
	agent string
	done  chan struct{}
}

type RecordingState struct {
	Active     bool   `json:"active"`
	HolderID   string `json:"holderId,omitempty"`
	HolderName string `json:"holderName,omitempty"`
	IsMine     bool   `json:"isMine"`
	// RecognitionPaused: recognition dropped out; recording goes on and the
	// missed stretch is recognized once it is back.
	RecognitionPaused bool `json:"recognitionPaused,omitempty"`
	// RecognitionCatchingUp: recognition is well, and paused only while audio
	// that waited, as through a dropped connection, is saved to be recognized
	// in its place.
	RecognitionCatchingUp bool `json:"recognitionCatchingUp,omitempty"`
}

// New accepts the sharing service through its narrow Resolve contract so room
// tests can exercise revocation without constructing browser credentials.
func New(database *store.Store, sharing AccessResolver, registry *providers.Registry, logger *slog.Logger) (*Service, error) {
	return newService(database, sharing, registry, logger)
}

func newService(database *store.Store, sharing AccessResolver, registry providerSource, logger *slog.Logger) (*Service, error) {
	if database == nil || sharing == nil || registry == nil {
		return nil, errors.New("rooms: store, sharing resolver, and provider registry are required")
	}
	if logger == nil {
		logger = slog.Default()
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Service{store: database, access: sharing, providers: registry, logger: logger,
		ctx: ctx, cancel: cancel, rooms: make(map[string]*room), jobs: make(chan translationTask, 64),
		inFlight: make(map[translationKey]struct{}), noAudioTimeout: noAudioDeadline, reattachGrace: reattachDeadline,
		watchesByViewer: make(map[string]int), progress: make(map[translationKey]translationProgress)}
	s.drafts = make(map[translationKey]*draftTranslationState)
	s.draftSlots = make(chan struct{}, 4)
	s.draftInterval.Store(int64(defaultDraftInterval))
	s.gapWake = make(chan struct{}, 1)
	for range 4 {
		s.workers.Add(1)
		go s.translationWorker()
	}
	s.workers.Add(2)
	go s.gapWorker()
	go s.translationRetryWorker()
	return s, nil
}

// SetHealth has the service consult a monitor's view of the providers.
func (s *Service) SetHealth(source providers.HealthSource) {
	s.mu.Lock()
	s.health = source
	s.mu.Unlock()
}

func (s *Service) healthSource() providers.HealthSource {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.health
}

// RecognitionAvailable says whether a recording could start now. The
// monitor's latest sample decides when there is one; otherwise the provider
// is asked.
func (s *Service) RecognitionAvailable(ctx context.Context) bool {
	provider := s.providers.Snapshot().ASR
	if provider == nil {
		return false
	}
	if source := s.healthSource(); source != nil {
		if health := source.ASRHealth(); health.Known {
			return health.Ready && health.CanAccept
		}
	}
	checkCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return provider.Ready(checkCtx) == nil
}

// Activity is this service's share of the providers' load: recordings in
// progress, open watches and the rooms holding them.
func (s *Service) Activity() (recordings, watchers, rooms int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, room := range s.rooms {
		if room.recorder != nil {
			recordings++
		}
	}
	return recordings, s.watchCount, len(s.rooms)
}

func (s *Service) roomLocked(sessionID string) *room {
	current := s.rooms[sessionID]
	if current == nil {
		current = &room{watches: make(map[uint64]*watcher)}
		s.rooms[sessionID] = current
	}
	return current
}

func (s *Service) stateLocked(sessionID string, viewer domain.Viewer) RecordingState {
	current := s.rooms[sessionID]
	if current == nil || current.recorder == nil {
		return RecordingState{}
	}
	lease := current.recorder
	return RecordingState{Active: true, HolderID: lease.viewer.ID,
		HolderName: lease.viewer.DisplayName, IsMine: lease.viewer.ID == viewer.ID,
		RecognitionPaused: lease.recognitionPaused.Load(), RecognitionCatchingUp: lease.recognitionPaused.Load() && lease.recognitionCatchingUp.Load()}
}

// State is an in-memory activity projection. Absence never implies that a
// persisted status transition has committed yet; the database remains authority.
func (s *Service) State(sessionID string, viewers ...domain.Viewer) RecordingState {
	var viewer domain.Viewer
	if len(viewers) != 0 {
		viewer = viewers[0]
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stateLocked(sessionID, viewer)
}

func (s *Service) begin() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing || s.ctx.Err() != nil {
		return errors.New("rooms: shutting down")
	}
	s.active.Add(1)
	return nil
}

func (s *Service) resolve(ctx context.Context, viewer domain.Viewer, sessionID string) (domain.SessionAccess, error) {
	if viewer.UserID != "" {
		if viewer.BrowserSessionID == "" || s.store.ValidateBrowserSession(ctx, viewer.UserID,
			viewer.BrowserSessionID, time.Now().UTC()) != nil {
			return domain.SessionAccess{}, ErrAuthRevoked
		}
	}
	return s.access.Resolve(ctx, viewer, sessionID)
}

func (s *Service) releaseWatch(sessionID string, current *watcher) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if room := s.rooms[sessionID]; room != nil {
		if room.watches[current.id] == current {
			delete(room.watches, current.id)
			s.watchCount--
			s.watchesByViewer[current.viewer.ID]--
			if s.watchesByViewer[current.viewer.ID] == 0 {
				delete(s.watchesByViewer, current.viewer.ID)
			}
		}
		if room.recorder == nil && len(room.watches) == 0 {
			delete(s.rooms, sessionID)
		} else {
			s.broadcastPresenceLocked(sessionID)
		}
	}
}

func (s *Service) registerWatch(sessionID string, current *watcher) (RecordingState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing || s.ctx.Err() != nil {
		return RecordingState{}, errors.New("rooms: shutting down")
	}
	room := s.rooms[sessionID]
	if s.watchCount >= maxGlobalWatchers || s.watchesByViewer[current.viewer.ID] >= maxViewerWatchers ||
		(room != nil && len(room.watches) >= maxRoomWatchers) {
		return RecordingState{}, ErrWatchCapacity
	}
	if room == nil {
		room = s.roomLocked(sessionID)
	}
	room.watches[current.id] = current
	s.watchCount++
	s.watchesByViewer[current.viewer.ID]++
	s.broadcastPresenceLocked(sessionID)
	return s.stateLocked(sessionID, current.viewer), nil
}

func (s *Service) broadcast(sessionID string, event roomEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	room := s.rooms[sessionID]
	if room == nil {
		return
	}
	for _, watch := range room.watches {
		if event.target != "" && event.target != watch.access.TargetLanguage {
			continue
		}
		select {
		case watch.queue <- event:
		default:
			watch.cancel()
		}
	}
}

func (s *Service) broadcastRecording(sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	room := s.rooms[sessionID]
	if room == nil {
		return
	}
	for _, watch := range room.watches {
		state := s.stateLocked(sessionID, watch.viewer)
		select {
		case watch.queue <- roomEvent{data: map[string]any{"type": "recording", "recording": state}}:
		default:
			watch.cancel()
		}
	}
	// Who is recording is part of who is here.
	s.broadcastPresenceLocked(sessionID)
}

func sendSSE(w http.ResponseWriter, value any) error {
	controller := http.NewResponseController(w)
	if err := controller.SetWriteDeadline(time.Now().Add(watchWriteTimeout)); err != nil && !errors.Is(err, http.ErrNotSupported) {
		return err
	}
	defer func() { _ = controller.SetWriteDeadline(time.Time{}) }()
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "data: %s\n\n", payload); err != nil {
		return err
	}
	return controller.Flush()
}

func sendSSEHeartbeat(w http.ResponseWriter) error {
	controller := http.NewResponseController(w)
	if err := controller.SetWriteDeadline(time.Now().Add(watchWriteTimeout)); err != nil && !errors.Is(err, http.ErrNotSupported) {
		return err
	}
	defer func() { _ = controller.SetWriteDeadline(time.Time{}) }()
	if _, err := fmt.Fprint(w, ": keepalive\n\n"); err != nil {
		return err
	}
	return controller.Flush()
}

// ServeWatch registers before the bootstrap read. Events racing with the tail
// query remain queued, and clients merge duplicate sequence snapshots by ID.
func (s *Service) ServeWatch(w http.ResponseWriter, r *http.Request, viewer domain.Viewer, sessionID string) error {
	if err := s.begin(); err != nil {
		return err
	}
	defer s.active.Done()
	access, err := s.resolve(r.Context(), viewer, sessionID)
	if err != nil {
		return err
	}
	// The root's fixed deadline protects unauthenticated requests. Once
	// authorized, SSE owns an idle connection; each write gets its own bound.
	if err := http.NewResponseController(w).SetWriteDeadline(time.Time{}); err != nil && !errors.Is(err, http.ErrNotSupported) {
		return err
	}
	ctx, cancel := context.WithCancel(r.Context())
	viewer = access.Viewer
	current := &watcher{id: s.nextID.Add(1), viewer: viewer, access: access,
		queue: make(chan roomEvent, watchQueueLimit), presence: make(chan struct{}, 1), cancel: cancel}
	state, err := s.registerWatch(sessionID, current)
	if err != nil {
		cancel()
		return err
	}
	defer func() { cancel(); s.releaseWatch(sessionID, current) }()
	page, err := s.store.ListSegmentsWindow(ctx, access.Session.UserID, sessionID,
		store.SegmentPageQuery{Mode: store.SegmentPageTail, Limit: watchTailLimit})
	if err != nil {
		return err
	}
	segments, err := s.PresentSegments(ctx, access, page.Items)
	if err != nil {
		return err
	}
	projectedSession := access.Session
	projectedSession.TargetLanguage = access.TargetLanguage
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	gaps, err := s.store.ListRecognitionGaps(ctx, access.Session.UserID, sessionID)
	if err != nil {
		return err
	}
	if err := sendSSE(w, map[string]any{"type": "snapshot", "session": projectedSession, "recognitionGaps": gaps,
		"segments": segments, "access": map[string]any{
			"viewerId": viewer.ID, "displayName": viewer.DisplayName, "isOwner": access.IsOwner,
			"permission": access.Permission, "targetLanguage": access.TargetLanguage,
		}, "recording": state, "presence": s.Presence(sessionID, viewer), "targetLanguage": access.TargetLanguage}); err != nil {
		return nil
	}
	recheck := time.NewTicker(watchRevalidateEvery)
	defer recheck.Stop()
	heartbeat := time.NewTicker(watchHeartbeatEvery)
	defer heartbeat.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case event := <-current.queue:
			if err := sendSSE(w, event.data); err != nil {
				return nil
			}
		case <-current.presence:
			if err := sendSSE(w, map[string]any{"type": "presence", "presence": s.Presence(sessionID, viewer)}); err != nil {
				return nil
			}
		case <-heartbeat.C:
			if err := sendSSEHeartbeat(w); err != nil {
				return nil
			}
		case <-recheck.C:
			fresh, err := s.resolve(ctx, viewer, sessionID)
			if err != nil || accessChanged(current.access, fresh) {
				return nil
			}
		}
	}
}

func (s *Service) RevokeBrowserSession(browserSessionID string) {
	if browserSessionID == "" {
		return
	}
	s.cancelMatching(func(v domain.Viewer) bool { return v.BrowserSessionID == browserSessionID }, ErrAuthRevoked)
}

func (s *Service) RevokeUser(userID string) {
	if userID == "" {
		return
	}
	s.cancelMatching(func(v domain.Viewer) bool { return v.UserID == userID }, ErrAuthRevoked)
}

func (s *Service) cancelMatching(matches func(domain.Viewer) bool, cause error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, room := range s.rooms {
		for _, watch := range room.watches {
			if matches(watch.viewer) {
				watch.cancel()
			}
		}
		if room.recorder != nil && matches(room.recorder.viewer) {
			room.recorder.cancel(cause)
		}
	}
}

// AccessChanged closes watches whose target changed, letting EventSource
// reconnect with the new preference. An unchanged record grant keeps its lease.
func (s *Service) AccessChanged(sessionID string) {
	s.mu.Lock()
	room := s.rooms[sessionID]
	if room == nil {
		s.mu.Unlock()
		return
	}
	watches := make([]*watcher, 0, len(room.watches))
	for _, watch := range room.watches {
		watches = append(watches, watch)
	}
	current := room.recorder
	s.mu.Unlock()
	for _, watch := range watches {
		ctx, cancel := context.WithTimeout(s.ctx, 2*time.Second)
		fresh, err := s.resolve(ctx, watch.viewer, sessionID)
		cancel()
		if err != nil || accessChanged(watch.access, fresh) {
			watch.cancel()
		}
	}
	if current != nil {
		ctx, cancel := context.WithTimeout(s.ctx, 2*time.Second)
		fresh, err := s.resolve(ctx, current.viewer, sessionID)
		cancel()
		if err != nil || (fresh.Permission != domain.ShareRecord && !fresh.IsOwner) || fresh.Session.ArchivedAt != nil {
			current.cancel(ErrAccessRevoked)
		}
	}
}

func accessChanged(before, after domain.SessionAccess) bool {
	return before.TargetLanguage != after.TargetLanguage || before.Permission != after.Permission ||
		before.ShareID != after.ShareID || before.IsOwner != after.IsOwner ||
		(before.Session.ArchivedAt == nil) != (after.Session.ArchivedAt == nil)
}

func (s *Service) StopRecorder(ctx context.Context, viewer domain.Viewer, sessionID string) error {
	access, err := s.resolve(ctx, viewer, sessionID)
	if err != nil {
		return err
	}
	if !access.IsOwner {
		return store.ErrForbidden
	}
	s.mu.Lock()
	room := s.rooms[sessionID]
	var current *recordLease
	if room != nil {
		current = room.recorder
	}
	s.mu.Unlock()
	if current == nil {
		return nil
	}
	current.cancel(ErrStopped)
	select {
	case <-current.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// EndOwnerRecordings stops every recording of one owner's sessions, whoever
// is recording, and waits for each to end, as before the owner's account is
// deleted.
func (s *Service) EndOwnerRecordings(ctx context.Context, ownerID string) error {
	s.mu.Lock()
	var leases []*recordLease
	for _, room := range s.rooms {
		if room.recorder != nil && room.recorder.access.Session.UserID == ownerID {
			leases = append(leases, room.recorder)
		}
	}
	s.mu.Unlock()
	for _, lease := range leases {
		lease.cancel(ErrStopped)
	}
	for _, lease := range leases {
		select {
		case <-lease.done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

func (s *Service) Shutdown(ctx context.Context) error {
	s.mu.Lock()
	s.closing = true
	s.cancel()
	for _, room := range s.rooms {
		for _, watch := range room.watches {
			watch.cancel()
		}
		if room.recorder != nil {
			room.recorder.cancel(context.Canceled)
		}
	}
	s.mu.Unlock()
	done := make(chan struct{})
	go func() { s.active.Wait(); s.draftWG.Wait(); s.workers.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// OwnerRecordings is how many of one owner's sessions are recording now.
func (s *Service) OwnerRecordings(ownerID string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	count := 0
	for _, room := range s.rooms {
		if room.recorder != nil && room.recorder.access.Session.UserID == ownerID {
			count++
		}
	}
	return count
}

// ownerRecordingsFor counts the owner's recordings as a start by viewer
// would: runs of the viewer's own browser that wait for it do not count.
func (s *Service) ownerRecordingsFor(ownerID string, viewer domain.Viewer) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	count := 0
	for _, room := range s.rooms {
		if lease := room.recorder; lease != nil && lease.access.Session.UserID == ownerID &&
			!(lease.detached.Load() && sameRecorder(lease.viewer, viewer)) {
			count++
		}
	}
	return count
}

// Gaps is one session's recognition gaps, for readers of its transcript.
func (s *Service) Gaps(ctx context.Context, access domain.SessionAccess) ([]domain.RecognitionGap, error) {
	return s.store.ListRecognitionGaps(ctx, access.Session.UserID, access.Session.ID)
}
