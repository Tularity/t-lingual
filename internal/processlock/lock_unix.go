//go:build !windows

package processlock

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

func lockFile(file *os.File) error {
	for {
		err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if errors.Is(err, unix.EWOULDBLOCK) || errors.Is(err, unix.EAGAIN) {
			return ErrAlreadyLocked
		}
		return err
	}
}

func unlockFile(file *os.File) error {
	for {
		err := unix.Flock(int(file.Fd()), unix.LOCK_UN)
		if !errors.Is(err, unix.EINTR) {
			return err
		}
	}
}
