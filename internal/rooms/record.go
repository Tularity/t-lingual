package rooms

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/Tularity/t-lingual/internal/asr"
	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/id"
	"github.com/Tularity/t-lingual/internal/media"
	"github.com/Tularity/t-lingual/internal/store"
	"github.com/coder/websocket"
)

const (
	maxAudioFrame   = 256 << 10
	maxControlFrame = 8 << 10
	helloDeadline   = 10 * time.Second
	noAudioDeadline = 30 * time.Second
	// reattachDeadline is how long a run whose connection dropped waits for
	// its browser to come back to it.
	reattachDeadline = 5 * time.Minute
	// upstreamKeepAlive: recognition hears from a waiting run this often, so
	// it keeps the stream while no audio comes.
	upstreamKeepAlive = 30 * time.Second
	maxRecordLength   = 4 * time.Hour
	writeDeadline     = 2 * time.Second
	upstreamDeadline  = 2 * time.Second
	captionForceAfter = 8 * time.Second
	// Recognition that drops out is asked for again after this long at
	// first, backing off to the most.
	recognitionRetryFirst = 2 * time.Second
	recognitionRetryMost  = 15 * time.Second
	// A gap keeps one sequence number for each this many milliseconds of
	// audio, and a few spare: a spoken line is rarely shorter.
	gapMillisecondsPerLine = 400
	gapSpareLines          = 32

	// maxCatchUp is the most audio a returning recorder can send faster than
	// it is spoken: what its browser kept while the connection was down.
	maxCatchUp = 15 * time.Minute
	// Catching up by more than catchUpInline pauses recognition: the audio is
	// saved at once and recognized later at a pace recognition can keep,
	// while live recognition resumes where speech is now. Less is sent to
	// recognition as it arrives, a few times faster than speech.
	catchUpInline = 20 * time.Second
)

// errCatchingUp pauses recognition while a returning recorder sends the audio
// it kept while its connection was down.
var errCatchingUp = errors.New("catching up audio kept while the connection was down")

// errCapabilitiesUnavailable: recognition could not be asked what it can do,
// as when it is away.
var errCapabilitiesUnavailable = errors.New("recognition capabilities unavailable")

type audioHello struct {
	Type  string `json:"type"`
	Audio struct {
		Encoding   string `json:"encoding"`
		SampleRate int    `json:"sampleRate"`
		Channels   int    `json:"channels"`
	} `json:"audio"`
	Client *clientDiagnostics `json:"client"`
}

// clientDiagnostics is what a recording browser saw since its last
// connection, as it tells with each start. It is only logged, so that an
// interrupted recording can be explained afterwards.
type clientDiagnostics struct {
	Reason    string `json:"reason"`
	Attempt   int    `json:"attempt"`
	LastClose *struct {
		Code    int    `json:"code"`
		Reason  string `json:"reason"`
		AfterMS int64  `json:"afterMs"`
	} `json:"lastClose"`
	HiddenMS     int64  `json:"hiddenMs"`
	CaptureGapMS int64  `json:"captureGapMs"`
	LostMS       int64  `json:"lostMs"`
	KeptMS       int64  `json:"keptMs"`
	AudioState   string `json:"audioState"`
	Visible      *bool  `json:"visible"`
}

// logAttributes are the diagnostics as bounded log attributes.
func (d *clientDiagnostics) logAttributes() []any {
	if d == nil {
		return nil
	}
	bounded := func(value string, most int) string {
		if len(value) > most {
			return value[:most]
		}
		return value
	}
	attributes := []any{"client_reason", bounded(d.Reason, 16), "client_attempt", d.Attempt,
		"client_hidden_ms", d.HiddenMS, "client_capture_gap_ms", d.CaptureGapMS, "client_lost_ms", d.LostMS,
		"client_kept_ms", d.KeptMS, "client_audio_state", bounded(d.AudioState, 16)}
	if d.Visible != nil {
		attributes = append(attributes, "client_visible", *d.Visible)
	}
	if d.LastClose != nil {
		attributes = append(attributes, "client_last_close_code", d.LastClose.Code,
			"client_last_close_reason", bounded(d.LastClose.Reason, 120), "client_last_close_after_ms", d.LastClose.AfterMS)
	}
	return attributes
}

// userAgent is a request's browser, bounded for the log.
func userAgent(r *http.Request) string {
	agent := r.UserAgent()
	if len(agent) > 200 {
		agent = agent[:200]
	}
	return agent
}

type clientPacket struct {
	kind websocket.MessageType
	data []byte
	err  error
}

type draftLine struct {
	id          string
	sequence    int64
	revision    int
	firstWallMS int64
	forced      bool
}

func shouldForceCaption(draft *draftLine, event asr.Event, vadState string) bool {
	if draft == nil || draft.forced || vadState != "speech" || draft.firstWallMS <= 0 ||
		event.WallMS-draft.firstWallMS < captionForceAfter.Milliseconds() {
		return false
	}
	han, letters := 0, 0
	for _, character := range event.Text {
		if unicode.Is(unicode.Han, character) {
			han++
		}
		if unicode.IsLetter(character) {
			letters++
		}
	}
	return han >= 12 || letters >= 40
}

type speakerSpan struct {
	id      string
	wall0MS int64
	wall1MS int64
}

func speakerForWallRange(wall0MS, wall1MS int64, spans []speakerSpan) string {
	chosen, _ := speakerDecision(wall0MS, wall1MS, spans)
	return chosen
}

func speakerDecision(wall0MS, wall1MS int64, spans []speakerSpan) (string, bool) {
	if wall0MS <= 0 || wall1MS <= wall0MS {
		return "", false
	}
	type interval struct{ start, end int64 }
	bySpeaker := make(map[string][]interval)
	for _, span := range spans {
		start, end := max(wall0MS, span.wall0MS), min(wall1MS, span.wall1MS)
		if end > start && span.id != "" {
			bySpeaker[span.id] = append(bySpeaker[span.id], interval{start, end})
		}
	}
	best, chosen, tied := int64(0), "", false
	for speaker, intervals := range bySpeaker {
		sort.Slice(intervals, func(i, j int) bool { return intervals[i].start < intervals[j].start })
		start, end, total := intervals[0].start, intervals[0].end, int64(0)
		for _, current := range intervals[1:] {
			if current.start <= end {
				end = max(end, current.end)
			} else {
				total += end - start
				start, end = current.start, current.end
			}
		}
		total += end - start
		if total > best {
			best, chosen, tied = total, speaker, false
		} else if total == best {
			tied = true
		}
	}
	duration := wall1MS - wall0MS
	if tied {
		// Competing substantial evidence means unknown; a pair of tiny
		// boundary overlaps must not erase a previously established label.
		return "", best*4 >= duration
	}
	if best*2 > duration {
		return chosen, true
	}
	return "", false
}

// In audio_sense sessions t0/t1 are VAD-gated ASR time. w0/w1 are stamped
// against the received, un-gated PCM clock; only the latter preserves silence.
func sourceTimelineRange(event asr.Event, info asr.StartResponse, offsetMS int64) (int64, int64) {
	if info.CreatedAt > 0 {
		originMS := int64(info.CreatedAt * 1000)
		start, end := event.Wall0MS-originMS, event.Wall1MS-originMS
		if event.Wall0MS >= originMS && end >= start && end <= (maxRecordLength+5*time.Minute).Milliseconds() {
			return offsetMS + start, offsetMS + end
		}
	}
	start, end := max(int64(0), event.StartMS), max(int64(0), event.EndMS)
	if end < start {
		end = start
	}
	return offsetMS + start, offsetMS + end
}

