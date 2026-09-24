package rooms

import (
	"bufio"
	"context"
	"encoding/json"
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
	"github.com/coder/websocket"
)

const parityOriginSeconds = 1_700_000_000.0

type parityASR struct {
	requests  chan asr.StartRequest
	opened    chan *parityStream
	tailOnEnd *asr.Event
}

func (*parityASR) Ready(context.Context) error { return nil }
func (*parityASR) Capabilities(context.Context) (asr.Capabilities, error) {
	return asr.Capabilities{SupportedLanguages: []string{"auto", "en-US", "zh-CN"}, AudioSense: true, Diarization: true}, nil
}
func (p *parityASR) Start(_ context.Context, request asr.StartRequest) (asr.Stream, error) {
	stream := &parityStream{events: make(chan asr.Event, 16),
		info:      asr.StartResponse{CreatedAt: parityOriginSeconds, ChunkMS: 80, AudioSense: request.AudioSense, Diarize: request.Diarize},
		tailOnEnd: p.tailOnEnd}
	p.requests <- request
	p.opened <- stream
	return stream, nil
}

type parityStream struct {
	info       asr.StartResponse
	events     chan asr.Event
	tailOnEnd  *asr.Event
	endOnce    sync.Once
	forceCalls atomic.Int32
}

func (s *parityStream) Info() asr.StartResponse                   { return s.info }
func (*parityStream) SendAudio(context.Context, []byte) error     { return nil }
func (s *parityStream) ForceEndOfUtterance(context.Context) error { s.forceCalls.Add(1); return nil }
func (*parityStream) Reset(context.Context) error                 { return nil }
func (*parityStream) Ping(context.Context) error                  { return nil }
func (s *parityStream) End(context.Context) error {
	s.endOnce.Do(func() {
		if s.tailOnEnd != nil {
			s.events <- *s.tailOnEnd
		}
		close(s.events)
	})
	return nil
}
func (s *parityStream) Events() <-chan asr.Event        { return s.events }
func (*parityStream) Wait() error                       { return nil }
func (s *parityStream) Close(ctx context.Context) error { return s.End(ctx) }

func TestASRCapsEnableSenseAndNormalizeOnlyAdvertisedLanguage(t *testing.T) {
	provider := &parityASR{}
	options, err := resolveASRStart(context.Background(), provider, "zh-Hans", true)
	if err != nil || options.language != "zh-CN" || !options.audioSense {
		t.Fatalf("ASR options = %#v, %v", options, err)
	}
	options, err = resolveASRStart(context.Background(), provider, "auto", false)
	if err != nil || options.language != "auto" || !options.audioSense {
		t.Fatalf("auto options = %#v, %v", options, err)
	}
	if _, err := resolveASRStart(context.Background(), provider, "fr", false); err == nil {
		t.Fatal("unadvertised language accepted")
	}
}

