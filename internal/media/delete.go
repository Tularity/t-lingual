package media

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/id"
	"github.com/Tularity/t-lingual/internal/store"
)

func (m *Manager) trashDir() string { return filepath.Join(m.root, ".trash") }
func (m *Manager) safeDirectory(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("media: unsafe session directory")
	}
	root, err := filepath.EvalSymlinks(m.root)
	if err != nil {
		return err
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return err
	}
	rel, err := filepath.Rel(root, resolved)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return errors.New("media: directory escapes session root")
	}
	return nil
}
func (m *Manager) removeTrash(path string) error {
	if err := m.safeDirectory(path); err != nil {
		return err
	}
	return os.RemoveAll(path)
}

// DeleteSessionWithMedia quarantines the private directory, invokes the
// caller's owner-scoped idle-only central delete, then removes quarantined
// bytes. On a rejected delete it restores the directory. Concurrent bundle
// exports pin their immutable source files and make deletion return conflict.
// The callback must delete exactly this session through the authorized API.
func (m *Manager) DeleteSessionWithMedia(ctx context.Context, ownerID, sessionID string, deleteCentral func(context.Context) error) error {
	if !validID(ownerID) || !validID(sessionID) || deleteCentral == nil {
		return store.ErrNotFound
	}
	guard := m.lock(sessionID)
	guard.Lock()
	defer guard.Unlock()
	session, err := m.db.GetInterpretationSession(ctx, ownerID, sessionID)
	if err != nil {
		return err
	}
	if session.Status == domain.InterpretationLive || m.pinned(sessionID) {
		return fmt.Errorf("%w: recording or export is active", store.ErrConflict)
	}
	source := filepath.Join(m.root, sessionID)
	existed := false
	if _, err := os.Lstat(source); err == nil {
		if err := m.safeDirectory(source); err != nil {
			return err
		}
		existed = true
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	quarantine := ""
	if existed {
		if err := os.MkdirAll(m.trashDir(), 0700); err != nil {
			return err
		}
		if err := m.safeDirectory(m.trashDir()); err != nil {
			return err
		}
		nonce, err := id.New("trash")
		if err != nil {
			return err
		}
		quarantine = filepath.Join(m.trashDir(), sessionID+"."+ownerID+"."+nonce)
		if err := os.Rename(source, quarantine); err != nil {
			return fmt.Errorf("media: quarantine session: %w", err)
		}
	}
	restore := func() error {
		if !existed {
			return nil
		}
		if err := m.safeDirectory(quarantine); err != nil {
			return err
		}
		return os.Rename(quarantine, source)
	}
	deleteErr := deleteCentral(ctx)
	// An ambiguous callback may have committed the central deletion. Resolve
	// that state before deciding whether to restore or permanently remove files.
	_, remainingErr := m.db.GetInterpretationSession(context.Background(), ownerID, sessionID)
	if remainingErr == nil {
		if err := restore(); err != nil {
			return fmt.Errorf("media: central delete rejected (%v), restore failed: %w", deleteErr, err)
		}
		if deleteErr != nil {
			return deleteErr
		}
		return errors.New("media: central delete callback did not remove session")
	}
	if !errors.Is(remainingErr, store.ErrNotFound) {
		return fmt.Errorf("media: deletion outcome unknown; preserved quarantine: %w", remainingErr)
	}
	if existed {
		if err := m.removeTrash(quarantine); err != nil {
			return fmt.Errorf("media: session deleted; cleanup pending: %w", err)
		}
	}
	return nil
}

// RecoverTrash runs once at startup before serving requests. A crash before
// central deletion restores the prior directory; a crash after deletion
// reclaims its quarantined bytes. Unknown or unsafe entries are preserved.
func (m *Manager) RecoverTrash(ctx context.Context) error {
	if err := os.MkdirAll(m.root, 0700); err != nil {
		return err
	}
	if _, err := os.Lstat(m.trashDir()); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	if err := m.safeDirectory(m.trashDir()); err != nil {
		return err
	}
	entries, err := os.ReadDir(m.trashDir())
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		parts := strings.Split(entry.Name(), ".")
		if len(parts) != 3 || !validID(parts[0]) || !validID(parts[1]) || !validID(parts[2]) || !entry.IsDir() {
			continue
		}
		sessionID, ownerID := parts[0], parts[1]
		guard := m.lock(sessionID)
		guard.Lock()
		path := filepath.Join(m.trashDir(), entry.Name())
		_, lookupErr := m.db.GetInterpretationSession(ctx, ownerID, sessionID)
		if lookupErr == nil {
			target := filepath.Join(m.root, sessionID)
			if _, err := os.Lstat(target); errors.Is(err, os.ErrNotExist) {
				err = os.Rename(path, target)
				if err != nil {
					guard.Unlock()
					return err
				}
			} else if err != nil {
				guard.Unlock()
				return err
			} else {
				guard.Unlock()
				return errors.New("media: recovery destination already exists; preserved quarantine")
			}
		} else if errors.Is(lookupErr, store.ErrNotFound) {
			if err := m.removeTrash(path); err != nil {
				guard.Unlock()
				return err
			}
		} else {
			guard.Unlock()
			return lookupErr
		}
		guard.Unlock()
	}
	return nil
}
