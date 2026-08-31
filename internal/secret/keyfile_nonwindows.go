//go:build !windows

package secret

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

func validateKeyFileSecurity(info os.FileInfo) error {
	if info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("master key permissions %04o expose it to group or other users", info.Mode().Perm())
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return errors.New("master key ownership could not be verified")
	}
	if int(stat.Uid) != os.Geteuid() {
		return fmt.Errorf("master key is owned by uid %d, expected uid %d", stat.Uid, os.Geteuid())
	}
	return nil
}

func syncKeyDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