func observedLanguage(requested, upstream string) string {
	// A fixed language or echoed "auto" is the decoding mode, not evidence of
	// a per-utterance language decision. Preserve only a concrete auto tag.
	if requested == "auto" && upstream != "" && upstream != "auto" {
		return upstream
	}
	return ""
}

func asrPersistenceContext(ctx context.Context) (context.Context, context.CancelFunc) {
	// Owner-stop cancels the browser lease before the upstream force/end drain.
	// Its last final still belongs to this generation and must be durable.
	if errors.Is(context.Cause(ctx), ErrStopped) {
		return context.WithTimeout(context.Background(), 5*time.Second)
	}
	return ctx, func() {}
}

func asrLanguage(source string) (string, error) {
	switch strings.ToLower(source) {
	case "auto":
		return "auto", nil
	case "en", "en-us":
		return "en", nil
	case "zh-hans", "zh-cn", "zh-sg":
		return "zh-CN", nil
	default:
		return "", errors.New("the configured recognition provider does not support this source language")
	}
}

type asrStartOptions struct {
	language   string
	audioSense bool
}

func resolveASRStart(ctx context.Context, provider asr.Provider, source string, diarization bool) (asrStartOptions, error) {
	capable, ok := provider.(asr.CapabilityProvider)
	if !ok {
		language, err := asrLanguage(source)
		return asrStartOptions{language: language}, err
	}
	checkCtx, cancel := context.WithTimeout(ctx, upstreamDeadline)
	capabilities, err := capable.Capabilities(checkCtx)
	cancel()
	if err != nil {
		return asrStartOptions{}, fmt.Errorf("%w: %w", errCapabilitiesUnavailable, err)
	}
	if diarization && !capabilities.Diarization {
		return asrStartOptions{}, errors.New("recognition provider does not support diarization")
	}
	language, err := asr.NormalizeLanguage(source, capabilities)
	if err != nil {
		return asrStartOptions{}, err
	}
	return asrStartOptions{language: language, audioSense: capabilities.AudioSense}, nil
}

func (s *Service) isCurrent(lease *recordLease) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	room := s.rooms[lease.access.Session.ID]
	return room != nil && room.recorder == lease
}

// sameRecorder reports whether two leases come from the same person in the
// same browser: a recorder returning after its connection dropped.
func sameRecorder(a, b domain.Viewer) bool {
	return a.ID == b.ID && a.BrowserSessionID == b.BrowserSessionID && a.GuestID == b.GuestID
}

func (s *Service) reserveRecorder(lease *recordLease, takeover, resume bool, ownerLimit int) (*recordLease, error) {
	s.mu.Lock()
	room := s.roomLocked(lease.access.Session.ID)
	s.mu.Unlock()
	room.gate.Lock()
	defer room.gate.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing {
		return nil, errors.New("rooms: shutting down")
	}
	previous := room.recorder
	// The same browser coming back replaces its own run: resuming it, or
	// starting again after its page was reloaded while the run waited.
	if previous != nil && (!takeover || !lease.access.IsOwner) && !((resume || previous.detached.Load()) && sameRecorder(previous.viewer, lease.viewer)) {
		return nil, ErrOccupied
	}
	if previous == nil {
		// A browser starting a recording has left any run of its own that
		// still waits for it: those end rather than count against it.
		var abandoned []*recordLease
		active, byOwner := 0, 0
		for _, existing := range s.rooms {
			if existing.recorder == nil {
				continue
			}
			if existing.recorder.detached.Load() && sameRecorder(existing.recorder.viewer, lease.viewer) {
				abandoned = append(abandoned, existing.recorder)
				continue
			}
			active++
			if existing.recorder.access.Session.UserID == lease.access.Session.UserID {
				byOwner++
			}
		}
		if active >= maxRecordings {
			return nil, store.ErrCapacity
		}
		if byOwner >= ownerLimit {
			return nil, ErrRecordingLimit
		}
		for _, left := range abandoned {
			left.cancel(ErrReplaced)
		}
	}
	lease.room = room
	room.recorder = lease
	return previous, nil
}

func (s *Service) releaseRecorder(lease *recordLease, status domain.InterpretationStatus) {
	room := lease.room
	room.gate.Lock()
	s.mu.Lock()
	current := s.rooms[lease.access.Session.ID] == room && room.recorder == lease
	s.mu.Unlock()
	if current && lease.claimed {
		now := time.Now().UTC()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		if err := s.store.UpdateInterpretationSessionStatus(ctx, lease.access.Session.UserID,
			lease.access.Session.ID, status, lease.access.Session.StartedAt, &now, now); err != nil {
			s.logger.Error("persist recorder end", "session_id", lease.access.Session.ID, "error", err)
		}
		cancel()
		snapshotCtx, snapshotCancel := context.WithTimeout(context.Background(), 5*time.Second)
		if err := s.store.FlushPortableSession(snapshotCtx, lease.access.Session.UserID, lease.access.Session.ID); err != nil {
			s.logger.Error("flush portable session", "session_id", lease.access.Session.ID, "error", err)
		}
		snapshotCancel()
	}
	s.mu.Lock()
	if current && room.recorder == lease {
		room.recorder = nil
		if len(room.watches) == 0 {
			delete(s.rooms, lease.access.Session.ID)
		}
	}
	s.mu.Unlock()
	room.gate.Unlock()
	if current {
		s.broadcastRecording(lease.access.Session.ID)
		s.broadcast(lease.access.Session.ID, roomEvent{data: map[string]any{"type": "stopped", "status": status}})
	}
	close(lease.done)
}

func (s *Service) writeRecord(lease *recordLease, data any) error {
	if lease.conn == nil {
		return nil
	}
	payload, err := json.Marshal(data)
	if err != nil {
		return err
	}
	lease.writeMu.Lock()
	defer lease.writeMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), writeDeadline)
	defer cancel()
	return lease.conn.Write(ctx, websocket.MessageText, payload)
}

func readHello(ctx context.Context, conn *websocket.Conn) (audioHello, error) {
	var hello audioHello
	deadline, cancel := context.WithTimeout(ctx, helloDeadline)
	defer cancel()
	kind, payload, err := conn.Read(deadline)
	if err != nil {
		return hello, err
	}
	if kind != websocket.MessageText || len(payload) > maxControlFrame || json.Unmarshal(payload, &hello) != nil || hello.Type != "start" ||
		(hello.Audio.Encoding != "pcm32f" && hello.Audio.Encoding != "pcm16") || hello.Audio.Channels != 1 || hello.Audio.SampleRate < 8000 || hello.Audio.SampleRate > 192000 {
		return audioHello{}, errors.New("invalid mono pcm32f or pcm16 start message")
	}
	return hello, nil
}

