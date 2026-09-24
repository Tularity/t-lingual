package media

import (
	"archive/zip"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/id"
	"github.com/Tularity/t-lingual/internal/store"
	_ "modernc.org/sqlite"
)

var bundlePins = struct {
	sync.Mutex
	active map[string]int
}{active: make(map[string]int)}

func (m *Manager) pinKey(sessionID string) string { return m.root + "\x00" + sessionID }
func (m *Manager) pin(sessionID string) {
	bundlePins.Lock()
	bundlePins.active[m.pinKey(sessionID)]++
	bundlePins.Unlock()
}
func (m *Manager) unpin(sessionID string) {
	bundlePins.Lock()
	key := m.pinKey(sessionID)
	bundlePins.active[key]--
	if bundlePins.active[key] == 0 {
		delete(bundlePins.active, key)
	}
	bundlePins.Unlock()
}
func (m *Manager) pinned(sessionID string) bool {
	bundlePins.Lock()
	defer bundlePins.Unlock()
	return bundlePins.active[m.pinKey(sessionID)] > 0
}

// WriteBundle snapshots metadata and pins the selected immutable audio parts
// under the file lock, then releases it before slow HTTP ZIP streaming. New
// runs may begin while the export streams; DeleteSessionWithMedia respects pins.
func (m *Manager) WriteBundle(ctx context.Context, ownerID, sessionID string, out io.Writer) error {
	if !validID(sessionID) {
		return store.ErrNotFound
	}
	guard := m.lock(sessionID)
	guard.Lock()
	locked := true
	defer func() {
		if locked {
			guard.Unlock()
		}
	}()
	session, err := m.db.GetInterpretationSession(ctx, ownerID, sessionID)
	if err != nil {
		return err
	}
	if session.Status == domain.InterpretationLive {
		return fmt.Errorf("%w: active recording cannot be exported", store.ErrConflict)
	}
	parts, err := m.reconcile(ctx, ownerID, sessionID)
	if err != nil {
		return err
	}
	if err := m.db.FlushPortableSession(ctx, ownerID, sessionID); err != nil {
		return err
	}
	dir := filepath.Join(m.root, sessionID)
	manifest, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return err
	}
	if len(manifest) > 2<<20 {
		return errors.New("media: oversized session manifest")
	}
	cloneID, err := id.New("export")
	if err != nil {
		return err
	}
	clone := filepath.Join(dir, "."+cloneID+".sqlite")
	defer os.Remove(clone)
	source, err := sql.Open("sqlite", filepath.Join(dir, "transcript.sqlite"))
	if err != nil {
		return err
	}
	if _, err := source.ExecContext(ctx, `VACUUM INTO ?`, clone); err != nil {
		source.Close()
		return fmt.Errorf("media: clone transcript: %w", err)
	}
	if err := source.Close(); err != nil {
		return err
	}
	m.pin(sessionID)
	guard.Unlock()
	locked = false
	defer m.unpin(sessionID)
	archive := zip.NewWriter(out)
	addBytes := func(name string, payload []byte) error {
		entry, err := archive.Create(name)
		if err != nil {
			return err
		}
		_, err = entry.Write(payload)
		return err
	}
	addFile := func(name, path string) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return errors.New("media: unsafe archive source")
		}
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		defer file.Close()
		entry, err := archive.Create(name)
		if err != nil {
			return err
		}
		_, err = io.Copy(entry, &contextReader{ctx: ctx, source: file})
		return err
	}
	if err := addBytes("manifest.json", manifest); err != nil {
		archive.Close()
		return err
	}
	if err := addFile("transcript.sqlite", clone); err != nil {
		archive.Close()
		return err
	}
	for _, part := range parts {
		if err := addFile("audio/"+part.ID+".pcm", m.path(sessionID, part.ID)); err != nil {
			archive.Close()
			return err
		}
	}
	return archive.Close()
}

type contextReader struct {
	ctx    context.Context
	source io.Reader
}

func (r *contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.source.Read(p)
}
