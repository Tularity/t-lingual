package control

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
)

func TestUnixServerLifecycleAndSocketSafety(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("filesystem Unix socket mode and inode lifecycle are validated in the Linux container")
	}
	service, database := newControlTestService(t)
	now := time.Now().UTC()
	createControlTestUser(t, database, "usr_socket_admin", domain.RoleAdmin, now)
	createControlTestUser(t, database, "usr_socket_member", domain.RoleUser, now.Add(time.Second))
	revoked := make(chan string, 1)
	directory := t.TempDir()
	socketPath := filepath.Join(directory, "admin.sock")
	server, err := StartServer(
		socketPath,
		service,
		func(userID string) { revoked <- userID },
		DefaultMaxJSONBytes,
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	})

	info, err := os.Lstat(socketPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeSocket == 0 {
		t.Fatalf("listener path is not a socket: %v", info.Mode())
	}
	if runtime.GOOS == "linux" && info.Mode().Perm() != 0o600 {
		t.Fatalf("socket mode = %o, want 600", info.Mode().Perm())
	}
	client, err := NewClient(socketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer client.CloseIdleConnections()
	status, err := client.Status(context.Background())
	if err != nil || status.Status != "ok" {
		t.Fatalf("status=%#v err=%v", status, err)
	}
	if err := client.SetUserRole(context.Background(), "usr_socket_member", domain.RoleAdmin); err != nil {
		t.Fatalf("promote through Unix client: %v", err)
	}
	select {
	case userID := <-revoked:
		if userID != "usr_socket_member" {
			t.Fatalf("Unix control promotion revoked %q", userID)
		}
	case <-time.After(time.Second):
		t.Fatal("Unix control promotion did not revoke live user")
	}
	select {
	case userID := <-revoked:
		t.Fatalf("Unix control promotion revoked %q more than once", userID)
	default:
	}

	if _, err := StartServer(socketPath, service, nil, DefaultMaxJSONBytes); !errors.Is(err, ErrSocketInUse) {
		t.Fatalf("second listener error = %v, want ErrSocketInUse", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(socketPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("socket remains after shutdown: %v", err)
	}
}

func TestUnixServerReplacesOnlyConfirmedStaleSocket(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("filesystem Unix socket mode and inode lifecycle are validated in the Linux container")
	}
	service, _ := newControlTestService(t)
	directory := t.TempDir()
	socketPath := filepath.Join(directory, "admin.sock")
	stale, err := net.ListenUnix("unix", &net.UnixAddr{Name: socketPath, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	stale.SetUnlinkOnClose(false)
	if err := stale.Close(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(socketPath)
	if err != nil {
		t.Fatalf("inspect constructed stale socket: %v", err)
	}
	if info.Mode()&os.ModeSocket == 0 {
		t.Fatalf("failed to construct stale socket: mode=%v", info.Mode())
	}

	server, err := StartServer(socketPath, service, nil, DefaultMaxJSONBytes)
	if err != nil {
		t.Fatalf("confirmed stale socket was not replaced: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestServerRejectsUnsafePathsWithoutReplacingFiles(t *testing.T) {
	service, _ := newControlTestService(t)
	if _, err := StartServer("", service, nil, DefaultMaxJSONBytes); err == nil {
		t.Fatal("empty socket path was accepted")
	}
	if _, err := StartServer("@abstract", service, nil, DefaultMaxJSONBytes); err == nil {
		t.Fatal("non-filesystem abstract socket was accepted")
	}

	regularPath := filepath.Join(t.TempDir(), "not-a-socket")
	contents := []byte("must remain")
	if err := os.WriteFile(regularPath, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := StartServer(regularPath, service, nil, DefaultMaxJSONBytes); err == nil {
		t.Fatal("regular file was replaced by socket")
	}
	remaining, err := os.ReadFile(regularPath)
	if err != nil || string(remaining) != string(contents) {
		t.Fatalf("regular file changed: data=%q err=%v", remaining, err)
	}
}
