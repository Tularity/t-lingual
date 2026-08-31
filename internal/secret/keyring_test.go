package secret

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"testing"
)

func TestSealRoundTripAndPurposeIsolation(t *testing.T) {
	keyring, err := New(bytes.Repeat([]byte{7}, masterKeyBytes))
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := keyring.Seal("credential/usr_1", []byte("sensitive record"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(sealed, []byte("sensitive")) {
		t.Fatal("sealed value leaked plaintext")
	}
	opened, err := keyring.Open("credential/usr_1", sealed)
	if err != nil {
		t.Fatal(err)
	}
	if string(opened) != "sensitive record" {
		t.Fatalf("unexpected plaintext %q", opened)
	}
	if _, err := keyring.Open("credential/usr_2", sealed); err == nil {
		t.Fatal("expected a different purpose to fail authentication")
	}
}

func TestInvitationDigestUsesKey(t *testing.T) {
	a, _ := New(bytes.Repeat([]byte{1}, masterKeyBytes))
	b, _ := New(bytes.Repeat([]byte{2}, masterKeyBytes))
	if a.InvitationDigest("123456") == b.InvitationDigest("123456") {
		t.Fatal("invite digest is not keyed")
	}
}

func TestInvitationBucketIsKeyedCoarseAndCoversAllBuckets(t *testing.T) {
	a, _ := New(bytes.Repeat([]byte{1}, masterKeyBytes))
	b, _ := New(bytes.Repeat([]byte{2}, masterKeyBytes))
	counts := make([]int, 4096)
	differentKeys := 0
	const samples = 262_144
	for value := range samples {
		code := fmt.Sprintf("%06d", value)
		bucket := a.InvitationBucket(code)
		if bucket >= 4096 {
			t.Fatalf("bucket %d is outside the 4096-bucket threat model", bucket)
		}
		counts[bucket]++
		if bucket != b.InvitationBucket(code) {
			differentKeys++
		}
	}
	for bucket, count := range counts {
		if count < 30 || count > 105 {
			t.Fatalf("bucket %d received %d of %d codes", bucket, count, samples)
		}
	}
	if differentKeys < 260_000 {
		t.Fatalf("only %d bucket assignments changed with a different key", differentKeys)
	}
	if work := 5 * len(counts); work < 20_000 {
		t.Fatalf("configured failure buckets permit targeted revocation after only %d UV ceremonies", work)
	}
	if probability := float64(5*len(counts)) / 1_000_000; probability > 0.025 {
		t.Fatalf("configured success-before-revocation probability is too high: %f", probability)
	}
}

func TestInvitationCodeShape(t *testing.T) {
	for range 100 {
		code, err := InvitationCode()
		if err != nil {
			t.Fatal(err)
		}
		if !regexp.MustCompile(`^[0-9]{6}$`).MatchString(code) {
			t.Fatalf("invalid invitation code %q", code)
		}
	}
}

func TestOpenOrCreatePersistsKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "master.key")
	first, err := OpenOrCreate(path)
	if err != nil {
		t.Fatal(err)
	}
	second, err := OpenOrCreate(path)
	if err != nil {
		t.Fatal(err)
	}
	if first.InvitationDigest("654321") != second.InvitationDigest("654321") {
		t.Fatal("master key changed across loads")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() != masterKeyBytes {
		t.Fatalf("unexpected key size %d", info.Size())
	}
}

func TestOpenOrCreateRejectsNonRegularAndSymlinkKeys(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "key-directory")
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenOrCreate(directory); err == nil {
		t.Fatal("directory was accepted as a master key")
	}

	target := filepath.Join(t.TempDir(), "target.key")
	if err := os.WriteFile(target, bytes.Repeat([]byte{8}, masterKeyBytes), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "linked.key")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symbolic links are unavailable: %v", err)
	}
	if _, err := OpenOrCreate(link); err == nil {
		t.Fatal("symbolic link was accepted as a master key")
	}
}

func TestOpenOrCreateRejectsBroadUnixPermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows ACLs are not represented by FileMode")
	}
	path := filepath.Join(t.TempDir(), "broad.key")
	if err := os.WriteFile(path, bytes.Repeat([]byte{8}, masterKeyBytes), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenOrCreate(path); err == nil {
		t.Fatal("group/world-readable master key was accepted")
	}
}
