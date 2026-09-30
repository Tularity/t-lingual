package rooms

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/providers"
	"github.com/Tularity/t-lingual/internal/store"
	"github.com/Tularity/t-lingual/internal/translate"
)

type draftCall struct {
	input   translate.Request
	release chan struct{}
}
type controlledDraftTranslator struct {
	calls chan *draftCall
	count atomic.Int32
}

type manualDraftCall struct {
	input   translate.Request
	emit    chan translate.StreamUpdate
	release chan struct{}
}

type manualDraftTranslator struct {
	calls chan *manualDraftCall
	count atomic.Int32
}

func (*manualDraftTranslator) Ready(context.Context) error { return nil }
func (*manualDraftTranslator) Translate(context.Context, translate.Request) (translate.Response, error) {
	return translate.Response{}, errors.New("sync path not expected")
}
func (p *manualDraftTranslator) TranslateStream(ctx context.Context, input translate.Request, callback func(translate.StreamUpdate) error) (translate.Response, error) {
	index := p.count.Add(1)
	call := &manualDraftCall{input: input, emit: make(chan translate.StreamUpdate, 4), release: make(chan struct{})}
	p.calls <- call
	for {
		select {
		case update := <-call.emit:
			if err := callback(update); err != nil {
				return translate.Response{}, err
			}
		case <-call.release:
			return translate.Response{RequestID: fmt.Sprintf("manual-%d", index), SourceLanguage: input.SourceLanguage,
				TargetLanguage: input.TargetLanguage, Translation: "validated-" + input.Text}, nil
		case <-ctx.Done():
			return translate.Response{}, ctx.Err()
		}
	}
}

func (*controlledDraftTranslator) Ready(context.Context) error { return nil }
func (*controlledDraftTranslator) Translate(context.Context, translate.Request) (translate.Response, error) {
	return translate.Response{}, errors.New("sync path not expected")
}
func (p *controlledDraftTranslator) TranslateStream(ctx context.Context, input translate.Request, emit func(translate.StreamUpdate) error) (translate.Response, error) {
	call := &draftCall{input: input, release: make(chan struct{})}
	index := p.count.Add(1)
	p.calls <- call
	if err := emit(translate.StreamUpdate{RequestID: fmt.Sprintf("req-%d", index), Index: 1, Text: "draft-" + input.Text}); err != nil {
		return translate.Response{}, err
	}
	select {
	case <-call.release:
	case <-ctx.Done():
		return translate.Response{}, ctx.Err()
	}
	return translate.Response{RequestID: fmt.Sprintf("req-%d", index), SourceLanguage: input.SourceLanguage,
		TargetLanguage: input.TargetLanguage, Translation: "validated-" + input.Text}, nil
}

func awaitDraftCall(t *testing.T, provider *controlledDraftTranslator) *draftCall {
	t.Helper()
	select {
	case call := <-provider.calls:
		return call
	case <-time.After(2 * time.Second):
		t.Fatal("draft translator did not receive request")
		return nil
	}
}

func testDraftLease(t *testing.T, svc *Service, resolver *testResolver, session domain.InterpretationSession, viewer domain.Viewer, provider translate.Provider) (*recordLease, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	return &recordLease{ctx: ctx, access: resolver.access[viewer.ID], viewer: viewer, provider: providers.Snapshot{Translator: provider}}, cancel
}

