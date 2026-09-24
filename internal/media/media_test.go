package media

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/store"
)

func fixture(t *testing.T) (*Manager, *store.Store, domain.InterpretationSession, string) {
	t.Helper()
	root := t.TempDir()
	db, err := store.Open(filepath.Join(root, "state.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	now := time.Now().UTC()
	user := domain.User{ID: "usr_media", WebAuthnID: []byte("webauthn-media"), Username: "media", DisplayName: "Media", Role: domain.RoleUser, Status: domain.UserActive, CreatedAt: now, UpdatedAt: now}
	if err := db.CreateUser(context.Background(), user); err != nil {
		t.Fatal(err)
	}
	session := domain.InterpretationSession{ID: "session_media", UserID: user.ID, Title: "Audio", SourceLanguage: "en", TargetLanguage: "zh-Hans", Status: domain.InterpretationCreated, CreatedAt: now, UpdatedAt: now}
	if err := db.CreateInterpretationSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	manager, err := New(db, root)
	if err != nil {
		t.Fatal(err)
	}
	return manager, db, session, root
}
func TestRecordingDurableResumeWAVRangeAndOwnership(t *testing.T) {
	m, _, session, root := fixture(t)
	ctx := context.Background()
	writer, offset, err := m.Begin(ctx, session.UserID, session.ID, "run_one", 16000)
	if err != nil || offset != 0 {
		t.Fatalf("begin %d %v", offset, err)
	}
	pcm := make([]byte, 64000)
	binary.LittleEndian.PutUint32(pcm[4:], 0x3f800000)
	if err := writer.Append(ctx, pcm); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := New(m.db, root)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := reopened.DurationMS(ctx, session.UserID, session.ID); err != nil || got != 1000 {
		t.Fatalf("duration %d %v", got, err)
	}
	second, start, err := reopened.Begin(ctx, session.UserID, session.ID, "run_two", 16000, 100)
	if err != nil || start != 1000 {
		t.Fatalf("resume %d %v", start, err)
	}
	if err := second.Append(ctx, pcm[:32000]); err != nil {
		t.Fatal(err)
	}
	second.Close()
	parts, err := reopened.List(ctx, session.UserID, session.ID)
	if err != nil || len(parts) != 2 || parts[0].StartMS != 0 || parts[0].DurationMS != 1000 || parts[1].StartMS != 1000 || parts[1].DurationMS != 500 {
		t.Fatalf("parts %#v %v", parts, err)
	}
	if _, _, err := reopened.OpenWAV(ctx, "usr_other", session.ID, parts[0].ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("foreign audio: %v", err)
	}
	if _, err := reopened.List(ctx, session.UserID, "../session_media"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("traversal: %v", err)
	}
	reader, length, err := reopened.OpenWAV(ctx, session.UserID, session.ID, parts[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	if length != int64(len(pcm)+44) {
		t.Fatalf("length %d", length)
	}
	head := make([]byte, 44)
	if _, err := io.ReadFull(reader, head); err != nil || !bytes.Equal(head[:4], []byte("RIFF")) || binary.LittleEndian.Uint16(head[20:]) != 3 {
		t.Fatalf("wav header %q %v", head, err)
	}
	if _, err := reader.Seek(48, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	sample := make([]byte, 4)
	if _, err := io.ReadFull(reader, sample); err != nil || binary.LittleEndian.Uint32(sample) != 0x3f800000 {
		t.Fatalf("seek sample %x %v", sample, err)
	}
}
func TestCrashTailReconciliationAndCommittedTruncation(t *testing.T) {
	m, db, session, _ := fixture(t)
	ctx := context.Background()
	w, _, err := m.Begin(ctx, session.UserID, session.ID, "run_a", 8000)
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Append(ctx, make([]byte, 3200)); err != nil {
		t.Fatal(err)
	}
	w.Close()
	parts, err := db.ListRecordingParts(ctx, session.UserID, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	path := m.path(session.ID, parts[0].ID)
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write(make([]byte, 3200)); err != nil {
		t.Fatal(err)
	}
	f.Sync()
	f.Close()
	if got, err := m.DurationMS(ctx, session.UserID, session.ID); err != nil || got != 200 {
		t.Fatalf("recover tail %d %v", got, err)
	}
	if err := os.Truncate(path, 3200); err != nil {
		t.Fatal(err)
	}
	if _, err := m.List(ctx, session.UserID, session.ID); err == nil {
		t.Fatal("committed truncation not detected")
	}
}
