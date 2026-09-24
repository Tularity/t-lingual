package rooms

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/asr"
	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/providers"
	"github.com/Tularity/t-lingual/internal/store"
	"github.com/Tularity/t-lingual/internal/translate"
	"github.com/coder/websocket"
)

type testResolver struct {
	mu     sync.Mutex
	access map[string]domain.SessionAccess
	denied map[string]bool
}

type deadlineWatchWriter struct {
	*httptest.ResponseRecorder
	mu        sync.Mutex
	deadlines []time.Time
	flushed   chan struct{}
}

func (w *deadlineWatchWriter) SetWriteDeadline(deadline time.Time) error {
	w.mu.Lock()
	w.deadlines = append(w.deadlines, deadline)
	w.mu.Unlock()
	return nil
}
func (w *deadlineWatchWriter) Flush() {
	w.ResponseRecorder.Flush()
	select {
	case w.flushed <- struct{}{}:
	default:
	}
}
func (w *deadlineWatchWriter) times() []time.Time {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]time.Time(nil), w.deadlines...)
}

func (r *testResolver) Resolve(_ context.Context, viewer domain.Viewer, _ string) (domain.SessionAccess, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.denied[viewer.ID] {
		return domain.SessionAccess{}, store.ErrNotFound
	}
	access, ok := r.access[viewer.ID]
	if !ok {
		return domain.SessionAccess{}, store.ErrNotFound
	}
	return access, nil
}

type testProviders struct{ snapshot providers.Snapshot }

func (p testProviders) Snapshot() providers.Snapshot { return p.snapshot }

type testTranslator struct {
	mu      sync.Mutex
	calls   map[string]int
	sources map[string]string
}

func (p *testTranslator) Ready(context.Context) error { return nil }
func (p *testTranslator) Translate(_ context.Context, request translate.Request) (translate.Response, error) {
	p.mu.Lock()
	p.calls[request.TargetLanguage]++
	if p.sources == nil {
		p.sources = make(map[string]string)
	}
	p.sources[request.TargetLanguage] = request.SourceLanguage
	p.mu.Unlock()
	source := request.SourceLanguage
	if source == "auto" {
		source = "en"
	}
	result := translate.Response{Translation: "translated-" + request.TargetLanguage, SourceLanguage: source, RequestID: "req-" + request.TargetLanguage}
	if request.SourceLanguage == "auto" {
		result.SourceDetection = &translate.SourceDetection{Method: "fasttext-lid.176", Confidence: .9, Rank: 1}
	}
	return result, nil
}
func (p *testTranslator) source(target string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.sources[target]
}

type rejectingAutoTranslator struct{}

func (*rejectingAutoTranslator) Ready(context.Context) error { return nil }
func (*rejectingAutoTranslator) Translate(_ context.Context, request translate.Request) (translate.Response, error) {
	if request.SourceLanguage != "auto" {
		return translate.Response{}, errors.New("expected auto source")
	}
	return translate.Response{}, &translate.ProviderError{StatusCode: 422, Code: "language_identification_failed"}
}

type heldTranslator struct {
	started chan struct{}
	release chan struct{}
	calls   atomic.Int32
	once    sync.Once
}

func (*heldTranslator) Ready(context.Context) error { return nil }
func (p *heldTranslator) Translate(ctx context.Context, request translate.Request) (translate.Response, error) {
	p.calls.Add(1)
	p.once.Do(func() { close(p.started) })
	select {
	case <-p.release:
		return translate.Response{Translation: "held-" + request.TargetLanguage, SourceLanguage: "en"}, nil
	case <-ctx.Done():
		return translate.Response{}, ctx.Err()
	}
}
func (p *testTranslator) count(target string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.calls[target]
}