// ServeRecord admits exactly one recorder per session. An owner must explicitly
// request takeover; record-granted collaborators cannot silently replace peers.
func (s *Service) ServeRecord(w http.ResponseWriter, r *http.Request, viewer domain.Viewer, sessionID string, takeover bool) error {
	if err := s.begin(); err != nil {
		return err
	}
	defer s.active.Done()
	access, err := s.resolve(r.Context(), viewer, sessionID)
	if err != nil {
		return err
	}
	if (access.Permission != domain.ShareRecord && !access.IsOwner) || access.Session.ArchivedAt != nil {
		return store.ErrForbidden
	}
	if takeover && !access.IsOwner {
		http.Error(w, "Only the owner can take over a recording", http.StatusForbidden)
		return nil
	}
	// A recorder returning after its connection dropped goes on where it was.
	resume := r.URL.Query().Get("resume") == "true"
	// A recording counts against the session's owner, whoever records it.
	limits, err := s.store.EffectiveLimits(r.Context(), access.Session.UserID)
	if err != nil {
		return err
	}
	// A returning recorder whose run still waits for it goes on with that run.
	if resume && !takeover {
		if running := s.reattachable(sessionID, access.Viewer); running != nil {
			return s.reattach(w, r, access.Viewer, running)
		}
	}
	base, deadlineCancel := context.WithTimeoutCause(s.ctx, maxRecordLength, errors.New("recording duration exceeded"))
	ctx, cancel := context.WithCancelCause(base)
	viewer = access.Viewer
	lease := &recordLease{id: s.nextID.Add(1), viewer: viewer, access: access, ctx: ctx,
		cancel: cancel, done: make(chan struct{}), provider: s.providers.Snapshot(),
		attach: make(chan recordAttachment), closed: make(chan struct{})}
	previous, err := s.reserveRecorder(lease, takeover, resume, limits.ConcurrentRecordings)
	if err != nil {
		cancel(err)
		deadlineCancel()
		if errors.Is(err, ErrOccupied) {
			http.Error(w, "Another recorder is active", http.StatusConflict)
			return nil
		}
		if errors.Is(err, ErrRecordingLimit) {
			return refuseRecording(w, r, "RECORDING_LIMIT", "This session's owner is already recording as many sessions at once as their account allows.")
		}
		return err
	}
	if previous != nil {
		if previous.claimed {
			lease.claimed = true
			lease.access.Session.StartedAt = previous.access.Session.StartedAt
		}
		previous.cancel(ErrReplaced)
	}
	s.broadcastRecording(sessionID)
	status := domain.InterpretationCompleted
	finished := false
	finish := func() {
		if !finished {
			s.releaseRecorder(lease, status)
			finished = true
		}
	}
	defer func() {
		cancel(nil)
		deadlineCancel()
		finish()
		if lease.conn != nil {
			_ = lease.conn.CloseNow()
		}
		close(lease.closed)
	}()
	// The API route has already applied the configured RP-origin allowlist.
	// coder/websocket's default same-host check would reject a valid RP origin
	// when the service sits behind a reverse proxy with a different Host.
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		CompressionMode: websocket.CompressionDisabled, OriginPatterns: []string{"*"},
	})
	if err != nil {
		return fmt.Errorf("accept recording websocket: %w", err)
	}
	conn.SetReadLimit(maxAudioFrame)
	lease.conn = conn
	hello, err := readHello(ctx, conn)
	if err != nil {
		_ = s.writeRecord(lease, map[string]any{"type": "error", "code": "INVALID_START", "message": "A mono pcm32f start message is required."})
		return nil
	}
	lease.sampleRate = hello.Audio.SampleRate
	// A share can be revoked while its browser is waiting for microphone access.
	fresh, err := s.resolve(ctx, viewer, sessionID)
	if err != nil || (fresh.Permission != domain.ShareRecord && !fresh.IsOwner) || fresh.Session.ArchivedAt != nil || !s.isCurrent(lease) {
		code := "ACCESS_REVOKED"
		if errors.Is(err, ErrAuthRevoked) {
			code = "AUTH_REVOKED"
		}
		_ = s.writeRecord(lease, map[string]any{"type": "error", "code": code, "message": "Recording access changed. Reopen the session."})
		return nil
	}
	// Nothing is claimed for a recording that could not go on.
	if refusal := s.admitRecording(ctx, lease, limits, resume); refusal != nil {
		_ = s.writeRecord(lease, refusal)
		return nil
	}
	if previous != nil {
		select {
		case <-previous.done:
		case <-time.After(upstreamDeadline):
		case <-ctx.Done():
		}
	}
	lease.room.gate.Lock()
	if !s.isCurrent(lease) || ctx.Err() != nil {
		lease.room.gate.Unlock()
		return nil
	}
	fresh, err = s.resolve(ctx, viewer, sessionID)
	if err == nil && (fresh.Permission != domain.ShareRecord && !fresh.IsOwner || fresh.Session.ArchivedAt != nil) {
		err = store.ErrForbidden
	}
	if err == nil {
		lease.access = fresh
		access = fresh
	}
	var claimed domain.InterpretationSession
	if err == nil {
		claimed, err = s.store.ClaimInterpretationSessionLive(ctx, access.Session.UserID, sessionID, time.Now().UTC())
	}
	if err == nil {
		lease.claimed = true
		lease.access.Session = claimed
	}
	lease.room.gate.Unlock()
	if err != nil {
		_ = s.writeRecord(lease, map[string]any{"type": "error", "code": "RECORDING_UNAVAILABLE", "message": "This session cannot be recorded right now."})
		return nil
	}
	if err := s.record(ctx, lease, hello, limits); err != nil {
		if !errors.Is(err, ErrStopped) && !errors.Is(err, ErrReplaced) && !errors.Is(err, ErrAuthRevoked) && !errors.Is(err, ErrAccessRevoked) && !errors.Is(err, ErrRecordingQuota) && !errors.Is(err, context.Canceled) {
			status = domain.InterpretationFailed
		}
		finish()
		if errors.Is(err, ErrAuthRevoked) {
			_ = s.writeRecord(lease, map[string]any{"type": "error", "code": "AUTH_REVOKED", "message": "Browser authentication was revoked. Sign in again."})
		} else if errors.Is(err, ErrReplaced) || errors.Is(err, ErrAccessRevoked) {
			_ = s.writeRecord(lease, map[string]any{"type": "error", "code": "ACCESS_REVOKED", "message": "The recording moved or access changed."})
		} else if errors.Is(err, ErrRecordingQuota) {
			_ = s.writeRecord(lease, map[string]any{"type": "error", "code": "RECORDING_QUOTA", "message": "Recording stopped: this session's owner has used their recording time or storage. What was recorded is saved."})
		} else if status == domain.InterpretationFailed {
			_ = s.writeRecord(lease, map[string]any{"type": "error", "code": "RECORDING_STOPPED", "message": "The recording ended unexpectedly."})
		}
		return nil
	}
	finish()
	_ = s.writeRecord(lease, map[string]any{"type": "stopped", "status": domain.InterpretationCompleted})
	return nil
}

// reattachable is the run a returning recorder can go on with: the session's
// run, recording, from the same browser.
func (s *Service) reattachable(sessionID string, viewer domain.Viewer) *recordLease {
	s.mu.Lock()
	defer s.mu.Unlock()
	room := s.rooms[sessionID]
	if s.reattachGrace <= 0 || room == nil || room.recorder == nil {
		return nil
	}
	lease := room.recorder
	if lease.attach == nil || !lease.looping.Load() || !sameRecorder(lease.viewer, viewer) {
		return nil
	}
	return lease
}

// reattach hands a returning recorder's new connection to its run in
// progress, which answers it as a start. This request holds the connection
// until the run lets go of it.
func (s *Service) reattach(w http.ResponseWriter, r *http.Request, viewer domain.Viewer, lease *recordLease) error {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		CompressionMode: websocket.CompressionDisabled, OriginPatterns: []string{"*"},
	})
	if err != nil {
		return fmt.Errorf("accept recording websocket: %w", err)
	}
	conn.SetReadLimit(maxAudioFrame)
	refuse := func(code, message string) error {
		ctx, cancel := context.WithTimeout(context.Background(), writeDeadline)
		defer cancel()
		payload, _ := json.Marshal(map[string]any{"type": "error", "code": code, "message": message})
		_ = conn.Write(ctx, websocket.MessageText, payload)
		return conn.Close(websocket.StatusNormalClosure, "")
	}
	hello, err := readHello(r.Context(), conn)
	if err != nil {
		return refuse("INVALID_START", "A mono pcm32f start message is required.")
	}
	fresh, err := s.resolve(r.Context(), viewer, lease.access.Session.ID)
	if err != nil || (fresh.Permission != domain.ShareRecord && !fresh.IsOwner) || fresh.Session.ArchivedAt != nil {
		code := "ACCESS_REVOKED"
		if errors.Is(err, ErrAuthRevoked) {
			code = "AUTH_REVOKED"
		}
		return refuse(code, "Recording access changed. Reopen the session.")
	}
	// A run records at one rate; audio at another starts a run of its own,
	// which the recorder's next try does once this one has ended.
	if hello.Audio.SampleRate != lease.sampleRate {
		lease.cancel(ErrReplaced)
		return refuse("RECORDING_UNAVAILABLE", "The recording is starting again.")
	}
	attachment := recordAttachment{conn: conn, hello: hello, agent: userAgent(r), done: make(chan struct{})}
	select {
	case lease.attach <- attachment:
	case <-lease.done:
		return refuse("RECORDING_UNAVAILABLE", "The recording is starting again.")
	case <-r.Context().Done():
		return conn.CloseNow()
	}
	select {
	case <-attachment.done:
	case <-lease.closed:
	case <-s.ctx.Done():
	}
	return nil
}

