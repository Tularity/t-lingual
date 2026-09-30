//go:build windows

package diskspace

import "golang.org/x/sys/windows"

func of(path string) (Usage, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return Usage{}, err
	}
	var available, total, free uint64
	if err := windows.GetDiskFreeSpaceEx(name, &available, &total, &free); err != nil {
		return Usage{}, err
	}
	return Usage{Free: available, Total: total}, nil
}
