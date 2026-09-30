package rooms

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/asr"
	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/providers"
	"github.com/Tularity/t-lingual/internal/translate"
	"github.com/coder/websocket"
)

// flakyASR is recognition that can be taken down: while down it is not
// ready and starts nothing, and a stream told to fail drops its connection.
type flakyASR struct {
	down    atomic.Bool
	streams chan *flakyStream
}

func (p *flakyASR) Ready(context.Context) error {
	if p.down.Load() {
		return asr.ErrUnavailable
	}
	return nil
}

func (p *flakyASR) Start(_ context.Context, request asr.StartRequest) (asr.Stream, error) {
	if p.down.Load() {
		return nil, asr.ErrUnavailable
	}
	stream := &flakyStream{request: request, events: make(chan asr.Event, 32)}
	p.streams <- stream
	return stream, nil
}

type flakyStream struct {
	request asr.StartRequest
	events  chan asr.Event
	audio   atomic.Int64
	fail    atomic.Bool
	ended   atomic.Bool
	once    sync.Once
}

func (*flakyStream) Info() asr.StartResponse { return asr.StartResponse{ChunkMS: 160} }
func (s *flakyStream) SendAudio(_ context.Context, audio []byte) error {
	if s.fail.Load() {
		return errors.New("recognition connection lost")
	}
	s.audio.Add(int64(len(audio)))
	return nil
}
func (*flakyStream) ForceEndOfUtterance(context.Context) error { return nil }
func (*flakyStream) Reset(context.Context) error               { return nil }
func (*flakyStream) Ping(context.Context) error                { return nil }
func (s *flakyStream) End(context.Context) error {
	s.ended.Store(true)
	s.once.Do(func() { close(s.events) })
	return nil
}
func (s *flakyStream) Events() <-chan asr.Event        { return s.events }
func (*flakyStream) Wait() error                       { return nil }
func (s *flakyStream) Close(ctx context.Context) error { return s.End(ctx) }

func nextStream(t *testing.T, provider *flakyASR, wait time.Duration) *flakyStream {
	t.Helper()
	select {
	case stream := <-provider.streams:
		return stream
	case <-time.After(wait):
		t.Fatal("recognition stream did not start")
		return nil
	}
}

