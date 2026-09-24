package rooms

import (
	"context"
	"strings"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/language"
	"github.com/Tularity/t-lingual/internal/translate"
)

// DraftTranslationInput is the current ASR utterance, never durable transcript
// content. The recorder supplies its stable ID and monotonic source revision.
type DraftTranslationInput struct {
	ID               string
	Sequence         int64
	Revision         int64
	Text             string
	DetectedLanguage string
	LanguageSource   string
	SpeakerID        string
}

type draftTranslationState struct {
	task      translationTask
	lease     *recordLease
	ctx       context.Context
	cancel    context.CancelFunc
	latest    domain.Segment
	revision  int64
	final     *domain.Segment
	abandoned bool
}

func (s *Service) targetsForLease(lease *recordLease) []string {
	s.mu.Lock()
	targets := map[string]struct{}{lease.access.TargetLanguage: {}}
	if room := s.rooms[lease.access.Session.ID]; room != nil {
		for _, watch := range room.watches {
			targets[watch.access.TargetLanguage] = struct{}{}
		}
	}
	s.mu.Unlock()
	result := make([]string, 0, len(targets))
	for target := range targets {
		if canonical, err := language.Canonicalize(target); err == nil {
			result = append(result, canonical)
		}
	}
	return result
}

// UpdateDraft starts translation on the first usable ASR partial. Further
// revisions replace the pending source while one stream remains in flight.
func (s *Service) UpdateDraft(lease *recordLease, input DraftTranslationInput) {
	if lease == nil || lease.provider.Translator == nil || lease.ctx.Err() != nil || s.ctx.Err() != nil ||
		input.ID == "" || input.Sequence <= 0 || input.Revision <= 0 || strings.TrimSpace(input.Text) == "" {
		return
	}
	if _, ok := lease.provider.Translator.(translate.StreamingProvider); !ok {
		return
	}
	for _, target := range s.targetsForLease(lease) {
		if lease.access.Session.SourceLanguage != "auto" {
			if source, err := language.Canonicalize(lease.access.Session.SourceLanguage); err == nil && source == target {
				continue
			}
		}
		key := translationKey{sessionID: lease.access.Session.ID, segmentID: input.ID, target: target}
		segment := domain.Segment{ID: input.ID, SessionID: key.sessionID, UserID: lease.access.Session.UserID,
			Sequence: input.Sequence, SourceText: input.Text, DetectedLanguage: input.DetectedLanguage,
			LanguageSource: input.LanguageSource, SpeakerID: input.SpeakerID, TranslationStatus: domain.TranslationPending}
		s.draftMu.Lock()
		if state := s.drafts[key]; state != nil {
			if state.final == nil && input.Revision > state.revision {
				state.latest = segment
				state.revision = input.Revision
				state.task.sourceRevision = input.Revision
			}
			s.draftMu.Unlock()
			continue
		}
		if len(s.drafts) >= 128 {
			s.draftMu.Unlock()
			continue
		}
		draftCtx, draftCancel := context.WithCancel(s.ctx)
		state := &draftTranslationState{task: translationTask{session: lease.access.Session, segment: segment, target: target, provider: lease.provider, phase: "draft", sourceRevision: input.Revision, draftLease: lease}, lease: lease, ctx: draftCtx, cancel: draftCancel, latest: segment, revision: input.Revision}
		s.mu.Lock()
		if s.closing || s.ctx.Err() != nil {
			s.mu.Unlock()
			s.draftMu.Unlock()
			draftCancel()
			return
		}
		s.draftWG.Add(1)
		s.mu.Unlock()
		s.drafts[key] = state
		s.draftMu.Unlock()
		go s.runDraft(key, state)
	}
}

// FinalizeDraft is called after the ASR final has been saved. A busy draft
// finishes first; its speculative result is never persisted or reused as final.
func (s *Service) FinalizeDraft(lease *recordLease, final domain.Segment) {
	if lease == nil || !final.Final || final.ID == "" || final.SessionID != lease.access.Session.ID {
		return
	}
	for _, target := range s.targetsForLease(lease) {
		key := translationKey{sessionID: final.SessionID, segmentID: final.ID, target: target}
		s.draftMu.Lock()
		if state := s.drafts[key]; state != nil {
			copy := final
			state.final = &copy
			s.markDraftFinalizing(key, lease)
			s.draftMu.Unlock()
			continue
		}
		s.draftMu.Unlock()
		// A fast draft may already have completed, but its displayed progress
		// still belongs to this final segment until the validated request wins.
		s.markDraftFinalizing(key, lease)
		s.ensureTranslation(s.ctx, lease.access.Session, final, target, lease.provider)
	}
}

func (s *Service) markDraftFinalizing(key translationKey, lease *recordLease) bool {
	s.progressMu.Lock()
	marked := false
	if progress, ok := s.progress[key]; ok && progress.DraftLease == lease {
		progress.DraftLease = nil
		progress.Finalizing = true
		s.progress[key] = progress
		marked = true
	}
	s.progressMu.Unlock()
	return marked
}

