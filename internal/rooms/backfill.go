package rooms

import (
	"context"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/Tularity/t-lingual/internal/asr"
	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/id"
	"github.com/Tularity/t-lingual/internal/media"
	"github.com/Tularity/t-lingual/internal/providers"
	"github.com/Tularity/t-lingual/internal/store"
)

const (
	// gapPace is how many times faster than real time saved audio is sent
	// for recognition; recognition's own backpressure may slow it further.
	gapPace = 3
	// gapChunk is how much audio goes in one message.
	gapChunk = 160 * time.Millisecond
	// gapRetryAfter spaces out attempts at a gap that failed, growing with
	// each; gapStaleAfter frees a gap whose filler stopped answering.
	gapRetryAfter  = time.Minute
	gapStaleAfter  = 30 * time.Minute
	maxGapAttempts = 5
	// gapFreeSlots is the room recognition must have left for live
	// recordings before background filling may take a slot.
	gapFreeSlots = 2

	translationRetryEvery   = 15 * time.Second
	translationRetryAfter   = 30 * time.Second
	maxTranslationAttempts  = 6
	maxTranslationRetryPass = 4
)

// retryableTranslationErrors are failures of availability, not of the text:
// asked again once translation is back, they can succeed.
var retryableTranslationErrors = []string{"translator_unavailable", "capacity_exhausted", "engine_unavailable",
	"language_detector_unavailable", "busy", "unavailable", "translation_persistence_failed", "interrupted"}

func (s *Service) wakeGaps() {
	select {
	case s.gapWake <- struct{}{}:
	default:
	}
}

// gapWorker fills gaps one at a time while recognition has room to spare.
func (s *Service) gapWorker() {
	defer s.workers.Done()
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
		case <-s.gapWake:
		}
		for s.ctx.Err() == nil && s.fillNextGap() {
		}
	}
}

// recognitionHasRoom: background work must never take recognition from a
// live recording, so it waits for normal pressure and slots to spare.
func (s *Service) recognitionHasRoom(ctx context.Context, provider asr.Provider) bool {
	if source := s.healthSource(); source != nil {
		if health := source.ASRHealth(); health.Known {
			return health.Ready && health.CanAccept && !health.Elevated && health.Room >= gapFreeSlots
		}
	}
	checkCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return provider.Ready(checkCtx) == nil
}

// fillNextGap fills one gap and reports whether it did.
func (s *Service) fillNextGap() bool {
	snapshot := s.providers.Snapshot()
	if snapshot.ASR == nil || !s.recognitionHasRoom(s.ctx, snapshot.ASR) {
		return false
	}
	now := time.Now().UTC()
	gap, err := s.store.ClaimRecognitionGap(s.ctx, now, gapRetryAfter, gapStaleAfter)
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			s.logger.Warn("claim recognition gap", "error", err)
		}
		return false
	}
	s.broadcast(gap.SessionID, roomEvent{data: map[string]any{"type": "gap", "gap": gap}})
	filled, fillErr := s.fillGap(gap, snapshot)
	state, lastError := domain.GapFilled, ""
	if fillErr != nil {
		state, lastError = domain.GapPending, fillErr.Error()
		if gap.Attempts >= maxGapAttempts {
			state = domain.GapFailed
		}
		s.logger.Warn("fill recognition gap", "session_id", gap.SessionID, "attempt", gap.Attempts, "error", fillErr)
	}
	finishCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	finished, err := s.store.FinishRecognitionGap(finishCtx, gap.ID, state, filled, lastError, time.Now().UTC())
	cancel()
	if err != nil {
		s.logger.Error("finish recognition gap", "gap_id", gap.ID, "error", err)
		return false
	}
	s.broadcast(gap.SessionID, roomEvent{data: map[string]any{"type": "gap", "gap": finished}})
	return fillErr == nil
}

