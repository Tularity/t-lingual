package rooms

import (
	"testing"

	"github.com/Tularity/t-lingual/internal/domain"
)

func TestStableTranslationUnicodePrefixReplacementAndExplicitDraftCompletion(t *testing.T) {
	svc, _, resolver, session, viewers := roomFixture(t, nil)
	watch := &watcher{id: 401, viewer: viewers[1], access: resolver.access[viewers[1].ID], queue: make(chan roomEvent, 32), cancel: func() {}}
	if _, err := svc.registerWatch(session.ID, watch); err != nil {
		t.Fatal(err)
	}
	defer svc.releaseWatch(session.ID, watch)
	task := translationTask{session: session, segment: domain.Segment{ID: "seg_unicode", SessionID: session.ID, Sequence: 1}, target: "zh-Hans", phase: "draft", sourceRevision: 1}
	key := translationKey{sessionID: session.ID, segmentID: task.segment.ID, target: task.target}
	visible := func() translationProgress {
		svc.progressMu.Lock()
		defer svc.progressMu.Unlock()
		return svc.progress[key]
	}
	svc.beginTranslationProgress(task)
	svc.publishTranslationProgress(task, "你好😀", "first")
	svc.completeTranslationProgress(task, "你好😀", "first")
	if !visible().Completed {
		t.Fatal("draft response had no completed marker")
	}
	task.sourceRevision = 2
	svc.beginTranslationProgress(task)
	if got := visible().Text; got != "你好😀" {
		t.Fatalf("new request cleared old display: %q", got)
	}
	svc.publishTranslationProgress(task, "你好", "second")
	if got := visible().Text; got != "你好😀" {
		t.Fatalf("same-prefix short candidate flashed: %q", got)
	}
	svc.publishTranslationProgress(task, "新", "second")
	svc.publishTranslationProgress(task, "新的", "second")
	if got := visible().Text; got != "你好😀" {
		t.Fatalf("divergent short candidate flashed: %q", got)
	}
	svc.publishTranslationProgress(task, "新的🙂", "second")
	if got := visible().Text; got != "新的🙂" {
		t.Fatalf("rune threshold missed: %q", got)
	}
	svc.publishTranslationProgress(task, "新的🙂续", "second")
	if got := visible().Text; got != "新的🙂续" {
		t.Fatalf("incremental append missed: %q", got)
	}
	task.sourceRevision = 3
	svc.beginTranslationProgress(task)
	svc.publishTranslationProgress(task, "新的🙂", "third")
	if got := visible().Text; got != "新的🙂续" {
		t.Fatalf("short same-prefix restart flashed: %q", got)
	}
	svc.completeTranslationProgress(task, "短", "third")
	if got := visible().Text; got != "短" {
		t.Fatalf("normal short completion not revealed: %q", got)
	}
	var completed bool
	for len(watch.queue) > 0 {
		message := (<-watch.queue).data.(map[string]any)
		if message["draftComplete"] == true && message["translation"] == "短" && message["status"] == domain.TranslationPending {
			completed = true
		}
	}
	if !completed {
		t.Fatal("no explicit pending draft completion event")
	}
	segment := domain.Segment{ID: key.segmentID, SessionID: key.sessionID, TranslationStatus: domain.TranslationPending, Final: true}
	projected := svc.presentTranslationProgress(task.target, []domain.Segment{segment})
	if projected[0].Translation != "短" {
		t.Fatalf("late snapshot differs from SSE: %q", projected[0].Translation)
	}
	svc.failTranslationProgress(task)
	if got := visible().Text; got != "" {
		t.Fatalf("failed correction retained invalid text: %q", got)
	}
}

func TestStableTranslationUsesRuneCountNotUTF8Bytes(t *testing.T) {
	previous := "你好😀" // three runes, ten UTF-8 bytes
	if got := stableTranslationText(previous, "新", 3); got != previous {
		t.Fatalf("one rune replaced old: %q", got)
	}
	if got := stableTranslationText(previous, "新的", 3); got != previous {
		t.Fatalf("two runes replaced old: %q", got)
	}
	if got := stableTranslationText(previous, "新的🙂", 3); got != "新的🙂" {
		t.Fatalf("three runes did not replace: %q", got)
	}
	if got := stableTranslationText("hello", "hel", 5); got != "hello" {
		t.Fatalf("same-prefix shrink flashed: %q", got)
	}
	if got := stableTranslationText("hello", "hello!", 5); got != "hello!" {
		t.Fatalf("matching prefix did not append: %q", got)
	}
}

func TestDraftUnsupportedRecognitionModeUsesAutoTranslatorSource(t *testing.T) {
	session := domain.InterpretationSession{SourceLanguage: "nb"}
	task := translationTask{session: session, segment: domain.Segment{SourceText: "Hei", Final: false}}
	source, err := translationSource(task)
	if err != nil || source != "auto" {
		t.Fatalf("unsupported draft source = %q, %v", source, err)
	}
	session.SourceLanguage = "nn"
	task.session = session
	source, err = translationSource(task)
	if err != nil || source != "auto" {
		t.Fatalf("Nynorsk draft source = %q, %v", source, err)
	}
	task.segment.Final = true
	task.segment.DetectedLanguage = "nb"
	source, err = translationSource(task)
	if err != nil || source != "auto" {
		t.Fatalf("final evidence source = %q, %v", source, err)
	}
}
