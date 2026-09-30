package rooms

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/providers"
	"github.com/Tularity/t-lingual/internal/store"
	"github.com/coder/websocket"
)

// fillOwnerStorage gives the fixture's owner a one-megabyte storage limit,
// set by an administrator, and two megabytes of recorded audio.
func fillOwnerStorage(t *testing.T, database *store.Store, session domain.InterpretationSession) {
	t.Helper()
	ctx := context.Background()
	now := time.Now().UTC()
	admin := domain.User{ID: "usr_admin", Username: "admin", DisplayName: "Admin", WebAuthnID: []byte("admin"),
		Role: domain.RoleAdmin, Status: domain.UserActive, CreatedAt: now, UpdatedAt: now}
	if err := database.CreateUser(ctx, admin); err != nil {
		t.Fatal(err)
	}
	if err := database.CreateBrowserSession(ctx, domain.BrowserSession{ID: "browser_admin", UserID: admin.ID, CreatedAt: now,
		ExpiresAt: now.Add(time.Hour), LastSeen: now}, "token_admin"); err != nil {
		t.Fatal(err)
	}
	one := 1
	actor := admin.ID
	if err := database.SetLimitOverridesAsAdmin(ctx, admin.ID, "browser_admin", now, session.UserID, domain.LimitOverrides{StorageMB: &one},
		store.AuditEvent{ID: "audit_limit", ActorUserID: &actor, Action: "user.limits.set", TargetType: "user", TargetID: session.UserID,
			Metadata: []byte(`{}`), CreatedAt: now}, now); err != nil {
		t.Fatal(err)
	}
	part := store.RecordingPart{ID: "part_full", RunID: "run_full", SampleRate: 16000, CreatedAt: now}
	if err := database.CreateRecordingPart(ctx, session.UserID, session.ID, part); err != nil {
		t.Fatal(err)
	}
	if err := database.AdvanceRecordingPart(ctx, session.UserID, session.ID, part.ID, 2<<20); err != nil {
		t.Fatal(err)
	}
}

func TestNobodyRecordsIntoTheSessionsOfAnOwnerWhoseStorageIsFull(t *testing.T) {
	svc, database, resolver, session, viewers := roomFixture(t, nil)
	provider := &flakyASR{streams: make(chan *flakyStream, 4)}
	svc.providers = testProviders{snapshot: providers.Snapshot{ASR: provider}}
	// Someone the owner shared with, who may record.
	sharee := resolver.access[viewers[1].ID]
	sharee.Permission = domain.ShareRecord
	resolver.access[viewers[1].ID] = sharee

	ctx := context.Background()
	for _, viewer := range viewers[:2] {
		if admission, err := svc.Admission(ctx, viewer, session.ID); err != nil || !admission.Allowed {
			t.Fatalf("admission before the storage filled = %#v, %v", admission, err)
		}
	}
	if admission, err := svc.Admission(ctx, viewers[2], session.ID); err != nil || admission.Reason != RefusalNotPermitted {
		t.Fatalf("admission of a viewer who may only watch = %#v, %v", admission, err)
	}

	fillOwnerStorage(t, database, session)
	for _, viewer := range viewers[:2] {
		if admission, err := svc.Admission(ctx, viewer, session.ID); err != nil || admission.Allowed || admission.Reason != RefusalStorageFull {
			t.Fatalf("admission once the owner's storage is full = %#v, %v", admission, err)
		}
	}
	// The sharee's own storage is not what counts: the owner's is.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = svc.ServeRecord(w, r, viewers[1], session.ID, false)
	}))
	defer server.Close()
	dial, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(dial, strings.Replace(server.URL, "http://", "ws://", 1), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if err := conn.Write(dial, websocket.MessageText, []byte(`{"type":"start","audio":{"encoding":"pcm32f","sampleRate":16000,"channels":1}}`)); err != nil {
		t.Fatal(err)
	}
	if _, message, err := conn.Read(dial); err != nil || !strings.Contains(string(message), `"code":"RECORDING_QUOTA"`) || !strings.Contains(string(message), "storage") {
		t.Fatalf("refusal = %s, %v", message, err)
	}
	stored, err := database.GetInterpretationSession(ctx, session.UserID, session.ID)
	if err != nil || stored.Status != domain.InterpretationCreated {
		t.Fatalf("a refused recording claimed the session: %v %v", stored.Status, err)
	}
}

func TestAdmissionSaysWhenRecognitionCannotTakeARecording(t *testing.T) {
	svc, _, _, session, viewers := roomFixture(t, nil)
	provider := &flakyASR{streams: make(chan *flakyStream, 4)}
	provider.down.Store(true)
	svc.providers = testProviders{snapshot: providers.Snapshot{ASR: provider}}
	if admission, err := svc.Admission(context.Background(), viewers[0], session.ID); err != nil || admission.Reason != RefusalRecognitionUnavailable {
		t.Fatalf("admission while recognition is down = %#v, %v", admission, err)
	}
}