func TestSenseUtterancesKeepDistinctDraftsAndUngatedSilenceClock(t *testing.T) {
	svc, database, _, session, viewers := roomFixture(t, nil)
	session.SourceLanguage = "auto"
	session.RecognitionLanguages = []string{"en", "zh-Hans"}
	if err := database.UpdateInterpretationSession(context.Background(), session.UserID, session); err != nil {
		t.Fatal(err)
	}
	provider := &parityASR{requests: make(chan asr.StartRequest, 1), opened: make(chan *parityStream, 1)}
	svc.providers = testProviders{snapshot: providers.Snapshot{ASR: provider}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/record":
			_ = svc.ServeRecord(w, r, viewers[0], session.ID, false)
		case "/watch":
			_ = svc.ServeWatch(w, r, viewers[1], session.ID)
		}
	}))
	defer server.Close()
	watch, err := http.Get(server.URL + "/watch")
	if err != nil {
		t.Fatal(err)
	}
	defer watch.Body.Close()
	scanner := bufio.NewScanner(watch.Body)
	if !scanner.Scan() || !strings.Contains(scanner.Text(), `"type":"snapshot"`) {
		t.Fatal("watcher snapshot missing")
	}
	conn := dialRecorder(t, server.URL+"/record")
	defer conn.CloseNow()
	request := <-provider.requests
	if request.Language != "auto" || !request.AudioSense || len(request.LanguageRegions) != 0 {
		t.Fatalf("recording must use audio sense, not pretend candidate regions: %#v", request)
	}
	stream := <-provider.opened
	origin := int64(parityOriginSeconds * 1000)
	stream.events <- asr.Event{Type: "audio_state", State: "speech", AudioPositionMS: 1_000}
	stream.events <- asr.Event{Type: "partial", Sequence: 1, Text: "Hello"} // Upstream partial has no line field.
	stream.events <- asr.Event{Type: "final", Sequence: 2, Line: 1, Text: "Hello.", StartMS: 0, EndMS: 800,
		Wall0MS: origin + 1_000, Wall1MS: origin + 1_800, Language: "auto"}
	stream.events <- asr.Event{Type: "audio_state", State: "speech", AudioPositionMS: 11_000}
	stream.events <- asr.Event{Type: "partial", Sequence: 3, Text: "Next sentence"}
	stream.events <- asr.Event{Type: "final", Sequence: 4, Line: 2, Text: "Next sentence.", StartMS: 800, EndMS: 1_600,
		Wall0MS: origin + 11_000, Wall1MS: origin + 11_800, Language: "auto"}
	type streamed struct {
		Type      string `json:"type"`
		SegmentID string `json:"segmentId"`
		StartMS   int64  `json:"startMs"`
		Segment   struct {
			ID               string `json:"id"`
			Sequence         int64  `json:"sequence"`
			SourceRevision   int    `json:"sourceRevision"`
			DetectedLanguage string `json:"detectedLanguage"`
			LanguageSource   string `json:"languageSource"`
		} `json:"segment"`
	}
	seen := make(chan []streamed, 1)
	go func() {
		items := make([]streamed, 0, 4)
		for scanner.Scan() {
			line := scanner.Text()
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			var ev streamed
			if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &ev) != nil {
				continue
			}
			if ev.Type == "partial" || ev.Type == "final" {
				items = append(items, ev)
			}
			if len(items) == 4 {
				seen <- items
				return
			}
		}
		seen <- items
	}()
	var events []streamed
	select {
	case events = <-seen:
	case <-time.After(2 * time.Second):
		t.Fatal("missing two utterances")
	}
	if len(events) != 4 || events[0].Type != "partial" || events[1].Type != "final" || events[2].Type != "partial" || events[3].Type != "final" ||
		events[0].SegmentID != events[1].Segment.ID || events[2].SegmentID != events[3].Segment.ID || events[0].SegmentID == events[2].SegmentID ||
		events[0].StartMS != 1_000 || events[2].StartMS != 11_000 || events[1].Segment.Sequence != 1 || events[3].Segment.Sequence != 2 ||
		events[1].Segment.SourceRevision < 2 || events[3].Segment.SourceRevision < 2 ||
		events[1].Segment.LanguageSource != "text" || events[3].Segment.LanguageSource != "text" {
		t.Fatalf("utterance continuity = %#v", events)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"type":"end"}`)); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for svc.State(session.ID).Active && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if svc.State(session.ID).Active {
		t.Fatal("session did not stop")
	}
	segments, err := database.ListSegments(context.Background(), session.UserID, session.ID)
	if err != nil || len(segments) != 2 {
		t.Fatalf("persisted segments = %#v, %v", segments, err)
	}
	if segments[0].StartMS != 1_000 || segments[0].EndMS != 1_800 || segments[1].StartMS != 11_000 || segments[1].EndMS != 11_800 ||
		segments[0].DetectedLanguage != "en" || segments[1].DetectedLanguage != "en" ||
		segments[0].LanguageSource != "text" || segments[1].LanguageSource != "text" {
		t.Fatalf("silence compressed or text routing mislabeled as recognizer: %#v", segments)
	}
}

func TestOwnerStopDrainsDelayedFinalBeforeSaving(t *testing.T) {
	svc, database, _, session, viewers := roomFixture(t, nil)
	provider := &parityASR{requests: make(chan asr.StartRequest, 1), opened: make(chan *parityStream, 1),
		tailOnEnd: &asr.Event{Type: "final", Sequence: 1, Line: 1, Text: "Last phrase.", StartMS: 0, EndMS: 700, Language: "en"}}
	svc.providers = testProviders{snapshot: providers.Snapshot{ASR: provider}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = svc.ServeRecord(w, r, viewers[0], session.ID, false)
	}))
	defer server.Close()
	conn := dialRecorder(t, server.URL)
	defer conn.CloseNow()
	stream := <-provider.opened
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	if err := svc.StopRecorder(ctx, viewers[0], session.ID); err != nil {
		t.Fatal(err)
	}
	segments, err := database.ListSegments(context.Background(), session.UserID, session.ID)
	if err != nil || len(segments) != 1 || segments[0].SourceText != "Last phrase." || stream.forceCalls.Load() < 1 {
		t.Fatalf("owner stop lost tail final: %#v, force=%d, err=%v", segments, stream.forceCalls.Load(), err)
	}
	saved, err := database.GetInterpretationSession(context.Background(), session.UserID, session.ID)
	if err != nil || saved.Status != domain.InterpretationCompleted {
		t.Fatalf("saved status=%s, %v", saved.Status, err)
	}
}

func TestSourceTimelineFallbackAndLanguageEvidence(t *testing.T) {
	info := asr.StartResponse{CreatedAt: parityOriginSeconds}
	origin := int64(parityOriginSeconds * 1000)
	start, end := sourceTimelineRange(asr.Event{StartMS: 20, EndMS: 820, Wall0MS: origin + 10_000, Wall1MS: origin + 10_800}, info, 4_000)
	if start != 14_000 || end != 14_800 {
		t.Fatalf("ungated range=%d..%d", start, end)
	}
	start, end = sourceTimelineRange(asr.Event{StartMS: 20, EndMS: 820}, info, 4_000)
	if start != 4_020 || end != 4_820 {
		t.Fatalf("old provider fallback=%d..%d", start, end)
	}
	if observedLanguage("auto", "auto") != "" || observedLanguage("en", "en-US") != "" || observedLanguage("auto", "en-US") != "en-US" {
		t.Fatal("configured mode was conflated with genuine model language metadata")
	}
}

func TestCaptionForceRequiresActiveSpeechAndMeaningfulLongDraft(t *testing.T) {
	draft := &draftLine{firstWallMS: 1_000}
	long := asr.Event{Type: "partial", WallMS: 9_001, Text: "我们现在正在讨论下一个重要会议事项请大家注意"}
	if !shouldForceCaption(draft, long, "speech") {
		t.Fatal("long active draft did not qualify")
	}
	if shouldForceCaption(draft, long, "silence") {
		t.Fatal("silence triggered force")
	}
	if shouldForceCaption(draft, asr.Event{WallMS: 9_001, Text: "嗯"}, "speech") {
		t.Fatal("short noise triggered force")
	}
	if shouldForceCaption(draft, asr.Event{WallMS: 8_999, Text: long.Text}, "speech") {
		t.Fatal("draft below eight seconds triggered force")
	}
	draft.forced = true
	if shouldForceCaption(draft, long, "speech") {
		t.Fatal("same draft forced twice")
	}
}

func TestCaptionForceOnceDuringLongSpeechWithoutReset(t *testing.T) {
	svc, database, _, session, viewers := roomFixture(t, nil)
	session.SourceLanguage = "auto"
	session.RecognitionLanguages = []string{"en", "zh-Hans"}
	if err := database.UpdateInterpretationSession(context.Background(), session.UserID, session); err != nil {
		t.Fatal(err)
	}
	provider := &parityASR{requests: make(chan asr.StartRequest, 1), opened: make(chan *parityStream, 1)}
	svc.providers = testProviders{snapshot: providers.Snapshot{ASR: provider}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = svc.ServeRecord(w, r, viewers[0], session.ID, false)
	}))
	defer server.Close()
	conn := dialRecorder(t, server.URL)
	defer conn.CloseNow()
	stream := <-provider.opened
	origin := int64(parityOriginSeconds * 1000)
	stream.events <- asr.Event{Type: "audio_state", State: "speech", AudioPositionMS: 1_000}
	stream.events <- asr.Event{Type: "partial", Sequence: 1, WallMS: origin + 1_000, Text: "我们现在讨论"}
	stream.events <- asr.Event{Type: "partial", Sequence: 2, WallMS: origin + 9_100, Text: "我们现在正在讨论下一个重要会议事项请大家注意"}
	deadline := time.Now().Add(time.Second)
	for stream.forceCalls.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if stream.forceCalls.Load() != 1 {
		t.Fatalf("long draft forces=%d", stream.forceCalls.Load())
	}
	stream.events <- asr.Event{Type: "partial", Sequence: 3, WallMS: origin + 10_500, Text: "我们现在正在讨论下一个重要会议事项请大家注意新的观点"}
	stream.events <- asr.Event{Type: "audio_state", State: "silence", AudioPositionMS: 11_000}
	stream.events <- asr.Event{Type: "partial", Sequence: 4, WallMS: origin + 20_000, Text: "我们现在正在讨论下一个重要会议事项请大家注意新的观点和决定"}
	stream.events <- asr.Event{Type: "final", Sequence: 5, Line: 1, Text: "我们现在正在讨论下一个重要会议事项。", StartMS: 0, EndMS: 9_000,
		Wall0MS: origin + 1_000, Wall1MS: origin + 10_000, Language: "auto"}
	deadline = time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		segments, err := database.ListSegments(context.Background(), session.UserID, session.ID)
		if err == nil && len(segments) == 1 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if stream.forceCalls.Load() != 1 {
		t.Fatalf("same draft or silence retriggered force: %d", stream.forceCalls.Load())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"type":"end"}`)); err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(3 * time.Second)
	for svc.State(session.ID).Active && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if svc.State(session.ID).Active {
		t.Fatal("recording did not finish")
	}
}

