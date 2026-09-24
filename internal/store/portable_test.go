package store

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
	_ "modernc.org/sqlite"
)

func TestPortableSnapshotContainsOwnTranscriptAndNoSecrets(t *testing.T) {
	db, _ := newTestStore(t)
	ctx := context.Background()
	owner := testUser("usr_portable", "portable", domain.RoleUser)
	mustCreateUser(t, db, owner)
	session := archiveTestSession("session_portable", owner.ID, testNow, domain.InterpretationCompleted)
	if err := db.CreateInterpretationSession(ctx, session); err != nil {
		t.Fatal(err)
	}
	if err := db.AppendSegment(ctx, owner.ID, domain.Segment{ID: "seg_portable", SessionID: session.ID, UserID: owner.ID, Sequence: 1, SourceText: "hello", SpeakerID: "speaker_1", Translation: "你好", Final: true, StartMS: 0, EndMS: 400, CreatedAt: testNow.Add(time.Second)}); err != nil {
		t.Fatal(err)
	}
	if err := db.FlushPortableSession(ctx, "usr_other", session.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign snapshot: %v", err)
	}
	if err := db.FlushPortableSession(ctx, owner.ID, "../session_portable"); err == nil {
		t.Fatal("traversal accepted")
	}
	if err := db.FlushPortableSession(ctx, owner.ID, session.ID); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(db.DataRoot(), "sessions", session.ID)
	file, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(file), "session_portable") || strings.Contains(string(file), owner.ID) {
		t.Fatalf("manifest identity leak: %s", file)
	}
	portable, err := sql.Open("sqlite", filepath.Join(dir, "transcript.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer portable.Close()
	var text, speaker string
	if err := portable.QueryRow(`SELECT source_text,speaker_id FROM segments`).Scan(&text, &speaker); err != nil {
		t.Fatal(err)
	}
	if text != "hello" || speaker != "speaker_1" {
		t.Fatalf("snapshot %q %q", text, speaker)
	}
	var n int
	if err := portable.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE name IN ('users','browser_sessions','session_shares','provider_endpoints')`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("secret table count %d %v", n, err)
	}
}
