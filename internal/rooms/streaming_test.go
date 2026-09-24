package rooms

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/store"
	"github.com/Tularity/t-lingual/internal/translate"
)

type progressiveTranslator struct {
	calls   atomic.Int32
	emitted chan struct{}
	finish  chan struct{}
	once    sync.Once
	fail    bool
}

func (*progressiveTranslator) Ready(context.Context) error { return nil }
func (*progressiveTranslator) Translate(context.Context, translate.Request) (translate.Response, error) {
	return translate.Response{}, errors.New("synchronous path must not be used")
}
func (p *progressiveTranslator) TranslateStream(ctx context.Context, request translate.Request, emit func(translate.StreamUpdate) error) (translate.Response, error) {
	p.calls.Add(1)
	if err := emit(translate.StreamUpdate{RequestID: "req-stream", Index: 1, Text: "Provisional"}); err != nil {
		return translate.Response{}, err
	}
	p.once.Do(func() { close(p.emitted) })
	select {
	case <-ctx.Done():
		return translate.Response{}, ctx.Err()
	case <-p.finish:
	}
	if p.fail {
		return translate.Response{}, &translate.ProviderError{Code: "output_validation_failed", RequestID: "req-stream", StatusCode: 422}
	}
	return translate.Response{Translation: "Validated result", SourceLanguage: "en", TargetLanguage: request.TargetLanguage, RequestID: "req-stream"}, nil
}

func TestStreamingTranslationFanoutDoesNotPersistDraftAndDeduplicatesLateViewers(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "complete", true: "rejected"}[fail], func(t *testing.T) {
			provider := &progressiveTranslator{emitted: make(chan struct{}), finish: make(chan struct{}), fail: fail}
			svc, database, resolver, session, viewers := roomFixture(t, provider)
			segment := domain.Segment{ID: "seg_stream", SessionID: session.ID, UserID: session.UserID, Sequence: 1, SourceText: "Hello",
				DetectedLanguage: "en", LanguageSource: "session", TranslationStatus: domain.TranslationNotRequested,
				Final: true, CreatedAt: time.Now().UTC()}
			if err := database.AppendSegment(context.Background(), session.UserID, segment); err != nil {
				t.Fatal(err)
			}
			watches := make([]*watcher, 0, len(viewers))
			for i, viewer := range viewers {
				watch := &watcher{id: uint64(i + 1), viewer: viewer, access: resolver.access[viewer.ID], queue: make(chan roomEvent, 10), cancel: func() {}}
				if _, err := svc.registerWatch(session.ID, watch); err != nil {
					t.Fatal(err)
				}
				watches = append(watches, watch)
				defer svc.releaseWatch(session.ID, watch)
			}
			query := store.SegmentPageQuery{Mode: store.SegmentPageTail, Limit: 10}
			if _, err := svc.SegmentWindow(context.Background(), viewers[0], session.ID, query); err != nil {
				t.Fatal(err)
			}
			select {
			case <-provider.emitted:
			case <-time.After(2 * time.Second):
				t.Fatal("no streamed output")
			}
			saved, err := database.GetTranslation(context.Background(), session.UserID, session.ID, segment.ID, "zh-Hans")
			if err != nil || saved.Text != "" || saved.Status != domain.TranslationPending {
				t.Fatalf("provisional text persisted: %#v %v", saved, err)
			}
			projected, err := svc.SegmentWindow(context.Background(), viewers[1], session.ID, query)
			if err != nil || len(projected.Items) != 1 || projected.Items[0].Translation != "Provisional" {
				t.Fatalf("late viewer: %#v %v", projected, err)
			}
			if provider.calls.Load() != 1 {
				t.Fatal("same-language viewer restarted translator")
			}
			for _, watch := range watches[:2] {
				found := false
				for len(watch.queue) > 0 {
					event := (<-watch.queue).data.(map[string]any)
					if event["translation"] == "Provisional" {
						found = true
					}
				}
				if !found {
					t.Fatal("matching viewer missed streamed text")
				}
			}
			if len(watches[2].queue) != 0 {
				t.Fatal("different-language viewer received provisional text")
			}
			close(provider.finish)
			want := domain.TranslationSucceeded
			if fail {
				want = domain.TranslationFailed
			}
			deadline := time.Now().Add(2 * time.Second)
			for time.Now().Before(deadline) {
				saved, err = database.GetTranslation(context.Background(), session.UserID, session.ID, segment.ID, "zh-Hans")
				if err == nil && saved.Status == want {
					break
				}
				time.Sleep(time.Millisecond)
			}
			if err != nil || saved.Status != want {
				t.Fatalf("terminal result: %#v %v", saved, err)
			}
			if fail && saved.Text != "" {
				t.Fatal("rejected draft remained stored")
			}
			if !fail && saved.Text != "Validated result" {
				t.Fatal("complete did not replace provisional text")
			}
			final, err := svc.SegmentWindow(context.Background(), viewers[0], session.ID, query)
			if err != nil || final.Items[0].Translation != saved.Text {
				t.Fatalf("terminal projection: %#v %v", final, err)
			}
			if provider.calls.Load() != 1 {
				t.Fatal("terminal query restarted translation")
			}
		})
	}
}
