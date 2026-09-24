package media

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/store"
)

func TestBundleRejectsLiveAndExportsPortableFiles(t *testing.T) {
	m, db, session, _ := fixture(t)
	ctx := context.Background()
	writer, _, err := m.Begin(ctx, session.UserID, session.ID, "run_zip", 8000)
	if err != nil {
		t.Fatal(err)
	}
	if err := writer.Append(ctx, make([]byte, 3200)); err != nil {
		t.Fatal(err)
	}
	writer.Close()
	started := time.Now().UTC()
	if _, err := db.ClaimInterpretationSessionLive(ctx, session.UserID, session.ID, started); err != nil {
		t.Fatal(err)
	}
	var archive bytes.Buffer
	if err := m.WriteBundle(ctx, session.UserID, session.ID, &archive); !errors.Is(err, store.ErrConflict) {
		t.Fatalf("active export %v", err)
	}
	ended := started.Add(time.Minute)
	if err := db.UpdateInterpretationSessionStatus(ctx, session.UserID, session.ID, domain.InterpretationCompleted, &started, &ended, ended); err != nil {
		t.Fatal(err)
	}
	if err := m.WriteBundle(ctx, "usr_foreign", session.ID, &archive); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("foreign export %v", err)
	}
	if err := m.WriteBundle(ctx, session.UserID, session.ID, &archive); err != nil {
		t.Fatal(err)
	}
	z, err := zip.NewReader(bytes.NewReader(archive.Bytes()), int64(archive.Len()))
	if err != nil {
		t.Fatal(err)
	}
	if len(z.File) != 3 || z.File[0].Name != "manifest.json" || z.File[1].Name != "transcript.sqlite" || z.File[2].Name[:6] != "audio/" {
		t.Fatalf("archive contents %#v", z.File)
	}
}
