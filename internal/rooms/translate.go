package rooms

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/language"
	"github.com/Tularity/t-lingual/internal/providers"
	"github.com/Tularity/t-lingual/internal/store"
	"github.com/Tularity/t-lingual/internal/translate"
)

type translationKey struct {
	sessionID string
	segmentID string
	target    string
}

type translationTask struct {
	session        domain.InterpretationSession
	segment        domain.Segment
	target         string
	provider       providers.Snapshot
	phase          string
	sourceRevision int64
	draftLease     *recordLease
}

func (s *Service) SegmentWindow(ctx context.Context, viewer domain.Viewer, sessionID string,
	query store.SegmentPageQuery) (store.SegmentPage, error) {
	access, err := s.resolve(ctx, viewer, sessionID)
	if err != nil {
		return store.SegmentPage{}, err
	}
	page, err := s.store.ListSegmentsWindow(ctx, access.Session.UserID, sessionID, query)
	if err != nil {
		return store.SegmentPage{}, err
	}
	page.Items, err = s.PresentSegments(ctx, access, page.Items)
	return page, err
}

// PresentSegments never projects another viewer's language. It also ensures
// translations for cold history pages, not only the currently connected tail.
func (s *Service) PresentSegments(ctx context.Context, access domain.SessionAccess, segments []domain.Segment) ([]domain.Segment, error) {
	return s.ProjectSegments(ctx, access, segments)
}

func (s *Service) ProjectSegments(ctx context.Context, access domain.SessionAccess, segments []domain.Segment) ([]domain.Segment, error) {
	target, err := language.Canonicalize(access.TargetLanguage)
	if err != nil {
		return nil, err
	}
	for _, segment := range segments {
		if segment.Final && segment.SourceText != "" {
			s.ensureTranslation(ctx, access.Session, segment, target, s.providers.Snapshot())
		}
	}
	presented, err := s.store.PresentSegments(ctx, access.Session.UserID, access.Session.ID, target, segments)
	if err != nil {
		return nil, err
	}
	presented, err = s.store.ProjectSourceDetection(ctx, access.Session.UserID, access.Session.ID, target, presented)
	if err != nil {
		return nil, err
	}
	return s.presentTranslationProgress(target, presented), nil
}

func (s *Service) ensureForWatchers(lease *recordLease, segment domain.Segment) {
	s.FinalizeDraft(lease, segment)
}

func (s *Service) ensureTranslation(ctx context.Context, session domain.InterpretationSession,
	segment domain.Segment, target string, snapshot providers.Snapshot) {
	canonical, err := language.Canonicalize(target)
	if err != nil {
		return
	}
	// The current session setting can change after this final was recorded.
	// Only the segment's captured language evidence can justify an identity skip.
	source, err := translationSource(translationTask{session: session, segment: segment})
	if err != nil {
		return
	}
	if source != "auto" && source == canonical {
		return
	}
	// An unconfigured translator is not a terminal failure. Leave the source
	// untouched so a later provider configuration can serve this cold history.
	if snapshot.Translator == nil {
		return
	}
	claimCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	record, _, err := s.store.ClaimTranslation(claimCtx, session.UserID, session.ID, segment.ID, canonical, time.Now().UTC())
	cancel()
	if err != nil || record.Status != domain.TranslationPending {
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			s.logger.Warn("claim translation", slog.String("segment_id", segment.ID), slog.String("error", err.Error()))
		}
		return
	}
	key := translationKey{sessionID: session.ID, segmentID: segment.ID, target: canonical}
	s.draftMu.Lock()
	if pending := s.drafts[key]; pending != nil {
		// A viewer can read the saved final between AppendSegment and the
		// recorder's FinalizeDraft call. Never start a second request while
		// this draft is active; let its worker enqueue the final afterward.
		if pending.final == nil {
			copy := segment
			pending.final = &copy
			s.markDraftFinalizing(key, pending.lease)
		}
		s.draftMu.Unlock()
		return
	}
	s.draftMu.Unlock()
	s.jobMu.Lock()
	if _, exists := s.inFlight[key]; exists {
		s.jobMu.Unlock()
		return
	}
	// ClaimTranslation's pending snapshot can become stale before this lock:
	// the previous worker may commit success and release inFlight in between.
	// Re-read under the lock before reserving a second job.
	checkCtx, checkCancel := context.WithTimeout(s.ctx, 2*time.Second)
	current, checkErr := s.store.GetTranslation(checkCtx, session.UserID, session.ID, segment.ID, canonical)
	checkCancel()
	if checkErr != nil || current.Status != domain.TranslationPending {
		s.jobMu.Unlock()
		if checkErr != nil {
			s.logger.Warn("recheck translation claim", slog.String("segment_id", segment.ID), slog.String("error", checkErr.Error()))
		}
		return
	}
	s.inFlight[key] = struct{}{}
	s.jobMu.Unlock()
	job := translationTask{session: session, segment: segment, target: canonical, provider: snapshot, phase: "final"}
	select {
	case s.jobs <- job:
		// Existing pending work is recovered by the first watcher after restart.
	default:
		s.finishTranslationFailure(session, segment, canonical, "capacity_exhausted", "")
		s.endFlight(key)
	}
}