func roomFixture(t *testing.T, translator translate.Provider) (*Service, *store.Store, *testResolver, domain.InterpretationSession, []domain.Viewer) {
	t.Helper()
	database, err := store.Open(filepath.Join(t.TempDir(), "rooms.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	now := time.Now().UTC()
	users := []domain.User{
		{ID: "owner", Username: "owner", DisplayName: "Owner", WebAuthnID: []byte("owner"), Role: domain.RoleUser, Status: domain.UserActive, CreatedAt: now, UpdatedAt: now},
		{ID: "guest_user_a", Username: "guest_a", DisplayName: "Alice", WebAuthnID: []byte("guest_a"), Role: domain.RoleUser, Status: domain.UserActive, CreatedAt: now, UpdatedAt: now},
		{ID: "guest_user_b", Username: "guest_b", DisplayName: "Bob", WebAuthnID: []byte("guest_b"), Role: domain.RoleUser, Status: domain.UserActive, CreatedAt: now, UpdatedAt: now},
	}
	viewers := make([]domain.Viewer, 0, len(users))
	for _, user := range users {
		if err := database.CreateUser(context.Background(), user); err != nil {
			t.Fatal(err)
		}
		browser := domain.BrowserSession{ID: "browser_" + user.ID, UserID: user.ID, CreatedAt: now,
			ExpiresAt: now.Add(time.Hour), LastSeen: now, UserAgent: "test", IPAddress: "127.0.0.1"}
		if err := database.CreateBrowserSession(context.Background(), browser, "token_"+user.ID); err != nil {
			t.Fatal(err)
		}
		viewers = append(viewers, domain.Viewer{ID: "user:" + user.ID, UserID: user.ID,
			BrowserSessionID: browser.ID, DisplayName: user.DisplayName})
	}
	session := domain.InterpretationSession{ID: "session_1", UserID: users[0].ID, Title: "Meeting",
		SourceLanguage: "en", TargetLanguage: "zh-Hans", Status: domain.InterpretationCreated,
		CreatedAt: now, UpdatedAt: now}
	if err := database.CreateInterpretationSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	resolver := &testResolver{access: make(map[string]domain.SessionAccess), denied: make(map[string]bool)}
	for i, viewer := range viewers {
		target := "zh-Hans"
		if i == 2 {
			target = "ja"
		}
		permission := domain.ShareView
		if i == 0 {
			permission = domain.ShareRecord
		}
		resolver.access[viewer.ID] = domain.SessionAccess{Session: session, Viewer: viewer,
			Permission: permission, IsOwner: i == 0, TargetLanguage: target}
	}
	svc, err := newService(database, resolver, testProviders{snapshot: providers.Snapshot{Translator: translator}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = svc.Shutdown(ctx)
	})
	return svc, database, resolver, session, viewers
}

func TestTranslationWorkSharedByLanguageNotViewer(t *testing.T) {
	provider := &testTranslator{calls: make(map[string]int)}
	svc, database, _, session, viewers := roomFixture(t, provider)
	segment := domain.Segment{ID: "seg_1", SessionID: session.ID, UserID: session.UserID,
		Sequence: 1, SourceText: "Hello", TranslationStatus: domain.TranslationNotRequested,
		Final: true, StartMS: 0, EndMS: 900, CreatedAt: time.Now().UTC()}
	if err := database.AppendSegment(context.Background(), session.UserID, segment); err != nil {
		t.Fatal(err)
	}
	query := store.SegmentPageQuery{Mode: store.SegmentPageTail, Limit: 10}
	var wait sync.WaitGroup
	for _, viewer := range viewers {
		wait.Add(1)
		go func(viewer domain.Viewer) {
			defer wait.Done()
			if _, err := svc.SegmentWindow(context.Background(), viewer, session.ID, query); err != nil {
				t.Error(err)
			}
		}(viewer)
	}
	wait.Wait()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if provider.count("zh-Hans") == 1 && provider.count("ja") == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if provider.count("zh-Hans") != 1 || provider.count("ja") != 1 {
		t.Fatalf("translator calls: zh=%d ja=%d", provider.count("zh-Hans"), provider.count("ja"))
	}
	for _, viewer := range viewers {
		page, err := svc.SegmentWindow(context.Background(), viewer, session.ID, query)
		if err != nil {
			t.Fatal(err)
		}
		target := "zh-Hans"
		if viewer.ID == viewers[2].ID {
			target = "ja"
		}
		if len(page.Items) != 1 || page.Items[0].Translation != "translated-"+target {
			t.Fatalf("viewer %s projection: %#v", viewer.ID, page.Items)
		}
	}
}

func TestConcurrentWatchersDoNotRestartCompletedTranslation(t *testing.T) {
	provider := &heldTranslator{started: make(chan struct{}), release: make(chan struct{})}
	svc, database, _, session, _ := roomFixture(t, provider)
	segment := domain.Segment{ID: "seg_contention", SessionID: session.ID, UserID: session.UserID,
		Sequence: 1, SourceText: "Hello", TranslationStatus: domain.TranslationNotRequested,
		Final: true, StartMS: 0, EndMS: 900, CreatedAt: time.Now().UTC()}
	if err := database.AppendSegment(context.Background(), session.UserID, segment); err != nil {
		t.Fatal(err)
	}
	snapshot := svc.providers.Snapshot()
	svc.ensureTranslation(context.Background(), session, segment, "zh-Hans", snapshot)
	select {
	case <-provider.started:
	case <-time.After(time.Second):
		t.Fatal("translator did not start")
	}
	var wait sync.WaitGroup
	for range 48 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			svc.ensureTranslation(context.Background(), session, segment, "zh-Hans", snapshot)
		}()
	}
	close(provider.release)
	wait.Wait()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		record, err := database.GetTranslation(context.Background(), session.UserID, session.ID, segment.ID, "zh-Hans")
		if err == nil && record.Status == domain.TranslationSucceeded {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	for range 16 {
		svc.ensureTranslation(context.Background(), session, segment, "zh-Hans", snapshot)
	}
	if got := provider.calls.Load(); got != 1 {
		t.Fatalf("completed language translation invoked %d times", got)
	}
}

func TestUnconfiguredTranslatorDoesNotPoisonColdHistory(t *testing.T) {
	svc, database, _, session, viewers := roomFixture(t, nil)
	segment := domain.Segment{ID: "seg_cold", SessionID: session.ID, UserID: session.UserID,
		Sequence: 1, SourceText: "Hello", TranslationStatus: domain.TranslationNotRequested,
		Final: true, StartMS: 0, EndMS: 900, CreatedAt: time.Now().UTC()}
	if err := database.AppendSegment(context.Background(), session.UserID, segment); err != nil {
		t.Fatal(err)
	}
	query := store.SegmentPageQuery{Mode: store.SegmentPageTail, Limit: 10}
	page, err := svc.SegmentWindow(context.Background(), viewers[1], session.ID, query)
	if err != nil || page.Items[0].TranslationStatus != domain.TranslationNotRequested {
		t.Fatalf("unconfigured translation = %#v, %v", page.Items, err)
	}
	if _, err := database.GetTranslation(context.Background(), session.UserID, session.ID, segment.ID, "zh-Hans"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unconfigured cache = %v, want absent", err)
	}
	provider := &testTranslator{calls: make(map[string]int)}
	svc.providers = testProviders{snapshot: providers.Snapshot{Translator: provider}}
	if _, err := svc.SegmentWindow(context.Background(), viewers[1], session.ID, query); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		record, err := database.GetTranslation(context.Background(), session.UserID, session.ID, segment.ID, "zh-Hans")
		if err == nil && record.Status == domain.TranslationSucceeded {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	page, err = svc.SegmentWindow(context.Background(), viewers[1], session.ID, query)
	if err != nil || page.Items[0].Translation != "translated-zh-Hans" || provider.count("zh-Hans") != 1 {
		t.Fatalf("recovered cold translation = %#v calls=%d err=%v", page.Items, provider.count("zh-Hans"), err)
	}
}

func TestAutoSourceTranslationDeduplicatesAndRetainsProviderLIDError(t *testing.T) {
	provider := &testTranslator{calls: make(map[string]int)}
	svc, database, _, session, viewers := roomFixture(t, provider)
	session.SourceLanguage = "auto"
	segment := domain.Segment{ID: "seg_auto", SessionID: session.ID, UserID: session.UserID,
		Sequence: 1, SourceText: "Hello", DetectedLanguage: "auto", TranslationStatus: domain.TranslationNotRequested,
		Final: true, StartMS: 0, EndMS: 900, CreatedAt: time.Now().UTC()}
	if err := database.AppendSegment(context.Background(), session.UserID, segment); err != nil {
		t.Fatal(err)
	}
	var wait sync.WaitGroup
	for range 12 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			svc.ensureTranslation(context.Background(), session, segment, "zh-Hans", svc.providers.Snapshot())
		}()
	}
	wait.Wait()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		record, err := database.GetTranslation(context.Background(), session.UserID, session.ID, segment.ID, "zh-Hans")
		if err == nil && record.Status == domain.TranslationSucceeded {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if provider.count("zh-Hans") != 1 || provider.source("zh-Hans") != "auto" {
		t.Fatalf("auto source requests=%d source=%q", provider.count("zh-Hans"), provider.source("zh-Hans"))
	}
	access := domain.SessionAccess{Session: session, Viewer: viewers[1], TargetLanguage: "zh-Hans"}
	projected, err := svc.PresentSegments(context.Background(), access, []domain.Segment{segment})
	if err != nil || projected[0].Translation != "translated-zh-Hans" {
		t.Fatalf("auto projection=%#v, %v", projected, err)
	}
	failed := domain.Segment{ID: "seg_auto_422", SessionID: session.ID, UserID: session.UserID,
		Sequence: 2, SourceText: "Unidentified", DetectedLanguage: "auto", TranslationStatus: domain.TranslationNotRequested,
		Final: true, StartMS: 1000, EndMS: 1800, CreatedAt: time.Now().UTC()}
	if err := database.AppendSegment(context.Background(), session.UserID, failed); err != nil {
		t.Fatal(err)
	}
	svc.providers = testProviders{snapshot: providers.Snapshot{Translator: &rejectingAutoTranslator{}}}
	svc.ensureTranslation(context.Background(), session, failed, "zh-Hans", svc.providers.Snapshot())
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		record, err := database.GetTranslation(context.Background(), session.UserID, session.ID, failed.ID, "zh-Hans")
		if err == nil && record.Status == domain.TranslationFailed {
			if record.Error != "language_identification_failed" {
				t.Fatalf("LID error=%q", record.Error)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("provider LID failure was not persisted")
}

func TestAutoSourceDoesNotSkipTextGuessMatchingTarget(t *testing.T) {
	provider := &testTranslator{calls: make(map[string]int)}
	svc, database, _, session, _ := roomFixture(t, provider)
	// An idle edit made after the segment was recorded cannot promote its
	// script-only guess into a proven source language.
	session.SourceLanguage = "zh-Hans"
	segment := domain.Segment{ID: "seg_same_guess", SessionID: session.ID, UserID: session.UserID,
		Sequence: 1, SourceText: "你好世界", DetectedLanguage: "zh-Hans", LanguageSource: "text",
		TranslationStatus: domain.TranslationNotRequested, Final: true, CreatedAt: time.Now().UTC()}
	if err := database.AppendSegment(context.Background(), session.UserID, segment); err != nil {
		t.Fatal(err)
	}
	svc.ensureTranslation(context.Background(), session, segment, "zh-Hans", svc.providers.Snapshot())
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		record, err := database.GetTranslation(context.Background(), session.UserID, session.ID, segment.ID, "zh-Hans")
		if err == nil && record.Status == domain.TranslationSucceeded {
			if provider.count("zh-Hans") != 1 || provider.source("zh-Hans") != "auto" {
				t.Fatalf("auto same-target LID request count=%d source=%q", provider.count("zh-Hans"), provider.source("zh-Hans"))
			}
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("text heuristic incorrectly skipped Translator LID")
}

func TestColdHistorySkipsOnlyCapturedIdenticalSource(t *testing.T) {
	provider := &testTranslator{calls: make(map[string]int)}
	svc, database, _, session, _ := roomFixture(t, provider)
	session.SourceLanguage = "zh-Hans" // current setting differs from recorded English
	segment := domain.Segment{ID: "old_english", SessionID: session.ID, UserID: session.UserID,
		Sequence: 1, SourceText: "Hello", DetectedLanguage: "en", LanguageSource: "session",
		TranslationStatus: domain.TranslationNotRequested, Final: true, CreatedAt: time.Now().UTC()}
	if err := database.AppendSegment(context.Background(), session.UserID, segment); err != nil {
		t.Fatal(err)
	}
	svc.ensureTranslation(context.Background(), session, segment, "en", svc.providers.Snapshot())
	if provider.count("en") != 0 {
		t.Fatal("captured identity translation incorrectly called provider")
	}
	if _, err := database.GetTranslation(context.Background(), session.UserID, session.ID, segment.ID, "en"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("captured identity translation claimed a cache entry: %v", err)
	}
}

func TestColdHistoryUsesCapturedSourceAfterIdleSessionLanguageChange(t *testing.T) {
	provider := &testTranslator{calls: make(map[string]int)}
	svc, database, resolver, session, viewers := roomFixture(t, provider)
	ctx := context.Background()
	// The user records in Chinese, stops, then changes the idle session to
	// English before an English-speaking viewer opens this historical page.
	session.SourceLanguage = "zh-Hans"
	session.TargetLanguage = "en"
	session.UpdatedAt = time.Now().UTC()
	if err := database.UpdateInterpretationSession(ctx, session.UserID, session); err != nil {
		t.Fatal(err)
	}
	old := domain.Segment{ID: "old_chinese", SessionID: session.ID, UserID: session.UserID,
		Sequence: 1, SourceText: "你好，欢迎。", Final: true, DetectedLanguage: "zh-Hans", LanguageSource: "session",
		TranslationStatus: domain.TranslationNotRequested, CreatedAt: time.Now().UTC()}
	if err := database.AppendSegment(ctx, session.UserID, old); err != nil {
		t.Fatal(err)
	}
	session.SourceLanguage = "en"
	session.UpdatedAt = session.UpdatedAt.Add(time.Second)
	if err := database.UpdateInterpretationSession(ctx, session.UserID, session); err != nil {
		t.Fatal(err)
	}
	access := resolver.access[viewers[1].ID]
	access.Session = session
	access.TargetLanguage = "en"
	if _, err := svc.ProjectSegments(ctx, access, []domain.Segment{old}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		record, err := database.GetTranslation(ctx, session.UserID, session.ID, old.ID, "en")
		if err == nil && record.Status == domain.TranslationSucceeded {
			if provider.source("en") != "zh-Hans" {
				t.Fatalf("cold row translated with current session mode %q", provider.source("en"))
			}
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("captured Chinese source was skipped after changing session to English")
}

func TestFinalSourceIdentityUsesCapturedEvidenceOnly(t *testing.T) {
	session := domain.InterpretationSession{SourceLanguage: "en"}
	for _, test := range []struct {
		name, source, origin, want string
	}{
		{"session evidence survives new mode", "zh-Hans", "session", "zh-Hans"},
		{"recognizer evidence survives new mode", "da", "recognizer", "da"},
		{"text guess is not LID", "en", "text", "auto"},
		{"legacy concrete tag", "fr", "", "fr"},
		{"legacy auto sentinel", "auto", "", "auto"},
		{"unknown source", "", "", "auto"},
		{"unsupported legacy tag", "not-a-language", "", "auto"},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := translationSource(translationTask{session: session, segment: domain.Segment{
				Final: true, DetectedLanguage: test.source, LanguageSource: test.origin,
			}})
			if err != nil || got != test.want {
				t.Fatalf("source = %q, %v; want %q", got, err, test.want)
			}
		})
	}
	draft, err := translationSource(translationTask{session: session, segment: domain.Segment{SourceText: "draft"}})
	if err != nil || draft != "en" {
		t.Fatalf("draft did not retain lease mode: %q %v", draft, err)
	}
}

func TestRecordLeaseDeniesStealAndOwnerCanTakeOverWithoutStaleRelease(t *testing.T) {
	svc, _, resolver, session, viewers := roomFixture(t, nil)
	resolver.mu.Lock()
	guestAccess := resolver.access[viewers[1].ID]
	guestAccess.Permission = domain.ShareRecord
	resolver.access[viewers[1].ID] = guestAccess
	resolver.mu.Unlock()
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	holder := &recordLease{id: 1, viewer: viewers[1], access: guestAccess, ctx: ctx, cancel: cancel, done: make(chan struct{})}
	if _, err := svc.reserveRecorder(holder, false); err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/record", nil)
	if err := svc.ServeRecord(response, request, viewers[2], session.ID, false); !errors.Is(err, store.ErrForbidden) {
		// Bob has no recording grant, so permission denial precedes conflict.
		t.Fatalf("view-only record = %v", err)
	}
	response = httptest.NewRecorder()
	if err := svc.ServeRecord(response, request, viewers[1], session.ID, false); err != nil || response.Code != http.StatusConflict {
		t.Fatalf("occupied response = %d, %v", response.Code, err)
	}
	ownerAccess := resolver.access[viewers[0].ID]
	takeoverCtx, takeoverCancel := context.WithCancelCause(context.Background())
	defer takeoverCancel(nil)
	owner := &recordLease{id: 2, viewer: viewers[0], access: ownerAccess, ctx: takeoverCtx,
		cancel: takeoverCancel, done: make(chan struct{})}
	old, err := svc.reserveRecorder(owner, true)
	if err != nil || old != holder {
		t.Fatalf("takeover = %v, %v", old, err)
	}
	holder.cancel(ErrReplaced)
	svc.releaseRecorder(holder, domain.InterpretationCompleted)
	if !svc.State(session.ID).Active || svc.State(session.ID).HolderID != owner.viewer.ID {
		t.Fatal("stale release displaced the new recorder")
	}
	svc.releaseRecorder(owner, domain.InterpretationCompleted)
	if svc.State(session.ID).Active {
		t.Fatal("recorder still active")
	}
}

func TestWatchSnapshotAndRevokedShareClose(t *testing.T) {
	svc, _, resolver, session, viewers := roomFixture(t, nil)
	viewer := viewers[1]
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = svc.ServeWatch(w, r, viewer, session.ID)
	}))
	defer server.Close()
	response, err := http.Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	scanner := bufio.NewScanner(response.Body)
	if !scanner.Scan() {
		t.Fatal("missing snapshot")
	}
	line := scanner.Text()
	if !strings.HasPrefix(line, "data: ") {
		t.Fatalf("SSE line = %q", line)
	}
	var snapshot map[string]json.RawMessage
	if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &snapshot); err != nil {
		t.Fatal(err)
	}
	if string(snapshot["type"]) != `"snapshot"` {
		t.Fatalf("snapshot = %s", line)
	}
	var access struct {
		TargetLanguage string `json:"targetLanguage"`
		ViewerID       string `json:"viewerId"`
	}
	if err := json.Unmarshal(snapshot["access"], &access); err != nil {
		t.Fatal(err)
	}
	if access.ViewerID != viewer.ID || access.TargetLanguage != "zh-Hans" {
		t.Fatalf("access = %#v", access)
	}
	resolver.mu.Lock()
	resolver.denied[viewer.ID] = true
	resolver.mu.Unlock()
	svc.AccessChanged(session.ID)
	closed := make(chan struct{})
	go func() {
		for scanner.Scan() {
		}
		close(closed)
	}()
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("revoked SSE did not close")
	}
}