func TestSpeakerDominanceIgnoresTinyBoundaryOverlapAndMergesSameSpeakerSpans(t *testing.T) {
	const start, end = int64(1_000), int64(5_000)
	spans := []speakerSpan{
		{id: "speaker_2", wall0MS: 1_000, wall1MS: 4_300},
		{id: "speaker_3", wall0MS: 4_300, wall1MS: 4_600},
	}
	if got, decisive := speakerDecision(start, end, spans); got != "speaker_2" || !decisive {
		t.Fatalf("tiny adjacent interval stole previous line: %q, decisive=%t", got, decisive)
	}
	if got, decisive := speakerDecision(start, end, spans[1:]); got != "" || decisive {
		t.Fatalf("tiny isolated overlap incorrectly displaced established speaker: %q, decisive=%t", got, decisive)
	}
	spans = append(spans, speakerSpan{id: "speaker_3", wall0MS: 1_100, wall1MS: 4_900})
	if got, decisive := speakerDecision(start, end, spans); got != "speaker_3" || !decisive {
		t.Fatalf("dominant late correction was ignored: %q, decisive=%t", got, decisive)
	}
	if got, decisive := speakerDecision(start, end, []speakerSpan{
		{id: "speaker_2", wall0MS: 1_000, wall1MS: 3_000},
		{id: "speaker_3", wall0MS: 3_000, wall1MS: 5_000},
	}); got != "" || !decisive {
		t.Fatalf("equal substantial coverage should clear attribution: %q, decisive=%t", got, decisive)
	}
	// Overlapping intervals from the same speaker are a union, not an
	// inflated sum that can defeat a genuinely stronger competing speaker.
	if got, decisive := speakerDecision(start, end, []speakerSpan{
		{id: "speaker_2", wall0MS: 1_000, wall1MS: 3_000},
		{id: "speaker_2", wall0MS: 2_000, wall1MS: 4_000},
		{id: "speaker_3", wall0MS: 1_200, wall1MS: 4_700},
	}); got != "speaker_3" || !decisive {
		t.Fatalf("overlapping spans double-counted: %q, decisive=%t", got, decisive)
	}
}