// refuseRecording answers a recording that cannot begin in the recording's
// own words: a browser cannot read the status of a refused WebSocket.
func refuseRecording(w http.ResponseWriter, r *http.Request, code, message string) error {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		CompressionMode: websocket.CompressionDisabled, OriginPatterns: []string{"*"},
	})
	if err != nil {
		return fmt.Errorf("accept recording websocket: %w", err)
	}
	ctx, cancel := context.WithTimeout(r.Context(), writeDeadline)
	defer cancel()
	payload, _ := json.Marshal(map[string]any{"type": "error", "code": code, "message": message})
	_ = conn.Write(ctx, websocket.MessageText, payload)
	return conn.Close(websocket.StatusNormalClosure, "")
}

// admitRecording is what must hold before a session is claimed for
// recording: the owner has recording time and storage left, and recognition
// can take a new stream. It returns the refusal to send, or nil.
func (s *Service) admitRecording(ctx context.Context, lease *recordLease, limits domain.UserLimits, resume bool) map[string]any {
	refusal := func(code, message string) map[string]any {
		return map[string]any{"type": "error", "code": code, "message": message}
	}
	if _, reason := s.quotaReached(ctx, lease.access.Session.UserID, limits); reason != "" {
		return refusal("RECORDING_QUOTA", reason)
	}
	if lease.provider.ASR == nil {
		return refusal("ASR_UNAVAILABLE", "Recognition is not set up, so recording can't start.")
	}
	// A recording under way goes on while recognition is away; what it
	// misses is recognized once it is back.
	if !resume && !s.RecognitionAvailable(ctx) {
		return refusal("ASR_UNAVAILABLE", "Recognition is unavailable right now, so recording can't start. Try again shortly.")
	}
	return nil
}

// Why a session cannot be recorded now, as the recording page is told.
const (
	RefusalNotPermitted           = "not_permitted"
	RefusalArchived               = "archived"
	RefusalStorageFull            = "storage_full"
	RefusalRecordingTimeUsed      = "recording_time_used"
	RefusalRecordingLimit         = "recording_limit"
	RefusalRecognitionUnavailable = "recognition_unavailable"
)

// quotaReached names the used limit that stops the owner recording, if any:
// a reason code, and the words a recorder is told.
func (s *Service) quotaReached(ctx context.Context, ownerID string, limits domain.UserLimits) (string, string) {
	if limits.StorageMB > 0 {
		used, err := s.store.StorageBytes(ctx, ownerID)
		if err == nil && used >= int64(limits.StorageMB)<<20 {
			return RefusalStorageFull, "This session's owner has used their storage. Deleting older sessions frees it."
		}
	}
	if limits.MonthlyRecordingMinutes > 0 {
		used, err := s.store.RecordedMillisecondsSince(ctx, ownerID, store.MonthStart(time.Now()))
		if err == nil && used >= int64(limits.MonthlyRecordingMinutes)*60_000 {
			return RefusalRecordingTimeUsed, "This session's owner has used their recording time for this month."
		}
	}
	return "", ""
}

// RecordingAdmission is whether a viewer could start recording a session now,
// and if not, why. Recording is still decided when it starts; this lets the
// recording page say so before anyone tries.
type RecordingAdmission struct {
	Allowed bool   `json:"allowed"`
	Reason  string `json:"reason,omitempty"`
}

// Admission answers for one viewer and session with the rules recording
// itself applies: the viewer may record, the session is not archived, its
// owner has storage and recording time left and is not already recording as
// many sessions as allowed, and recognition can take a new stream. A session
// already being recorded is not refused for the owner's count: that is the
// recording in progress, which the page shows as such.
func (s *Service) Admission(ctx context.Context, viewer domain.Viewer, sessionID string) (RecordingAdmission, error) {
	access, err := s.resolve(ctx, viewer, sessionID)
	if err != nil {
		return RecordingAdmission{}, err
	}
	refuse := func(reason string) (RecordingAdmission, error) { return RecordingAdmission{Reason: reason}, nil }
	if access.Permission != domain.ShareRecord && !access.IsOwner {
		return refuse(RefusalNotPermitted)
	}
	if access.Session.ArchivedAt != nil {
		return refuse(RefusalArchived)
	}
	limits, err := s.store.EffectiveLimits(ctx, access.Session.UserID)
	if err != nil {
		return RecordingAdmission{}, err
	}
	if reason, _ := s.quotaReached(ctx, access.Session.UserID, limits); reason != "" {
		return refuse(reason)
	}
	s.mu.Lock()
	room := s.rooms[sessionID]
	recording := room != nil && room.recorder != nil
	s.mu.Unlock()
	if !recording && s.ownerRecordingsFor(access.Session.UserID, access.Viewer) >= limits.ConcurrentRecordings {
		return refuse(RefusalRecordingLimit)
	}
	if !s.RecognitionAvailable(ctx) {
		return refuse(RefusalRecognitionUnavailable)
	}
	return RecordingAdmission{Allowed: true}, nil
}

// ServeLive is the owner-only legacy route adapter. It still uses the same
// room lease, so the old endpoint cannot bypass collaborative exclusivity.
func (s *Service) ServeLive(w http.ResponseWriter, r *http.Request, user domain.User,
	browserSession domain.BrowserSession, sessionID string) error {
	if browserSession.ID == "" || browserSession.UserID != user.ID {
		return store.ErrForbidden
	}
	viewer := domain.Viewer{ID: "user:" + user.ID, UserID: user.ID,
		BrowserSessionID: browserSession.ID, DisplayName: user.DisplayName}
	return s.ServeRecord(w, r, viewer, sessionID, r.URL.Query().Get("takeover") == "true")
}

func readRecorder(ctx context.Context, conn *websocket.Conn, packets chan<- clientPacket) {
	defer close(packets)
	for {
		kind, data, err := conn.Read(ctx)
		select {
		case packets <- clientPacket{kind: kind, data: data, err: err}:
		case <-ctx.Done():
			return
		}
		if err != nil {
			return
		}
	}
}

