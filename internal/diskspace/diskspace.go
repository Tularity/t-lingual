// Package diskspace reads how much room the file system holding a path has.
package diskspace

// Usage is the space of the file system holding a path, in bytes. Free is
// what an unprivileged process may still write, not the raw free blocks.
type Usage struct {
	Free  uint64
	Total uint64
}

// Of reads the space of the file system that holds path.
func Of(path string) (Usage, error) {
	return of(path)
}
