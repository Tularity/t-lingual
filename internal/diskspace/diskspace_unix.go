//go:build unix

package diskspace

import "golang.org/x/sys/unix"

func of(path string) (Usage, error) {
	var stat unix.Statfs_t
	if err := unix.Statfs(path, &stat); err != nil {
		return Usage{}, err
	}
	block := uint64(stat.Bsize)
	return Usage{Free: uint64(stat.Bavail) * block, Total: uint64(stat.Blocks) * block}, nil
}
