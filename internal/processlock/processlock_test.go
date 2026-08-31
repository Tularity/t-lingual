package processlock

import (
	"bufio"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

func TestAcquireExcludesSecondHandleAndReleases(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "state.db")
	first, err := Acquire(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = first.Close() })
	if !filepath.IsAbs(first.DataPath()) || !filepath.IsAbs(first.Path()) {
		t.Fatalf("lock identity is not absolute: data=%q lock=%q", first.DataPath(), first.Path())
	}

	alias := filepath.Join(filepath.Dir(databasePath), "unused", "..", filepath.Base(databasePath))
	second, err := Acquire(alias)
	if second != nil {
		_ = second.Close()
		t.Fatal("second lock unexpectedly succeeded")
	}
	if !errors.Is(err, ErrAlreadyLocked) {
		t.Fatalf("second lock error = %v, want ErrAlreadyLocked", err)
	}

	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("second close failed: %v", err)
	}
	reacquired, err := Acquire(databasePath)
	if err != nil {
		t.Fatalf("lock was not released: %v", err)
	}
	if err := reacquired.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(databasePath + ".lock"); err != nil {
		t.Fatalf("persistent sidecar is missing: %v", err)
	}
}

func TestAcquireRejectsNonRegularSidecar(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "state.db")
	if err := os.Mkdir(databasePath+".lock", 0o700); err != nil {
		t.Fatal(err)
	}
	if lock, err := Acquire(databasePath); err == nil {
		_ = lock.Close()
		t.Fatal("directory sidecar was accepted")
	}
}

func TestAcquireRejectsNonFilesystemDatabase(t *testing.T) {
	for _, path := range []string{"", ":memory:", "file::memory:?cache=shared"} {
		if lock, err := Acquire(path); err == nil {
			_ = lock.Close()
			t.Fatalf("Acquire(%q) unexpectedly succeeded", path)
		}
	}
}

func TestAcquireExcludesAnotherProcessAndReleasesAtExit(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "state.db")
	command := exec.Command(os.Args[0], "-test.run=^TestProcessLockHelper$")
	command.Env = append(os.Environ(),
		"TLINGUAL_PROCESSLOCK_HELPER=1",
		"TLINGUAL_PROCESSLOCK_PATH="+databasePath,
	)
	stdin, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = stdin.Close()
		if command.ProcessState == nil {
			_ = command.Process.Kill()
			_ = command.Wait()
		}
	})
	scanner := bufio.NewScanner(stdout)
	if !scanner.Scan() || scanner.Text() != "locked" {
		t.Fatalf("helper did not acquire lock: line=%q error=%v", scanner.Text(), scanner.Err())
	}

	second, err := Acquire(databasePath)
	if second != nil {
		_ = second.Close()
		t.Fatal("parent acquired the child process lock")
	}
	if !errors.Is(err, ErrAlreadyLocked) {
		t.Fatalf("parent lock error = %v, want ErrAlreadyLocked", err)
	}

	if err := stdin.Close(); err != nil {
		t.Fatal(err)
	}
	if err := command.Wait(); err != nil {
		t.Fatalf("helper process exit: %v", err)
	}
	reacquired, err := Acquire(databasePath)
	if err != nil {
		t.Fatalf("process-exit lock was not released: %v", err)
	}
	if err := reacquired.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestProcessLockHelper(t *testing.T) {
	if os.Getenv("TLINGUAL_PROCESSLOCK_HELPER") != "1" {
		return
	}
	lock, err := Acquire(os.Getenv("TLINGUAL_PROCESSLOCK_PATH"))
	if err != nil {
		_, _ = io.WriteString(os.Stderr, err.Error()+"\n")
		os.Exit(2)
	}
	_, _ = io.WriteString(os.Stdout, "locked\n")
	_ = os.Stdout.Sync()
	_, _ = io.Copy(io.Discard, os.Stdin)
	runtime.KeepAlive(lock) // Deliberately rely on process exit instead of Close.
	os.Exit(0)
}