// CancelDrafts clears provisional text when a recorder ends without an ASR
// final. Call this after draining the ASR event stream, before releasing the
// lease. Already-finalized utterances remain eligible for durable translation.
func (s *Service) CancelDrafts(lease *recordLease) {
	if lease == nil {
		return
	}
	s.draftMu.Lock()
	for key, state := range s.drafts {
		if state.lease == lease && state.final == nil {
			state.abandoned = true
			state.cancel()
			delete(s.drafts, key)
		}
	}
	s.progressMu.Lock()
	type clearEvent struct {
		key      translationKey
		revision int64
	}
	var cleared []clearEvent
	for key, progress := range s.progress {
		if progress.DraftLease == lease {
			cleared = append(cleared, clearEvent{key: key, revision: progress.Revision + 1})
			delete(s.progress, key)
		}
	}
	s.progressMu.Unlock()
	s.draftMu.Unlock()
	for _, item := range cleared {
		s.broadcast(item.key.sessionID, roomEvent{target: item.key.target, data: map[string]any{
			"type": "translation", "phase": "draft", "segmentId": item.key.segmentID,
			"targetLanguage": item.key.target, "status": domain.TranslationPending,
			"translation": "", "requestId": "", "revision": item.revision,
		}})
	}
}

func (s *Service) runDraft(key translationKey, state *draftTranslationState) {
	defer s.draftWG.Done()
	defer state.cancel()
	select {
	case s.draftSlots <- struct{}{}:
		defer func() { <-s.draftSlots }()
	case <-s.ctx.Done():
		s.finishDraftState(key, state)
		return
	case <-state.ctx.Done():
		s.finishDraftState(key, state)
		return
	}
	for {
		s.draftMu.Lock()
		if state.final != nil || state.abandoned {
			s.draftMu.Unlock()
			s.finishDraftState(key, state)
			return
		}
		current := state.latest
		revision := state.revision
		task := state.task
		task.segment = current
		task.sourceRevision = revision
		// Keep the old complete display while the next request catches up.
		s.beginTranslationProgress(task)
		s.draftMu.Unlock()
		ctx, cancel := context.WithTimeout(state.ctx, 100*time.Second)
		input, inputErr := s.translationInput(task)
		var response translate.Response
		err := inputErr
		if err == nil {
			streaming := task.provider.Translator.(translate.StreamingProvider)
			response, err = streaming.TranslateStream(ctx, input, func(update translate.StreamUpdate) error {
				if err := ctx.Err(); err != nil {
					return err
				}
				s.draftMu.Lock()
				if !state.abandoned && s.drafts[key] == state {
					s.publishTranslationProgress(task, update.Text, update.RequestID)
				}
				s.draftMu.Unlock()
				return nil
			})
		}
		cancel()
		s.draftMu.Lock()
		if state.abandoned {
			s.draftMu.Unlock()
			s.finishDraftState(key, state)
			return
		}
		if state.final != nil {
			if err != nil {
				s.failTranslationProgress(task)
			} else {
				s.completeTranslationProgress(task, response.Translation, response.RequestID)
			}
			s.draftMu.Unlock()
			s.finishDraftState(key, state)
			return
		}
		if err == nil {
			s.completeTranslationProgress(task, response.Translation, response.RequestID)
		} else {
			s.failTranslationProgress(task)
		}
		if state.revision != revision {
			s.draftMu.Unlock()
			continue
		}
		delete(s.drafts, key)
		s.draftMu.Unlock()
		return
	}
}

func (s *Service) finishDraftState(key translationKey, state *draftTranslationState) {
	s.draftMu.Lock()
	if s.drafts[key] != state {
		s.draftMu.Unlock()
		return
	}
	final := state.final
	delete(s.drafts, key)
	s.draftMu.Unlock()
	if final != nil {
		s.ensureTranslation(s.ctx, state.task.session, *final, key.target, state.task.provider)
		return
	}
	s.failTranslationProgress(state.task)
	s.finishProgress(key.sessionID, key.segmentID, key.target)
}

// Provisional output exists only in memory. Text is the single stable display
// projection used by SSE, late-watcher snapshots, and the PiP client.
type translationProgress struct {
	Text          string
	Candidate     string
	Floor         int
	RequestID     string
	Revision      int64
	LastBroadcast time.Time
	DraftLease    *recordLease
	Finalizing    bool
	Completed     bool
}

