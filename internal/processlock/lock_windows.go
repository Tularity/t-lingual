//go:build windows

package processlock

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

func lockFile(file *os.File) error {
	overlapped := new(windows.Overlapped)
	err := windows.LockFileEx(
		windows.Handle(file.Fd()),
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY,
		0,
		^uint32(0),
		^uint32(0),
		overlapped,
	)
	if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
		return ErrAlreadyLocked
	}
	return err
}

func unlockFile(file *os.File) error {
	return windows.UnlockFileEx(
		windows.Handle(file.Fd()),
		0,
		^uint32(0),
		^uint32(0),
		new(windows.Overlapped),
	)
}
