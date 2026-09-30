package rooms

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/media"
	"github.com/Tularity/t-lingual/internal/providers"
	"github.com/coder/websocket"
)

// sessionResolver answers for more than one session: the base resolver's
// access, with the session asked for.
type sessionResolver struct {
	base     AccessResolver
	sessions map[string]domain.InterpretationSession
}

func (r sessionResolver) Resolve(ctx context.Context, viewer domain.Viewer, sessionID string) (domain.SessionAccess, error) {
	access, err := r.base.Resolve(ctx, viewer, sessionID)
	if session, ok := r.sessions[sessionID]; ok && err == nil {
		access.Session = session
	}
	return access, err
}

func sendControl(t *testing.T, conn *websocket.Conn, control string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, []byte(control)); err != nil {
		t.Fatal(err)
	}
}

// A connection that drops is not the end of the recording: the browser comes
// back to the same run, whose recognition stream never stopped, and the
// audio and its lines go on as one.
func TestADroppedConnectionGoesOnWithTheSameRunAndRecognition(t *testing.T) {
	svc, database, _, session, viewers := roomFixture(t, nil)
	provider := &flakyASR{streams: make(chan *flakyStream, 8)}
	svc.providers = testProviders{snapshot: providers.Snapshot{ASR: provider}}
	svc.reattachGrace = 5 * time.Second
	server := recordingServer(t, svc, map[string]domain.Viewer{"owner": viewers[0]}, session.ID)

	first, ready := openRecorder(t, server.URL+"/owner")
	if !strings.Contains(ready, `"type":"ready"`) {
		t.Fatalf("first ready = %s", ready)
	}
	stream := nextStream(t, provider, time.Second)
	writeAudio(t, first, 16, true) // one second
	eventually(t, "the audio to reach recognition", func() bool { return stream.audio.Load() >= 60000 })
	_ = first.CloseNow() // the network goes

	eventually(t, "the run to wait for its recorder", func() bool {
		svc.mu.Lock()
		defer svc.mu.Unlock()
		room := svc.rooms[session.ID]
		return room != nil && room.recorder != nil && room.recorder.detached.Load()
	})
	if !svc.State(session.ID).Active {
		t.Fatal("the recording ended with its connection")
	}
	second, ready := openRecorder(t, server.URL+"/owner?resume=true")
	if !strings.Contains(ready, `"type":"ready"`) || !strings.Contains(ready, `"offsetMs":1000`) {
		t.Fatalf("resumed ready = %s", ready)
	}
	defer second.CloseNow()
	sendControl(t, second, `{"type":"catch_up","ms":2000}`)
	writeAudio(t, second, 32, false) // two seconds kept by the browser, sent at once
	writeAudio(t, second, 16, true)
	select {
	case again := <-provider.streams:
		t.Fatalf("recognition was started again: %v", again.request)
	default:
	}
	// Everything reached the same stream, as one recording.
	eventually(t, "all the audio to reach the same recognition", func() bool { return stream.audio.Load() >= 4*64000-10240 })
	if gaps, err := database.ListRecognitionGaps(context.Background(), session.UserID, session.ID); err != nil || len(gaps) != 0 {
		t.Fatalf("gaps = %#v, %v", gaps, err)
	}
	sendControl(t, second, `{"type":"end"}`)
	eventually(t, "the recording to end", func() bool { return !svc.State(session.ID).Active })
	manager, err := media.New(database, database.DataRoot())
	if err != nil {
		t.Fatal(err)
	}
	if saved, err := manager.DurationMS(context.Background(), session.UserID, session.ID); err != nil || saved != 4000 {
		t.Fatalf("saved audio = %d ms, %v", saved, err)
	}
	stored, err := database.GetInterpretationSession(context.Background(), session.UserID, session.ID)
	if err != nil || stored.Status != domain.InterpretationCompleted {
		t.Fatalf("status = %v, %v", stored.Status, err)
	}
}

// Audio the network held up arrives all at once, and is taken: it is late,
// not faster than speech.
func TestAudioHeldUpByTheNetworkArrivesLateWithoutEndingTheRecording(t *testing.T) {
	svc, database, _, session, viewers := roomFixture(t, nil)
	provider := &flakyASR{streams: make(chan *flakyStream, 8)}
	svc.providers = testProviders{snapshot: providers.Snapshot{ASR: provider}}
	svc.reattachGrace = 5 * time.Second
	server := recordingServer(t, svc, map[string]domain.Viewer{"owner": viewers[0]}, session.ID)
	conn, ready := openRecorder(t, server.URL+"/owner")
	if !strings.Contains(ready, `"type":"ready"`) {
		t.Fatalf("ready = %s", ready)
	}
	defer conn.CloseNow()
	nextStream(t, provider, time.Second)
	writeAudio(t, conn, 16, true)  // one second as it is spoken
	time.Sleep(4 * time.Second)    // the network holds the next four
	writeAudio(t, conn, 64, false) // and lets them go at once
	writeAudio(t, conn, 8, true)
	if !svc.State(session.ID).Active {
		t.Fatal("audio the network held up ended the recording")
	}
	sendControl(t, conn, `{"type":"end"}`)
	eventually(t, "the recording to end", func() bool { return !svc.State(session.ID).Active })
	manager, err := media.New(database, database.DataRoot())
	if err != nil {
		t.Fatal(err)
	}
	if saved, err := manager.DurationMS(context.Background(), session.UserID, session.ID); err != nil || saved != 5500 {
		t.Fatalf("saved audio = %d ms, %v", saved, err)
	}
}