func (s *Service) endFlight(key translationKey) {
	s.finishProgress(key.sessionID, key.segmentID, key.target)
	s.jobMu.Lock()
	delete(s.inFlight, key)
	s.jobMu.Unlock()
}

func (s *Service) translationWorker() {
	defer s.workers.Done()
	for {
		select {
		case <-s.ctx.Done():
			return
		case task := <-s.jobs:
			s.runTranslation(task)
			s.endFlight(translationKey{sessionID: task.session.ID, segmentID: task.segment.ID, target: task.target})
		}
	}
}

func (s *Service) runTranslation(task translationTask) {
	input, inputErr := s.translationInput(task)
	if inputErr != nil {
		s.finishTranslationFailure(task.session, task.segment, task.target, "source_language_unsupported", "")
		return
	}
	ctx, cancel := context.WithTimeout(s.ctx, 100*time.Second)
	s.beginTranslationProgress(task)
	var response translate.Response
	var err error
	if streaming, ok := task.provider.Translator.(translate.StreamingProvider); ok {
		response, err = streaming.TranslateStream(ctx, input, func(update translate.StreamUpdate) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			s.publishTranslationProgress(task, update.Text, update.RequestID)
			return nil
		})
	} else {
		response, err = task.provider.Translator.Translate(ctx, input)
	}
	cancel()
	if err != nil {
		code, requestID := "translator_unavailable", ""
		var providerError *translate.ProviderError
		if errors.As(err, &providerError) {
			if providerError.Code != "" {
				code = providerError.Code
			}
			requestID = providerError.RequestID
		}
		s.finishTranslationFailure(task.session, task.segment, task.target, code, requestID)
		return
	}
	if input.SourceLanguage == "auto" && response.SourceDetection == nil {
		s.finishTranslationFailure(task.session, task.segment, task.target, "invalid_source_detection", response.RequestID)
		return
	}
	s.completeTranslationProgress(task, response.Translation, response.RequestID)
	persistCtx, persistCancel := context.WithTimeout(context.Background(), 5*time.Second)
	var record store.SegmentTranslation
	if input.SourceLanguage == "auto" {
		if response.SourceDetection == nil {
			persistCancel()
			s.finishTranslationFailure(task.session, task.segment, task.target, "invalid_source_detection", response.RequestID)
			return
		}
		detection := domain.SourceDetection{Method: response.SourceDetection.Method,
			Confidence: response.SourceDetection.Confidence, Rank: response.SourceDetection.Rank,
			Uncertain: response.SourceDetection.Uncertain, ContextUsed: response.SourceDetection.ContextUsed}
		record, err = s.store.FinishTranslationWithDetection(persistCtx, task.session.UserID, task.session.ID,
			task.segment.ID, task.target, response.Translation, response.RequestID,
			response.SourceLanguage, detection, time.Now().UTC())
	} else {
		record, err = s.store.FinishTranslation(persistCtx, task.session.UserID, task.session.ID,
			task.segment.ID, task.target, domain.TranslationSucceeded, response.Translation,
			"", response.RequestID, time.Now().UTC())
	}
	persistCancel()
	if err != nil {
		code := "translation_persistence_failed"
		if errors.Is(err, store.ErrCapacity) {
			code = "storage_limit"
		}
		s.logger.Warn("persist translation", "segment_id", task.segment.ID, "error", err)
		s.finishTranslationFailure(task.session, task.segment, task.target, code, "")
		return
	}
	s.broadcastTranslationWithDetection(record, response.SourceLanguage, response.SourceDetection)
	s.flushTranslationSnapshot(task.session)
}

func (s *Service) flushTranslationSnapshot(session domain.InterpretationSession) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.store.FlushPortableSession(ctx, session.UserID, session.ID); err != nil {
		s.logger.Warn("flush portable translation", "session_id", session.ID, "error", err)
	}
}

func (s *Service) translationInput(task translationTask) (translate.Request, error) {
	source, err := translationSource(task)
	if err != nil {
		return translate.Request{}, err
	}
	input := translate.Request{SourceLanguage: source, TargetLanguage: task.target, Text: task.segment.SourceText}
	if source == "auto" && utf8.RuneCountInString(input.Text) <= 32 {
		input.SourceContext = s.sourceContext(task)
	}
	return input, nil
}

