package media

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/store"
)

type stalledWriter struct {
	once             sync.Once
	entered, release chan struct{}
	payload          bytes.Buffer
}

func (w *stalledWriter) Write(p []byte) (int, error) {
	w.once.Do(func() { close(w.entered) })
	<-w.release
	return w.payload.Write(p)
}

func TestSlowBundleDoesNotBlockNewRunAndPinsDeletion(t *testing.T) {
	m, _, session, _ := fixture(t)
	ctx := context.Background()
	first, _, err := m.Begin(ctx, session.UserID, session.ID, "run_old", 8000)
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Append(ctx, make([]byte, 3200)); err != nil {
		t.Fatal(err)
	}
	first.Close()
	w := &stalledWriter{entered: make(chan struct{}), release: make(chan struct{})}
	done := make(chan error, 1)
	go func() { done <- m.WriteBundle(ctx, session.UserID, session.ID, w) }()
	select {
	case <-w.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("bundle did not reach writer")
	}
	deleteCalled := false
	if err := m.DeleteSessionWithMedia(ctx, session.UserID, session.ID, func(context.Context) error { deleteCalled = true; return nil }); !errors.Is(err, store.ErrConflict) || deleteCalled {
		t.Fatalf("pinned delete %v callback=%t", err, deleteCalled)
	}
	begun := make(chan error, 1)
	go func() {
		second, _, err := m.Begin(ctx, session.UserID, session.ID, "run_new", 8000)
		if err == nil {
			err = second.Append(ctx, make([]byte, 3200))
			if closeErr := second.Close(); err == nil {
				err = closeErr
			}
		}
		begun <- err
	}()
	select {
	case err := <-begun:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("slow HTTP bundle blocked recording")
	}
	close(w.release)
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("bundle did not finish")
	}
	parts, err := m.List(ctx, session.UserID, session.ID)
	if err != nil || len(parts) != 2 {
		t.Fatalf("new recording missing: %#v %v", parts, err)
	}
}
func TestDeleteSessionQuarantineRollbackCleanupAndRecovery(t *testing.T) {
	m, db, session, _ := fixture(t)
	ctx := context.Background()
	writer, _, err := m.Begin(ctx, session.UserID, session.ID, "run_delete", 8000)
	if err != nil {
		t.Fatal(err)
	}
	if err := writer.Append(ctx, make([]byte, 3200)); err != nil {
		t.Fatal(err)
	}
	writer.Close()
	dir := filepath.Join(m.root, session.ID)
	if err := m.DeleteSessionWithMedia(ctx, session.UserID, "../"+session.ID, func(context.Context) error { t.Fatal("traversal callback called"); return nil }); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("traversal delete: %v", err)
	}
	if err := m.DeleteSessionWithMedia(ctx, "usr_other", session.ID, func(context.Context) error { t.Fatal("foreign delete called"); return nil }); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("foreign delete: %v", err)
	}
	if err := m.DeleteSessionWithMedia(ctx, session.UserID, session.ID, func(context.Context) error { return store.ErrConflict }); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("rollback: %v", err)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("session not restored: %v", err)
	}
	// Simulate interruption immediately after the quarantine rename.
	if err := os.MkdirAll(m.trashDir(), 0700); err != nil {
		t.Fatal(err)
	}
	abandoned := filepath.Join(m.trashDir(), session.ID+"."+session.UserID+".trash_crash")
	if err := os.Rename(dir, abandoned); err != nil {
		t.Fatal(err)
	}
	if err := m.RecoverTrash(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("crash rollback: %v", err)
	}
	if err := m.DeleteSessionWithMedia(ctx, session.UserID, session.ID, func(ctx context.Context) error {
		return db.DeleteInterpretationSessionIfNotLive(ctx, session.UserID, session.ID)
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("session bytes retained after deletion: %v", err)
	}
	if _, err := db.GetInterpretationSession(ctx, session.UserID, session.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("central session retained: %v", err)
	}
}
func TestRecoveryReclaimsCommittedQuarantine(t *testing.T) {
	m, db, session, _ := fixture(t)
	ctx := context.Background()
	writer, _, err := m.Begin(ctx, session.UserID, session.ID, "run_recover", 8000)
	if err != nil {
		t.Fatal(err)
	}
	if err := writer.Append(ctx, make([]byte, 3200)); err != nil {
		t.Fatal(err)
	}
	writer.Close()
	if err := os.MkdirAll(m.trashDir(), 0700); err != nil {
		t.Fatal(err)
	}
	abandoned := filepath.Join(m.trashDir(), session.ID+"."+session.UserID+".trash_after_delete")
	if err := os.Rename(filepath.Join(m.root, session.ID), abandoned); err != nil {
		t.Fatal(err)
	}
	if err := db.DeleteInterpretationSessionIfNotLive(ctx, session.UserID, session.ID); err != nil {
		t.Fatal(err)
	}
	if err := m.RecoverTrash(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(abandoned); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("orphan bytes retained: %v", err)
	}
}