func TestDraftTranslationsCoalesceWhileBusyThenAlwaysTranslatePersistedFinal(t *testing.T) {
	provider := &controlledDraftTranslator{calls: make(chan *draftCall, 8)}
	svc, database, resolver, session, viewers := roomFixture(t, provider)
	lease, cancel := testDraftLease(t, svc, resolver, session, viewers[0], provider)
	defer cancel()
	watch := &watcher{id: 1, viewer: viewers[1], access: resolver.access[viewers[1].ID], queue: make(chan roomEvent, 32), cancel: func() {}}
	if _, err := svc.registerWatch(session.ID, watch); err != nil {
		t.Fatal(err)
	}
	defer svc.releaseWatch(session.ID, watch)
	first := DraftTranslationInput{ID: "seg_draft", Sequence: 1, Revision: 1, Text: "Hello"}
	svc.UpdateDraft(lease, first)
	call1 := awaitDraftCall(t, provider)
	if call1.input.Text != "Hello" {
		t.Fatalf("first partial was not translated: %#v", call1.input)
	}
	svc.UpdateDraft(lease, DraftTranslationInput{ID: first.ID, Sequence: 1, Revision: 2, Text: "Hello there"})
	svc.UpdateDraft(lease, DraftTranslationInput{ID: first.ID, Sequence: 1, Revision: 3, Text: "Hello latest"})
	if provider.count.Load() != 1 {
		t.Fatalf("busy stream was duplicated: %d", provider.count.Load())
	}
	if _, err := database.GetTranslation(context.Background(), session.UserID, session.ID, first.ID, "zh-Hans"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("draft created durable translation: %v", err)
	}
	close(call1.release)
	call2 := awaitDraftCall(t, provider)
	if call2.input.Text != "Hello latest" {
		t.Fatalf("coalesced draft input = %#v", call2.input)
	}
	final := domain.Segment{ID: first.ID, SessionID: session.ID, UserID: session.UserID, Sequence: 1, SourceText: "Hello latest", Final: true,
		DetectedLanguage: "en", LanguageSource: "session",
		TranslationStatus: domain.TranslationNotRequested, CreatedAt: time.Now().UTC()}
	if err := database.AppendSegment(context.Background(), session.UserID, final); err != nil {
		t.Fatal(err)
	}
	svc.FinalizeDraft(lease, final)
	if provider.count.Load() != 2 {
		t.Fatal("final translation started before active draft ended")
	}
	close(call2.release)
	call3 := awaitDraftCall(t, provider)
	if call3.input.Text != final.SourceText || provider.count.Load() != 3 {
		t.Fatalf("final request missing or reused draft: %#v count=%d", call3.input, provider.count.Load())
	}
	close(call3.release)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		record, err := database.GetTranslation(context.Background(), session.UserID, session.ID, final.ID, "zh-Hans")
		if err == nil && record.Status == domain.TranslationSucceeded {
			if record.Text != "validated-Hello latest" || record.RequestID != "req-3" {
				t.Fatalf("draft was stored as final: %#v", record)
			}
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("validated final was not persisted")
}

func TestBusyDraftKeepsEmittingAfterCorrectionAndFinalUntilDistinctFinalStarts(t *testing.T) {
	provider := &manualDraftTranslator{calls: make(chan *manualDraftCall, 3)}
	svc, database, resolver, session, viewers := roomFixture(t, provider)
	lease, cancel := testDraftLease(t, svc, resolver, session, viewers[0], provider)
	defer cancel()
	watch := &watcher{id: 103, viewer: viewers[1], access: resolver.access[viewers[1].ID], queue: make(chan roomEvent, 32), cancel: func() {}}
	if _, err := svc.registerWatch(session.ID, watch); err != nil {
		t.Fatal(err)
	}
	defer svc.releaseWatch(session.ID, watch)
	svc.UpdateDraft(lease, DraftTranslationInput{ID: "long_utterance", Sequence: 1, Revision: 1, Text: "old source"})
	var first *manualDraftCall
	select {
	case first = <-provider.calls:
	case <-time.After(time.Second):
		t.Fatal("first draft request missing")
	}
	svc.UpdateDraft(lease, DraftTranslationInput{ID: "long_utterance", Sequence: 1, Revision: 2, Text: "corrected source"})
	first.emit <- translate.StreamUpdate{RequestID: "manual-1", Index: 1, Text: "old stream remains visible"}
	waitProgress := func(want string) {
		t.Helper()
		deadline := time.After(time.Second)
		for {
			select {
			case event := <-watch.queue:
				message, ok := event.data.(map[string]any)
				if !ok || message["translation"] != want {
					continue
				}
				if message["phase"] != "draft" || message["sourceRevision"] != int64(1) {
					t.Fatalf("old stream lost revision identity: %#v", message)
				}
				return
			case <-deadline:
				t.Fatalf("old draft output %q was suppressed", want)
			}
		}
	}
	waitProgress("old stream remains visible")
	final := domain.Segment{ID: "long_utterance", SessionID: session.ID, UserID: session.UserID,
		Sequence: 1, SourceText: "final source", Final: true, DetectedLanguage: "en", LanguageSource: "session",
		TranslationStatus: domain.TranslationNotRequested, CreatedAt: time.Now().UTC()}
	if err := database.AppendSegment(context.Background(), session.UserID, final); err != nil {
		t.Fatal(err)
	}
	// A history read can race ahead of the recorder's FinalizeDraft callback.
	access := resolver.access[viewers[1].ID]
	if _, err := svc.ProjectSegments(context.Background(), access, []domain.Segment{final}); err != nil {
		t.Fatal(err)
	}
	if provider.count.Load() != 1 {
		t.Fatal("history read dispatched final while draft still streaming")
	}
	svc.FinalizeDraft(lease, final)
	cancel() // the normal recorder lease ends before this long GPU stream
	svc.CancelDrafts(lease)
	time.Sleep(45 * time.Millisecond) // progress broadcasts are bounded at 40ms
	first.emit <- translate.StreamUpdate{RequestID: "manual-1", Index: 2, Text: "old stream after final"}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		svc.progressMu.Lock()
		progress := svc.progress[translationKey{sessionID: session.ID, segmentID: "long_utterance", target: "zh-Hans"}]
		svc.progressMu.Unlock()
		if progress.Candidate == "old stream after final" {
			if progress.Text != "old stream remains visible" {
				t.Fatalf("short correction flashed: %#v", progress)
			}
			break
		}
		time.Sleep(time.Millisecond)
	}
	first.emit <- translate.StreamUpdate{RequestID: "manual-1", Index: 3, Text: "old stream after final, with additional words"}
	waitProgress("old stream after final, with additional words")
	if provider.count.Load() != 1 {
		t.Fatal("final request started before old stream completed")
	}
	close(first.release)
	var finalCall *manualDraftCall
	select {
	case finalCall = <-provider.calls:
	case <-time.After(2 * time.Second):
		t.Fatal("distinct final request did not start after draft completion")
	}
	if finalCall.input.Text != final.SourceText || provider.count.Load() != 2 {
		t.Fatalf("final request = %#v, count=%d", finalCall.input, provider.count.Load())
	}
	close(finalCall.release)
}