func TestWatchClearsRootDeadlineOnlyAfterAccessAndBoundsEachWrite(t *testing.T) {
	svc, _, resolver, session, viewers := roomFixture(t, nil)
	viewer := viewers[1]
	writer := &deadlineWatchWriter{ResponseRecorder: httptest.NewRecorder(), flushed: make(chan struct{}, 2)}
	initial := time.Now().Add(10 * time.Second)
	_ = writer.SetWriteDeadline(initial)
	requestCtx, cancel := context.WithCancel(context.Background())
	request := httptest.NewRequest(http.MethodGet, "/watch", nil).WithContext(requestCtx)
	done := make(chan error, 1)
	go func() { done <- svc.ServeWatch(writer, request, viewer, session.ID) }()
	select {
	case <-writer.flushed:
	case <-time.After(time.Second):
		t.Fatal("watch did not flush snapshot")
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	times := writer.times()
	if len(times) < 4 || !times[0].Equal(initial) || !times[1].IsZero() ||
		!times[2].After(time.Now()) || !times[3].IsZero() {
		t.Fatalf("watch deadlines = %#v", times)
	}
	if err := sendSSEHeartbeat(writer); err != nil {
		t.Fatal(err)
	}
	times = writer.times()
	if !times[len(times)-2].After(time.Now()) || !times[len(times)-1].IsZero() {
		t.Fatalf("heartbeat deadlines = %#v", times)
	}
	resolver.mu.Lock()
	resolver.denied[viewer.ID] = true
	resolver.mu.Unlock()
	denied := &deadlineWatchWriter{ResponseRecorder: httptest.NewRecorder(), flushed: make(chan struct{}, 1)}
	_ = denied.SetWriteDeadline(initial)
	if err := svc.ServeWatch(denied, httptest.NewRequest(http.MethodGet, "/watch", nil), viewer, session.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("denied access = %v", err)
	}
	if len(denied.times()) != 1 {
		t.Fatalf("unauthorized deadline was cleared: %#v", denied.times())
	}
}

func TestWatchCapacityLimitsAndRelease(t *testing.T) {
	svc, _, _, session, viewers := roomFixture(t, nil)
	makeWatch := func(id uint64, viewerID string) *watcher {
		return &watcher{id: id, viewer: domain.Viewer{ID: viewerID}}
	}
	var owned []*watcher
	for i := range maxViewerWatchers {
		current := makeWatch(uint64(i+1), viewers[0].ID)
		if _, err := svc.registerWatch(session.ID, current); err != nil {
			t.Fatal(err)
		}
		owned = append(owned, current)
	}
	if _, err := svc.registerWatch("never-created", makeWatch(99, viewers[0].ID)); !errors.Is(err, ErrWatchCapacity) {
		t.Fatalf("per-viewer limit = %v", err)
	}
	if _, exists := svc.rooms["never-created"]; exists {
		t.Fatal("rejected watcher created a room")
	}
	for _, current := range owned {
		svc.releaseWatch(session.ID, current)
	}
	if svc.watchCount != 0 || len(svc.rooms) != 0 || len(svc.watchesByViewer) != 0 {
		t.Fatalf("viewer release leaked state: count=%d rooms=%d index=%d", svc.watchCount, len(svc.rooms), len(svc.watchesByViewer))
	}
	owned = nil
	for i := range maxGlobalWatchers {
		roomID := fmt.Sprintf("room_%d", i/maxRoomWatchers)
		current := makeWatch(uint64(i+1), fmt.Sprintf("viewer_%d", i))
		if _, err := svc.registerWatch(roomID, current); err != nil {
			t.Fatal(err)
		}
		owned = append(owned, current)
		if i == maxRoomWatchers-1 {
			if _, err := svc.registerWatch(roomID, makeWatch(10000, "room-overflow")); !errors.Is(err, ErrWatchCapacity) {
				t.Fatalf("room limit = %v", err)
			}
		}
	}
	if _, err := svc.registerWatch("new-room", makeWatch(9999, "new-viewer")); !errors.Is(err, ErrWatchCapacity) {
		t.Fatalf("global limit = %v", err)
	}
	if _, exists := svc.rooms["new-room"]; exists {
		t.Fatal("global rejection created a room")
	}
	if _, err := svc.registerWatch("room_0", makeWatch(10000, "room-overflow")); !errors.Is(err, ErrWatchCapacity) {
		t.Fatalf("room limit = %v", err)
	}
	svc.releaseWatch("room_0", owned[0])
	if _, err := svc.registerWatch("new-room", makeWatch(10001, "new-viewer")); err != nil {
		t.Fatalf("released capacity not reusable: %v", err)
	}
	for i, current := range owned {
		svc.releaseWatch(fmt.Sprintf("room_%d", i/maxRoomWatchers), current)
	}
	svc.releaseWatch("new-room", makeWatch(10001, "new-viewer")) // Different pointer must not decrement.
	if svc.watchCount != 1 {
		t.Fatalf("nonmember release changed count: %d", svc.watchCount)
	}
	actual := svc.rooms["new-room"].watches[10001]
	svc.releaseWatch("new-room", actual)
	if svc.watchCount != 0 || len(svc.rooms) != 0 || len(svc.watchesByViewer) != 0 {
		t.Fatalf("global release leaked state: count=%d rooms=%d index=%d", svc.watchCount, len(svc.rooms), len(svc.watchesByViewer))
	}
}

func TestBrowserRevocationCancelsRecorderLease(t *testing.T) {
	svc, _, resolver, _, viewers := roomFixture(t, nil)
	access := resolver.access[viewers[0].ID]
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	current := &recordLease{id: 3, viewer: viewers[0], access: access, ctx: ctx,
		cancel: cancel, done: make(chan struct{})}
	if _, err := svc.reserveRecorder(current, false); err != nil {
		t.Fatal(err)
	}
	svc.RevokeBrowserSession(viewers[0].BrowserSessionID)
	if !errors.Is(context.Cause(ctx), ErrAuthRevoked) {
		t.Fatalf("revoke cause = %v", context.Cause(ctx))
	}
	svc.releaseRecorder(current, domain.InterpretationCompleted)
}

type testASR struct {
	starts atomic.Int32
	opened chan *testASRStream
}

func (*testASR) Ready(context.Context) error { return nil }
func (p *testASR) Start(_ context.Context, _ asr.StartRequest) (asr.Stream, error) {
	p.starts.Add(1)
	stream := &testASRStream{events: make(chan asr.Event, 8)}
	p.opened <- stream
	return stream, nil
}

type testASRStream struct {
	events chan asr.Event
	once   sync.Once
	audio  atomic.Int32
}

func (*testASRStream) Info() asr.StartResponse                   { return asr.StartResponse{ChunkMS: 200} }
func (s *testASRStream) SendAudio(context.Context, []byte) error { s.audio.Add(1); return nil }
func (*testASRStream) ForceEndOfUtterance(context.Context) error { return nil }
func (*testASRStream) Reset(context.Context) error               { return nil }
func (*testASRStream) Ping(context.Context) error                { return nil }
func (s *testASRStream) End(context.Context) error               { s.once.Do(func() { close(s.events) }); return nil }
func (s *testASRStream) Events() <-chan asr.Event                { return s.events }
func (*testASRStream) Wait() error                               { return nil }
func (s *testASRStream) Close(context.Context) error             { return s.End(context.Background()) }

func dialRecorder(t *testing.T, url string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, strings.Replace(url, "http://", "ws://", 1), nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel = context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"type":"start","audio":{"encoding":"pcm32f","sampleRate":16000,"channels":1}}`)); err != nil {
		t.Fatal(err)
	}
	_, message, err := conn.Read(ctx)
	if err != nil || !strings.Contains(string(message), `"type":"ready"`) {
		t.Fatalf("ready = %s, %v", message, err)
	}
	return conn
}

func TestRecorderStreamsFinalToWatchersAndPersistsSavedStatus(t *testing.T) {
	svc, database, _, session, viewers := roomFixture(t, nil)
	asrProvider := &testASR{opened: make(chan *testASRStream, 2)}
	svc.providers = testProviders{snapshot: providers.Snapshot{ASR: asrProvider}}
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
		t.Fatal("missing watcher snapshot")
	}
	conn := dialRecorder(t, server.URL+"/record")
	defer conn.CloseNow()
	var stream *testASRStream
	select {
	case stream = <-asrProvider.opened:
	case <-time.After(time.Second):
		t.Fatal("ASR did not start")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageBinary, []byte{1, 0, 0, 0}); err != nil {
		t.Fatal(err)
	}
	stream.events <- asr.Event{Type: "partial", Line: 1, Text: "Hel", Sequence: 1}
	stream.events <- asr.Event{Type: "final", Line: 1, Text: "Hello", Sequence: 2, StartMS: 0, EndMS: 800, Language: "en"}
	seenFinal := make(chan bool, 1)
	go func() {
		for scanner.Scan() {
			if strings.Contains(scanner.Text(), `"type":"final"`) {
				seenFinal <- true
				return
			}
		}
		seenFinal <- false
	}()
	select {
	case seen := <-seenFinal:
		if !seen {
			t.Fatal("watch closed before final")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("watch did not receive final")
	}
	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"type":"end"}`)); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if !svc.State(session.ID).Active {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if svc.State(session.ID).Active {
		t.Fatal("recorder lease remains after end")
	}
	stored, err := database.ListSegments(context.Background(), session.UserID, session.ID)
	if err != nil || len(stored) != 1 || stored[0].SourceText != "Hello" || stream.audio.Load() != 1 {
		t.Fatalf("stored=%#v audio=%d err=%v", stored, stream.audio.Load(), err)
	}
	updated, err := database.GetInterpretationSession(context.Background(), session.UserID, session.ID)
	if err != nil || updated.Status != domain.InterpretationCompleted {
		t.Fatalf("saved status=%s, %v", updated.Status, err)
	}
}

