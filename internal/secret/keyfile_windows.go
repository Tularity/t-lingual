package secret

import "os"

// Windows ACLs are not faithfully represented by FileMode permission bits.
// The container production path is validated on Unix; on Windows we still
// enforce regular-file, no-symlink, identity, and exact-length checks.
func validateKeyFileSecurity(os.FileInfo) error { return nil }

func syncKeyDirectory(string) error { return nil }
