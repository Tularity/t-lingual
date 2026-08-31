// Package processlock prevents more than one t-lingual process from opening
// the same durable data store at a time.
package processlock

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// ErrAlreadyLocked reports that another process already owns the data path.
var ErrAlreadyLocked = errors.New("data store is already in use by another process")

// Lock is an exclusive operating-system lock associated with one absolute
// database identity. The sidecar file remains on disk, but the lock itself is
// released by the operating system when Close is called or the process exits.
type Lock struct {
	mu       sync.Mutex
	file     *os.File
	dataPath string
	lockPath string
}

// Acquire obtains a non-blocking, exclusive lock for dataPath. It creates the
// database directory if necessary so callers can acquire this lock before any
// database or migration work starts.
func Acquire(dataPath string) (*Lock, error) {
	canonical, err := canonicalDataPath(dataPath)
	if err != nil {
		return nil, err
	}
	lockPath := canonical + ".lock"
	file, err := openLockFile(lockPath)
	if err != nil {
		return nil, err
	}
	if err := lockFile(file); err != nil {
		_ = file.Close()
		if errors.Is(err, ErrAlreadyLocked) {
			return nil, fmt.Errorf("lock data store %q: %w", canonical, ErrAlreadyLocked)
		}
		return nil, fmt.Errorf("lock data store %q: %w", canonical, err)
	}
	return &Lock{file: file, dataPath: canonical, lockPath: lockPath}, nil
}

// DataPath returns the canonical absolute database path protected by the lock.
func (l *Lock) DataPath() string {
	if l == nil {
		return ""
	}
	return l.dataPath
}

// Path returns the persistent sidecar path used for the operating-system lock.
func (l *Lock) Path() string {
	if l == nil {
		return ""
	}
	return l.lockPath
}

// Close releases the operating-system lock. It is safe to call more than once.
func (l *Lock) Close() error {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file == nil {
		return nil
	}
	file := l.file
	l.file = nil
	return errors.Join(unlockFile(file), file.Close())
}

func canonicalDataPath(dataPath string) (string, error) {
	dataPath = strings.TrimSpace(dataPath)
	if dataPath == "" {
		return "", errors.New("process lock: database path is empty")
	}
	if dataPath == ":memory:" || strings.HasPrefix(dataPath, "file:") {
		return "", errors.New("process lock: database path must name a durable filesystem file")
	}
	absolute, err := filepath.Abs(filepath.Clean(dataPath))
	if err != nil {
		return "", fmt.Errorf("process lock: resolve database path: %w", err)
	}
	parent := filepath.Dir(absolute)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return "", fmt.Errorf("process lock: create database directory: %w", err)
	}

	// Resolve an existing database symlink as well as parent-directory links so
	// relative, absolute, and linked spellings converge on the same sidecar.
	if resolved, resolveErr := filepath.EvalSymlinks(absolute); resolveErr == nil {
		absolute = resolved
	} else if !errors.Is(resolveErr, os.ErrNotExist) {
		return "", fmt.Errorf("process lock: resolve database identity: %w", resolveErr)
	} else {
		resolvedParent, parentErr := filepath.EvalSymlinks(parent)
		if parentErr != nil {
			return "", fmt.Errorf("process lock: resolve database directory: %w", parentErr)
		}
		absolute = filepath.Join(resolvedParent, filepath.Base(absolute))
	}
	return filepath.Clean(absolute), nil
}

func openLockFile(path string) (*os.File, error) {
	if info, err := os.Lstat(path); err == nil {
		if !info.Mode().IsRegular() {
			return nil, fmt.Errorf("process lock: %q is not a regular file", path)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("process lock: inspect %q: %w", path, err)
	}

	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("process lock: open %q: %w", path, err)
	}
	closeOnError := func(openErr error) (*os.File, error) {
		_ = file.Close()
		return nil, openErr
	}
	openedInfo, err := file.Stat()
	if err != nil {
		return closeOnError(fmt.Errorf("process lock: inspect opened %q: %w", path, err))
	}
	pathInfo, err := os.Lstat(path)
	if err != nil {
		return closeOnError(fmt.Errorf("process lock: re-inspect %q: %w", path, err))
	}
	if !pathInfo.Mode().IsRegular() || !os.SameFile(openedInfo, pathInfo) {
		return closeOnError(fmt.Errorf("process lock: %q changed while it was opened", path))
	}
	return file, nil
}
