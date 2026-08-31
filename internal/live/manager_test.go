package live

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/asr"
	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/store"
	"github.com/Tularity/t-lingual/internal/translate"
	"github.com/Tularity/t-lingual/internal/workspace"
	"github.com/coder/websocket"
)

const liveTestTimeout = 3 * time.Second

var liveTestNow = time.Date(2026, time.September, 1, 3, 30, 0, 0, time.UTC)

func TestManagerForwardsAudioPersistsFinalAndTranslatesAsynchronously(t *testing.T) {
	releaseTranslation := make(chan struct{})
	translator := newFakeTranslator()
	translator.release = releaseTranslation
	translator.response = translate.Response{
		RequestID:      "translator-request-1",
		SourceLanguage: "en-US",
		TargetLanguage: "fr",
		Translation:    "Bonjour tout le monde",
		Model:          "test-translator",
	}
	fixture := newLiveFixture(t, translator)
	fixture.stream.info.ChunkMS = 40
	wsURL, served := startManagerServer(t, fixture.manager, fixture.owner, fixture.browserSession, fixture.session.ID)
	connection := dialLive(t, wsURL)

	writeClientJSON(t, connection, map[string]any{
		"type": "start",
		"audio": map[string]any{
			"encoding":   "pcm32f",
			"sampleRate": 16_000,
			"channels":   1,
		},
	})
	ready := readLiveMessage(t, connection)
	if ready.Type != "ready" || ready.SessionID != fixture.session.ID || ready.RunID == "" || ready.ChunkMS != 40 {
		t.Fatalf("ready message = %#v", ready)
	}
	start := receiveWithin(t, fixture.provider.started)
	if start.Language != fixture.session.SourceLanguage || start.Audio != (asr.AudioSpec{
		Encoding: "pcm32f", SampleRate: 16_000, Channels: 1,
	}) || start.CacheLines != 1000 || start.SpeakerEmbedding != "off" {
		t.Fatalf("ASR start request = %#v", start)
	}

	audio := []byte{0x00, 0x00, 0x80, 0x3f, 0x00, 0x00, 0x00, 0x00}
	writeClient(t, connection, websocket.MessageBinary, audio)
	if forwarded := receiveWithin(t, fixture.stream.audio); !bytes.Equal(forwarded, audio) {
		t.Fatalf("forwarded audio = %x, want %x", forwarded, audio)
	}

	fixture.stream.emit(t, asr.Event{
		Type: "final", Sequence: 17, Text: "Hello everyone", StartMS: 120,
		EndMS: 980, Language: "en-US",
	})
	final := readLiveMessage(t, connection)
	if final.Type != "final" || final.UpstreamSequence != 17 || final.DetectedLanguage != "en-US" {
		t.Fatalf("final message = %#v", final)
	}
	if final.Segment.ID == "" || final.Segment.SessionID != fixture.session.ID ||
		final.Segment.Sequence != 1 || final.Segment.SourceText != "Hello everyone" ||
		!final.Segment.Final || final.Segment.TranslationStatus != domain.TranslationPending {
		t.Fatalf("final segment = %#v", final.Segment)
	}

	translationRequest := receiveWithin(t, translator.started)
	if translationRequest != (translate.Request{
		SourceLanguage: fixture.session.SourceLanguage, TargetLanguage: fixture.session.TargetLanguage, Text: "Hello everyone",
	}) {
		t.Fatalf("translation request = %#v", translationRequest)
	}
	segments, err := fixture.database.ListSegments(context.Background(), fixture.owner.ID, fixture.session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(segments) != 1 || segments[0].ID != final.Segment.ID ||
		segments[0].TranslationStatus != domain.TranslationPending || segments[0].Translation != "" {
		t.Fatalf("segment before translator release = %#v", segments)
	}

	close(releaseTranslation)
	translated := readLiveMessage(t, connection)
	if translated.Type != "translation" || translated.SegmentID != final.Segment.ID ||
		translated.Status != string(domain.TranslationSucceeded) ||
		translated.Translation != translator.response.Translation ||
		translated.RequestID != translator.response.RequestID || translated.Error != "" {
		t.Fatalf("translation message = %#v", translated)
	}
	segments, err = fixture.database.ListSegments(context.Background(), fixture.owner.ID, fixture.session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(segments) != 1 || segments[0].TranslationStatus != domain.TranslationSucceeded ||
		segments[0].Translation != translator.response.Translation ||
		segments[0].TranslatorRequestID != translator.response.RequestID ||
		segments[0].TranslationError != "" {
		t.Fatalf("translated segment = %#v", segments)
	}
	if calls := translator.callCount(); calls != 1 {
		t.Fatalf("translator call count = %d, want 1", calls)
	}

	writeClientJSON(t, connection, map[string]string{"type": "end"})
	stopped := readLiveMessage(t, connection)
	if stopped.Type != "stopped" || stopped.Status != string(domain.InterpretationCompleted) {
		t.Fatalf("stopped message = %#v", stopped)
	}
	assertCloseStatus(t, connection, websocket.StatusNormalClosure)
	if err := receiveWithin(t, served); err != nil {
		t.Fatalf("ServeLive returned %v", err)
	}
	session, err := fixture.database.GetInterpretationSession(context.Background(), fixture.owner.ID, fixture.session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if session.Status != domain.InterpretationCompleted || session.StartedAt == nil || session.EndedAt == nil {
		t.Fatalf("completed session = %#v", session)
	}
	forceEOU, end, closeCalls := fixture.stream.stopCounts()
	if forceEOU != 1 || end != 1 || closeCalls != 1 {
		t.Fatalf("graceful stop counts: force_eou=%d end=%d close=%d", forceEOU, end, closeCalls)
	}
}

func TestManagerRejectsUnownedAndMissingSessionsBeforeUpgrade(t *testing.T) {
	fixture := newLiveFixture(t, nil)
	intruder := liveTestUser("usr_live_intruder", "live-intruder")
	if err := fixture.database.CreateUser(context.Background(), intruder); err != nil {
		t.Fatal(err)
	}
	intruderBrowser := createLiveBrowserSession(t, fixture.database, intruder.ID, "ses_live_intruder", time.Now().UTC().Add(time.Hour), "intruder-browser-token")

	tests := []struct {
		name      string
		user      domain.User
		browser   domain.BrowserSession
		sessionID string
	}{
		{name: "cross owner", user: intruder, browser: intruderBrowser, sessionID: fixture.session.ID},
		{name: "missing", user: fixture.owner, browser: fixture.browserSession, sessionID: "ises_missing"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			wsURL, served := startManagerServer(t, fixture.manager, test.user, test.browser, test.sessionID)
			ctx, cancel := context.WithTimeout(context.Background(), liveTestTimeout)
			defer cancel()
			connection, response, err := websocket.Dial(ctx, wsURL, nil)
			if connection != nil {
				connection.CloseNow()
			}
			if err == nil {
				t.Fatal("unauthorized websocket was upgraded")
			}
			if response == nil {
				t.Fatalf("websocket rejection omitted HTTP response: %v", err)
			}
			defer response.Body.Close()
			if response.StatusCode != http.StatusNotFound || response.Header.Get("Upgrade") != "" {
				t.Fatalf("rejection status=%d upgrade=%q", response.StatusCode, response.Header.Get("Upgrade"))
			}
			serveErr := receiveWithin(t, served)
			if !errors.Is(serveErr, store.ErrNotFound) {
				t.Fatalf("ServeLive error = %v, want store.ErrNotFound", serveErr)
			}
		})
	}
	if starts := fixture.provider.startCount(); starts != 0 {
		t.Fatalf("ASR started %d times for rejected sessions", starts)
	}
}

func TestManagerRejectsInvalidHelloWithoutStartingASR(t *testing.T) {
	validHello := `{"type":"start","audio":{"encoding":"pcm32f","sampleRate":16000,"channels":1}}`
	tests := []struct {
		name        string
		messageType websocket.MessageType
		payload     string
	}{
		{name: "binary", messageType: websocket.MessageBinary, payload: validHello},
		{name: "malformed JSON", messageType: websocket.MessageText, payload: `{"type":`},
		{name: "wrong control type", messageType: websocket.MessageText, payload: `{"type":"listen","audio":{"encoding":"pcm32f","sampleRate":16000,"channels":1}}`},
		{name: "unsupported audio", messageType: websocket.MessageText, payload: `{"type":"start","audio":{"encoding":"opus","sampleRate":16000,"channels":2}}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newLiveFixture(t, nil)
			wsURL, served := startManagerServer(t, fixture.manager, fixture.owner, fixture.browserSession, fixture.session.ID)
			connection := dialLive(t, wsURL)
			writeClient(t, connection, test.messageType, []byte(test.payload))
			message := readLiveMessage(t, connection)
			if message.Type != "error" || message.Code != "LIVE_STOPPED" || message.Message == "" {
				t.Fatalf("invalid hello response = %#v", message)
			}
			_ = connection.CloseNow()
			if err := receiveWithin(t, served); err != nil {
				t.Fatalf("ServeLive returned %v after reporting websocket error", err)
			}
			if starts := fixture.provider.startCount(); starts != 0 {
				t.Fatalf("ASR started %d times", starts)
			}
			session, err := fixture.database.GetInterpretationSession(context.Background(), fixture.owner.ID, fixture.session.ID)
			if err != nil {
				t.Fatal(err)
			}
			if session.Status != domain.InterpretationCreated || session.StartedAt != nil || session.EndedAt != nil {
				t.Fatalf("invalid hello changed session = %#v", session)
			}
		})
	}
}

func TestInvalidOrUnupgradedConnectionCannotFenceCurrentInterpretation(t *testing.T) {
	fixture := newLiveFixture(t, nil)
	fixture.manager.helloTimeout = 60 * time.Millisecond
	current, currentServed := startReadyLive(
		t, fixture.manager, fixture.owner, fixture.browserSession, fixture.session.ID, 16_000,
	)

	t.Run("ordinary HTTP request", func(t *testing.T) {
		wsURL, served := startManagerServer(t, fixture.manager, fixture.owner, fixture.browserSession, fixture.session.ID)
		request, err := http.NewRequest(http.MethodGet, "http"+strings.TrimPrefix(wsURL, "ws"), nil)
		if err != nil {
			t.Fatal(err)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if err := receiveWithin(t, served); err == nil {
			t.Fatal("non-upgrade request unexpectedly succeeded")
		}
	})

	t.Run("invalid hello", func(t *testing.T) {
		wsURL, served := startManagerServer(t, fixture.manager, fixture.owner, fixture.browserSession, fixture.session.ID)
		candidate := dialLive(t, wsURL)
		writeClientJSON(t, candidate, map[string]any{"type": "invalid"})
		message := readLiveMessage(t, candidate)
		if message.Type != "error" {
			t.Fatalf("invalid hello message = %#v", message)
		}
		assertCloseStatus(t, candidate, websocket.StatusInternalError)
		if err := receiveWithin(t, served); err != nil {
			t.Fatalf("invalid hello ServeLive returned %v", err)
		}
	})

	t.Run("silent after upgrade", func(t *testing.T) {
		wsURL, served := startManagerServer(t, fixture.manager, fixture.owner, fixture.browserSession, fixture.session.ID)
		candidate := dialLive(t, wsURL)
		ctx, cancel := context.WithTimeout(context.Background(), liveTestTimeout)
		_, _, err := candidate.Read(ctx)
		cancel()
		if err == nil {
			t.Fatal("silent connection remained open after hello timeout")
		}
		if err := receiveWithin(t, served); err != nil {
			t.Fatalf("silent hello ServeLive returned %v", err)
		}
	})

	if starts := fixture.provider.startCount(); starts != 1 {
		t.Fatalf("invalid candidates started ASR %d times, want only current stream", starts)
	}
	audio := []byte{0, 0, 0, 0}
	writeClient(t, current, websocket.MessageBinary, audio)
	if forwarded := receiveWithin(t, fixture.stream.audio); !bytes.Equal(forwarded, audio) {
		t.Fatalf("current stream was fenced; forwarded=%x", forwarded)
	}
	writeClientJSON(t, current, map[string]string{"type": "end"})
	if stopped := readLiveMessage(t, current); stopped.Type != "stopped" {
		t.Fatalf("current stop message = %#v", stopped)
	}
	assertCloseStatus(t, current, websocket.StatusNormalClosure)
	if err := receiveWithin(t, currentServed); err != nil {
		t.Fatalf("current ServeLive returned %v", err)
	}
}

func TestLoggedOutSecondBrowserCannotLeaveCurrentInterpretationStale(t *testing.T) {
	tests := []struct {
		name              string
		pauseAfterPending bool
	}{
		{name: "logout while second browser waits for hello"},
		{name: "logout between pending registration and indexed validation", pauseAfterPending: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newLiveFixture(t, nil)
			secondToken := "second-live-browser-token-with-enough-entropy"
			secondBrowser := createLiveBrowserSession(
				t, fixture.database, fixture.owner.ID, "ses_live_second_browser",
				time.Now().UTC().Add(time.Hour), secondToken,
			)
			current, currentServed := startReadyLive(
				t, fixture.manager, fixture.owner, fixture.browserSession, fixture.session.ID, 16_000,
			)

			wsURL, candidateServed := startManagerServer(t, fixture.manager, fixture.owner, secondBrowser, fixture.session.ID)
			candidate := dialLive(t, wsURL)
			var reachedPreValidation chan struct{}
			var continueAdmission chan struct{}
			if test.pauseAfterPending {
				reachedPreValidation = make(chan struct{})
				continueAdmission = make(chan struct{})
				fixture.manager.afterPendingRegistration = func() {
					close(reachedPreValidation)
					<-continueAdmission
				}
				writeDone := make(chan struct{})
				go func() {
					defer close(writeDone)
					ctx, cancel := context.WithTimeout(context.Background(), liveTestTimeout)
					defer cancel()
					payload, _ := json.Marshal(validLiveHello(16_000))
					_ = candidate.Write(ctx, websocket.MessageText, payload)
				}()
				<-reachedPreValidation
				if err := fixture.database.DeleteBrowserSession(context.Background(), secondToken); err != nil {
					t.Fatal(err)
				}
				fixture.manager.RevokeBrowserSession(secondBrowser.ID)
				close(continueAdmission)
				<-writeDone
			} else {
				if err := fixture.database.DeleteBrowserSession(context.Background(), secondToken); err != nil {
					t.Fatal(err)
				}
				fixture.manager.RevokeBrowserSession(secondBrowser.ID)
				writeClientJSON(t, candidate, validLiveHello(16_000))
			}

			message := readLiveMessage(t, candidate)
			if message.Type != "error" || message.Code != "AUTH_REVOKED" {
				t.Fatalf("logged-out candidate message = %#v", message)
			}
			assertCloseStatus(t, candidate, websocket.StatusPolicyViolation)
			if err := receiveWithin(t, candidateServed); err != nil {
				t.Fatalf("candidate ServeLive returned %v", err)
			}
			if starts := fixture.provider.startCount(); starts != 1 {
				t.Fatalf("logged-out candidate started ASR; starts=%d", starts)
			}
			session, err := fixture.database.GetInterpretationSession(context.Background(), fixture.owner.ID, fixture.session.ID)
			if err != nil {
				t.Fatal(err)
			}
			if session.Status != domain.InterpretationLive || session.EndedAt != nil {
				t.Fatalf("healthy predecessor became stale/ended: %#v", session)
			}
			audio := []byte{0, 0, 0, 0}
			writeClient(t, current, websocket.MessageBinary, audio)
			if forwarded := receiveWithin(t, fixture.stream.audio); !bytes.Equal(forwarded, audio) {
				t.Fatalf("predecessor audio = %x", forwarded)
			}
			writeClientJSON(t, current, map[string]string{"type": "end"})
			if stopped := readLiveMessage(t, current); stopped.Type != "stopped" {
				t.Fatalf("predecessor stop = %#v", stopped)
			}
			assertCloseStatus(t, current, websocket.StatusNormalClosure)
			if err := receiveWithin(t, currentServed); err != nil {
				t.Fatalf("predecessor ServeLive returned %v", err)
			}
		})
	}
}

func TestPendingAdmissionDoesNotRestorePredecessorThatAlreadyEnded(t *testing.T) {
	fixture := newLiveFixture(t, nil)
	secondToken := "pending-ended-browser-token-with-enough-entropy"
	secondBrowser := createLiveBrowserSession(
		t, fixture.database, fixture.owner.ID, "ses_live_pending_ended",
		time.Now().UTC().Add(time.Hour), secondToken,
	)
	current, currentServed := startReadyLive(
		t, fixture.manager, fixture.owner, fixture.browserSession, fixture.session.ID, 16_000,
	)
	reachedPending := make(chan struct{})
	continueValidation := make(chan struct{})
	fixture.manager.afterPendingRegistration = func() {
		close(reachedPending)
		<-continueValidation
	}
	wsURL, candidateServed := startManagerServer(t, fixture.manager, fixture.owner, secondBrowser, fixture.session.ID)
	candidate := dialLive(t, wsURL)
	writeDone := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), liveTestTimeout)
		defer cancel()
		payload, _ := json.Marshal(validLiveHello(16_000))
		writeDone <- candidate.Write(ctx, websocket.MessageText, payload)
	}()
	<-reachedPending

	writeClientJSON(t, current, map[string]string{"type": "end"})
	if stopped := readLiveMessage(t, current); stopped.Type != "stopped" {
		t.Fatalf("predecessor stop = %#v", stopped)
	}
	assertCloseStatus(t, current, websocket.StatusNormalClosure)
	if err := receiveWithin(t, currentServed); err != nil {
		t.Fatalf("predecessor ServeLive returned %v", err)
	}
	if err := fixture.database.DeleteBrowserSession(context.Background(), secondToken); err != nil {
		t.Fatal(err)
	}
	fixture.manager.RevokeBrowserSession(secondBrowser.ID)
	close(continueValidation)
	if err := <-writeDone; err != nil {
		t.Fatalf("candidate hello write: %v", err)
	}
	message := readLiveMessage(t, candidate)
	if message.Type != "error" || message.Code != "AUTH_REVOKED" {
		t.Fatalf("candidate revoke = %#v", message)
	}
	assertCloseStatus(t, candidate, websocket.StatusPolicyViolation)
	if err := receiveWithin(t, candidateServed); err != nil {
		t.Fatalf("candidate ServeLive returned %v", err)
	}

	session, err := fixture.database.GetInterpretationSession(context.Background(), fixture.owner.ID, fixture.session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if session.Status != domain.InterpretationCompleted || session.EndedAt == nil {
		t.Fatalf("ended predecessor durability = %#v", session)
	}
	fixture.manager.mu.Lock()
	defer fixture.manager.mu.Unlock()
	if len(fixture.manager.byInterpretation) != 0 || len(fixture.manager.pendingByInterpretation) != 0 ||
		len(fixture.manager.byBrowserSession) != 0 || len(fixture.manager.byUser) != 0 {
		t.Fatalf("dead admission leaked indexes: active=%d pending=%d browser=%d user=%d",
			len(fixture.manager.byInterpretation), len(fixture.manager.pendingByInterpretation),
			len(fixture.manager.byBrowserSession), len(fixture.manager.byUser))
	}
}

func TestManagerRevokesAuthenticationLifecycle(t *testing.T) {
	tests := []struct {
		name      string
		configure func(*testing.T, *liveFixture) domain.BrowserSession
		revoke    func(*testing.T, *liveFixture, domain.BrowserSession)
	}{
		{
			name: "browser session immediate revoke",
			revoke: func(_ *testing.T, fixture *liveFixture, browser domain.BrowserSession) {
				fixture.manager.RevokeBrowserSession(browser.ID)
			},
		},
		{
			name: "user immediate revoke",
			revoke: func(_ *testing.T, fixture *liveFixture, _ domain.BrowserSession) {
				fixture.manager.RevokeUser(fixture.owner.ID)
			},
		},
		{
			name: "deleted session periodic validation",
			configure: func(_ *testing.T, fixture *liveFixture) domain.BrowserSession {
				fixture.manager.authRevalidateInterval = 20 * time.Millisecond
				return fixture.browserSession
			},
			revoke: func(t *testing.T, fixture *liveFixture, _ domain.BrowserSession) {
				if err := fixture.database.DeleteBrowserSession(context.Background(), fixture.browserToken); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "disabled user periodic validation",
			configure: func(_ *testing.T, fixture *liveFixture) domain.BrowserSession {
				fixture.manager.authRevalidateInterval = 20 * time.Millisecond
				return fixture.browserSession
			},
			revoke: func(t *testing.T, fixture *liveFixture, _ domain.BrowserSession) {
				if err := fixture.database.UpdateUserStatus(context.Background(), fixture.owner.ID, domain.UserDisabled, time.Now().UTC()); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "expiry timer",
			configure: func(t *testing.T, fixture *liveFixture) domain.BrowserSession {
				return createLiveBrowserSession(
					t, fixture.database, fixture.owner.ID, "ses_live_expiring",
					time.Now().UTC().Add(350*time.Millisecond), "expiring-live-browser-token",
				)
			},
			revoke: func(*testing.T, *liveFixture, domain.BrowserSession) {},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newLiveFixture(t, nil)
			browser := fixture.browserSession
			if test.configure != nil {
				browser = test.configure(t, &fixture)
			}
			connection, served := startReadyLive(t, fixture.manager, fixture.owner, browser, fixture.session.ID, 16_000)
			test.revoke(t, &fixture, browser)

			message := readLiveMessage(t, connection)
			if message.Type != "error" || message.Code != "AUTH_REVOKED" || message.Message == "" {
				t.Fatalf("authentication revoke message = %#v", message)
			}
			assertCloseStatus(t, connection, websocket.StatusPolicyViolation)
			if err := receiveWithin(t, served); err != nil {
				t.Fatalf("ServeLive returned %v", err)
			}
			session, err := fixture.database.GetInterpretationSession(context.Background(), fixture.owner.ID, fixture.session.ID)
			if err != nil {
				t.Fatal(err)
			}
			if session.Status != domain.InterpretationCompleted || session.EndedAt == nil {
				t.Fatalf("revoked interpretation state = %#v", session)
			}
			_, endCalls, closeCalls := fixture.stream.stopCounts()
			if endCalls != 1 || closeCalls != 1 {
				t.Fatalf("revoked upstream end=%d close=%d", endCalls, closeCalls)
			}
		})
	}
}

func TestRevocationStopsAcceptingAudioBeforeUpstreamShutdown(t *testing.T) {
	fixture := newLiveFixture(t, nil)
	connection, served := startReadyLive(
		t, fixture.manager, fixture.owner, fixture.browserSession, fixture.session.ID, 16_000,
	)
	fixture.manager.RevokeBrowserSession(fixture.browserSession.ID)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	_ = connection.Write(ctx, websocket.MessageBinary, []byte{0, 0, 0, 0})
	cancel()
	message := readLiveMessage(t, connection)
	if message.Type != "error" || message.Code != "AUTH_REVOKED" {
		t.Fatalf("revoke message = %#v", message)
	}
	select {
	case payload := <-fixture.stream.audio:
		t.Fatalf("audio reached upstream after revocation: %x", payload)
	case <-time.After(100 * time.Millisecond):
	}
	assertCloseStatus(t, connection, websocket.StatusPolicyViolation)
	if err := receiveWithin(t, served); err != nil {
		t.Fatalf("ServeLive returned %v", err)
	}
}

func TestRevokedSilentBrowserCannotDelayDurableFinalization(t *testing.T) {
	fixture := newLiveFixture(t, nil)
	connection, served := startReadyLive(
		t, fixture.manager, fixture.owner, fixture.browserSession, fixture.session.ID, 16_000,
	)
	defer connection.CloseNow()

	// Do not read the terminal error or a close frame. A graceful coder/websocket
	// Close would wait roughly five seconds for this peer to participate.
	started := time.Now()
	fixture.manager.RevokeBrowserSession(fixture.browserSession.ID)
	if err := receiveWithin(t, served); err != nil {
		t.Fatalf("ServeLive returned %v", err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("silent browser delayed revoked stream shutdown: %s", elapsed)
	}

	session, err := fixture.database.GetInterpretationSession(
		context.Background(), fixture.owner.ID, fixture.session.ID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if session.Status != domain.InterpretationCompleted || session.EndedAt == nil {
		t.Fatalf("revoked stream was closed before durable finalization: %#v", session)
	}
}

func TestShutdownFinalizesBeforeClosingSilentBrowser(t *testing.T) {
	fixture := newLiveFixture(t, nil)
	connection, served := startReadyLive(
		t, fixture.manager, fixture.owner, fixture.browserSession, fixture.session.ID, 16_000,
	)
	defer connection.CloseNow()

	started := time.Now()
	fixture.cancel()
	if err := receiveWithin(t, served); err != nil {
		t.Fatalf("ServeLive returned %v", err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("silent browser delayed manager-cancelled stream shutdown: %s", elapsed)
	}

	session, err := fixture.database.GetInterpretationSession(
		context.Background(), fixture.owner.ID, fixture.session.ID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if session.Status != domain.InterpretationCompleted || session.EndedAt == nil {
		t.Fatalf("shutdown stream was closed before durable finalization: %#v", session)
	}
}

func TestManagerEnforcesLiveResourceBounds(t *testing.T) {
	tests := []struct {
		name      string
		configure func(*Manager)
		act       func(*testing.T, *websocket.Conn)
		code      string
	}{
		{
			name: "client read idle timeout",
			configure: func(manager *Manager) {
				manager.clientIdleTimeout = 50 * time.Millisecond
			},
			act:  func(*testing.T, *websocket.Conn) {},
			code: "CLIENT_IDLE",
		},
		{
			name: "maximum live duration",
			configure: func(manager *Manager) {
				manager.maxLiveDuration = 120 * time.Millisecond
			},
			act:  func(*testing.T, *websocket.Conn) {},
			code: "LIVE_DURATION_EXCEEDED",
		},
		{
			name:      "audio faster than real time",
			configure: func(*Manager) {},
			act: func(t *testing.T, connection *websocket.Conn) {
				writeClient(t, connection, websocket.MessageBinary, make([]byte, 128<<10))
			},
			code: "AUDIO_RATE_EXCEEDED",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newLiveFixture(t, nil)
			test.configure(fixture.manager)
			connection, served := startReadyLive(t, fixture.manager, fixture.owner, fixture.browserSession, fixture.session.ID, 8_000)
			test.act(t, connection)
			message := readLiveMessage(t, connection)
			if message.Type != "error" || message.Code != test.code {
				t.Fatalf("resource error = %#v, want code %s", message, test.code)
			}
			assertCloseStatus(t, connection, websocket.StatusPolicyViolation)
			if err := receiveWithin(t, served); err != nil {
				t.Fatalf("ServeLive returned %v", err)
			}
			session, err := fixture.database.GetInterpretationSession(context.Background(), fixture.owner.ID, fixture.session.ID)
			if err != nil {
				t.Fatal(err)
			}
			if session.Status != domain.InterpretationFailed || session.EndedAt == nil {
				t.Fatalf("resource-limited interpretation state = %#v", session)
			}
		})
	}
}

func TestControlMessagesDoNotResetAudioIdleTimeout(t *testing.T) {
	fixture := newLiveFixture(t, nil)
	fixture.manager.clientIdleTimeout = 90 * time.Millisecond
	connection, served := startReadyLive(
		t, fixture.manager, fixture.owner, fixture.browserSession, fixture.session.ID, 16_000,
	)
	stopPings := make(chan struct{})
	pingsDone := make(chan struct{})
	go func() {
		defer close(pingsDone)
		ticker := time.NewTicker(30 * time.Millisecond)
		defer ticker.Stop()
		payload := []byte(`{"type":"ping"}`)
		for {
			select {
			case <-stopPings:
				return
			case <-ticker.C:
				ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
				err := connection.Write(ctx, websocket.MessageText, payload)
				cancel()
				if err != nil {
					return
				}
			}
		}
	}()
	started := time.Now()
	message := readLiveMessage(t, connection)
	close(stopPings)
	<-pingsDone
	if message.Type != "error" || message.Code != "CLIENT_IDLE" {
		t.Fatalf("idle with controls message = %#v", message)
	}
	if elapsed := time.Since(started); elapsed > 300*time.Millisecond {
		t.Fatalf("control traffic incorrectly extended audio idle timeout to %s", elapsed)
	}
	assertCloseStatus(t, connection, websocket.StatusPolicyViolation)
	if err := receiveWithin(t, served); err != nil {
		t.Fatalf("ServeLive returned %v", err)
	}
}

func TestBrowserControlRateIsBoundedAndPingStaysLocal(t *testing.T) {
	fixture := newLiveFixture(t, nil)
	connection, served := startReadyLive(
		t, fixture.manager, fixture.owner, fixture.browserSession, fixture.session.ID, 16_000,
	)
	for range controlCommandBurst + 1 {
		writeClient(t, connection, websocket.MessageText, []byte(`{"type":"ping"}`))
	}
	message := readLiveMessage(t, connection)
	if message.Type != "error" || message.Code != "CONTROL_RATE_EXCEEDED" {
		t.Fatalf("control rate message = %#v", message)
	}
	assertCloseStatus(t, connection, websocket.StatusPolicyViolation)
	if err := receiveWithin(t, served); err != nil {
		t.Fatalf("ServeLive returned %v", err)
	}
	fixture.stream.mu.Lock()
	providerPings := fixture.stream.pingCalls
	fixture.stream.mu.Unlock()
	if providerPings != 0 {
		t.Fatalf("browser keepalive was amplified into %d provider pings", providerPings)
	}
}

func TestEndFollowedByFramesDoesNotLeakReader(t *testing.T) {
	for iteration := range 12 {
		t.Run(fmt.Sprintf("reconnect_%d", iteration), func(t *testing.T) {
			fixture := newLiveFixture(t, nil)
			connection, served := startReadyLive(
				t, fixture.manager, fixture.owner, fixture.browserSession, fixture.session.ID, 16_000,
			)
			ctx, cancel := context.WithTimeout(context.Background(), liveTestTimeout)
			if err := connection.Write(ctx, websocket.MessageText, []byte(`{"type":"end"}`)); err != nil {
				cancel()
				t.Fatal(err)
			}
			for range 8 {
				_ = connection.Write(ctx, websocket.MessageBinary, make([]byte, 4<<10))
			}
			cancel()
			if stopped := readLiveMessage(t, connection); stopped.Type != "stopped" {
				t.Fatalf("stop message = %#v", stopped)
			}
			assertCloseStatus(t, connection, websocket.StatusNormalClosure)
			if err := receiveWithin(t, served); err != nil {
				t.Fatalf("ServeLive returned %v", err)
			}
			select {
			case payload := <-fixture.stream.audio:
				t.Fatalf("post-end payload reached upstream: %d bytes", len(payload))
			default:
			}
		})
	}
}

func TestTranslationBacklogIsBoundedPerUser(t *testing.T) {
	fixture := newLiveFixture(t, newFakeTranslator())
	for index := range translationUserBacklog {
		if !fixture.manager.reserveTranslation(fixture.owner.ID) {
			t.Fatalf("reservation %d rejected before per-user limit", index)
		}
	}
	if fixture.manager.reserveTranslation(fixture.owner.ID) {
		t.Fatal("per-user translation backlog exceeded")
	}
	if !fixture.manager.reserveTranslation("usr_other") {
		t.Fatal("one user's backlog prevented another user's reservation")
	}
	for range translationUserBacklog {
		fixture.manager.releaseTranslation(fixture.owner.ID)
	}
	fixture.manager.releaseTranslation("usr_other")
}

func TestTranslationSourceLanguageHonorsExplicitSelection(t *testing.T) {
	tests := []struct {
		name       string
		configured string
		detected   string
		want       string
		wantOK     bool
	}{
		{name: "explicit ignores conflicting detection", configured: "en", detected: "de", want: "en", wantOK: true},
		{name: "explicit survives missing detection", configured: "fr", want: "fr", wantOK: true},
		{name: "automatic uses detection", configured: "auto", detected: "de", want: "de", wantOK: true},
		{name: "automatic requires detection", configured: "auto"},
		{name: "automatic rejects unresolved detection", configured: "auto", detected: "auto"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, ok := translationSourceLanguage(test.configured, test.detected)
			if got != test.want || ok != test.wantOK {
				t.Fatalf("translationSourceLanguage(%q, %q) = %q, %v; want %q, %v", test.configured, test.detected, got, ok, test.want, test.wantOK)
			}
		})
	}
}

func TestManagerFinalizesLiveStateWhenReadyWriteFails(t *testing.T) {
	fixture := newLiveFixture(t, nil)
	fixture.manager.writeReady = func(context.Context, *websocket.Conn, *writeMutex, any) error {
		return errors.New("injected ready write failure")
	}
	wsURL, served := startManagerServer(t, fixture.manager, fixture.owner, fixture.browserSession, fixture.session.ID)
	connection := dialLive(t, wsURL)
	writeClientJSON(t, connection, validLiveHello(16_000))
	message := readLiveMessage(t, connection)
	if message.Type != "error" || message.Code != "LIVE_STOPPED" {
		t.Fatalf("ready failure message = %#v", message)
	}
	assertCloseStatus(t, connection, websocket.StatusInternalError)
	if err := receiveWithin(t, served); err != nil {
		t.Fatalf("ServeLive returned %v", err)
	}
	session, err := fixture.database.GetInterpretationSession(context.Background(), fixture.owner.ID, fixture.session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if session.Status != domain.InterpretationFailed || session.StartedAt == nil || session.EndedAt == nil {
		t.Fatalf("ready-write failure left session live: %#v", session)
	}
}

func TestBlockedBrowserWriterCannotPinStreamOrTranslationWorker(t *testing.T) {
	t.Run("stream", func(t *testing.T) {
		fixture := newLiveFixture(t, nil)
		fixture.manager.writeReady = func(ctx context.Context, connection *websocket.Conn, writer *writeMutex, value any) error {
			writer.timeout = 60 * time.Millisecond
			if err := writer.lock(context.Background()); err != nil {
				return err
			}
			defer writer.unlock()
			return writeJSON(ctx, connection, writer, value)
		}
		started := time.Now()
		wsURL, served := startManagerServer(t, fixture.manager, fixture.owner, fixture.browserSession, fixture.session.ID)
		connection := dialLive(t, wsURL)
		writeClientJSON(t, connection, validLiveHello(16_000))
		message := readLiveMessage(t, connection)
		if message.Type != "error" || message.Code != "LIVE_STOPPED" {
			t.Fatalf("blocked ready writer message = %#v", message)
		}
		assertCloseStatus(t, connection, websocket.StatusInternalError)
		if err := receiveWithin(t, served); err != nil {
			t.Fatalf("ServeLive returned %v", err)
		}
		if elapsed := time.Since(started); elapsed > time.Second {
			t.Fatalf("blocked stream writer took %s", elapsed)
		}
		_, endCalls, closeCalls := fixture.stream.stopCounts()
		if endCalls != 1 || closeCalls != 1 {
			t.Fatalf("blocked stream writer left upstream open: end=%d close=%d", endCalls, closeCalls)
		}
	})

	t.Run("translation worker", func(t *testing.T) {
		translator := newFakeTranslator()
		translator.response = translate.Response{Translation: "bonjour", RequestID: "req_blocked_writer"}
		fixture := newLiveFixture(t, translator)
		segment := domain.Segment{
			ID: "seg_blocked_writer", SessionID: fixture.session.ID, UserID: fixture.owner.ID,
			Sequence: 1, SourceText: "hello", TranslationStatus: domain.TranslationPending,
			Final: true, CreatedAt: time.Now().UTC(),
		}
		if err := fixture.database.AppendSegment(context.Background(), fixture.owner.ID, segment); err != nil {
			t.Fatal(err)
		}
		writer := newWriteMutex()
		writer.timeout = 60 * time.Millisecond
		if err := writer.lock(context.Background()); err != nil {
			t.Fatal(err)
		}
		defer writer.unlock()
		if !fixture.manager.reserveTranslation(fixture.owner.ID) {
			t.Fatal("translation reservation rejected")
		}
		fixture.manager.translationQueue <- translationTask{
			connection: nil, writeMu: writer, user: fixture.owner, session: fixture.session,
			segment: segment, detectedLanguage: "en-US",
		}
		deadline := time.Now().Add(time.Second)
		for {
			fixture.manager.translationMu.Lock()
			outstanding := fixture.manager.translationByUser[fixture.owner.ID]
			fixture.manager.translationMu.Unlock()
			if outstanding == 0 {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("translation worker remained pinned behind browser writer")
			}
			time.Sleep(5 * time.Millisecond)
		}
	})
}

func TestManagerAdmissionLimitsAndReconnectFencing(t *testing.T) {
	t.Run("per user and same interpretation reconnect", func(t *testing.T) {
		fixture := newLiveFixture(t, nil)
		manager := fixture.manager
		first := newTestLease(manager, "ises_1", "ses_1", "usr_1")
		second := newTestLease(manager, "ises_2", "ses_1", "usr_1")
		for _, current := range []*lease{first, second} {
			if old, err := admitTestLease(manager, current); err != nil || old != nil {
				t.Fatalf("acquire %s old=%p err=%v", current.interpretationID, old, err)
			}
		}
		third := newTestLease(manager, "ises_3", "ses_1", "usr_1")
		if _, err := admitTestLease(manager, third); !errors.Is(err, ErrUserCapacity) {
			t.Fatalf("third user stream error = %v, want ErrUserCapacity", err)
		}
		replacement := newTestLease(manager, first.interpretationID, "ses_2", "usr_1")
		old, err := admitTestLease(manager, replacement)
		if err != nil || old != first {
			t.Fatalf("same interpretation reconnect old=%p err=%v", old, err)
		}
		manager.release(first)
		if !manager.isCurrent(replacement.interpretationID, replacement) {
			t.Fatal("old lease release removed replacement indexes")
		}
		manager.mu.Lock()
		active := len(manager.byInterpretation)
		userActive := len(manager.byUser[replacement.userID])
		manager.mu.Unlock()
		if active != 2 || userActive != 2 {
			t.Fatalf("reconnect admission active=%d user=%d, want 2/2", active, userActive)
		}
		manager.release(replacement)
		manager.release(second)
	})

	t.Run("global", func(t *testing.T) {
		fixture := newLiveFixture(t, nil)
		manager := fixture.manager
		accepted := make([]*lease, 0, maxGlobalLiveStreams)
		for index := range maxGlobalLiveStreams {
			current := newTestLease(manager, fmt.Sprintf("ises_%d", index), fmt.Sprintf("ses_%d", index), fmt.Sprintf("usr_%d", index))
			if _, err := admitTestLease(manager, current); err != nil {
				t.Fatalf("acquire global slot %d: %v", index, err)
			}
			accepted = append(accepted, current)
		}
		overflow := newTestLease(manager, "ises_overflow", "ses_overflow", "usr_overflow")
		if _, err := admitTestLease(manager, overflow); !errors.Is(err, ErrGlobalCapacity) {
			t.Fatalf("global overflow error = %v, want ErrGlobalCapacity", err)
		}
		for _, current := range accepted {
			manager.release(current)
		}
	})
}

func TestSlowReplacedStreamDoesNotBlockUnrelatedAdmission(t *testing.T) {
	fixture := newLiveFixture(t, nil)

	// Model a predecessor whose cleanup does not acknowledge cancellation until
	// after the complete upstream-stop budget. The reconnect must wait for it,
	// but that wait is scoped to this interpretation only.
	old, oldContext := newTestLeaseWithContext(
		fixture.manager, fixture.session.ID, fixture.browserSession.ID, fixture.owner.ID,
	)
	if previous, err := admitTestLease(fixture.manager, old); err != nil || previous != nil {
		t.Fatalf("admit predecessor old=%p err=%v", previous, err)
	}
	t.Cleanup(func() {
		old.cancel(context.Canceled)
		close(old.done)
		fixture.manager.release(old)
	})

	reconnectURL, reconnectServed := startManagerServer(
		t, fixture.manager, fixture.owner, fixture.browserSession, fixture.session.ID,
	)
	reconnect := dialLive(t, reconnectURL)
	writeClientJSON(t, reconnect, validLiveHello(16_000))
	select {
	case <-oldContext.Done():
		if !errors.Is(context.Cause(oldContext), errStreamReplaced) {
			t.Fatalf("predecessor cause = %v, want errStreamReplaced", context.Cause(oldContext))
		}
	case <-time.After(liveTestTimeout):
		t.Fatal("reconnect did not promote over predecessor")
	}

	otherUser := liveTestUser("usr_live_unrelated", "live-unrelated")
	if err := fixture.database.CreateUser(context.Background(), otherUser); err != nil {
		t.Fatal(err)
	}
	otherBrowser := createLiveBrowserSession(
		t, fixture.database, otherUser.ID, "ses_live_unrelated",
		time.Now().UTC().Add(time.Hour), "unrelated-browser-token-with-enough-entropy",
	)
	otherSession := domain.InterpretationSession{
		ID: "ises_live_unrelated", UserID: otherUser.ID, Title: "Unrelated live test",
		SourceLanguage: "en", TargetLanguage: "fr", Status: domain.InterpretationCreated,
		CreatedAt: liveTestNow, UpdatedAt: liveTestNow,
	}
	if err := fixture.database.CreateInterpretationSession(context.Background(), otherSession); err != nil {
		t.Fatal(err)
	}
	otherURL, otherServed := startManagerServer(
		t, fixture.manager, otherUser, otherBrowser, otherSession.ID,
	)
	other := dialLive(t, otherURL)
	writeClientJSON(t, other, validLiveHello(16_000))

	// A process-wide admission lock would retain this request for the two-second
	// predecessor timeout. Give normal local scheduling ample room while keeping
	// the assertion well below that bound.
	readyContext, readyCancel := context.WithTimeout(context.Background(), 750*time.Millisecond)
	messageType, payload, err := other.Read(readyContext)
	readyCancel()
	if err != nil {
		t.Fatalf("unrelated admission waited behind predecessor: %v", err)
	}
	if messageType != websocket.MessageText {
		t.Fatalf("unrelated ready message type = %v", messageType)
	}
	var ready liveMessage
	if err := json.Unmarshal(payload, &ready); err != nil {
		t.Fatal(err)
	}
	if ready.Type != "ready" || ready.SessionID != otherSession.ID {
		t.Fatalf("unrelated ready message = %#v", ready)
	}

	// Cancel the reconnect while it is still waiting, then end the independent
	// stream normally. Neither path needs the synthetic predecessor to finish.
	fixture.manager.RevokeBrowserSession(fixture.browserSession.ID)
	reconnectError := readLiveMessage(t, reconnect)
	if reconnectError.Type != "error" || reconnectError.Code != "AUTH_REVOKED" {
		t.Fatalf("reconnect cancellation = %#v", reconnectError)
	}
	assertCloseStatus(t, reconnect, websocket.StatusPolicyViolation)
	if err := receiveWithin(t, reconnectServed); err != nil {
		t.Fatalf("reconnect ServeLive returned %v", err)
	}

	writeClientJSON(t, other, map[string]string{"type": "end"})
	if stopped := readLiveMessage(t, other); stopped.Type != "stopped" {
		t.Fatalf("unrelated stop = %#v", stopped)
	}
	assertCloseStatus(t, other, websocket.StatusNormalClosure)
	if err := receiveWithin(t, otherServed); err != nil {
		t.Fatalf("unrelated ServeLive returned %v", err)
	}
	fixture.manager.admissionGatesMu.Lock()
	remainingGates := len(fixture.manager.admissionGates)
	fixture.manager.admissionGatesMu.Unlock()
	if remainingGates != 0 {
		t.Fatalf("admission gates leaked after handoffs: %d", remainingGates)
	}
}

func TestHandshakeAdmissionBoundsSilentConnections(t *testing.T) {
	fixture := newLiveFixture(t, nil)
	fixture.manager.helloTimeout = 500 * time.Millisecond
	firstURL, firstServed := startManagerServer(t, fixture.manager, fixture.owner, fixture.browserSession, fixture.session.ID)
	first := dialLive(t, firstURL)
	secondURL, secondServed := startManagerServer(t, fixture.manager, fixture.owner, fixture.browserSession, fixture.session.ID)
	second := dialLive(t, secondURL)

	thirdURL, thirdServed := startManagerServer(t, fixture.manager, fixture.owner, fixture.browserSession, fixture.session.ID)
	ctx, cancel := context.WithTimeout(context.Background(), liveTestTimeout)
	third, response, err := websocket.Dial(ctx, thirdURL, nil)
	cancel()
	if third != nil {
		third.CloseNow()
	}
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err == nil || response == nil || response.StatusCode == http.StatusSwitchingProtocols {
		t.Fatalf("third silent handshake was admitted: response=%v err=%v", response, err)
	}
	if serveErr := receiveWithin(t, thirdServed); !errors.Is(serveErr, ErrUserCapacity) {
		t.Fatalf("third handshake ServeLive error = %v, want ErrUserCapacity", serveErr)
	}
	fixture.manager.handshakeMu.Lock()
	activeHandshakes := fixture.manager.handshakes
	userHandshakes := fixture.manager.handshakesByUser[fixture.owner.ID]
	fixture.manager.handshakeMu.Unlock()
	if activeHandshakes != 2 || userHandshakes != 2 {
		t.Fatalf("handshake counts global=%d user=%d, want 2/2", activeHandshakes, userHandshakes)
	}

	_ = first.CloseNow()
	_ = second.CloseNow()
	_ = receiveWithin(t, firstServed)
	_ = receiveWithin(t, secondServed)
	fixture.manager.handshakeMu.Lock()
	defer fixture.manager.handshakeMu.Unlock()
	if fixture.manager.handshakes != 0 || len(fixture.manager.handshakesByUser) != 0 {
		t.Fatalf("handshake slots leaked: global=%d users=%#v", fixture.manager.handshakes, fixture.manager.handshakesByUser)
	}
}

func TestHandshakeAdmissionPrecedesSessionLookupForNonUpgradeRequests(t *testing.T) {
	fixture := newLiveFixture(t, nil)
	entered := make(chan struct{}, maxLiveStreamsPerUser)
	release := make(chan struct{})
	fixture.manager.afterHandshakeAdmission = func() {
		entered <- struct{}{}
		<-release
	}

	served := make(chan error, maxLiveStreamsPerUser)
	for index := range maxLiveStreamsPerUser {
		go func() {
			request := httptest.NewRequest(http.MethodGet, "/api/v1/sessions/ises_missing/live", nil)
			served <- fixture.manager.ServeLive(
				httptest.NewRecorder(), request, fixture.owner, fixture.browserSession,
				fmt.Sprintf("ises_missing_%d", index),
			)
		}()
	}
	for range maxLiveStreamsPerUser {
		receiveWithin(t, entered)
	}

	// This request is not a WebSocket upgrade and names no real session. It
	// must nevertheless fail at the per-user admission boundary before it can
	// join SQLite's single-connection queue.
	overflow := make(chan error, 1)
	go func() {
		request := httptest.NewRequest(http.MethodGet, "/api/v1/sessions/ises_missing/live", nil)
		overflow <- fixture.manager.ServeLive(
			httptest.NewRecorder(), request, fixture.owner, fixture.browserSession, "ises_missing_overflow",
		)
	}()
	if err := receiveWithin(t, overflow); !errors.Is(err, ErrUserCapacity) {
		t.Fatalf("overflow preflight error = %v, want ErrUserCapacity", err)
	}

	close(release)
	for range maxLiveStreamsPerUser {
		if err := receiveWithin(t, served); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("admitted missing-session error = %v, want store.ErrNotFound", err)
		}
	}
	fixture.manager.handshakeMu.Lock()
	defer fixture.manager.handshakeMu.Unlock()
	if fixture.manager.handshakes != 0 || len(fixture.manager.handshakesByUser) != 0 {
		t.Fatalf(
			"preflight handshake slots leaked: global=%d users=%#v",
			fixture.manager.handshakes, fixture.manager.handshakesByUser,
		)
	}
}

func TestHandshakeGlobalAdmissionLimit(t *testing.T) {
	fixture := newLiveFixture(t, nil)
	releases := make([]func(), 0, maxGlobalLiveStreams)
	for index := range maxGlobalLiveStreams {
		release, err := fixture.manager.beginHandshake(fmt.Sprintf("usr_handshake_%d", index))
		if err != nil {
			t.Fatalf("handshake %d: %v", index, err)
		}
		releases = append(releases, release)
	}
	if _, err := fixture.manager.beginHandshake("usr_handshake_overflow"); !errors.Is(err, ErrGlobalCapacity) {
		t.Fatalf("global handshake overflow error = %v", err)
	}
	for _, release := range releases {
		release()
	}
}

func TestPromotedLeaseFinalizesWhenRevokedBeforeServe(t *testing.T) {
	fixture := newLiveFixture(t, nil)
	secondBrowser := createLiveBrowserSession(
		t, fixture.database, fixture.owner.ID, "ses_live_promoted",
		time.Now().UTC().Add(time.Hour), "promoted-browser-token-with-enough-entropy",
	)
	current, currentServed := startReadyLive(
		t, fixture.manager, fixture.owner, fixture.browserSession, fixture.session.ID, 16_000,
	)
	promoted := make(chan struct{})
	continueWait := make(chan struct{})
	fixture.manager.afterPromotion = func() {
		close(promoted)
		<-continueWait
	}
	wsURL, candidateServed := startManagerServer(t, fixture.manager, fixture.owner, secondBrowser, fixture.session.ID)
	candidate := dialLive(t, wsURL)
	writeDone := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), liveTestTimeout)
		defer cancel()
		payload, _ := json.Marshal(validLiveHello(16_000))
		writeDone <- candidate.Write(ctx, websocket.MessageText, payload)
	}()
	<-promoted
	fixture.manager.RevokeBrowserSession(secondBrowser.ID)
	close(continueWait)
	if err := <-writeDone; err != nil {
		t.Fatalf("candidate hello write: %v", err)
	}

	currentError := readLiveMessage(t, current)
	if currentError.Type != "error" || currentError.Code != "SESSION_REPLACED" {
		t.Fatalf("predecessor replacement = %#v", currentError)
	}
	assertCloseStatus(t, current, websocket.StatusPolicyViolation)
	if err := receiveWithin(t, currentServed); err != nil {
		t.Fatalf("predecessor ServeLive returned %v", err)
	}
	candidateError := readLiveMessage(t, candidate)
	if candidateError.Type != "error" || candidateError.Code != "AUTH_REVOKED" {
		t.Fatalf("promoted candidate revoke = %#v", candidateError)
	}
	assertCloseStatus(t, candidate, websocket.StatusPolicyViolation)
	if err := receiveWithin(t, candidateServed); err != nil {
		t.Fatalf("candidate ServeLive returned %v", err)
	}
	session, err := fixture.database.GetInterpretationSession(context.Background(), fixture.owner.ID, fixture.session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if session.Status != domain.InterpretationCompleted || session.EndedAt == nil {
		t.Fatalf("pre-serve abort left session stale: %#v", session)
	}
	if starts := fixture.provider.startCount(); starts != 1 {
		t.Fatalf("revoked promoted lease started ASR; starts=%d", starts)
	}
}

func TestReplacedGenerationCannotReclaimFinalizedSessionLive(t *testing.T) {
	fixture := newLiveFixture(t, nil)
	first := newTestLease(fixture.manager, fixture.session.ID, fixture.browserSession.ID, fixture.owner.ID)
	if _, err := admitTestLease(fixture.manager, first); err != nil {
		t.Fatal(err)
	}
	second := newTestLease(fixture.manager, fixture.session.ID, fixture.browserSession.ID, fixture.owner.ID)
	old, err := admitTestLease(fixture.manager, second)
	if err != nil || old != first {
		t.Fatalf("replacement old=%p err=%v", old, err)
	}
	now := time.Now().UTC()
	claimed, err := fixture.manager.claimLive(context.Background(), fixture.owner.ID, fixture.session.ID, second, now)
	if err != nil {
		t.Fatal(err)
	}
	fixture.manager.markEnded(fixture.owner.ID, claimed, second, domain.InterpretationCompleted)
	if _, err := fixture.manager.claimLive(context.Background(), fixture.owner.ID, fixture.session.ID, first, now.Add(time.Second)); !errors.Is(err, errStreamReplaced) {
		t.Fatalf("old generation claimLive error = %v, want errStreamReplaced", err)
	}
	stored, err := fixture.database.GetInterpretationSession(context.Background(), fixture.owner.ID, fixture.session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != domain.InterpretationCompleted || stored.EndedAt == nil {
		t.Fatalf("old generation overwrote final state: %#v", stored)
	}
	fixture.manager.release(first)
	fixture.manager.release(second)
}

func TestManagerAtomicallyClaimsFreshMetadataBeforeProviderStart(t *testing.T) {
	translator := newFakeTranslator()
	translator.response = translate.Response{Translation: "testo tradotto", RequestID: "req_claimed_metadata"}
	fixture := newLiveFixture(t, translator)
	workspaceService, err := workspace.New(fixture.database)
	if err != nil {
		t.Fatal(err)
	}
	reachedClaimBoundary := make(chan struct{})
	allowClaim := make(chan struct{})
	fixture.manager.afterPromotion = func() {
		close(reachedClaimBoundary)
		<-allowClaim
	}

	wsURL, served := startManagerServer(t, fixture.manager, fixture.owner, fixture.browserSession, fixture.session.ID)
	connection := dialLive(t, wsURL)
	writeClientJSON(t, connection, validLiveHello(16_000))
	<-reachedClaimBoundary

	updated, err := workspaceService.Update(context.Background(), fixture.owner.ID, fixture.session.ID, workspace.UpdateInput{
		Title: "Claimed metadata", SourceLanguage: "de-DE", TargetLanguage: "it-IT",
	})
	if err != nil {
		t.Fatalf("metadata update before claim: %v", err)
	}
	close(allowClaim)

	start := receiveWithin(t, fixture.provider.started)
	if start.Language != updated.SourceLanguage {
		t.Fatalf("ASR language = %q, want freshly claimed %q", start.Language, updated.SourceLanguage)
	}
	stored, err := fixture.database.GetInterpretationSession(context.Background(), fixture.owner.ID, fixture.session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != domain.InterpretationLive || stored.Title != updated.Title ||
		stored.SourceLanguage != updated.SourceLanguage || stored.TargetLanguage != updated.TargetLanguage ||
		stored.StartedAt == nil || stored.EndedAt != nil {
		t.Fatalf("claimed session/provider mismatch: stored=%#v updated=%#v", stored, updated)
	}
	if _, err := workspaceService.Update(context.Background(), fixture.owner.ID, fixture.session.ID, workspace.UpdateInput{
		Title: "Too late", SourceLanguage: "es", TargetLanguage: "pt",
	}); !errors.Is(err, workspace.ErrSessionLive) {
		t.Fatalf("metadata update after claim = %v, want ErrSessionLive", err)
	}
	if err := workspaceService.Delete(context.Background(), fixture.owner.ID, fixture.session.ID); !errors.Is(err, workspace.ErrSessionLive) {
		t.Fatalf("delete after claim = %v, want ErrSessionLive", err)
	}

	ready := readLiveMessage(t, connection)
	if ready.Type != "ready" || ready.SessionID != fixture.session.ID {
		t.Fatalf("ready message = %#v", ready)
	}
	fixture.stream.emit(t, asr.Event{
		Type: "final", Sequence: 1, Text: "Guten Tag", Language: "es", EndMS: 400,
	})
	if final := readLiveMessage(t, connection); final.Type != "final" {
		t.Fatalf("final message = %#v", final)
	}
	translationRequest := receiveWithin(t, translator.started)
	if translationRequest != (translate.Request{
		SourceLanguage: updated.SourceLanguage,
		TargetLanguage: updated.TargetLanguage,
		Text:           "Guten Tag",
	}) {
		t.Fatalf("translator request did not use claimed metadata: %#v", translationRequest)
	}
	if translated := readLiveMessage(t, connection); translated.Type != "translation" ||
		translated.Status != string(domain.TranslationSucceeded) {
		t.Fatalf("translation message = %#v", translated)
	}
	writeClientJSON(t, connection, map[string]string{"type": "end"})
	if stopped := readLiveMessage(t, connection); stopped.Type != "stopped" {
		t.Fatalf("stop message = %#v", stopped)
	}
	assertCloseStatus(t, connection, websocket.StatusNormalClosure)
	if err := receiveWithin(t, served); err != nil {
		t.Fatalf("ServeLive returned %v", err)
	}
}

func TestManagerDeleteBeforeClaimPreventsProviderStart(t *testing.T) {
	fixture := newLiveFixture(t, nil)
	workspaceService, err := workspace.New(fixture.database)
	if err != nil {
		t.Fatal(err)
	}
	reachedClaimBoundary := make(chan struct{})
	allowClaim := make(chan struct{})
	fixture.manager.afterPromotion = func() {
		close(reachedClaimBoundary)
		<-allowClaim
	}

	wsURL, served := startManagerServer(t, fixture.manager, fixture.owner, fixture.browserSession, fixture.session.ID)
	connection := dialLive(t, wsURL)
	writeClientJSON(t, connection, validLiveHello(16_000))
	<-reachedClaimBoundary
	if err := workspaceService.Delete(context.Background(), fixture.owner.ID, fixture.session.ID); err != nil {
		t.Fatalf("delete before claim: %v", err)
	}
	close(allowClaim)

	message := readLiveMessage(t, connection)
	if message.Type != "error" || message.Code != "LIVE_STOPPED" {
		t.Fatalf("deleted-session terminal message = %#v", message)
	}
	assertCloseStatus(t, connection, websocket.StatusInternalError)
	if err := receiveWithin(t, served); err != nil {
		t.Fatalf("ServeLive returned %v", err)
	}
	if starts := fixture.provider.startCount(); starts != 0 {
		t.Fatalf("ASR started %d times after delete won claim race", starts)
	}
	if _, err := fixture.database.GetInterpretationSession(context.Background(), fixture.owner.ID, fixture.session.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("deleted session was recreated or mutated: %v", err)
	}
}

func TestManagerAcquireAndRevocationInterleavingHasNoAuthorizationGap(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*testing.T, *liveFixture)
		revoke func(*liveFixture)
	}{
		{
			name: "logout wins before lease registration",
			mutate: func(t *testing.T, fixture *liveFixture) {
				if err := fixture.database.DeleteBrowserSession(context.Background(), fixture.browserToken); err != nil {
					t.Fatal(err)
				}
			},
			revoke: func(fixture *liveFixture) { fixture.manager.RevokeBrowserSession(fixture.browserSession.ID) },
		},
		{
			name: "disable wins before lease registration",
			mutate: func(t *testing.T, fixture *liveFixture) {
				if err := fixture.database.UpdateUserStatus(context.Background(), fixture.owner.ID, domain.UserDisabled, time.Now().UTC()); err != nil {
					t.Fatal(err)
				}
			},
			revoke: func(fixture *liveFixture) { fixture.manager.RevokeUser(fixture.owner.ID) },
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := newLiveFixture(t, nil)
			test.mutate(t, &fixture)
			test.revoke(&fixture) // no lease is indexed yet
			current, leaseCtx := newTestLeaseWithContext(fixture.manager, fixture.session.ID, fixture.browserSession.ID, fixture.owner.ID)
			if err := fixture.manager.registerPending(current); err != nil {
				t.Fatal(err)
			}
			if err := fixture.database.ValidateBrowserSession(context.Background(), current.userID, current.browserSessionID, time.Now().UTC()); !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("post-acquire validation error = %v, want ErrNotFound", err)
			}
			current.cancel(ErrAuthenticationRevoked)
			if !errors.Is(context.Cause(leaseCtx), ErrAuthenticationRevoked) {
				t.Fatal("post-registration validation did not revoke lease")
			}
			fixture.manager.release(current)
		})
	}

	t.Run("revoke wins after atomic registration", func(t *testing.T) {
		fixture := newLiveFixture(t, nil)
		current, leaseCtx := newTestLeaseWithContext(fixture.manager, fixture.session.ID, fixture.browserSession.ID, fixture.owner.ID)
		registered := make(chan struct{})
		continueValidation := make(chan struct{})
		done := make(chan error, 1)
		go func() {
			err := fixture.manager.registerPending(current)
			close(registered)
			<-continueValidation
			if err == nil {
				err = fixture.database.ValidateBrowserSession(leaseCtx, current.userID, current.browserSessionID, time.Now().UTC())
			}
			done <- err
		}()
		<-registered
		if err := fixture.database.DeleteBrowserSession(context.Background(), fixture.browserToken); err != nil {
			t.Fatal(err)
		}
		fixture.manager.RevokeBrowserSession(fixture.browserSession.ID)
		close(continueValidation)
		<-done
		if !errors.Is(context.Cause(leaseCtx), ErrAuthenticationRevoked) {
			t.Fatalf("lease cause = %v, want ErrAuthenticationRevoked", context.Cause(leaseCtx))
		}
		fixture.manager.release(current)
	})
}

func TestManagerLeaseIndexesAreRaceSafe(t *testing.T) {
	fixture := newLiveFixture(t, nil)
	manager := fixture.manager
	var wait sync.WaitGroup
	for worker := range 16 {
		wait.Add(1)
		go func(worker int) {
			defer wait.Done()
			for iteration := range 100 {
				current := newTestLease(manager, fmt.Sprintf("ises_%d", iteration%2), fmt.Sprintf("ses_%d", worker%3), "usr_race")
				old, err := admitTestLease(manager, current)
				if err != nil {
					continue
				}
				if old != nil {
					old.cancel(errStreamReplaced)
				}
				if iteration%2 == 0 {
					manager.RevokeBrowserSession(current.browserSessionID)
				} else {
					manager.RevokeUser(current.userID)
				}
				manager.release(current)
			}
		}(worker)
	}
	wait.Wait()
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if len(manager.byInterpretation) != 0 || len(manager.pendingByInterpretation) != 0 || len(manager.byBrowserSession) != 0 || len(manager.byUser) != 0 {
		t.Fatalf("lease indexes leaked: interpretations=%d pending=%d sessions=%d users=%d", len(manager.byInterpretation), len(manager.pendingByInterpretation), len(manager.byBrowserSession), len(manager.byUser))
	}
}

type liveFixture struct {
	database       *store.Store
	owner          domain.User
	browserSession domain.BrowserSession
	browserToken   string
	session        domain.InterpretationSession
	stream         *fakeASRStream
	provider       *fakeASRProvider
	manager        *Manager
	cancel         context.CancelFunc
}

func newLiveFixture(t *testing.T, translator translate.Provider) liveFixture {
	t.Helper()
	database, err := store.Open(filepath.Join(t.TempDir(), "state", "live.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Errorf("close store: %v", err)
		}
	})
	owner := liveTestUser("usr_live_owner", "live-owner")
	if err := database.CreateUser(context.Background(), owner); err != nil {
		t.Fatal(err)
	}
	browserToken := "live-browser-token-with-enough-entropy"
	browserSession := createLiveBrowserSession(
		t, database, owner.ID, "ses_live_owner", time.Now().UTC().Add(time.Hour), browserToken,
	)
	session := domain.InterpretationSession{
		ID: "ises_live", UserID: owner.ID, Title: "Live test", SourceLanguage: "en",
		TargetLanguage: "fr", Status: domain.InterpretationCreated,
		CreatedAt: liveTestNow, UpdatedAt: liveTestNow,
	}
	if err := database.CreateInterpretationSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	stream := newFakeASRStream()
	provider := &fakeASRProvider{stream: stream, started: make(chan asr.StartRequest, 4)}
	managerContext, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	manager, err := New(managerContext, database, provider, translator, logger)
	if err != nil {
		t.Fatal(err)
	}
	return liveFixture{
		database: database, owner: owner, browserSession: browserSession, browserToken: browserToken,
		session: session, stream: stream,
		provider: provider, manager: manager,
		cancel: cancel,
	}
}

func createLiveBrowserSession(t *testing.T, database *store.Store, userID, sessionID string, expiresAt time.Time, token string) domain.BrowserSession {
	t.Helper()
	now := time.Now().UTC().Add(-time.Minute)
	session := domain.BrowserSession{
		ID: sessionID, UserID: userID, CreatedAt: now, ExpiresAt: expiresAt,
		LastSeen: now, UserAgent: "live-test", IPAddress: "127.0.0.1",
	}
	if err := database.CreateBrowserSession(context.Background(), session, token); err != nil {
		t.Fatal(err)
	}
	return session
}

func liveTestUser(id, username string) domain.User {
	return domain.User{
		ID: id, WebAuthnID: []byte("webauthn-" + id), Username: username,
		DisplayName: "Live " + username, Role: domain.RoleUser, Status: domain.UserActive,
		CreatedAt: liveTestNow, UpdatedAt: liveTestNow,
	}
}

func startManagerServer(t *testing.T, manager *Manager, user domain.User, browserSession domain.BrowserSession, sessionID string) (string, <-chan error) {
	t.Helper()
	served := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		err := manager.ServeLive(response, request, user, browserSession, sessionID)
		served <- err
		if err != nil {
			http.Error(response, http.StatusText(http.StatusNotFound), http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	return "ws" + strings.TrimPrefix(server.URL, "http"), served
}

func startReadyLive(
	t *testing.T,
	manager *Manager,
	user domain.User,
	browserSession domain.BrowserSession,
	sessionID string,
	sampleRate int,
) (*websocket.Conn, <-chan error) {
	t.Helper()
	wsURL, served := startManagerServer(t, manager, user, browserSession, sessionID)
	connection := dialLive(t, wsURL)
	writeClientJSON(t, connection, validLiveHello(sampleRate))
	ready := readLiveMessage(t, connection)
	if ready.Type != "ready" || ready.SessionID != sessionID {
		t.Fatalf("ready message = %#v", ready)
	}
	return connection, served
}

func validLiveHello(sampleRate int) map[string]any {
	return map[string]any{
		"type": "start",
		"audio": map[string]any{
			"encoding": "pcm32f", "sampleRate": sampleRate, "channels": 1,
		},
	}
}

func assertCloseStatus(t *testing.T, connection *websocket.Conn, want websocket.StatusCode) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), liveTestTimeout)
	defer cancel()
	_, _, err := connection.Read(ctx)
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		t.Fatalf("websocket remained open until assertion deadline: %v", err)
	}
	// Live shutdown deliberately uses CloseNow after its terminal JSON event so
	// a peer that ignores close handshakes cannot retain a server slot. Accept
	// the resulting transport close while still tolerating an already-received
	// protocol close from an older/remote path.
	if status := websocket.CloseStatus(err); status != want && status != -1 {
		t.Fatalf("websocket close status = %v (error %v), want %v", status, err, want)
	}
	if err == nil {
		t.Fatal("websocket remained open")
	}
}

func newTestLease(manager *Manager, interpretationID, browserSessionID, userID string) *lease {
	current, _ := newTestLeaseWithContext(manager, interpretationID, browserSessionID, userID)
	return current
}

func admitTestLease(manager *Manager, current *lease) (*lease, error) {
	if err := manager.registerPending(current); err != nil {
		return nil, err
	}
	return manager.promotePending(current)
}

func newTestLeaseWithContext(manager *Manager, interpretationID, browserSessionID, userID string) (*lease, context.Context) {
	ctx, cancel := context.WithCancelCause(context.Background())
	return &lease{
		generation:       manager.generation.Add(1),
		interpretationID: interpretationID,
		browserSessionID: browserSessionID,
		userID:           userID,
		expiresAt:        time.Now().UTC().Add(time.Hour),
		cancel:           cancel,
		done:             make(chan struct{}),
		readerRelease:    make(chan struct{}),
		readerFinished:   make(chan struct{}),
		writer:           newWriteMutex(),
	}, ctx
}

func dialLive(t *testing.T, url string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), liveTestTimeout)
	defer cancel()
	connection, response, err := websocket.Dial(ctx, url, nil)
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		t.Fatalf("dial live websocket: %v", err)
	}
	t.Cleanup(func() { _ = connection.CloseNow() })
	return connection
}

type liveMessage struct {
	Type             string         `json:"type"`
	Code             string         `json:"code"`
	Message          string         `json:"message"`
	SessionID        string         `json:"sessionId"`
	RunID            string         `json:"runId"`
	ChunkMS          int            `json:"chunkMs"`
	Status           string         `json:"status"`
	Segment          domain.Segment `json:"segment"`
	SegmentID        string         `json:"segmentId"`
	UpstreamSequence int64          `json:"upstreamSequence"`
	DetectedLanguage string         `json:"detectedLanguage"`
	Translation      string         `json:"translation"`
	Error            string         `json:"error"`
	RequestID        string         `json:"requestId"`
}

func readLiveMessage(t *testing.T, connection *websocket.Conn) liveMessage {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), liveTestTimeout)
	defer cancel()
	messageType, payload, err := connection.Read(ctx)
	if err != nil {
		t.Fatalf("read live websocket: %v", err)
	}
	if messageType != websocket.MessageText {
		t.Fatalf("message type = %v, want text", messageType)
	}
	var message liveMessage
	if err := json.Unmarshal(payload, &message); err != nil {
		t.Fatalf("decode live message %q: %v", payload, err)
	}
	return message
}

func writeClientJSON(t *testing.T, connection *websocket.Conn, value any) {
	t.Helper()
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	writeClient(t, connection, websocket.MessageText, payload)
}

func writeClient(t *testing.T, connection *websocket.Conn, messageType websocket.MessageType, payload []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), liveTestTimeout)
	defer cancel()
	if err := connection.Write(ctx, messageType, payload); err != nil {
		t.Fatalf("write live websocket: %v", err)
	}
}

func receiveWithin[T any](t *testing.T, values <-chan T) T {
	t.Helper()
	select {
	case value := <-values:
		return value
	case <-time.After(liveTestTimeout):
		t.Fatal("timed out waiting for test event")
		var zero T
		return zero
	}
}

type fakeASRProvider struct {
	mu       sync.Mutex
	stream   *fakeASRStream
	started  chan asr.StartRequest
	requests []asr.StartRequest
	startErr error
}

func (p *fakeASRProvider) Ready(context.Context) error { return nil }

func (p *fakeASRProvider) Start(_ context.Context, request asr.StartRequest) (asr.Stream, error) {
	p.mu.Lock()
	p.requests = append(p.requests, request)
	p.mu.Unlock()
	p.started <- request
	if p.startErr != nil {
		return nil, p.startErr
	}
	return p.stream, nil
}

func (p *fakeASRProvider) startCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.requests)
}

type fakeASRStream struct {
	info   asr.StartResponse
	events chan asr.Event
	audio  chan []byte

	eventMu       sync.Mutex
	closed        bool
	mu            sync.Mutex
	forceEOUCalls int
	pingCalls     int
	endCalls      int
	closeCalls    int
}

func newFakeASRStream() *fakeASRStream {
	return &fakeASRStream{
		info:   asr.StartResponse{SessionID: "asr-session", ChunkMS: 20},
		events: make(chan asr.Event, 8), audio: make(chan []byte, 8),
	}
}

func (s *fakeASRStream) Info() asr.StartResponse { return s.info }

func (s *fakeASRStream) SendAudio(ctx context.Context, payload []byte) error {
	copyPayload := append([]byte(nil), payload...)
	select {
	case s.audio <- copyPayload:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *fakeASRStream) ForceEndOfUtterance(context.Context) error {
	s.mu.Lock()
	s.forceEOUCalls++
	s.mu.Unlock()
	s.closeEvents()
	return nil
}

func (s *fakeASRStream) Reset(context.Context) error { return nil }

func (s *fakeASRStream) Ping(context.Context) error {
	s.mu.Lock()
	s.pingCalls++
	s.mu.Unlock()
	return nil
}

func (s *fakeASRStream) End(context.Context) error {
	s.mu.Lock()
	s.endCalls++
	s.mu.Unlock()
	s.closeEvents()
	return nil
}

func (s *fakeASRStream) Events() <-chan asr.Event { return s.events }

func (s *fakeASRStream) Wait() error { return nil }

func (s *fakeASRStream) Close(context.Context) error {
	s.mu.Lock()
	s.closeCalls++
	s.mu.Unlock()
	s.closeEvents()
	return nil
}

func (s *fakeASRStream) emit(t *testing.T, event asr.Event) {
	t.Helper()
	s.eventMu.Lock()
	defer s.eventMu.Unlock()
	if s.closed {
		t.Fatal("emit after fake ASR stream was closed")
	}
	s.events <- event
}

func (s *fakeASRStream) closeEvents() {
	s.eventMu.Lock()
	defer s.eventMu.Unlock()
	if !s.closed {
		close(s.events)
		s.closed = true
	}
}

func (s *fakeASRStream) stopCounts() (forceEOU, end, closeCalls int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.forceEOUCalls, s.endCalls, s.closeCalls
}

type fakeTranslator struct {
	mu       sync.Mutex
	started  chan translate.Request
	release  <-chan struct{}
	requests []translate.Request
	response translate.Response
	err      error
}

func newFakeTranslator() *fakeTranslator {
	return &fakeTranslator{started: make(chan translate.Request, 4)}
}

func (t *fakeTranslator) Ready(context.Context) error { return nil }

func (t *fakeTranslator) Translate(ctx context.Context, request translate.Request) (translate.Response, error) {
	t.mu.Lock()
	t.requests = append(t.requests, request)
	t.mu.Unlock()
	t.started <- request
	if t.release != nil {
		select {
		case <-t.release:
		case <-ctx.Done():
			return translate.Response{}, ctx.Err()
		}
	}
	return t.response, t.err
}

func (t *fakeTranslator) callCount() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.requests)
}