// fillGap recognizes a gap's saved audio and saves its lines into the
// numbers kept for them. It returns how many lines it saved.
func (s *Service) fillGap(gap domain.RecognitionGap, snapshot providers.Snapshot) (int, error) {
	ctx, cancel := context.WithTimeout(s.ctx, max(2*time.Minute, time.Duration(gap.EndMS-gap.StartMS)*time.Millisecond))
	defer cancel()
	session, err := s.store.GetInterpretationSession(ctx, gap.UserID, gap.SessionID)
	if err != nil {
		return 0, err
	}
	mediaManager, err := media.New(s.store, s.store.DataRoot())
	if err != nil {
		return 0, err
	}
	spans, err := mediaManager.Spans(ctx, gap.UserID, gap.SessionID, gap.StartMS, gap.EndMS)
	if err != nil {
		return 0, err
	}
	if len(spans) == 0 {
		return 0, errors.New("no saved audio for the gap")
	}
	options, err := resolveASRStart(ctx, snapshot.ASR, session.SourceLanguage, false)
	if err != nil {
		return 0, err
	}
	next := gap.SequenceFrom
	saved := 0
	for _, span := range spans {
		count, err := s.recognizeSpan(ctx, session, span, options, snapshot, &next, gap.SequenceTo)
		saved += count
		if err != nil {
			return saved, err
		}
	}
	return saved, nil
}

// recognizeSpan sends one span of saved audio through its own recognition
// stream, paced, and saves each final line as it comes.
func (s *Service) recognizeSpan(ctx context.Context, session domain.InterpretationSession, span media.Span,
	options asrStartOptions, snapshot providers.Snapshot, next *int64, last int64) (int, error) {
	// Neither diarization nor audio sense: a new stream cannot know the
	// recording's speakers, and only the ungated audio clock places a line
	// sent faster than it was spoken.
	stream, err := snapshot.ASR.Start(ctx, asr.StartRequest{Language: options.language,
		Audio:      asr.AudioSpec{Encoding: "pcm32f", SampleRate: span.SampleRate, Channels: 1},
		CacheLines: 1000, Diarize: false, SpeakerEmbedding: "off"})
	if err != nil {
		return 0, err
	}
	defer closeStream(stream)
	type outcome struct {
		saved int
		err   error
	}
	results := make(chan outcome, 1)
	go func() {
		saved := 0
		var previous lastFinal
		for event := range stream.Events() {
			if !event.Final() || event.Text == "" {
				continue
			}
			mark, text := splitLeadingMark(event.Text)
			previous = s.returnMark(session.ID, session.UserID, previous, mark)
			if text == "" {
				continue
			}
			event.Text = text
			if *next > last {
				s.logger.Warn("recognition gap ran out of reserved lines", "session_id", session.ID)
				continue
			}
			segmentID, err := id.New("seg")
			if err != nil {
				results <- outcome{saved, err}
				return
			}
			startMS, endMS := span.StartMS+max(int64(0), event.StartMS), span.StartMS+max(int64(0), event.EndMS)
			endMS = max(endMS, startMS)
			languageCode, languageSource := segmentLanguage(session, event.Language, event.Text)
			segment := domain.Segment{ID: segmentID, SessionID: session.ID, UserID: session.UserID, Sequence: *next,
				SourceText: event.Text, TranslationStatus: domain.TranslationNotRequested, Final: true,
				StartMS: startMS, EndMS: endMS, CreatedAt: time.Now().UTC(),
				DetectedLanguage: languageCode, LanguageSource: languageSource}
			persistCtx, persistCancel := asrPersistenceContext(ctx)
			err = s.store.AppendSegment(persistCtx, session.UserID, segment)
			persistCancel()
			if err != nil {
				results <- outcome{saved, err}
				return
			}
			previous = lastFinal{id: segment.ID, text: segment.SourceText}
			*next++
			saved++
			s.broadcast(session.ID, roomEvent{data: map[string]any{"type": "final", "segment": segment, "backfill": true}})
			s.translateForReaders(session, segment, snapshot)
		}
		results <- outcome{saved, stream.Wait()}
	}()
	reader, err := span.Open()
	if err != nil {
		return 0, err
	}
	defer reader.Close()
	chunk := make([]byte, int64(span.SampleRate)*gapChunk.Milliseconds()/1000*4)
	started := time.Now()
	var sent time.Duration
	for {
		n, readErr := io.ReadFull(reader, chunk)
		if n > 0 {
			if err := stream.SendAudio(ctx, chunk[:n]); err != nil {
				return 0, fmt.Errorf("send saved audio: %w", err)
			}
			sent += time.Duration(n/4) * time.Second / time.Duration(span.SampleRate)
			// Never faster than the pace: live recordings share the engine.
			if ahead := sent/gapPace - time.Since(started); ahead > 0 {
				select {
				case <-time.After(ahead):
				case <-ctx.Done():
					return 0, ctx.Err()
				}
			}
		}
		if errors.Is(readErr, io.EOF) || errors.Is(readErr, io.ErrUnexpectedEOF) {
			break
		}
		if readErr != nil {
			return 0, readErr
		}
	}
	_ = stream.ForceEndOfUtterance(ctx)
	if err := stream.End(ctx); err != nil {
		return 0, err
	}
	select {
	case result := <-results:
		if result.err != nil && !errors.Is(result.err, context.Canceled) {
			return result.saved, result.err
		}
		return result.saved, nil
	case <-ctx.Done():
		return 0, ctx.Err()
	}
}