func TestDraftCancellationStillSchedulesDurableTailFinal(t *testing.T) {
	provider := &controlledDraftTranslator{calls: make(chan *draftCall, 8)}
	svc, database, resolver, session, viewers := roomFixture(t, provider)
	lease, cancel := testDraftLease(t, svc, resolver, session, viewers[0], provider)
	defer cancel()
	svc.UpdateDraft(lease, DraftTranslationInput{ID: "seg_tail", Sequence: 1, Revision: 1, Text: "Before stop"})
	old := awaitDraftCall(t, provider)
	final := domain.Segment{ID: "seg_tail", SessionID: session.ID, UserID: session.UserID, Sequence: 1, SourceText: "Tail final", Final: true,
		DetectedLanguage: "en", LanguageSource: "session",
		TranslationStatus: domain.TranslationNotRequested, CreatedAt: time.Now().UTC()}
	if err := database.AppendSegment(context.Background(), session.UserID, final); err != nil {
		t.Fatal(err)
	}
	svc.FinalizeDraft(lease, final)
	cancel()
	svc.CancelDrafts(lease)
	if provider.count.Load() != 1 {
		t.Fatal("final request started before busy draft completed")
	}
	close(old.release)
	call := awaitDraftCall(t, provider)
	if call.input.Text != "Tail final" {
		t.Fatalf("tail final source was lost: %#v", call.input)
	}
	close(call.release)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		record, err := database.GetTranslation(context.Background(), session.UserID, session.ID, final.ID, "zh-Hans")
		if err == nil && record.Status == domain.TranslationSucceeded {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("canceled recorder lost final translation")
}

func TestCancelDraftsClearsOrphanProgressAndCannotBeRepopulatedByLateDelta(t *testing.T) {
	provider := &controlledDraftTranslator{calls: make(chan *draftCall, 2)}
	svc, _, resolver, session, viewers := roomFixture(t, provider)
	lease, cancel := testDraftLease(t, svc, resolver, session, viewers[0], provider)
	defer cancel()
	key := translationKey{sessionID: session.ID, segmentID: "orphan", target: "zh-Hans"}
	svc.UpdateDraft(lease, DraftTranslationInput{ID: key.segmentID, Sequence: 1, Revision: 1, Text: "Unfinished"})
	call := awaitDraftCall(t, provider)
	svc.CancelDrafts(lease)
	close(call.release)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		svc.draftMu.Lock()
		_, active := svc.drafts[key]
		svc.draftMu.Unlock()
		svc.progressMu.Lock()
		_, progress := svc.progress[key]
		svc.progressMu.Unlock()
		if !active && !progress {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("abandoned draft retained provisional text")
}

func TestCancelDraftsClearsCompletedUnfinalizedProgress(t *testing.T) {
	provider := &controlledDraftTranslator{calls: make(chan *draftCall, 2)}
	svc, _, resolver, session, viewers := roomFixture(t, provider)
	lease, cancel := testDraftLease(t, svc, resolver, session, viewers[0], provider)
	defer cancel()
	key := translationKey{sessionID: session.ID, segmentID: "completed_orphan", target: "zh-Hans"}
	svc.UpdateDraft(lease, DraftTranslationInput{ID: key.segmentID, Sequence: 1, Revision: 1, Text: "Unfinished"})
	call := awaitDraftCall(t, provider)
	close(call.release)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		svc.draftMu.Lock()
		_, active := svc.drafts[key]
		svc.draftMu.Unlock()
		if !active {
			break
		}
		time.Sleep(time.Millisecond)
	}
	svc.progressMu.Lock()
	before := svc.progress[key]
	svc.progressMu.Unlock()
	if before.Text != "validated-Unfinished" {
		t.Fatalf("completed provisional result missing before cleanup: %#v", before)
	}
	svc.CancelDrafts(lease)
	svc.progressMu.Lock()
	_, exists := svc.progress[key]
	svc.progressMu.Unlock()
	if exists {
		t.Fatal("completed unfinalized draft survived recorder cleanup")
	}
}

func TestSourceContextUsesOnlySameSessionSpeakerAndLanguageWithinByteCap(t *testing.T) {
	svc, database, _, session, _ := roomFixture(t, nil)
	session.SourceLanguage = "auto"
	for index, item := range []struct{ text, speaker, lang string }{
		{"Old matching phrase one.", "speaker_1", "en"},
		{"Wrong speaker phrase.", "speaker_2", "en"},
		{"Old matching phrase two.", "speaker_1", "en"},
		{"另一种语言。", "speaker_1", "zh-Hans"},
	} {
		segment := domain.Segment{ID: fmt.Sprintf("seg_prior_%d", index), SessionID: session.ID, UserID: session.UserID, Sequence: int64(index + 1),
			SourceText: item.text, SpeakerID: item.speaker, DetectedLanguage: item.lang, LanguageSource: "recognizer", Final: true,
			TranslationStatus: domain.TranslationNotRequested, CreatedAt: time.Now().UTC()}
		if err := database.AppendSegment(context.Background(), session.UserID, segment); err != nil {
			t.Fatal(err)
		}
	}
	draft := domain.Segment{ID: "seg_current", SessionID: session.ID, UserID: session.UserID, Sequence: 5, SourceText: "OK", SpeakerID: "speaker_1", DetectedLanguage: "en"}
	task := translationTask{session: session, segment: draft, target: "fr"}
	input, err := svc.translationInput(task)
	if err != nil || input.SourceLanguage != "auto" || input.SourceContext != "Old matching phrase one. Old matching phrase two." {
		t.Fatalf("unsafe context: %#v %v", input, err)
	}
	if len(input.SourceContext) > 256 {
		t.Fatal("context byte cap exceeded")
	}
	task.segment.SourceText = strings.Repeat("a", 33)
	input, _ = svc.translationInput(task)
	if input.SourceContext != "" {
		t.Fatal("long source incorrectly received context")
	}
	task.segment.SourceText = "OK"
	task.segment.SpeakerID = ""
	input, _ = svc.translationInput(task)
	if input.SourceContext != "" {
		t.Fatal("unknown speaker received context")
	}
	task.segment.SpeakerID = "speaker_1"
	task.session.SourceLanguage = "en"
	input, _ = svc.translationInput(task)
	if input.SourceContext != "" {
		t.Fatal("explicit source received LID context")
	}
}

func TestSourceContextCapsMultibyteBytesAndNeverCrossesSessions(t *testing.T) {
	svc, database, _, session, _ := roomFixture(t, nil)
	session.SourceLanguage = "auto"
	for index, text := range []string{strings.Repeat("界", 80), "Recent English sentence."} {
		segment := domain.Segment{ID: fmt.Sprintf("seg_context_%d", index), SessionID: session.ID, UserID: session.UserID,
			Sequence: int64(index + 1), SourceText: text, SpeakerID: "speaker_1", DetectedLanguage: "en",
			LanguageSource: "recognizer", Final: true, TranslationStatus: domain.TranslationNotRequested, CreatedAt: time.Now().UTC()}
		if err := database.AppendSegment(context.Background(), session.UserID, segment); err != nil {
			t.Fatal(err)
		}
	}
	task := translationTask{session: session, segment: domain.Segment{ID: "next", Sequence: 3, SourceText: "OK", SpeakerID: "speaker_1", DetectedLanguage: "en"}, target: "fr"}
	input, err := svc.translationInput(task)
	if err != nil || input.SourceContext != "Recent English sentence." {
		t.Fatalf("multibyte byte cap failed: %#v %v", input, err)
	}
	task.session.ID = "different_session"
	input, err = svc.translationInput(task)
	if err != nil || input.SourceContext != "" {
		t.Fatalf("cross-session context leaked: %#v %v", input, err)
	}
}

func TestSourceContextPrefersPriorValidatedSameTargetLIDOverScriptGuess(t *testing.T) {
	svc, database, _, session, _ := roomFixture(t, nil)
	session.SourceLanguage = "auto"
	prior := domain.Segment{ID: "prior_detected", SessionID: session.ID, UserID: session.UserID,
		Sequence: 1, SourceText: "Det bliver leveret i morgen.", SpeakerID: "speaker_1",
		DetectedLanguage: "en", LanguageSource: "text", Final: true,
		TranslationStatus: domain.TranslationNotRequested, CreatedAt: time.Now().UTC()}
	if err := database.AppendSegment(context.Background(), session.UserID, prior); err != nil {
		t.Fatal(err)
	}
	if _, _, err := database.ClaimTranslation(context.Background(), session.UserID, session.ID, prior.ID, "fr", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	detection := domain.SourceDetection{Method: "fasttext-lid.176", Confidence: .82, Rank: 1}
	if _, err := database.FinishTranslationWithDetection(context.Background(), session.UserID, session.ID,
		prior.ID, "fr", "Traduction", "rid", "da", detection, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	current := domain.Segment{ID: "current_detected", Sequence: 2, SourceText: "Tak.", SpeakerID: "speaker_1", DetectedLanguage: "da"}
	task := translationTask{session: session, segment: current, target: "fr"}
	input, err := svc.translationInput(task)
	if err != nil || input.SourceContext != prior.SourceText {
		t.Fatalf("validated same-target LID context = %#v %v", input, err)
	}
	task.target = "es"
	input, err = svc.translationInput(task)
	if err != nil || input.SourceContext != "" {
		t.Fatalf("LID from another target leaked: %#v %v", input, err)
	}
}

func TestDraftProgressCarriesPhaseAndSourceRevision(t *testing.T) {
	provider := &controlledDraftTranslator{calls: make(chan *draftCall, 2)}
	svc, _, resolver, session, viewers := roomFixture(t, provider)
	lease, cancel := testDraftLease(t, svc, resolver, session, viewers[0], provider)
	defer cancel()
	watch := &watcher{id: 42, viewer: viewers[1], access: resolver.access[viewers[1].ID], queue: make(chan roomEvent, 16), cancel: func() {}}
	if _, err := svc.registerWatch(session.ID, watch); err != nil {
		t.Fatal(err)
	}
	defer svc.releaseWatch(session.ID, watch)
	svc.UpdateDraft(lease, DraftTranslationInput{ID: "seg_metadata", Sequence: 1, Revision: 4, Text: "Hello"})
	call := awaitDraftCall(t, provider)
	defer close(call.release)
	deadline := time.After(time.Second)
	for {
		select {
		case event := <-watch.queue:
			message, ok := event.data.(map[string]any)
			if !ok || message["translation"] != "draft-Hello" {
				continue
			}
			if message["phase"] != "draft" || message["sourceRevision"] != int64(4) || message["status"] != domain.TranslationPending {
				t.Fatalf("draft event omitted source version: %#v", message)
			}
			return
		case <-deadline:
			t.Fatal("draft progress event missing")
		}
	}
}

func TestValidatedFinalEventCarriesResolvedLanguageAndUncertainty(t *testing.T) {
	svc, _, resolver, session, viewers := roomFixture(t, nil)
	watch := &watcher{id: 43, viewer: viewers[1], access: resolver.access[viewers[1].ID], queue: make(chan roomEvent, 4), cancel: func() {}}
	if _, err := svc.registerWatch(session.ID, watch); err != nil {
		t.Fatal(err)
	}
	defer svc.releaseWatch(session.ID, watch)
	detection := &translate.SourceDetection{Method: "fasttext-lid.176", Confidence: .65, Rank: 2, Uncertain: true, ContextUsed: true}
	svc.broadcastTranslationWithDetection(store.SegmentTranslation{SessionID: session.ID, SegmentID: "seg_final", TargetLanguage: "zh-Hans", Status: domain.TranslationSucceeded, Text: "你好"}, "da", detection)
	select {
	case event := <-watch.queue:
		message := event.data.(map[string]any)
		metadata := message["sourceDetection"].(map[string]any)
		if message["phase"] != "final" || message["resolvedSourceLanguage"] != "da" || metadata["uncertain"] != true || metadata["contextUsed"] != true {
			t.Fatalf("final LID event = %#v", message)
		}
	case <-time.After(time.Second):
		t.Fatal("validated final event missing")
	}
}

func TestDraftTranslationWaitsTheIntervalUnlessTheRequestWasSlowOrTheLineFinished(t *testing.T) {
	provider := &controlledDraftTranslator{calls: make(chan *draftCall, 8)}
	svc, database, resolver, session, viewers := roomFixture(t, provider)
	const interval = 400 * time.Millisecond
	svc.SetDraftTranslationInterval(interval)
	lease, cancel := testDraftLease(t, svc, resolver, session, viewers[0], provider)
	defer cancel()
	update := func(revision int64, text string) {
		svc.UpdateDraft(lease, DraftTranslationInput{ID: "seg_paced", Sequence: 1, Revision: revision, Text: text})
	}

	// The first words go out at once.
	update(1, "Hello")
	started := time.Now()
	first := awaitDraftCall(t, provider)
	update(2, "Hello there")
	close(first.release)
	second := awaitDraftCall(t, provider)
	if elapsed := time.Since(started); elapsed < interval-20*time.Millisecond {
		t.Fatalf("changed line asked for again after %s, before the %s interval", elapsed, interval)
	}
	if second.input.Text != "Hello there" {
		t.Fatalf("second draft = %q", second.input.Text)
	}

	// A request that took longer than the interval is followed at once.
	update(3, "Hello there, everyone")
	time.Sleep(interval + 100*time.Millisecond)
	released := time.Now()
	close(second.release)
	third := awaitDraftCall(t, provider)
	if waited := time.Since(released); waited > 150*time.Millisecond {
		t.Fatalf("slow request was followed after %s", waited)
	}

	// A finished line does not wait out the interval.
	update(4, "Hello there, everyone here")
	close(third.release)
	time.Sleep(50 * time.Millisecond)
	final := domain.Segment{ID: "seg_paced", SessionID: session.ID, UserID: session.UserID, Sequence: 1,
		SourceText: "Hello there, everyone here.", Final: true, DetectedLanguage: "en", LanguageSource: "session",
		TranslationStatus: domain.TranslationNotRequested, CreatedAt: time.Now().UTC()}
	if err := database.AppendSegment(context.Background(), session.UserID, final); err != nil {
		t.Fatal(err)
	}
	finalized := time.Now()
	svc.FinalizeDraft(lease, final)
	last := awaitDraftCall(t, provider)
	if waited := time.Since(finalized); waited > 150*time.Millisecond || last.input.Text != final.SourceText {
		t.Fatalf("final translation waited %s for %q", waited, last.input.Text)
	}
	close(last.release)
}