func eventually(t *testing.T, what string, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	for !check() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestRecordingDoesNotStartWhileRecognitionIsDown(t *testing.T) {
	svc, database, _, session, viewers := roomFixture(t, nil)
	provider := &flakyASR{streams: make(chan *flakyStream, 4)}
	provider.down.Store(true)
	svc.providers = testProviders{snapshot: providers.Snapshot{ASR: provider}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = svc.ServeRecord(w, r, viewers[0], session.ID, false)
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, strings.Replace(server.URL, "http://", "ws://", 1), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"type":"start","audio":{"encoding":"pcm32f","sampleRate":16000,"channels":1}}`)); err != nil {
		t.Fatal(err)
	}
	_, message, err := conn.Read(ctx)
	if err != nil || !strings.Contains(string(message), `"code":"ASR_UNAVAILABLE"`) {
		t.Fatalf("refusal = %s, %v", message, err)
	}
	stored, err := database.GetInterpretationSession(ctx, session.UserID, session.ID)
	if err != nil || stored.Status != domain.InterpretationCreated {
		t.Fatalf("a refused recording claimed the session: %v %v", stored.Status, err)
	}
}

func TestRecognitionOutageKeepsRecordingAndFillsTheGapInPlace(t *testing.T) {
	svc, database, _, session, viewers := roomFixture(t, nil)
	provider := &flakyASR{streams: make(chan *flakyStream, 8)}
	svc.providers = testProviders{snapshot: providers.Snapshot{ASR: provider}}
	svc.noAudioTimeout = 2 * time.Second
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = svc.ServeRecord(w, r, viewers[0], session.ID, false)
	}))
	defer server.Close()
	conn := dialRecorder(t, server.URL)
	defer conn.CloseNow()
	live := nextStream(t, provider, time.Second)
	// Audio at the pace it is spoken, as the recorder's rate limit expects:
	// a sixteenth of a second per packet, four packets a quarter.
	packet := make([]byte, 4000)
	send := func(quarters int) {
		for range quarters * 4 {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			if err := conn.Write(ctx, websocket.MessageBinary, packet); err != nil {
				cancel()
				t.Fatal(err)
			}
			cancel()
			time.Sleep(62 * time.Millisecond)
		}
	}
	send(4)
	live.events <- asr.Event{Type: "final", Text: "before", StartMS: 0, EndMS: 500}
	eventually(t, "the first line", func() bool {
		segments, _ := database.ListSegments(context.Background(), session.UserID, session.ID)
		return len(segments) == 1
	})

	// Recognition goes; the recording does not.
	provider.down.Store(true)
	live.fail.Store(true)
	send(2)
	eventually(t, "recognition to be marked paused", func() bool { return svc.State(session.ID).RecognitionPaused })
	if svc.State(session.ID).RecognitionCatchingUp {
		t.Fatal("recognition going away was told as catching up")
	}
	send(4)
	if !svc.State(session.ID).Active {
		t.Fatal("the recording ended with recognition")
	}

	// Recognition comes back: live recognition resumes, and the gap is kept.
	provider.down.Store(false)
	var resumed *flakyStream
	deadline := time.Now().Add(6 * time.Second)
	for resumed == nil && time.Now().Before(deadline) {
		send(1)
		select {
		case resumed = <-provider.streams:
		default:
		}
	}
	if resumed == nil {
		t.Fatal("recognition was not asked for again")
	}
	var gaps []domain.RecognitionGap
	eventually(t, "the kept gap", func() bool {
		gaps, _ = database.ListRecognitionGaps(context.Background(), session.UserID, session.ID)
		return len(gaps) == 1
	})
	gap := gaps[0]
	if gap.StartMS != 500 || gap.EndMS <= 1000 || gap.SequenceFrom != 2 || gap.SequenceTo < gap.SequenceFrom+gapSpareLines-1 {
		t.Fatalf("gap = %#v", gap)
	}
	if svc.State(session.ID).RecognitionPaused {
		t.Fatal("recognition still marked paused after it resumed")
	}
	resumed.events <- asr.Event{Type: "final", Text: "after", StartMS: 100, EndMS: 400}

	// The gap is filled from the saved audio, in the numbers kept for it.
	backfill := nextStream(t, provider, 5*time.Second)
	if backfill.request.Diarize || backfill.request.AudioSense {
		t.Fatalf("a gap was recognized with speakers or gating: %#v", backfill.request)
	}
	eventually(t, "the saved audio to be sent", func() bool { return backfill.ended.Load() || backfill.audio.Load() > 0 })
	backfill.events <- asr.Event{Type: "final", Text: "during", StartMS: 200, EndMS: 900}
	eventually(t, "the gap to be filled", func() bool {
		gaps, _ = database.ListRecognitionGaps(context.Background(), session.UserID, session.ID)
		return len(gaps) == 1 && gaps[0].State == domain.GapFilled
	})
	if gaps[0].FilledSegments != 1 {
		t.Fatalf("filled gap = %#v", gaps[0])
	}
	segments, err := database.ListSegments(context.Background(), session.UserID, session.ID)
	if err != nil || len(segments) != 3 {
		t.Fatalf("segments = %#v, %v", segments, err)
	}
	// Read in sequence, the lines are in the order they were spoken.
	if segments[0].SourceText != "before" || segments[1].SourceText != "during" || segments[2].SourceText != "after" {
		t.Fatalf("order = %q %q %q", segments[0].SourceText, segments[1].SourceText, segments[2].SourceText)
	}
	if segments[1].Sequence != gap.SequenceFrom || segments[1].StartMS != gap.StartMS+200 || segments[1].SpeakerID != "" {
		t.Fatalf("filled line = %#v", segments[1])
	}
	if segments[2].Sequence <= gap.SequenceTo {
		t.Fatalf("live line %d inside the kept numbers up to %d", segments[2].Sequence, gap.SequenceTo)
	}
}

// flakyTranslator fails while down and translates otherwise.
type flakyTranslator struct {
	down  atomic.Bool
	calls atomic.Int32
}

func (p *flakyTranslator) Ready(context.Context) error {
	if p.down.Load() {
		return translate.ErrUnavailable
	}
	return nil
}
func (p *flakyTranslator) Translate(_ context.Context, request translate.Request) (translate.Response, error) {
	p.calls.Add(1)
	if p.down.Load() {
		return translate.Response{}, translate.ErrUnavailable
	}
	return translate.Response{Translation: "译:" + request.Text, SourceLanguage: request.SourceLanguage, RequestID: "req_retry"}, nil
}

func TestTranslationsThatFailedWhileUnavailableAreAskedForAgain(t *testing.T) {
	translator := &flakyTranslator{}
	svc, database, _, session, _ := roomFixture(t, translator)
	ctx := context.Background()
	past := time.Now().UTC().Add(-time.Hour)
	sequence := int64(0)
	for index, code := range map[string]string{"seg_retry": "translator_unavailable", "seg_final": "source_language_unsupported"} {
		sequence++
		segment := domain.Segment{ID: index, SessionID: session.ID, UserID: session.UserID, Sequence: sequence,
			SourceText: "Hello " + index, Final: true, StartMS: 0, EndMS: 500, CreatedAt: past, DetectedLanguage: "en"}
		if err := database.AppendSegment(ctx, session.UserID, segment); err != nil {
			t.Fatal(err)
		}
		if _, _, err := database.ClaimTranslation(ctx, session.UserID, session.ID, segment.ID, "zh-Hans", past); err != nil {
			t.Fatal(err)
		}
		if _, err := database.FailTranslation(ctx, session.UserID, session.ID, segment.ID, "zh-Hans", code, past); err != nil {
			t.Fatal(err)
		}
	}
	// Not while translation is still unavailable…
	translator.down.Store(true)
	svc.retryTranslations()
	if translator.calls.Load() != 0 {
		t.Fatal("asked again while translation was down")
	}
	// …and once it is back, only what failed for want of it.
	translator.down.Store(false)
	svc.retryTranslations()
	eventually(t, "the retried translation", func() bool {
		record, err := database.GetTranslation(ctx, session.UserID, session.ID, "seg_retry", "zh-Hans")
		return err == nil && record.Status == domain.TranslationSucceeded
	})
	record, err := database.GetTranslation(ctx, session.UserID, session.ID, "seg_final", "zh-Hans")
	if err != nil || record.Status != domain.TranslationFailed || record.Error != "source_language_unsupported" {
		t.Fatalf("a failure of the text was retried: %#v, %v", record, err)
	}
}

func TestAnOwnersRecordingsAtOnceAreLimitedWhoeverRecords(t *testing.T) {
	svc, _, resolver, session, viewers := roomFixture(t, nil)
	lease := func(id uint64, viewer domain.Viewer, sessionID string) *recordLease {
		access := resolver.access[viewer.ID]
		access.Session.ID = sessionID
		ctx, cancel := context.WithCancelCause(context.Background())
		t.Cleanup(func() { cancel(nil) })
		return &recordLease{id: id, viewer: viewer, access: access, ctx: ctx, cancel: cancel, done: make(chan struct{})}
	}
	// A guest recording the owner's first session counts against the owner.
	if _, err := svc.reserveRecorder(lease(1, viewers[1], session.ID), false, false, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.reserveRecorder(lease(2, viewers[0], "session_2"), false, false, 1); !errors.Is(err, ErrRecordingLimit) {
		t.Fatalf("second recording at a limit of one = %v", err)
	}
	if _, err := svc.reserveRecorder(lease(3, viewers[0], "session_2"), false, false, 2); err != nil {
		t.Fatalf("second recording at a limit of two = %v", err)
	}
	if svc.OwnerRecordings(session.UserID) != 2 {
		t.Fatalf("owner recordings = %d", svc.OwnerRecordings(session.UserID))
	}
	// A refusal reaches the browser in words, since it cannot read a status.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = refuseRecording(w, r, "RECORDING_LIMIT", "limit")
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, strings.Replace(server.URL, "http://", "ws://", 1), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if _, message, err := conn.Read(ctx); err != nil || !strings.Contains(string(message), `"code":"RECORDING_LIMIT"`) {
		t.Fatalf("refusal = %s, %v", message, err)
	}
}
