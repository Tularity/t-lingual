package rooms

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/media"
	"github.com/Tularity/t-lingual/internal/providers"
	"github.com/coder/websocket"
)

func TestRecorderResumeUsesPersistedSilenceDuration(t *testing.T) {
	svc, db, _, session, viewers := roomFixture(t, nil)
	provider := &testASR{opened: make(chan *testASRStream, 2)}
	svc.providers = testProviders{snapshot: providers.Snapshot{ASR: provider}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _ = svc.ServeRecord(w, r, viewers[0], session.ID, false) }))
	defer server.Close()
	record := func(expect int64) {
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
		_, payload, err := conn.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var ready struct {
			Type     string `json:"type"`
			OffsetMS int64  `json:"offsetMs"`
		}
		if err := json.Unmarshal(payload, &ready); err != nil || ready.Type != "ready" || ready.OffsetMS != expect {
			t.Fatalf("ready %s %v, expected %d", payload, err, expect)
		}
		<-provider.opened
		if err := conn.Write(ctx, websocket.MessageBinary, make([]byte, 64000)); err != nil {
			t.Fatal(err)
		}
		// The control message is ordered after the audio on the same WebSocket.
		if err := conn.Write(ctx, websocket.MessageText, []byte(`{"type":"end"}`)); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(3 * time.Second)
		for svc.State(session.ID).Active && time.Now().Before(deadline) {
			time.Sleep(time.Millisecond)
		}
		if svc.State(session.ID).Active {
			t.Fatal("recorder did not stop")
		}
	}
	record(0)
	record(1000)
	manager, err := media.New(db, db.DataRoot())
	if err != nil {
		t.Fatal(err)
	}
	parts, err := manager.List(context.Background(), session.UserID, session.ID)
	if err != nil || len(parts) != 2 || parts[1].StartMS != 1000 || parts[1].DurationMS != 1000 {
		t.Fatalf("persisted runs %#v %v", parts, err)
	}
}