func TestLateSpeakerEventsDoNotStealAdjacentFinalButCanCorrectDominantRow(t *testing.T) {
	svc, database, _, session, viewers := roomFixture(t, nil)
	provider := &parityASR{requests: make(chan asr.StartRequest, 1), opened: make(chan *parityStream, 1)}
	svc.providers = testProviders{snapshot: providers.Snapshot{ASR: provider}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = svc.ServeRecord(w, r, viewers[0], session.ID, false)
	}))
	defer server.Close()
	conn := dialRecorder(t, server.URL)
	defer conn.CloseNow()
	stream := <-provider.opened
	origin := int64(parityOriginSeconds * 1000)
	first, next := 1, 2 // Upstream zero-based IDs become speaker_2 and speaker_3.
	stream.events <- asr.Event{Type: "speaker", Speaker: &first, Wall0MS: origin + 1_000, Wall1MS: origin + 4_200}
	stream.events <- asr.Event{Type: "final", Line: 1, Text: "First turn", StartMS: 0, EndMS: 4_000,
		Wall0MS: origin + 1_000, Wall1MS: origin + 5_000, Language: "en"}
	stream.events <- asr.Event{Type: "speaker", Speaker: &next, Wall0MS: origin + 4_900, Wall1MS: origin + 5_100}
	stream.events <- asr.Event{Type: "final", Line: 2, Text: "Second turn", StartMS: 4_000, EndMS: 6_900,
		Wall0MS: origin + 5_100, Wall1MS: origin + 8_000, Language: "en", Speaker: &next}
	deadline := time.Now().Add(2 * time.Second)
	var rows []domain.Segment
	for time.Now().Before(deadline) {
		var err error
		rows, err = database.ListSegments(context.Background(), session.UserID, session.ID)
		if err == nil && len(rows) == 2 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if len(rows) != 2 || rows[0].SpeakerID != "speaker_2" || rows[1].SpeakerID != "speaker_3" {
		t.Fatalf("tiny adjacent late interval stole earlier final: %#v", rows)
	}
	stream.events <- asr.Event{Type: "speaker", Speaker: &next, Wall0MS: origin + 1_100, Wall1MS: origin + 4_900}
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		rows, _ = database.ListSegments(context.Background(), session.UserID, session.ID)
		if len(rows) == 2 && rows[0].SpeakerID == "speaker_3" {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if len(rows) != 2 || rows[0].SpeakerID != "speaker_3" || rows[1].SpeakerID != "speaker_3" {
		t.Fatalf("dominant late speaker did not correct only its row: %#v", rows)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"type":"end"}`)); err != nil {
		t.Fatal(err)
	}
}