// A browser that starts recording another session has left its own waiting
// run: that run ends, and does not count against the owner's recordings.
func TestStartingAnotherRecordingEndsTheBrowsersWaitingRun(t *testing.T) {
	svc, database, _, session, viewers := roomFixture(t, nil)
	provider := &flakyASR{streams: make(chan *flakyStream, 8)}
	svc.providers = testProviders{snapshot: providers.Snapshot{ASR: provider}}
	svc.reattachGrace = time.Minute
	other := session
	other.ID, other.Title = "session_2", "Second"
	if err := database.CreateInterpretationSession(context.Background(), other); err != nil {
		t.Fatal(err)
	}
	svc.access = sessionResolver{base: svc.access, sessions: map[string]domain.InterpretationSession{session.ID: session, other.ID: other}}
	first := recordingServer(t, svc, map[string]domain.Viewer{"owner": viewers[0]}, session.ID)
	second := recordingServer(t, svc, map[string]domain.Viewer{"owner": viewers[0]}, other.ID)
	conn, ready := openRecorder(t, first.URL+"/owner")
	if !strings.Contains(ready, `"type":"ready"`) {
		t.Fatalf("ready = %s", ready)
	}
	nextStream(t, provider, time.Second)
	writeAudio(t, conn, 4, true)
	_ = conn.CloseNow()
	eventually(t, "the run to wait", func() bool {
		svc.mu.Lock()
		defer svc.mu.Unlock()
		room := svc.rooms[session.ID]
		return room != nil && room.recorder != nil && room.recorder.detached.Load()
	})
	if admission, err := svc.Admission(context.Background(), viewers[0], other.ID); err != nil || !admission.Allowed {
		t.Fatalf("admission = %#v, %v", admission, err)
	}
	next, ready := openRecorder(t, second.URL+"/owner")
	if !strings.Contains(ready, `"type":"ready"`) {
		t.Fatalf("a new recording was refused over a waiting run: %s", ready)
	}
	defer next.CloseNow()
	eventually(t, "the waiting run to end", func() bool { return !svc.State(session.ID).Active })
	stored, err := database.GetInterpretationSession(context.Background(), session.UserID, session.ID)
	if err != nil || stored.Status != domain.InterpretationCompleted {
		t.Fatalf("status of the left run = %v, %v", stored.Status, err)
	}
}