// translateForReaders asks for a filled-in line in the languages it is
// being read in: the session's own, and every current reader's.
func (s *Service) translateForReaders(session domain.InterpretationSession, segment domain.Segment, snapshot providers.Snapshot) {
	targets := map[string]struct{}{session.TargetLanguage: {}}
	s.mu.Lock()
	if room := s.rooms[session.ID]; room != nil {
		for _, watch := range room.watches {
			targets[watch.access.TargetLanguage] = struct{}{}
		}
	}
	s.mu.Unlock()
	for target := range targets {
		s.ensureTranslation(s.ctx, session, segment, target, snapshot)
	}
}

// translationRetryWorker asks again for translations that failed only
// because translation was unavailable, a few at a time and only while the
// translator says it has room.
func (s *Service) translationRetryWorker() {
	defer s.workers.Done()
	ticker := time.NewTicker(translationRetryEvery)
	defer ticker.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			s.retryTranslations()
		}
	}
}

func (s *Service) retryTranslations() {
	snapshot := s.providers.Snapshot()
	if snapshot.Translator == nil {
		return
	}
	room := maxTranslationRetryPass
	if source := s.healthSource(); source != nil {
		if health := source.TranslatorHealth(); health.Known {
			if !health.Ready || !health.CanAccept {
				return
			}
			room = min(room, health.Room/2)
		}
	} else {
		checkCtx, cancel := context.WithTimeout(s.ctx, 2*time.Second)
		err := snapshot.Translator.Ready(checkCtx)
		cancel()
		if err != nil {
			return
		}
	}
	// Live translation comes first.
	if room < 1 || len(s.jobs) > cap(s.jobs)/4 {
		return
	}
	ctx, cancel := context.WithTimeout(s.ctx, 5*time.Second)
	defer cancel()
	items, err := s.store.ReclaimRetryableTranslations(ctx, retryableTranslationErrors, maxTranslationAttempts,
		room, translationRetryAfter, time.Now().UTC())
	if err != nil {
		s.logger.Warn("reclaim translations", "error", err)
		return
	}
	for _, item := range items {
		session, err := s.store.GetInterpretationSession(ctx, item.UserID, item.SessionID)
		if err == nil {
			var segment domain.Segment
			segment, err = s.store.GetSegmentByID(ctx, item.UserID, item.SessionID, item.SegmentID)
			if err == nil {
				s.enqueueRetry(session, segment, item.TargetLanguage, snapshot)
				continue
			}
		}
		s.logger.Warn("load translation to retry", "segment_id", item.SegmentID, "error", err)
	}
}

// enqueueRetry sends a reclaimed, pending translation to the workers.
func (s *Service) enqueueRetry(session domain.InterpretationSession, segment domain.Segment, target string, snapshot providers.Snapshot) {
	key := translationKey{sessionID: session.ID, segmentID: segment.ID, target: target}
	s.jobMu.Lock()
	if _, exists := s.inFlight[key]; exists {
		s.jobMu.Unlock()
		return
	}
	s.inFlight[key] = struct{}{}
	s.jobMu.Unlock()
	select {
	case s.jobs <- translationTask{session: session, segment: segment, target: target, provider: snapshot, phase: "final"}:
	default:
		s.finishTranslationFailure(session, segment, target, "capacity_exhausted", "")
		s.endFlight(key)
	}
}