// record runs one recording run. Recognition may drop out part-way: the
// audio is still saved and the browser stays connected, recognition is asked
// for again with backoff, and the stretch it missed is kept as a gap to be
// recognized from the saved audio once it is back.
func (s *Service) record(ctx context.Context, lease *recordLease, hello audioHello, limits domain.UserLimits) error {
	session := lease.access.Session
	// What recognition can do is asked with each start: a provider that is
	// away cannot say, and one that says it cannot serve this session ends it.
	var options asrStartOptions
	resolved := false
	startStream := func() (asr.Stream, error) {
		if !resolved {
			found, err := resolveASRStart(ctx, lease.provider.ASR, session.SourceLanguage, session.Diarization)
			if err != nil {
				return nil, err
			}
			options, resolved = found, true
		}
		stream, err := lease.provider.ASR.Start(ctx, asr.StartRequest{Language: options.language,
			Audio:      asr.AudioSpec{Encoding: "pcm32f", SampleRate: hello.Audio.SampleRate, Channels: 1},
			CacheLines: 1000, AudioSense: options.audioSense, Diarize: session.Diarization, SpeakerEmbedding: "off"})
		if err != nil {
			return nil, err
		}
		if options.audioSense && !stream.Info().AudioSense {
			closeStream(stream)
			return nil, errors.New("recognition audio sense was not activated")
		}
		return stream, nil
	}
	// Recognition that cannot start now does not stop the recording; one that
	// cannot serve this session at all does.
	upstream, startErr := startStream()
	if startErr != nil && !resolved && !errors.Is(startErr, errCapabilitiesUnavailable) {
		return startErr
	}
	defer func() {
		if upstream != nil {
			closeStream(upstream)
		}
	}()
	// Past every saved line and every number kept for a gap.
	lastSequence, err := s.store.NextSequenceBase(ctx, session.UserID, session.ID)
	if err != nil {
		return err
	}
	mediaManager, err := media.New(s.store, s.store.DataRoot())
	if err != nil {
		return err
	}
	previousEnd, err := s.store.MaxSegmentEndMS(ctx, session.UserID, session.ID)
	if err != nil {
		return err
	}
	runID, err := id.New("run")
	if err != nil {
		return err
	}
	audioWriter, offset, err := mediaManager.Begin(ctx, session.UserID, session.ID, runID, hello.Audio.SampleRate, previousEnd)
	if err != nil {
		return err
	}
	defer func() {
		if err := audioWriter.Close(); err != nil {
			s.logger.Error("close recording audio", "session_id", session.ID, "error", err)
		}
	}()
	chunkMS := 0
	if upstream != nil {
		chunkMS = upstream.Info().ChunkMS
	}
	if err := s.writeRecord(lease, map[string]any{"type": "ready", "sessionId": session.ID,
		"runId": runID, "chunkMs": chunkMS, "offsetMs": offset}); err != nil {
		return err
	}
	// The run's connection is read in a context of its own, so a dropped one
	// can be let go of while the run waits for its recorder to come back.
	var readCancel context.CancelFunc
	var packets chan clientPacket
	readFrom := func(conn *websocket.Conn) {
		readCtx, cancel := context.WithCancel(ctx)
		readCancel = cancel
		packets = make(chan clientPacket, 8)
		go readRecorder(readCtx, conn, packets)
	}
	readFrom(lease.conn)
	defer func() { readCancel() }()
	var eventsDone chan error
	// Audio reaches recognition through a feeder, in pieces of its own chunk.
	bytesPerSecond := float64(hello.Audio.SampleRate * 4)
	var feed *feeder
	var feedFailed <-chan error
	startFeed := func(stream asr.Stream) {
		feed = newFeeder(ctx, stream, int(bytesPerSecond))
		feedFailed = feed.failed
	}
	defer func() {
		if feed != nil {
			feed.close()
		}
	}()
	if upstream != nil {
		eventsDone = make(chan error, 1)
		go s.forwardASR(ctx, lease, upstream, &lastSequence, offset, eventsDone)
		startFeed(upstream)
	}

	// The recognition side. streamOffset is where the current stream began on
	// the session timeline; gapFrom is where recognition was lost, while it is.
	var written int64
	position := func() int64 { return offset + written/4*1000/int64(hello.Audio.SampleRate) }
	streamOffset := offset
	gapFrom := int64(-1)
	var draining chan error
	retryAt, backoff := time.Time{}, recognitionRetryFirst
	// catchUpUntil is how much of this run's audio must arrive before
	// recognition may resume, while a returning recorder catches up.
	var catchUpUntil int64
	interrupt := func(cause error) {
		s.logger.Warn("recognition interrupted; saving audio for later", "session_id", session.ID, "error", cause)
		stream := upstream
		upstream, draining, eventsDone = nil, eventsDone, nil
		if feed != nil {
			feed.close()
			feed, feedFailed = nil, nil
		}
		go closeStream(stream)
		s.CancelDrafts(lease)
		lastEnd, err := s.store.MaxSegmentEndMS(ctx, session.UserID, session.ID)
		if err != nil {
			lastEnd = 0
		}
		gapFrom = max(streamOffset, lastEnd)
		// Audio that waited is not recognition going away, and is said so.
		reason := "unavailable"
		if errors.Is(cause, errCatchingUp) || errors.Is(cause, errFeedBehind) {
			reason = "catching_up"
		}
		lease.recognitionCatchingUp.Store(reason == "catching_up")
		lease.recognitionPaused.Store(true)
		s.broadcastRecording(session.ID)
		s.broadcast(session.ID, roomEvent{data: map[string]any{"type": "recognition", "state": "interrupted", "sinceMs": gapFrom, "reason": reason}})
		retryAt, backoff = time.Now().Add(backoff), recognitionRetryFirst
	}
	// keepGap sets aside the gap up to until; the old stream must have
	// finished writing lines before its numbers are counted.
	keepGap := func(until int64) error {
		if draining != nil {
			select {
			case <-draining:
				draining = nil
			case <-time.After(5 * time.Second):
				return errors.New("recognition stream did not finish")
			}
		}
		// A line the old stream saved while draining is not recognized twice.
		if lastEnd, err := s.store.MaxSegmentEndMS(ctx, session.UserID, session.ID); err == nil {
			gapFrom = max(gapFrom, lastEnd)
		}
		if until <= gapFrom {
			return nil
		}
		gapID, err := id.New("gap")
		if err != nil {
			return err
		}
		reserve := (until-gapFrom)/gapMillisecondsPerLine + gapSpareLines
		gap := domain.RecognitionGap{ID: gapID, SessionID: session.ID, UserID: session.UserID, StartMS: gapFrom, EndMS: until,
			SequenceFrom: lastSequence + 1, SequenceTo: lastSequence + reserve, State: domain.GapPending, CreatedAt: time.Now().UTC()}
		persistCtx, cancel := asrPersistenceContext(ctx)
		defer cancel()
		if err := s.store.CreateRecognitionGap(persistCtx, gap); err != nil {
			return err
		}
		lastSequence += reserve
		s.broadcast(session.ID, roomEvent{data: map[string]any{"type": "gap", "gap": gap}})
		s.wakeGaps()
		return nil
	}
	resume := func() {
		if !s.RecognitionAvailable(ctx) {
			retryAt, backoff = time.Now().Add(backoff), min(backoff*2, recognitionRetryMost)
			return
		}
		if draining != nil {
			select {
			case <-draining:
				draining = nil
			default:
				retryAt = time.Now().Add(time.Second)
				return
			}
		}
		stream, err := startStream()
		if err != nil {
			retryAt, backoff = time.Now().Add(backoff), min(backoff*2, recognitionRetryMost)
			return
		}
		resumeAt := position()
		if err := keepGap(resumeAt); err != nil {
			closeStream(stream)
			s.logger.Error("keep recognition gap", "session_id", session.ID, "error", err)
			retryAt = time.Now().Add(backoff)
			return
		}
		upstream, streamOffset, gapFrom = stream, resumeAt, -1
		eventsDone = make(chan error, 1)
		go s.forwardASR(ctx, lease, stream, &lastSequence, resumeAt, eventsDone)
		startFeed(stream)
		lease.recognitionPaused.Store(false)
		s.broadcastRecording(session.ID)
		s.broadcast(session.ID, roomEvent{data: map[string]any{"type": "recognition", "state": "recovered", "atMs": resumeAt}})
	}

	if upstream == nil {
		s.logger.Warn("recognition unavailable at start; saving audio for later", "session_id", session.ID, "error", startErr)
		gapFrom = offset
		lease.recognitionPaused.Store(true)
		s.broadcastRecording(session.ID)
		s.broadcast(session.ID, roomEvent{data: map[string]any{"type": "recognition", "state": "interrupted", "sinceMs": gapFrom}})
		retryAt = time.Now().Add(backoff)
	}

	idleTick := min(time.Second, max(25*time.Millisecond, s.noAudioTimeout/4))
	ticker := time.NewTicker(idleTick)
	defer ticker.Stop()
	recheck := time.NewTicker(watchRevalidateEvery)
	defer recheck.Stop()
	lastPacket := time.Now()
	tokens := bytesPerSecond * 2
	// credit lets a returning recorder send what it kept faster than speech.
	var credit float64
	lastToken := time.Now()
	controlTokens, lastControl := 4.0, time.Now()
	noteTokens, lastNote := 8.0, time.Now()
	// The connection side. A connection that drops, or goes quiet, is let go
	// of; the run waits for its recorder to come back with a new one and goes
	// on where it was: the same audio, the same recognition stream, the same
	// speakers. A recorder whose page is in the background is waited for longer.
	var connDone chan struct{}
	// Each connection says how its audio is encoded; the run keeps float32.
	encoding := hello.Audio.Encoding
	connectedAt, lastUpstream := time.Now(), time.Now()
	var detachedAt time.Time
	hidden := false
	connections := 1
	s.logger.Info("recording started", append([]any{"session_id", session.ID, "run_id", runID, "offset_ms", offset,
		"sample_rate", hello.Audio.SampleRate, "recognition", upstream != nil}, hello.Client.logAttributes()...)...)
	detach := func(reason string) {
		readCancel()
		packets = nil
		_ = lease.conn.CloseNow()
		detachedAt = time.Now()
		lease.detached.Store(true)
		s.logger.Info("recording connection lost; waiting for the recorder", "session_id", session.ID, "run_id", runID,
			"connection", connections, "reason", reason, "connected_ms", time.Since(connectedAt).Milliseconds(),
			"silent_ms", time.Since(lastPacket).Milliseconds(), "hidden", hidden, "offset_ms", position())
	}
	lease.looping.Store(true)
	var runErr error
	graceful := false
	for runErr == nil && !graceful {
		select {
		case <-ctx.Done():
			runErr = context.Cause(ctx)
		case <-ticker.C:
			switch {
			case !detachedAt.IsZero():
				if time.Since(detachedAt) > s.reattachGrace {
					runErr = ErrNoAudio
				}
			case hidden:
				// A page in the background may send nothing for a while.
				if time.Since(lastPacket) > max(s.noAudioTimeout, s.reattachGrace) {
					runErr = ErrNoAudio
				}
			case time.Since(lastPacket) > s.noAudioTimeout:
				if s.reattachGrace > 0 {
					detach("no audio")
				} else {
					runErr = ErrNoAudio
				}
			}
			if runErr == nil && upstream == nil && time.Now().After(retryAt) && written >= catchUpUntil {
				resume()
			}
			// Recognition keeps a stream that goes on hearing from its run.
			if runErr == nil && upstream != nil && time.Since(lastUpstream) > upstreamKeepAlive {
				pingCtx, cancel := context.WithTimeout(ctx, upstreamDeadline)
				err := upstream.Ping(pingCtx)
				cancel()
				lastUpstream = time.Now()
				if err != nil && ctx.Err() == nil {
					interrupt(err)
				}
			}
		case attachment := <-lease.attach:
			// The recorder came back: its new connection goes on with this run.
			readCancel()
			previous := lease.conn
			lease.writeMu.Lock()
			lease.conn = attachment.conn
			lease.writeMu.Unlock()
			if previous != nil && previous != attachment.conn {
				_ = previous.CloseNow()
			}
			if connDone != nil {
				close(connDone)
			}
			connDone = attachment.done
			readFrom(attachment.conn)
			connections++
			now := time.Now()
			away := int64(0)
			if !detachedAt.IsZero() {
				away = now.Sub(detachedAt).Milliseconds()
			}
			s.logger.Info("recording connection resumed", append([]any{"session_id", session.ID, "run_id", runID,
				"connection", connections, "away_ms", away, "offset_ms", position(), "user_agent", attachment.agent},
				attachment.hello.Client.logAttributes()...)...)
			detachedAt, hidden, connectedAt = time.Time{}, false, now
			encoding = attachment.hello.Audio.Encoding
			lease.detached.Store(false)
			tokens, credit, lastToken, lastPacket = bytesPerSecond*2, 0, now, now
			controlTokens, lastControl = 4, now
			if err := s.writeRecord(lease, map[string]any{"type": "ready", "sessionId": session.ID,
				"runId": runID, "chunkMs": chunkMS, "offsetMs": position()}); err != nil {
				detach("ready not delivered")
			}
		case err := <-feedFailed:
			feedFailed = nil
			interrupt(err)
		case <-recheck.C:
			fresh, err := s.resolve(ctx, lease.viewer, session.ID)
			if err != nil || (fresh.Permission != domain.ShareRecord && !fresh.IsOwner) || fresh.Session.ArchivedAt != nil {
				runErr = ErrAccessRevoked
				if errors.Is(err, ErrAuthRevoked) {
					runErr = ErrAuthRevoked
				}
			} else {
				// An administrator may have changed the owner's limits meanwhile.
				if fresh, err := s.store.EffectiveLimits(ctx, session.UserID); err == nil {
					limits = fresh
				}
				if reason, _ := s.quotaReached(ctx, session.UserID, limits); reason != "" {
					runErr = ErrRecordingQuota
				}
			}
		case err := <-eventsDone:
			// Mid-recording, a stream only ends because recognition did.
			if err == nil {
				err = errors.New("recognition stream ended")
			}
			eventsDone = nil
			interrupt(err)
			// The stream has finished writing; nothing is left to wait for.
			draining = nil
		case packet, open := <-packets:
			if !open {
				if s.reattachGrace > 0 && ctx.Err() == nil {
					detach("connection closed")
				} else {
					runErr = context.Canceled
				}
				break
			}
			if packet.err != nil {
				status := websocket.CloseStatus(packet.err)
				switch {
				case s.reattachGrace > 0:
					// Only an end the recorder asks for ends the run.
					detach(fmt.Sprintf("connection closed (%d): %v", status, packet.err))
				case status == websocket.StatusNormalClosure || status == websocket.StatusGoingAway:
					graceful = true
				default:
					runErr = packet.err
				}
				break
			}
			if packet.kind == websocket.MessageBinary {
				sampleBytes := 4
				if encoding == "pcm16" {
					sampleBytes = 2
				}
				if len(packet.data) == 0 || len(packet.data)%sampleBytes != 0 || len(packet.data) > maxAudioFrame {
					runErr = errors.New("invalid audio frame")
					break
				}
				if sampleBytes == 2 {
					packet.data = float32From16(packet.data)
				}
				now := time.Now()
				// No more audio than time has passed on this connection: audio
				// held up by the network may arrive all at once, but never
				// ahead of speech, and what a returning recorder kept comes
				// with its catch_up.
				tokens = min(float64(maxCatchUp.Milliseconds())/1000*bytesPerSecond, tokens+now.Sub(lastToken).Seconds()*bytesPerSecond)
				lastToken = now
				if size := float64(len(packet.data)); size > tokens {
					if size-tokens > credit {
						runErr = errors.New("audio rate exceeded")
						break
					}
					credit -= size - tokens
					tokens = 0
				} else {
					tokens -= size
				}
				// Silence is valid PCM; only absence of audio packets is idle.
				lastPacket = now
				if err := audioWriter.Append(ctx, packet.data); err != nil {
					runErr = err
					break
				}
				written += int64(len(packet.data))
				if upstream != nil {
					if feed.push(packet.data) {
						lastUpstream = now
					} else {
						interrupt(errFeedBehind)
					}
				}
				continue
			}
			if packet.kind != websocket.MessageText || len(packet.data) > maxControlFrame {
				runErr = errors.New("invalid recording control")
				break
			}
			var control struct {
				Type string `json:"type"`
				// MS is how much kept audio a catch_up announces, or how long
				// a noted stretch lasted.
				MS int64 `json:"ms"`
				// Event is what a note tells.
				Event string `json:"event"`
			}
			if err := json.Unmarshal(packet.data, &control); err != nil {
				runErr = err
				break
			}
			switch control.Type {
			case "end":
				graceful = true
			case "catch_up":
				now := time.Now()
				controlTokens = min(4, controlTokens+now.Sub(lastControl).Seconds())
				lastControl = now
				if controlTokens < 1 || control.MS <= 0 || control.MS > maxCatchUp.Milliseconds() {
					runErr = errors.New("invalid catch up")
					break
				}
				controlTokens--
				kept := control.MS * int64(hello.Audio.SampleRate) / 1000 * 4
				credit = min(credit+float64(kept), float64(maxCatchUp.Milliseconds()*int64(hello.Audio.SampleRate)/1000*4))
				if control.MS > catchUpInline.Milliseconds() {
					catchUpUntil = max(catchUpUntil, written+kept)
					if upstream != nil {
						interrupt(errCatchingUp)
					}
				}
			case "note":
				// Notes are never a reason to end a recording: too many are ignored.
				now := time.Now()
				noteTokens = min(8, noteTokens+now.Sub(lastNote).Seconds())
				lastNote = now
				if noteTokens < 1 {
					break
				}
				noteTokens--
				switch control.Event {
				case "hidden":
					hidden = true
				case "visible":
					// Audio comes back a moment after the page does.
					hidden, lastPacket = false, now
				case "capture_gap", "microphone_restarted", "microphone_blocked":
				default:
					break
				}
				if control.MS < 0 || control.MS > maxRecordLength.Milliseconds() {
					control.MS = 0
				}
				s.logger.Info("recording client note", "session_id", session.ID, "run_id", runID, "connection", connections,
					"event", strings.Map(func(r rune) rune {
						if r < 'a' || r > 'z' {
							return '_'
						}
						return r
					}, control.Event[:min(len(control.Event), 24)]), "ms", control.MS)
			case "pause", "ping":
				now := time.Now()
				controlTokens = min(4, controlTokens+now.Sub(lastControl).Seconds())
				lastControl = now
				if controlTokens < 1 {
					runErr = errors.New("control rate exceeded")
				} else {
					controlTokens--
				}
				// Neither control refreshes the no-audio lease deadline.
			case "force_eou", "reset_stream":
				now := time.Now()
				controlTokens = min(4, controlTokens+now.Sub(lastControl).Seconds())
				lastControl = now
				if controlTokens < 1 {
					runErr = errors.New("control rate exceeded")
					break
				}
				controlTokens--
				// Without recognition there is no utterance to end or reset.
				if upstream == nil {
					break
				}
				commandCtx, cancel := context.WithTimeout(ctx, upstreamDeadline)
				var commandErr error
				if control.Type == "force_eou" {
					commandErr = upstream.ForceEndOfUtterance(commandCtx)
				} else {
					commandErr = upstream.Reset(commandCtx)
				}
				cancel()
				if commandErr != nil && ctx.Err() == nil {
					interrupt(commandErr)
				}
			default:
				runErr = errors.New("unsupported recording control")
			}
		}
	}
	if runErr != nil && !graceful {
		s.logger.Info("recording ended", "session_id", session.ID, "run_id", runID, "reason", runErr.Error(),
			"connections", connections, "audio_ms", position()-offset)
	} else {
		s.logger.Info("recording ended", "session_id", session.ID, "run_id", runID, "reason", "stopped by the recorder",
			"connections", connections, "audio_ms", position()-offset)
	}
	stopBudget := upstreamDeadline
	if graceful || errors.Is(runErr, ErrStopped) || errors.Is(runErr, ErrRecordingQuota) {
		stopBudget = 10 * time.Second
	}
	stopCtx, stopCancel := context.WithTimeout(context.Background(), stopBudget)
	if upstream != nil {
		eventsFinished := false
		if graceful || errors.Is(runErr, ErrStopped) || errors.Is(runErr, ErrRecordingQuota) {
			// What is still waiting to reach recognition is heard before the end.
			if feed != nil {
				_ = feed.flush(stopBudget / 2)
			}
			_ = upstream.ForceEndOfUtterance(stopCtx)
			select {
			case <-eventsDone:
				eventsFinished = true
			case <-time.After(750 * time.Millisecond):
			}
		}
		_ = upstream.End(stopCtx)
		if !eventsFinished {
			select {
			case <-eventsDone:
			case <-stopCtx.Done():
			}
		}
	} else if gapFrom >= 0 {
		// Ended while recognition was away: the rest is kept for later.
		if err := keepGap(position()); err != nil {
			s.logger.Error("keep recognition gap", "session_id", session.ID, "error", err)
		}
		s.broadcast(session.ID, roomEvent{data: map[string]any{"type": "recognition", "state": "recovered", "atMs": position()}})
	}
	stopCancel()
	s.CancelDrafts(lease)
	if err := audioWriter.Close(); err != nil && (runErr == nil || graceful || errors.Is(runErr, ErrStopped) || errors.Is(runErr, context.Canceled)) {
		runErr = err
	}
	flushCtx, flushCancel := context.WithTimeout(context.Background(), 5*time.Second)
	if err := s.store.FlushPortableSession(flushCtx, session.UserID, session.ID); err != nil && (runErr == nil || graceful || errors.Is(runErr, ErrStopped) || errors.Is(runErr, context.Canceled)) {
		runErr = err
	}
	flushCancel()
	if runErr == nil || errors.Is(runErr, ErrStopped) || errors.Is(runErr, context.Canceled) {
		return nil
	}
	return runErr
}