// A browser sending 16-bit audio uses half the bandwidth; the recording is
// kept and recognized as float32 all the same, and a connection may change
// encoding when it comes back.
func TestSixteenBitAudioIsKeptAndRecognizedAsFloat(t *testing.T) {
	svc, database, _, session, viewers := roomFixture(t, nil)
	provider := &flakyASR{streams: make(chan *flakyStream, 8)}
	svc.providers = testProviders{snapshot: providers.Snapshot{ASR: provider}}
	svc.reattachGrace = 5 * time.Second
	server := recordingServer(t, svc, map[string]domain.Viewer{"owner": viewers[0]}, session.ID)
	dial := func(url, encoding string) *websocket.Conn {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		conn, _, err := websocket.Dial(ctx, strings.Replace(url, "http://", "ws://", 1), nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := conn.Write(ctx, websocket.MessageText, []byte(`{"type":"start","audio":{"encoding":"`+encoding+`","sampleRate":16000,"channels":1}}`)); err != nil {
			t.Fatal(err)
		}
		if _, message, err := conn.Read(ctx); err != nil || !strings.Contains(string(message), `"type":"ready"`) {
			t.Fatalf("ready = %s, %v", message, err)
		}
		return conn
	}
	conn := dial(server.URL+"/owner", "pcm16")
	stream := nextStream(t, provider, time.Second)
	half := make([]byte, 2000) // a sixteenth of a second of 16-bit samples
	for range 16 {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		if err := conn.Write(ctx, websocket.MessageBinary, half); err != nil {
			t.Fatal(err)
		}
		cancel()
		time.Sleep(62 * time.Millisecond)
	}
	_ = conn.CloseNow()
	again := dial(server.URL+"/owner?resume=true", "pcm32f")
	defer again.CloseNow()
	writeAudio(t, again, 16, true) // a second more, as float32
	sendControl(t, again, `{"type":"end"}`)
	eventually(t, "the recording to end", func() bool { return !svc.State(session.ID).Active })
	manager, err := media.New(database, database.DataRoot())
	if err != nil {
		t.Fatal(err)
	}
	if saved, err := manager.DurationMS(context.Background(), session.UserID, session.ID); err != nil || saved != 2000 {
		t.Fatalf("saved audio = %d ms, %v", saved, err)
	}
	// Recognition heard two seconds of float32.
	if heard := stream.audio.Load(); heard != 2*64000 {
		t.Fatalf("recognition heard %d bytes", heard)
	}
}

// A page in the background sends nothing for a while and is waited for;
// back in front, it must send audio again.
func TestAPageInTheBackgroundIsWaitedForLonger(t *testing.T) {
	svc, _, _, session, viewers := roomFixture(t, nil)
	provider := &flakyASR{streams: make(chan *flakyStream, 8)}
	svc.providers = testProviders{snapshot: providers.Snapshot{ASR: provider}}
	svc.noAudioTimeout = 300 * time.Millisecond
	svc.reattachGrace = 3 * time.Second
	server := recordingServer(t, svc, map[string]domain.Viewer{"owner": viewers[0]}, session.ID)
	conn, ready := openRecorder(t, server.URL+"/owner")
	if !strings.Contains(ready, `"type":"ready"`) {
		t.Fatalf("ready = %s", ready)
	}
	defer conn.CloseNow()
	nextStream(t, provider, time.Second)
	writeAudio(t, conn, 4, true)
	sendControl(t, conn, `{"type":"note","event":"hidden"}`)
	time.Sleep(900 * time.Millisecond)
	svc.mu.Lock()
	detached := svc.rooms[session.ID].recorder.detached.Load()
	svc.mu.Unlock()
	if detached || !svc.State(session.ID).Active {
		t.Fatal("a page in the background was let go of before its grace")
	}
	sendControl(t, conn, `{"type":"note","event":"visible","ms":900}`)
	writeAudio(t, conn, 4, true)
	// Visible and silent: let go of, and waited for, as any dropped connection.
	eventually(t, "the silent connection to be let go of", func() bool {
		svc.mu.Lock()
		defer svc.mu.Unlock()
		room := svc.rooms[session.ID]
		return room != nil && room.recorder != nil && room.recorder.detached.Load()
	})
	if !svc.State(session.ID).Active {
		t.Fatal("the recording ended instead of waiting")
	}
}

// A recorder that does not come back in time ends its run, as interrupted.
func TestARecorderThatDoesNotComeBackEndsTheRun(t *testing.T) {
	svc, database, _, session, viewers := roomFixture(t, nil)
	provider := &flakyASR{streams: make(chan *flakyStream, 8)}
	svc.providers = testProviders{snapshot: providers.Snapshot{ASR: provider}}
	svc.reattachGrace = 300 * time.Millisecond
	server := recordingServer(t, svc, map[string]domain.Viewer{"owner": viewers[0]}, session.ID)
	conn, ready := openRecorder(t, server.URL+"/owner")
	if !strings.Contains(ready, `"type":"ready"`) {
		t.Fatalf("ready = %s", ready)
	}
	stream := nextStream(t, provider, time.Second)
	writeAudio(t, conn, 4, true)
	_ = conn.CloseNow()
	eventually(t, "the run to end", func() bool { return !svc.State(session.ID).Active })
	if !stream.ended.Load() {
		t.Fatal("recognition was kept after the run ended")
	}
	stored, err := database.GetInterpretationSession(context.Background(), session.UserID, session.ID)
	if err != nil || stored.Status != domain.InterpretationFailed {
		t.Fatalf("status = %v, %v", stored.Status, err)
	}
}

// A reloaded page starts again: it takes over its own run that waits for it,
// while someone else still cannot.
func TestAReloadedPageStartsAgainOverItsWaitingRun(t *testing.T) {
	svc, _, resolver, session, viewers := roomFixture(t, nil)
	provider := &flakyASR{streams: make(chan *flakyStream, 8)}
	svc.providers = testProviders{snapshot: providers.Snapshot{ASR: provider}}
	svc.reattachGrace = 5 * time.Second
	other := viewers[1]
	access := resolver.access[other.ID]
	access.Permission = domain.ShareRecord
	resolver.access[other.ID] = access
	server := recordingServer(t, svc, map[string]domain.Viewer{"owner": viewers[0], "other": other}, session.ID)
	conn, ready := openRecorder(t, server.URL+"/owner")
	if !strings.Contains(ready, `"type":"ready"`) {
		t.Fatalf("ready = %s", ready)
	}
	nextStream(t, provider, time.Second)
	writeAudio(t, conn, 4, true)
	_ = conn.CloseNow()
	eventually(t, "the run to wait", func() bool {
		svc.mu.Lock()
		defer svc.mu.Unlock()
		room := svc.rooms[session.ID]
		return room != nil && room.recorder != nil && room.recorder.detached.Load()
	})
	if other, answer := openRecorder(t, server.URL+"/other"); !strings.Contains(answer, "Conflict") {
		if other != nil {
			other.CloseNow()
		}
		t.Fatalf("someone else took the waiting run: %s", answer)
	}
	again, ready := openRecorder(t, server.URL+"/owner")
	if !strings.Contains(ready, `"type":"ready"`) {
		t.Fatalf("restart after reload = %s", ready)
	}
	defer again.CloseNow()
	nextStream(t, provider, time.Second)
}