func (s *Service) beginTranslationProgress(task translationTask) {
	key := translationKey{sessionID: task.session.ID, segmentID: task.segment.ID, target: task.target}
	s.progressMu.Lock()
	current := s.progress[key]
	current.Candidate = ""
	current.Floor = len([]rune(current.Text))
	current.Completed = false
	if task.phase == "draft" {
		if !current.Finalizing {
			current.DraftLease = task.draftLease
		}
	} else {
		current.DraftLease = nil
		current.Finalizing = false
	}
	current.Revision++
	current.LastBroadcast = time.Now()
	s.progress[key] = current
	s.progressMu.Unlock()
	s.broadcastProgress(task, current, false, false)
}

func (s *Service) publishTranslationProgress(task translationTask, text, requestID string) {
	key := translationKey{sessionID: task.session.ID, segmentID: task.segment.ID, target: task.target}
	s.progressMu.Lock()
	current, exists := s.progress[key]
	current.Candidate = text
	visible := stableTranslationText(current.Text, text, current.Floor)
	if exists && visible == current.Text {
		s.progress[key] = current
		s.progressMu.Unlock()
		return
	}
	firstText := current.Text == "" && visible != ""
	replacement := current.Text != "" && !strings.HasPrefix(visible, current.Text)
	current.Text = visible
	if visible == text {
		current.RequestID = requestID
	}
	if task.phase == "draft" {
		if !current.Finalizing {
			current.DraftLease = task.draftLease
		}
	} else {
		current.DraftLease = nil
		current.Finalizing = false
	}
	current.Revision++
	now := time.Now()
	publish := firstText || replacement || current.LastBroadcast.IsZero() || now.Sub(current.LastBroadcast) >= 40*time.Millisecond
	if publish {
		current.LastBroadcast = now
	}
	s.progress[key] = current
	s.progressMu.Unlock()
	if publish {
		s.broadcastProgress(task, current, false, false)
	}
}

// A draft finishes with status=pending because only a separately validated
// final request can be durable. The completion event is explicit nevertheless:
// a short normal response replaces a longer interim display immediately.
func (s *Service) completeTranslationProgress(task translationTask, text, requestID string) {
	key := translationKey{sessionID: task.session.ID, segmentID: task.segment.ID, target: task.target}
	s.progressMu.Lock()
	current := s.progress[key]
	current.Candidate = text
	current.Text = text
	current.Floor = len([]rune(text))
	current.RequestID = requestID
	current.Completed = true
	current.Revision++
	current.LastBroadcast = time.Now()
	if task.phase == "draft" {
		if !current.Finalizing {
			current.DraftLease = task.draftLease
		}
	} else {
		current.DraftLease = nil
		current.Finalizing = false
	}
	s.progress[key] = current
	s.progressMu.Unlock()
	s.broadcastProgress(task, current, true, false)
}

// Provider or validation failures retract text from the superseded request.
// Keeping it would present an invalid translation as if it were merely late.
func (s *Service) failTranslationProgress(task translationTask) {
	key := translationKey{sessionID: task.session.ID, segmentID: task.segment.ID, target: task.target}
	s.progressMu.Lock()
	current := s.progress[key]
	current.Text = ""
	current.Candidate = ""
	current.Floor = 0
	current.RequestID = ""
	current.Completed = false
	current.Revision++
	current.LastBroadcast = time.Now()
	s.progress[key] = current
	s.progressMu.Unlock()
	s.broadcastProgress(task, current, false, true)
}

func (s *Service) broadcastProgress(task translationTask, current translationProgress, complete, retracted bool) {
	phase := task.phase
	if phase == "" {
		phase = "final"
	}
	message := map[string]any{
		"type": "translation", "segmentId": task.segment.ID, "targetLanguage": task.target,
		"phase": phase, "status": domain.TranslationPending, "translation": current.Text,
		"requestId": current.RequestID, "revision": current.Revision,
	}
	if task.sourceRevision > 0 {
		message["sourceRevision"] = task.sourceRevision
	}
	if complete {
		message["streamComplete"] = true
		if phase == "draft" {
			message["draftComplete"] = true
		}
	}
	if retracted {
		message["retracted"] = true
	}
	s.broadcast(task.session.ID, roomEvent{target: task.target, data: message})
}

func (s *Service) presentTranslationProgress(target string, segments []domain.Segment) []domain.Segment {
	s.progressMu.Lock()
	defer s.progressMu.Unlock()
	for i := range segments {
		if segments[i].TranslationStatus != domain.TranslationPending {
			continue
		}
		if current, ok := s.progress[translationKey{sessionID: segments[i].SessionID, segmentID: segments[i].ID, target: target}]; ok {
			segments[i].Translation = current.Text
			segments[i].TranslationRevision = current.Revision
			segments[i].TranslatorRequestID = current.RequestID
		}
	}
	return segments
}
func (s *Service) finishProgress(sessionID, segmentID, target string) int64 {
	key := translationKey{sessionID: sessionID, segmentID: segmentID, target: target}
	s.progressMu.Lock()
	defer s.progressMu.Unlock()
	revision := s.progress[key].Revision + 1
	delete(s.progress, key)
	return revision
}