func TestSuddenRecorderCloseReleasesLease(t *testing.T) {
	svc, _, _, session, viewers := roomFixture(t, nil)
	asrProvider := &testASR{opened: make(chan *testASRStream, 1)}
	svc.providers = testProviders{snapshot: providers.Snapshot{ASR: asrProvider}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = svc.ServeRecord(w, r, viewers[0], session.ID, false)
	}))
	defer server.Close()
	conn := dialRecorder(t, server.URL)
	_ = conn.CloseNow()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if !svc.State(session.ID).Active {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("sudden close retained recorder lease")
}

func TestSilentPCMKeepsLeaseButPingOnlyExpires(t *testing.T) {
	svc, database, _, session, viewers := roomFixture(t, nil)
	svc.noAudioTimeout = 150 * time.Millisecond
	asrProvider := &testASR{opened: make(chan *testASRStream, 1)}
	svc.providers = testProviders{snapshot: providers.Snapshot{ASR: asrProvider}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = svc.ServeRecord(w, r, viewers[0], session.ID, false)
	}))
	defer server.Close()
	conn := dialRecorder(t, server.URL)
	defer conn.CloseNow()
	stream := <-asrProvider.opened
	for range 6 {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		if err := conn.Write(ctx, websocket.MessageBinary, make([]byte, 4)); err != nil {
			t.Fatal(err)
		}
		cancel()
		time.Sleep(40 * time.Millisecond)
	}
	if !svc.State(session.ID).Active || stream.audio.Load() != 6 {
		t.Fatalf("quiet meeting was interrupted: active=%t packets=%d", svc.State(session.ID).Active, stream.audio.Load())
	}
	for range 3 {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		_ = conn.Write(ctx, websocket.MessageText, []byte(`{"type":"ping"}`))
		cancel()
		time.Sleep(45 * time.Millisecond)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if !svc.State(session.ID).Active {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if svc.State(session.ID).Active {
		t.Fatal("ping-only connection retained recording lease")
	}
	updated, err := database.GetInterpretationSession(context.Background(), session.UserID, session.ID)
	if err != nil || updated.Status != domain.InterpretationFailed {
		t.Fatalf("missing-audio terminal=%s, %v", updated.Status, err)
	}
}

func TestOnlyOwnerCanStopAnotherRecorder(t *testing.T) {
	svc, _, resolver, session, viewers := roomFixture(t, nil)
	access := resolver.access[viewers[1].ID]
	access.Permission = domain.ShareRecord
	resolver.mu.Lock()
	resolver.access[viewers[1].ID] = access
	resolver.mu.Unlock()
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	current := &recordLease{id: 4, viewer: viewers[1], access: access, ctx: ctx,
		cancel: cancel, done: make(chan struct{})}
	if _, err := svc.reserveRecorder(current, false); err != nil {
		t.Fatal(err)
	}
	if err := svc.StopRecorder(context.Background(), viewers[1], session.ID); !errors.Is(err, store.ErrForbidden) {
		t.Fatalf("collaborator stop = %v", err)
	}
	finished := make(chan error, 1)
	go func() {
		stopCtx, stopCancel := context.WithTimeout(context.Background(), time.Second)
		defer stopCancel()
		finished <- svc.StopRecorder(stopCtx, viewers[0], session.ID)
	}()
	deadline := time.Now().Add(time.Second)
	for context.Cause(ctx) == nil && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !errors.Is(context.Cause(ctx), ErrStopped) {
		t.Fatalf("owner stop cause = %v", context.Cause(ctx))
	}
	svc.releaseRecorder(current, domain.InterpretationCompleted)
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
}
