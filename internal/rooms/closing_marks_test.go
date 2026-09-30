package rooms

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/asr"
	"github.com/Tularity/t-lingual/internal/providers"
	"github.com/coder/websocket"
)

func TestSplitLeadingMark(t *testing.T) {
	for _, item := range []struct{ text, mark, rest string }{
		{"， 我翻你个发你个链接吧", "，", "我翻你个发你个链接吧"},
		{"。 R 切方", "。", "R 切方"},
		{"？！好", "？！", "好"},
		{". Next one", ".", "Next one"},
		{"No mark", "", "No mark"},
		{"。", "。", ""},
		{"  ，  ", "，", ""},
	} {
		mark, rest := splitLeadingMark(item.text)
		if mark != item.mark || rest != item.rest {
			t.Fatalf("split %q = %q, %q; want %q, %q", item.text, mark, rest, item.mark, item.rest)
		}
	}
	if !endsWithMark("好的。") || !endsWithMark("Done? ") || endsWithMark("还没有") || endsWithMark("") {
		t.Fatal("endsWithMark misread a line's end")
	}
}

// The recognizer sends the mark that ends a line at the start of the next
// one; it is given back to the line it ends, and a line never begins with it.
func TestClosingMarkReturnsToTheLineItEnds(t *testing.T) {
	svc, database, _, session, viewers := roomFixture(t, nil)
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
	<-provider.requests
	stream := <-provider.opened
	stream.events <- asr.Event{Type: "final", Sequence: 1, Line: 1, Text: "你就看我那个吧", StartMS: 0, EndMS: 800}
	stream.events <- asr.Event{Type: "partial", Sequence: 2, Text: "。是啥意思"}
	stream.events <- asr.Event{Type: "final", Sequence: 3, Line: 2, Text: "。是啥意思吧？", StartMS: 800, EndMS: 1_600}
	// A line that already ends keeps its own mark; a lone mark is no line.
	stream.events <- asr.Event{Type: "final", Sequence: 4, Line: 3, Text: "， 不", StartMS: 1_600, EndMS: 2_000}
	stream.events <- asr.Event{Type: "final", Sequence: 5, Line: 4, Text: "。", StartMS: 2_000, EndMS: 2_100}

	type streamed struct {
		Type       string `json:"type"`
		Text       string `json:"text"`
		SegmentID  string `json:"segmentId"`
		SourceText string `json:"sourceText"`
		Segment    struct {
			ID         string `json:"id"`
			SourceText string `json:"sourceText"`
		} `json:"segment"`
	}
	seen := make(chan []streamed, 1)
	go func() {
		items := make([]streamed, 0, 8)
		for scanner.Scan() {
			var event streamed
			line := scanner.Text()
			if !strings.HasPrefix(line, "data: ") || json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event) != nil {
				continue
			}
			if event.Type == "partial" || event.Type == "final" || event.Type == "source_text" {
				items = append(items, event)
			}
			if len(items) == 6 {
				break
			}
		}
		seen <- items
	}()
	var events []streamed
	select {
	case events = <-seen:
	case <-time.After(3 * time.Second):
		t.Fatal("missing recognition events")
	}
	if len(events) != 6 || events[0].Type != "final" || events[1].Type != "partial" || events[1].Text != "是啥意思" ||
		events[2].Type != "source_text" || events[2].SegmentID != events[0].Segment.ID || events[2].SourceText != "你就看我那个吧。" ||
		events[3].Type != "final" || events[3].Segment.SourceText != "是啥意思吧？" ||
		events[4].Type != "final" || events[4].Segment.SourceText != "不" ||
		events[5].Type != "source_text" || events[5].SourceText != "不。" {
		t.Fatalf("closing marks = %#v", events)
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
	segments, err := database.ListSegments(context.Background(), session.UserID, session.ID)
	if err != nil || len(segments) != 3 || segments[0].SourceText != "你就看我那个吧。" || segments[1].SourceText != "是啥意思吧？" ||
		segments[2].SourceText != "不。" {
		t.Fatalf("saved lines = %#v, %v", segments, err)
	}
	held, err := database.AccountStorageOf(context.Background(), session.UserID)
	if err != nil {
		t.Fatal(err)
	}
	var bytes int64
	for _, segment := range segments {
		bytes += int64(len(segment.SourceText) + len(segment.Translation))
	}
	if held.TranscriptBytes != bytes {
		t.Fatalf("transcript size %d, lines hold %d", held.TranscriptBytes, bytes)
	}
}
