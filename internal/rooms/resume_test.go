package rooms

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/media"
	"github.com/Tularity/t-lingual/internal/providers"
	"github.com/coder/websocket"
)

// openRecorder dials a recording connection and says hello, returning the
// connection and the first message the server answers with.
func openRecorder(t *testing.T, url string) (*websocket.Conn, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, response, err := websocket.Dial(ctx, strings.Replace(url, "http://", "ws://", 1), nil)
	if err != nil {
		status := 0
		if response != nil {
			status = response.StatusCode
		}
		return nil, "refused " + http.StatusText(status)
	}
	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"type":"start","audio":{"encoding":"pcm32f","sampleRate":16000,"channels":1}}`)); err != nil {
		t.Fatal(err)
	}
	_, message, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return conn, string(message)
}

func recordingServer(t *testing.T, svc *Service, viewers map[string]domain.Viewer, sessionID string) *httptest.Server {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = svc.ServeRecord(w, r, viewers[strings.TrimPrefix(r.URL.Path, "/")], sessionID, false)
	}))
	t.Cleanup(server.Close)
	return server
}

func writeAudio(t *testing.T, conn *websocket.Conn, packets int, paced bool) {
	t.Helper()
	packet := make([]byte, 4000) // a sixteenth of a second at 16 kHz
	for range packets {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		err := conn.Write(ctx, websocket.MessageBinary, packet)
		cancel()
		if err != nil {
			t.Fatal(err)
		}
		if paced {
			time.Sleep(62 * time.Millisecond)
		}
	}
}

// A recorder whose connection dropped comes back from the same browser: it
// replaces its own stale connection, sends what it kept faster than speech,
// and recognition resumes where speech is now while what was kept is left
// for later recognition.
func TestAReturningRecorderReplacesItsStaleConnectionAndCatchesUp(t *testing.T) {
	svc, database, resolver, session, viewers := roomFixture(t, nil)
	provider := &flakyASR{streams: make(chan *flakyStream, 8)}
	svc.providers = testProviders{snapshot: providers.Snapshot{ASR: provider}}
	svc.noAudioTimeout = 20 * time.Second
	other := viewers[1]
	access := resolver.access[other.ID]
	access.Permission = domain.ShareRecord
	resolver.access[other.ID] = access
	server := recordingServer(t, svc, map[string]domain.Viewer{"owner": viewers[0], "other": other}, session.ID)

	first, ready := openRecorder(t, server.URL+"/owner")
	if !strings.Contains(ready, `"type":"ready"`) {
		t.Fatalf("first ready = %s", ready)
	}
	defer first.CloseNow()
	nextStream(t, provider, time.Second)
	writeAudio(t, first, 16, true) // one second
	// The connection goes quiet without closing, as a cut network does.

	// Someone else cannot come back into it, even asking to resume.
	if conn, answer := openRecorder(t, server.URL+"/other?resume=true"); !strings.Contains(answer, "Conflict") {
		if conn != nil {
			conn.CloseNow()
		}
		t.Fatalf("another recorder resumed into the recording: %s", answer)
	}
	// Without resuming, the same browser is refused as before.
	if conn, answer := openRecorder(t, server.URL+"/owner"); !strings.Contains(answer, "Conflict") {
		if conn != nil {
			conn.CloseNow()
		}
		t.Fatalf("a second connection took the recording without resuming: %s", answer)
	}

	second, ready := openRecorder(t, server.URL+"/owner?resume=true")
	if !strings.Contains(ready, `"type":"ready"`) || !strings.Contains(ready, `"offsetMs":1000`) {
		t.Fatalf("resumed ready = %s", ready)
	}
	defer second.CloseNow()
	nextStream(t, provider, time.Second)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := second.Write(ctx, websocket.MessageText, []byte(`{"type":"catch_up","ms":25000}`)); err != nil {
		t.Fatal(err)
	}
	writeAudio(t, second, 400, false) // twenty-five seconds, all at once
	eventually(t, "recognition to pause for the catch-up", func() bool { return svc.State(session.ID).RecognitionPaused })
	// Said as catching up, not as recognition going away.
	if !svc.State(session.ID).RecognitionCatchingUp {
		t.Fatal("a catch-up was told as recognition being unavailable")
	}
	// Then speech goes on at its own pace, and recognition comes back to it.
	var resumed *flakyStream
	deadline := time.Now().Add(6 * time.Second)
	for resumed == nil && time.Now().Before(deadline) {
		writeAudio(t, second, 4, true)
		select {
		case resumed = <-provider.streams:
		default:
		}
	}
	if resumed == nil {
		t.Fatal("recognition did not resume after the catch-up")
	}
	gaps, err := database.ListRecognitionGaps(context.Background(), session.UserID, session.ID)
	if err != nil || len(gaps) != 1 || gaps[0].StartMS != 1000 || gaps[0].EndMS < 26000 {
		t.Fatalf("kept for later recognition = %#v, %v", gaps, err)
	}
	if !svc.State(session.ID).Active {
		t.Fatal("the recording ended")
	}
	manager, err := media.New(database, database.DataRoot())
	if err != nil {
		t.Fatal(err)
	}
	if saved, err := manager.DurationMS(context.Background(), session.UserID, session.ID); err != nil || saved < 26000 {
		t.Fatalf("saved audio = %d ms, %v", saved, err)
	}
}

// Without announcing a catch-up, audio faster than speech is still refused.
func TestAudioFasterThanSpeechWithoutACatchUpEndsTheRecording(t *testing.T) {
	svc, _, _, session, viewers := roomFixture(t, nil)
	provider := &flakyASR{streams: make(chan *flakyStream, 4)}
	svc.providers = testProviders{snapshot: providers.Snapshot{ASR: provider}}
	server := recordingServer(t, svc, map[string]domain.Viewer{"owner": viewers[0]}, session.ID)
	conn, ready := openRecorder(t, server.URL+"/owner")
	if !strings.Contains(ready, `"type":"ready"`) {
		t.Fatalf("ready = %s", ready)
	}
	defer conn.CloseNow()
	nextStream(t, provider, time.Second)
	packet := make([]byte, 4000)
	for range 80 {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		err := conn.Write(ctx, websocket.MessageBinary, packet)
		cancel()
		if err != nil {
			break
		}
	}
	eventually(t, "the recording to end", func() bool { return !svc.State(session.ID).Active })
}

// A recorder that comes back while recognition is away goes on recording,
// and recognition picks up once it returns.
func TestAResumedRecordingGoesOnWhileRecognitionIsAway(t *testing.T) {
	svc, database, _, session, viewers := roomFixture(t, nil)
	provider := &flakyASR{streams: make(chan *flakyStream, 8)}
	provider.down.Store(true)
	svc.providers = testProviders{snapshot: providers.Snapshot{ASR: provider}}
	server := recordingServer(t, svc, map[string]domain.Viewer{"owner": viewers[0]}, session.ID)

	// A new recording still waits for recognition.
	if conn, answer := openRecorder(t, server.URL+"/owner"); !strings.Contains(answer, "ASR_UNAVAILABLE") {
		if conn != nil {
			conn.CloseNow()
		}
		t.Fatalf("new recording without recognition = %s", answer)
	}
	conn, ready := openRecorder(t, server.URL+"/owner?resume=true")
	if !strings.Contains(ready, `"type":"ready"`) {
		t.Fatalf("resumed without recognition = %s", ready)
	}
	defer conn.CloseNow()
	writeAudio(t, conn, 16, true)
	if state := svc.State(session.ID); !state.Active || !state.RecognitionPaused {
		t.Fatalf("state while recognition is away = %#v", state)
	}
	provider.down.Store(false)
	var resumed *flakyStream
	deadline := time.Now().Add(6 * time.Second)
	for resumed == nil && time.Now().Before(deadline) {
		writeAudio(t, conn, 4, true)
		select {
		case resumed = <-provider.streams:
		default:
		}
	}
	if resumed == nil {
		t.Fatal("recognition was not asked for again")
	}
	eventually(t, "the kept gap", func() bool {
		gaps, _ := database.ListRecognitionGaps(context.Background(), session.UserID, session.ID)
		return len(gaps) == 1 && gaps[0].StartMS == 0 && gaps[0].EndMS >= 1000
	})
}
