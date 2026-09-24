package rooms

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	maxAudioFrame     = 256 << 10
	maxControlFrame   = 8 << 10
	helloDeadline     = 10 * time.Second
	noAudioDeadline   = 30 * time.Second
	maxRecordLength   = 4 * time.Hour
	writeDeadline     = 2 * time.Second
	upstreamDeadline  = 2 * time.Second
	captionForceAfter = 8 * time.Second
)

type audioHello struct {
	Type  string `json:"type"`
	Audio struct {
		Encoding   string `json:"encoding"`
		SampleRate int    `json:"sampleRate"`
		Channels   int    `json:"channels"`
	} `json:"audio"`
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
		return asrStartOptions{}, fmt.Errorf("recognition capabilities unavailable: %w", err)
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

func (s *Service) reserveRecorder(lease *recordLease, takeover bool) (*recordLease, error) {
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
	if previous != nil && (!takeover || !lease.access.IsOwner) {
		return nil, ErrOccupied
	}
	if previous == nil {
		active, byOwner := 0, 0
		for _, existing := range s.rooms {
			if existing.recorder != nil {
				active++
				if existing.recorder.access.Session.UserID == lease.access.Session.UserID {
					byOwner++
				}
			}
		}
		if active >= maxRecordings || byOwner >= maxPerOwnerRecordings {
			return nil, store.ErrCapacity
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
		hello.Audio.Encoding != "pcm32f" || hello.Audio.Channels != 1 || hello.Audio.SampleRate < 8000 || hello.Audio.SampleRate > 192000 {
		return audioHello{}, errors.New("invalid mono pcm32f start message")
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
	base, deadlineCancel := context.WithTimeoutCause(s.ctx, maxRecordLength, errors.New("recording duration exceeded"))
	ctx, cancel := context.WithCancelCause(base)
	viewer = access.Viewer
	lease := &recordLease{id: s.nextID.Add(1), viewer: viewer, access: access, ctx: ctx,
		cancel: cancel, done: make(chan struct{}), provider: s.providers.Snapshot()}
	previous, err := s.reserveRecorder(lease, takeover)
	if err != nil {
		cancel(err)
		deadlineCancel()
		if errors.Is(err, ErrOccupied) {
			http.Error(w, "Another recorder is active", http.StatusConflict)
			return nil
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
	if lease.provider.ASR == nil {
		status = domain.InterpretationFailed
		_ = s.writeRecord(lease, map[string]any{"type": "error", "code": "ASR_UNAVAILABLE", "message": "Recognition provider is not configured."})
		return nil
	}
	if err := s.record(ctx, lease, hello); err != nil {
		if !errors.Is(err, ErrStopped) && !errors.Is(err, ErrReplaced) && !errors.Is(err, ErrAuthRevoked) && !errors.Is(err, ErrAccessRevoked) && !errors.Is(err, context.Canceled) {
			status = domain.InterpretationFailed
		}
		finish()
		if errors.Is(err, ErrAuthRevoked) {
			_ = s.writeRecord(lease, map[string]any{"type": "error", "code": "AUTH_REVOKED", "message": "Browser authentication was revoked. Sign in again."})
		} else if errors.Is(err, ErrReplaced) || errors.Is(err, ErrAccessRevoked) {
			_ = s.writeRecord(lease, map[string]any{"type": "error", "code": "ACCESS_REVOKED", "message": "The recording moved or access changed."})
		} else if status == domain.InterpretationFailed {
			_ = s.writeRecord(lease, map[string]any{"type": "error", "code": "RECORDING_STOPPED", "message": "The recording ended unexpectedly."})
		}
		return nil
	}
	finish()
	_ = s.writeRecord(lease, map[string]any{"type": "stopped", "status": domain.InterpretationCompleted})
	return nil
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

func (s *Service) record(ctx context.Context, lease *recordLease, hello audioHello) error {
	session := lease.access.Session
	options, err := resolveASRStart(ctx, lease.provider.ASR, session.SourceLanguage, session.Diarization)
	if err != nil {
		return err
	}
	upstream, err := lease.provider.ASR.Start(ctx, asr.StartRequest{Language: options.language,
		Audio:      asr.AudioSpec{Encoding: "pcm32f", SampleRate: hello.Audio.SampleRate, Channels: 1},
		CacheLines: 1000, AudioSense: options.audioSense, Diarize: session.Diarization, SpeakerEmbedding: "off"})
	if err != nil {
		return err
	}
	defer func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), upstreamDeadline)
		_ = upstream.Close(closeCtx)
		cancel()
	}()
	if options.audioSense && !upstream.Info().AudioSense {
		return errors.New("recognition audio sense was not activated")
	}
	lastSequence, err := s.store.MaxSegmentSequence(ctx, session.UserID, session.ID)
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
	if err := s.writeRecord(lease, map[string]any{"type": "ready", "sessionId": session.ID,
		"runId": runID, "chunkMs": upstream.Info().ChunkMS, "offsetMs": offset}); err != nil {
		return err
	}
	packets := make(chan clientPacket, 8)
	go readRecorder(ctx, lease.conn, packets)
	eventsDone := make(chan error, 1)
	go s.forwardASR(ctx, lease, upstream, &lastSequence, offset, eventsDone)
	idleTick := min(time.Second, max(25*time.Millisecond, s.noAudioTimeout/4))
	ticker := time.NewTicker(idleTick)
	defer ticker.Stop()
	recheck := time.NewTicker(watchRevalidateEvery)
	defer recheck.Stop()
	lastPacket := time.Now()
	bytesPerSecond := float64(hello.Audio.SampleRate * 4)
	tokens := bytesPerSecond * 2
	lastToken := time.Now()
	controlTokens, lastControl := 4.0, time.Now()
	var runErr error
	graceful := false
	eventsFinished := false
	for runErr == nil && !graceful {
		select {
		case <-ctx.Done():
			runErr = context.Cause(ctx)
		case <-ticker.C:
			if time.Since(lastPacket) > s.noAudioTimeout {
				runErr = ErrNoAudio
			}
		case <-recheck.C:
			fresh, err := s.resolve(ctx, lease.viewer, session.ID)
			if err != nil || (fresh.Permission != domain.ShareRecord && !fresh.IsOwner) || fresh.Session.ArchivedAt != nil {
				runErr = ErrAccessRevoked
				if errors.Is(err, ErrAuthRevoked) {
					runErr = ErrAuthRevoked
				}
			}
		case err := <-eventsDone:
			eventsFinished = true
			if err != nil {
				runErr = err
			} else {
				graceful = true
			}
		case packet, open := <-packets:
			if !open {
				runErr = context.Canceled
				break
			}
			if packet.err != nil {
				if websocket.CloseStatus(packet.err) == websocket.StatusNormalClosure || websocket.CloseStatus(packet.err) == websocket.StatusGoingAway {
					graceful = true
				} else {
					runErr = packet.err
				}
				break
			}
			if packet.kind == websocket.MessageBinary {
				if len(packet.data) == 0 || len(packet.data)%4 != 0 || len(packet.data) > maxAudioFrame {
					runErr = errors.New("invalid audio frame")
					break
				}
				now := time.Now()
				tokens = min(bytesPerSecond*2, tokens+now.Sub(lastToken).Seconds()*bytesPerSecond)
				lastToken = now
				if float64(len(packet.data)) > tokens {
					runErr = errors.New("audio rate exceeded")
					break
				}
				tokens -= float64(len(packet.data))
				// Silence is valid PCM; only absence of audio packets is idle.
				lastPacket = now
				if err := audioWriter.Append(ctx, packet.data); err != nil {
					runErr = err
					break
				}
				if err := upstream.SendAudio(ctx, packet.data); err != nil {
					runErr = err
				}
				continue
			}
			if packet.kind != websocket.MessageText || len(packet.data) > maxControlFrame {
				runErr = errors.New("invalid recording control")
				break
			}
			var control struct {
				Type string `json:"type"`
			}
			if err := json.Unmarshal(packet.data, &control); err != nil {
				runErr = err
				break
			}
			switch control.Type {
			case "end":
				graceful = true
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
			case "force_eou":
				now := time.Now()
				controlTokens = min(4, controlTokens+now.Sub(lastControl).Seconds())
				lastControl = now
				if controlTokens < 1 {
					runErr = errors.New("control rate exceeded")
					break
				}
				controlTokens--
				commandCtx, cancel := context.WithTimeout(ctx, upstreamDeadline)
				runErr = upstream.ForceEndOfUtterance(commandCtx)
				cancel()
			case "reset_stream":
				now := time.Now()
				controlTokens = min(4, controlTokens+now.Sub(lastControl).Seconds())
				lastControl = now
				if controlTokens < 1 {
					runErr = errors.New("control rate exceeded")
					break
				}
				controlTokens--
				commandCtx, cancel := context.WithTimeout(ctx, upstreamDeadline)
				runErr = upstream.Reset(commandCtx)
				cancel()
			default:
				runErr = errors.New("unsupported recording control")
			}
		}
	}
	stopBudget := upstreamDeadline
	if graceful || errors.Is(runErr, ErrStopped) {
		stopBudget = 10 * time.Second
	}
	stopCtx, stopCancel := context.WithTimeout(context.Background(), stopBudget)
	if graceful || errors.Is(runErr, ErrStopped) {
		_ = upstream.ForceEndOfUtterance(stopCtx)
		if !eventsFinished {
			select {
			case <-eventsDone:
				eventsFinished = true
			case <-time.After(750 * time.Millisecond):
			}
		}
	}
	_ = upstream.End(stopCtx)
	if !eventsFinished {
		select {
		case <-eventsDone:
		case <-stopCtx.Done():
		}
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

func (s *Service) forwardASR(ctx context.Context, lease *recordLease, upstream asr.Stream,
	lastSequence *int64, offset int64, done chan<- error) {
	var draft *draftLine
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
			if event.Text == "" {
				continue
			}
			lease.room.gate.Lock()
			if !s.isCurrent(lease) {
				lease.room.gate.Unlock()
				continue
			}
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