// translationSource freezes the language decision at the utterance boundary.
// Drafts use the recording lease's mode; finalized rows use only evidence
// captured with that row. A script guess is never trusted as an explicit
// source, while legacy concrete tags without provenance remain usable.
func translationSource(task translationTask) (string, error) {
	if !task.segment.Final {
		if task.session.SourceLanguage == "" {
			return "", errors.New("source language is missing")
		}
		canonical, err := language.CanonicalizeSource(task.session.SourceLanguage)
		if err != nil {
			return "auto", nil
		}
		return canonical, nil
	}
	if task.segment.LanguageSource == "text" {
		return "auto", nil
	}
	if task.segment.LanguageSource != "" && task.segment.LanguageSource != "session" && task.segment.LanguageSource != "recognizer" {
		return "auto", nil
	}
	if task.segment.DetectedLanguage == "" || task.segment.DetectedLanguage == "auto" {
		return "auto", nil
	}
	canonical, err := language.Canonicalize(task.segment.DetectedLanguage)
	if err != nil {
		return "auto", nil
	}
	return canonical, nil
}

func (s *Service) sourceContext(task translationTask) string {
	segment := task.segment
	if segment.Sequence <= 1 || segment.SpeakerID == "" || segment.DetectedLanguage == "" || segment.DetectedLanguage == "auto" {
		return ""
	}
	ctx, cancel := context.WithTimeout(s.ctx, time.Second)
	defer cancel()
	page, err := s.store.ListSegmentsWindow(ctx, task.session.UserID, task.session.ID, store.SegmentPageQuery{
		Mode: store.SegmentPageBefore, Sequence: segment.Sequence, Limit: 12,
	})
	if err != nil {
		return ""
	}
	selected := make([]string, 0, 2)
	bytesUsed := 0
	for i := len(page.Items) - 1; i >= 0 && len(selected) < 2; i-- {
		prior := page.Items[i]
		text := strings.TrimSpace(prior.SourceText)
		if !prior.Final || prior.SpeakerID != segment.SpeakerID ||
			text == "" || !utf8.ValidString(text) || len(text) > 256 || bytesUsed+len(text)+len(selected) > 256 {
			continue
		}
		priorLanguage := ""
		if resolved, _, err := s.store.GetTranslationDetection(ctx, task.session.UserID, task.session.ID, prior.ID, task.target); err == nil {
			priorLanguage = resolved
		} else if prior.LanguageSource == "recognizer" {
			priorLanguage = prior.DetectedLanguage
		}
		if priorLanguage != segment.DetectedLanguage {
			continue
		}
		selected = append(selected, text)
		bytesUsed += len(text)
	}
	if len(selected) == 2 {
		selected[0], selected[1] = selected[1], selected[0]
	}
	return strings.Join(selected, " ")
}

func (s *Service) finishTranslationFailure(session domain.InterpretationSession,
	segment domain.Segment, target, code, requestID string) {
	s.failTranslationProgress(translationTask{session: session, segment: segment, target: target, phase: "final"})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	var record store.SegmentTranslation
	var err error
	if requestID != "" {
		record, err = s.store.FinishTranslation(ctx, session.UserID, session.ID, segment.ID,
			target, domain.TranslationFailed, "", code, requestID, time.Now().UTC())
	} else {
		record, err = s.store.FailTranslation(ctx, session.UserID, session.ID, segment.ID, target, code, time.Now().UTC())
	}
	cancel()
	if err != nil {
		s.logger.Error("persist translation failure", "segment_id", segment.ID, "error", err)
		return
	}
	s.broadcastTranslation(record)
	s.flushTranslationSnapshot(session)
}

func (s *Service) broadcastTranslation(record store.SegmentTranslation) {
	s.broadcastTranslationWithDetection(record, "", nil)
}

func (s *Service) broadcastTranslationWithDetection(record store.SegmentTranslation, resolvedSource string, detection *translate.SourceDetection) {
	revision := s.finishProgress(record.SessionID, record.SegmentID, record.TargetLanguage)
	message := map[string]any{
		"type": "translation", "phase": "final", "segmentId": record.SegmentID, "status": record.Status,
		"translation": record.Text, "error": record.Error, "requestId": record.RequestID,
		"targetLanguage": record.TargetLanguage, "revision": revision,
	}
	if detection != nil && resolvedSource != "" {
		message["resolvedSourceLanguage"] = resolvedSource
	}
	if detection != nil {
		message["sourceDetection"] = map[string]any{
			"method": detection.Method, "confidence": detection.Confidence, "rank": detection.Rank,
			"uncertain": detection.Uncertain, "contextUsed": detection.ContextUsed,
		}
	}
	s.broadcast(record.SessionID, roomEvent{target: record.TargetLanguage, data: message})
}
