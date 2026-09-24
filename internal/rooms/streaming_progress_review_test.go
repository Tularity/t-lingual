package rooms

import (
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
)

func TestStreamingProgressCoalescesAndNeverProjectsAnotherTarget(t *testing.T) {
	svc, _, resolver, session, viewers := roomFixture(t, nil)
	watches := make([]*watcher, 0, len(viewers))
	for index, viewer := range viewers {
		watch := &watcher{id: uint64(index + 1), viewer: viewer, access: resolver.access[viewer.ID], queue: make(chan roomEvent, 12), cancel: func() {}}
		if _, err := svc.registerWatch(session.ID, watch); err != nil {
			t.Fatal(err)
		}
		watches = append(watches, watch)
		defer svc.releaseWatch(session.ID, watch)
	}
	segment := domain.Segment{ID: "seg_progress", SessionID: session.ID, UserID: session.UserID, Sequence: 1, SourceText: "Hello", TranslationStatus: domain.TranslationPending, Final: true}
	task := translationTask{session: session, segment: segment, target: "zh-Hans"}
	svc.publishTranslationProgress(task, "", "")
	svc.publishTranslationProgress(task, "你", "req-1")
	key := translationKey{sessionID: session.ID, segmentID: segment.ID, target: "zh-Hans"}
	svc.progressMu.Lock()
	current := svc.progress[key]
	current.LastBroadcast = time.Now().Add(time.Minute)
	svc.progress[key] = current
	svc.progressMu.Unlock()
	svc.publishTranslationProgress(task, "你好", "req-1")
	for _, watch := range watches[:2] {
		if len(watch.queue) != 2 {
			t.Fatalf("rapid updates were not coalesced: %d", len(watch.queue))
		}
	}
	if len(watches[2].queue) != 0 {
		t.Fatal("Japanese viewer received Chinese provisional text")
	}
	projected := svc.presentTranslationProgress("zh-Hans", []domain.Segment{segment})
	if projected[0].Translation != "你好" || projected[0].TranslationRevision != 3 {
		t.Fatalf("late viewer did not see latest cumulative text: %#v", projected)
	}
	other := svc.presentTranslationProgress("ja", []domain.Segment{segment})
	if other[0].Translation != "" {
		t.Fatalf("other target saw provisional text: %#v", other)
	}
	svc.progressMu.Lock()
	current = svc.progress[key]
	current.LastBroadcast = time.Now().Add(-time.Second)
	svc.progress[key] = current
	svc.progressMu.Unlock()
	svc.publishTranslationProgress(task, "你好！", "req-1")
	for _, watch := range watches[:2] {
		if len(watch.queue) != 3 {
			t.Fatalf("next cadence was not delivered: %d", len(watch.queue))
		}
		<-watch.queue
		<-watch.queue
		message := (<-watch.queue).data.(map[string]any)
		if message["translation"] != "你好！" || message["revision"] != int64(4) {
			t.Fatalf("coalesced payload = %#v", message)
		}
	}
	if revision := svc.finishProgress(session.ID, segment.ID, "zh-Hans"); revision != 5 {
		t.Fatalf("terminal revision=%d", revision)
	}
	if cleared := svc.presentTranslationProgress("zh-Hans", []domain.Segment{segment}); cleared[0].Translation != "" {
		t.Fatalf("terminal retained provisional bytes: %#v", cleared)
	}
}
