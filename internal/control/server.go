package control

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/Tularity/t-lingual/internal/admin"
)

const staleSocketProbeTimeout = 250 * time.Millisecond

type Server struct {
	httpServer *http.Server
	listener   *net.UnixListener
	socketPath string
	socketInfo os.FileInfo
	done       chan struct{}

	mu         sync.Mutex
	serveErr   error
	cleanupErr error
}

// StartServer opens a filesystem Unix-domain socket and begins serving the
// local administrative API. It never creates a TCP listener.
func StartServer(
	socketPath string,
	service *admin.Service,
	revokeUser RevokeUserFunc,
	maxJSONBytes int64,
) (*Server, error) {
	handler, err := NewHandler(service, revokeUser, maxJSONBytes)
	if err != nil {
		return nil, err
	}
	path, listener, info, err := listenUnix(socketPath)
	if err != nil {
		return nil, err
	}
	server := &Server{
		httpServer: &http.Server{
			Handler:           handler,
			ReadHeaderTimeout: 5 * time.Second,
			ReadTimeout:       15 * time.Second,
			WriteTimeout:      30 * time.Second,
			IdleTimeout:       60 * time.Second,
			MaxHeaderBytes:    16 << 10,
		},
		listener:   listener,
		socketPath: path,
		socketInfo: info,
		done:       make(chan struct{}),
	}
	go server.serve()
	return server, nil
}

func (s *Server) serve() {
	err := s.httpServer.Serve(s.listener)
	if errors.Is(err, http.ErrServerClosed) {
		err = nil
	}
	cleanupErr := removeOwnedSocket(s.socketPath, s.socketInfo)
	s.mu.Lock()
	s.serveErr = err
	s.cleanupErr = cleanupErr
	s.mu.Unlock()
	close(s.done)
}

// Done closes after serving stops and the owned socket has been cleaned up.
func (s *Server) Done() <-chan struct{} { return s.done }

// Wait blocks until serving stops and returns any serve or safe-cleanup error.
func (s *Server) Wait() error {
	<-s.done
	s.mu.Lock()
	defer s.mu.Unlock()
	return errors.Join(s.serveErr, s.cleanupErr)
}

// Shutdown drains active HTTP requests until ctx expires. On expiry it closes
// remaining connections so the socket is still released deterministically.
func (s *Server) Shutdown(ctx context.Context) error {
	if ctx == nil {
		return errors.New("control: shutdown context is required")
	}
	shutdownErr := s.httpServer.Shutdown(ctx)
	if shutdownErr != nil {
		shutdownErr = errors.Join(shutdownErr, s.httpServer.Close())
	}
	return errors.Join(shutdownErr, s.Wait())
}

func listenUnix(socketPath string) (string, *net.UnixListener, os.FileInfo, error) {
	path := filepath.Clean(strings.TrimSpace(socketPath))
	if strings.TrimSpace(socketPath) == "" || path == "." || strings.HasPrefix(path, "@") {
		return "", nil, nil, errors.New("control: a filesystem Unix socket path is required")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", nil, nil, fmt.Errorf("control: create admin socket directory: %w", err)
	}
	if err := removeStaleSocket(path); err != nil {
		return "", nil, nil, err
	}

	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		return "", nil, nil, fmt.Errorf("control: listen on admin Unix socket: %w", err)
	}
	// Exact inode checks below own unlinking so shutdown can never remove a
	// replacement socket created by another process.
	listener.SetUnlinkOnClose(false)
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSocket == 0 {
		_ = listener.Close()
		if err == nil {
			_ = removeOwnedSocket(path, info)
		}
		if err != nil {
			return "", nil, nil, fmt.Errorf("control: inspect created admin socket: %w", err)
		}
		return "", nil, nil, errors.New("control: listener did not create a filesystem socket")
	}
	if runtime.GOOS == "linux" {
		if err := os.Chmod(path, 0o600); err != nil {
			_ = listener.Close()
			_ = removeOwnedSocket(path, info)
			return "", nil, nil, fmt.Errorf("control: secure admin socket: %w", err)
		}
		info, err = os.Lstat(path)
		if err != nil {
			_ = listener.Close()
			return "", nil, nil, fmt.Errorf("control: verify secured admin socket: %w", err)
		}
	}
	return path, listener, info, nil
}

func removeStaleSocket(path string) error {
	initial, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("control: inspect existing admin socket path: %w", err)
	}
	if initial.Mode()&os.ModeSocket == 0 {
		return fmt.Errorf("control: refusing to replace non-socket path %q", path)
	}

	connection, dialErr := net.DialTimeout("unix", path, staleSocketProbeTimeout)
	if dialErr == nil {
		_ = connection.Close()
		return fmt.Errorf("%w: %s", ErrSocketInUse, path)
	}
	if !errors.Is(dialErr, syscall.ECONNREFUSED) && !errors.Is(dialErr, syscall.ENOENT) && !errors.Is(dialErr, os.ErrNotExist) {
		return fmt.Errorf("control: existing socket could not be safely identified as stale: %w", dialErr)
	}

	current, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("control: recheck stale admin socket: %w", err)
	}
	if current.Mode()&os.ModeSocket == 0 || !os.SameFile(initial, current) {
		return errors.New("control: admin socket changed during stale-socket check; refusing to remove it")
	}
	if err := os.Remove(path); err != nil {
		return fmt.Errorf("control: remove stale admin socket: %w", err)
	}
	return nil
}

func removeOwnedSocket(path string, owned os.FileInfo) error {
	current, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("control: inspect admin socket during cleanup: %w", err)
	}
	if owned == nil || current.Mode()&os.ModeSocket == 0 || !os.SameFile(owned, current) {
		return errors.New("control: admin socket changed before cleanup; refusing to remove it")
	}
	if err := os.Remove(path); err != nil {
		return fmt.Errorf("control: remove admin socket: %w", err)
	}
	return nil
}