// float32From16 widens little-endian 16-bit samples, as a browser sends them
// to use half the bandwidth, to the float32 a recording is kept and
// recognized in.
func float32From16(pcm []byte) []byte {
	wide := make([]byte, len(pcm)*2)
	for index := 0; index+1 < len(pcm); index += 2 {
		sample := int16(binary.LittleEndian.Uint16(pcm[index:]))
		binary.LittleEndian.PutUint32(wide[index*2:], math.Float32bits(float32(sample)/32768))
	}
	return wide
}

func closeStream(stream asr.Stream) {
	closeCtx, cancel := context.WithTimeout(context.Background(), upstreamDeadline)
	_ = stream.Close(closeCtx)
	cancel()
}

func (s *Service) forwardASR(ctx context.Context, lease *recordLease, upstream asr.Stream,
	lastSequence *int64, offset int64, done chan<- error) {
	var draft *draftLine
	var previous lastFinal
	speechStartMS := int64(-1)
	vadState := ""
	speakers := make([]speakerSpan, 0, 16)
	firstSequence := *lastSequence + 1
	for event := range upstream.Events() {
		if !s.isCurrent(lease) {
			continue
		}
		switch event.Type {
		case "audio_state":
			vadState = event.State
			if event.State == "speech" {
				speechStartMS = offset + event.AudioPositionMS
			}
		case "partial":
			if _, text := splitLeadingMark(event.Text); text == "" {
				continue
			} else {
				event.Text = text
			}
			if draft == nil {
				segmentID, err := id.New("seg")
				if err != nil {
					done <- err
					return
				}
				draft = &draftLine{id: segmentID, sequence: *lastSequence + 1, firstWallMS: event.WallMS}
			}
			if draft.firstWallMS <= 0 && event.WallMS > 0 {
				draft.firstWallMS = event.WallMS
			}
			draft.revision++
			message := map[string]any{
				"type": "partial", "text": event.Text, "upstreamSequence": event.Sequence,
				"segmentId": draft.id, "sequence": draft.sequence, "revision": draft.revision,
			}
			if observed := observedLanguage(lease.access.Session.SourceLanguage, event.Language); observed != "" {
				message["language"] = observed
			}
			if speechStartMS >= 0 {
				message["startMs"] = speechStartMS
			} else if origin := upstream.Info().CreatedAt; origin > 0 && draft.firstWallMS >= int64(origin*1000) {
				// A partial can precede VAD's speech event. Give observers a
				// source-clock estimate until the final supplies its exact span.
				message["startMs"] = offset + draft.firstWallMS - int64(origin*1000)
			}
			s.broadcast(lease.access.Session.ID, roomEvent{data: message})
			draftLanguage, draftSource := segmentLanguage(lease.access.Session, event.Language, event.Text)
			draftSpeaker := ""
			if event.Speaker != nil && *event.Speaker >= 0 {
				draftSpeaker = fmt.Sprintf("speaker_%d", *event.Speaker+1)
			}
			s.UpdateDraft(lease, DraftTranslationInput{ID: draft.id, Sequence: draft.sequence,
				Revision: int64(draft.revision), Text: event.Text, DetectedLanguage: draftLanguage,
				LanguageSource: draftSource, SpeakerID: draftSpeaker})
			if shouldForceCaption(draft, event, vadState) {
				draft.forced = true
				commandCtx, cancel := context.WithTimeout(ctx, upstreamDeadline)
				err := upstream.ForceEndOfUtterance(commandCtx)
				cancel()
				if err != nil {
					done <- err
					return
				}
			}
		case "final":
			mark, text := splitLeadingMark(event.Text)
			if text == "" && mark == "" {
				continue
			}
			lease.room.gate.Lock()
			if !s.isCurrent(lease) {
				lease.room.gate.Unlock()
				continue
			}
			previous = s.returnMark(lease.access.Session.ID, lease.access.Session.UserID, previous, mark)
			if text == "" {
				lease.room.gate.Unlock()
				continue
			}
			event.Text = text
			*lastSequence++
			segmentID := ""
			revision := 1
			if draft != nil {
				segmentID = draft.id
				revision = draft.revision + 1
				draft = nil
			}
			speechStartMS = -1
			if segmentID == "" {
				var err error
				segmentID, err = id.New("seg")
				if err != nil {
					lease.room.gate.Unlock()
					done <- err
					return
				}
			}
			startMS, endMS := sourceTimelineRange(event, upstream.Info(), offset)
			languageCode, languageSource := segmentLanguage(lease.access.Session, event.Language, event.Text)
			segment := domain.Segment{ID: segmentID, SessionID: lease.access.Session.ID,
				UserID: lease.access.Session.UserID, Sequence: *lastSequence, SourceText: event.Text,
				TranslationStatus: domain.TranslationNotRequested, Final: true,
				StartMS: startMS, EndMS: endMS, CreatedAt: time.Now().UTC(),
				DetectedLanguage: languageCode, LanguageSource: languageSource,
				Wall0MS: max(int64(0), event.Wall0MS), Wall1MS: max(int64(0), event.Wall1MS)}
			if event.Speaker != nil && *event.Speaker >= 0 {
				segment.SpeakerID = fmt.Sprintf("speaker_%d", *event.Speaker+1)
			} else {
				segment.SpeakerID = speakerForWallRange(event.Wall0MS, event.Wall1MS, speakers)
			}
			persistCtx, persistCancel := asrPersistenceContext(ctx)
			err := s.store.AppendSegment(persistCtx, segment.UserID, segment)
			persistCancel()
			lease.room.gate.Unlock()
			if err != nil {
				done <- err
				return
			}
			previous = lastFinal{id: segment.ID, text: segment.SourceText}
			if !s.isCurrent(lease) {
				continue
			}
			flushCtx, flushCancel := asrPersistenceContext(ctx)
			err = s.store.FlushPortableSession(flushCtx, segment.UserID, segment.SessionID)
			flushCancel()
			if err != nil {
				done <- err
				return
			}
			payload := struct {
				domain.Segment
				SourceRevision int `json:"sourceRevision"`
			}{Segment: segment, SourceRevision: revision}
			s.broadcast(segment.SessionID, roomEvent{data: map[string]any{
				"type": "final", "segment": payload, "upstreamSequence": event.Sequence,
				"detectedLanguage": segment.DetectedLanguage,
			}})
			s.ensureForWatchers(lease, segment)
		case "speaker":
			if event.Speaker != nil {
				speakerID := fmt.Sprintf("speaker_%d", *event.Speaker+1)
				if event.Wall1MS > event.Wall0MS {
					speakers = append(speakers, speakerSpan{id: speakerID, wall0MS: event.Wall0MS, wall1MS: event.Wall1MS})
					cutoff := event.Wall1MS - 180_000
					kept := speakers[:0]
					for _, span := range speakers {
						if span.wall1MS >= cutoff {
							kept = append(kept, span)
						}
					}
					speakers = kept
					if len(speakers) > 128 {
						speakers = speakers[len(speakers)-128:]
					}
				}
				type speakerChange struct{ id, speaker string }
				changes := make([]speakerChange, 0)
				lease.room.gate.Lock()
				if s.isCurrent(lease) && event.Wall1MS > event.Wall0MS {
					persistCtx, persistCancel := asrPersistenceContext(ctx)
					candidates, err := s.store.SpeakerCandidatesForWallRange(persistCtx, lease.access.Session.UserID,
						lease.access.Session.ID, firstSequence, event.Wall0MS, event.Wall1MS)
					if err != nil {
						s.logger.Warn("read speaker candidates", "session_id", lease.access.Session.ID, "error", err)
					} else {
						for _, candidate := range candidates {
							chosen, decisive := speakerDecision(candidate.Wall0MS, candidate.Wall1MS, speakers)
							if !decisive || chosen == candidate.SpeakerID {
								continue
							}
							if err := s.store.SetSegmentSpeaker(persistCtx, lease.access.Session.UserID,
								lease.access.Session.ID, candidate.ID, chosen); err != nil {
								s.logger.Warn("persist speaker", "session_id", lease.access.Session.ID, "error", err)
								continue
							}
							changes = append(changes, speakerChange{id: candidate.ID, speaker: chosen})
						}
					}
					persistCancel()
				}
				lease.room.gate.Unlock()
				if len(changes) > 0 {
					snapshotCtx, snapshotCancel := asrPersistenceContext(ctx)
					if err := s.store.FlushPortableSession(snapshotCtx, lease.access.Session.UserID, lease.access.Session.ID); err != nil {
						snapshotCancel()
						done <- err
						return
					}
					snapshotCancel()
				}
				for _, change := range changes {
					s.broadcast(lease.access.Session.ID, roomEvent{data: map[string]any{
						"type": "speaker", "segmentId": change.id, "speakerId": change.speaker,
					}})
				}
			}
		case "error":
			s.broadcast(lease.access.Session.ID, roomEvent{data: map[string]any{
				"type": "provider_error", "provider": "asr", "code": event.Code,
			}})
		}
	}
	done <- upstream.Wait()
}
