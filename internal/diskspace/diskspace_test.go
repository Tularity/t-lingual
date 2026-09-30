package diskspace

import "testing"

func TestTheTemporaryDirectoryHasRoomAndATotal(t *testing.T) {
	usage, err := Of(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if usage.Total == 0 || usage.Free > usage.Total {
		t.Fatalf("usage = %#v", usage)
	}
}

func TestAMissingPathIsAnError(t *testing.T) {
	if _, err := Of(t.TempDir() + "/missing/deeper"); err == nil {
		t.Fatal("a missing path read as a file system")
	}
}
