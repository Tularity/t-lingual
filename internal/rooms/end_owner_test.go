package rooms

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
)

func TestEndingAnOwnersRecordingsStopsEveryOneOfThemAndWaits(t *testing.T) {
	svc, _, resolver, session, viewers := roomFixture(t, nil)
	start := func(id uint64, viewer domain.Viewer, sessionID string) *recordLease {
		access := resolver.access[viewer.ID]
		access.Session.ID = sessionID
		ctx, cancel := context.WithCancelCause(context.Background())
		lease := &recordLease{id: id, viewer: viewer, access: access, ctx: ctx, cancel: cancel, done: make(chan struct{})}
		// Stands in for the recording loop: it ends when its lease is cancelled.
		go func() { <-ctx.Done(); time.Sleep(20 * time.Millisecond); close(lease.done) }()
		if _, err := svc.reserveRecorder(lease, false, false, 4); err != nil {
			t.Fatal(err)
		}
		return lease
	}
	first := start(1, viewers[1], session.ID)
	second := start(2, viewers[0], "session_2")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := svc.EndOwnerRecordings(ctx, session.UserID); err != nil {
		t.Fatal(err)
	}
	for _, lease := range []*recordLease{first, second} {
		select {
		case <-lease.done:
		default:
			t.Fatal("returned before a recording ended")
		}
		if !errors.Is(context.Cause(lease.ctx), ErrStopped) {
			t.Fatalf("recording ended with %v", context.Cause(lease.ctx))
		}
	}
	if err := svc.EndOwnerRecordings(ctx, "someone_else"); err != nil {
		t.Fatalf("an owner with no recordings = %v", err)
	}
}
