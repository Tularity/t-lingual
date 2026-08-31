// Package spa serves the compiled React application without exposing the
// filesystem or turning missing static assets into misleading HTML responses.
package spa

import (
	"errors"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
)

type Handler struct {
	files      http.Handler
	filesystem fs.FS
	index      []byte
	production bool
}

func New(root string, production bool) (*Handler, error) {
	root = filepath.Clean(strings.TrimSpace(root))
	if root == "." || strings.TrimSpace(root) == "" {
		return nil, errors.New("web root is required")
	}
	filesystem := os.DirFS(root)
	index, err := fs.ReadFile(filesystem, "index.html")
	if err != nil {
		return nil, errors.New("read web root index.html: " + err.Error())
	}
	return &Handler{
		files:      http.FileServerFS(filesystem),
		filesystem: filesystem,
		index:      index,
		production: production,
	}, nil
}

func (h *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	h.securityHeaders(response.Header())
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		response.Header().Set("Allow", "GET, HEAD")
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	clean := path.Clean("/" + request.URL.Path)
	name := strings.TrimPrefix(clean, "/")
	if name == "" {
		h.serveIndex(response, request)
		return
	}
	if info, err := fs.Stat(h.filesystem, name); err == nil && !info.IsDir() {
		if strings.HasPrefix(name, "assets/") {
			response.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			response.Header().Set("Cache-Control", "public, max-age=3600")
		}
		h.files.ServeHTTP(response, request)
		return
	}

	// Routes without a file extension are client-side routes. Missing assets
	// remain real 404s so a bad deployment cannot be cached as index.html.
	if path.Ext(name) == "" {
		h.serveIndex(response, request)
		return
	}
	http.NotFound(response, request)
}

func (h *Handler) serveIndex(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-cache")
	response.Header().Set("Content-Type", mime.TypeByExtension(".html"))
	response.Header().Set("Content-Length", strconv.Itoa(len(h.index)))
	response.WriteHeader(http.StatusOK)
	if request.Method != http.MethodHead {
		_, _ = response.Write(h.index)
	}
}

func (h *Handler) securityHeaders(header http.Header) {
	// The browser talks only to this same origin, including the live WebSocket.
	// Scheme-wide ws:/wss: sources would let an injected script exfiltrate data
	// to any WebSocket host despite the rest of the same-origin boundary.
	header.Set("Content-Security-Policy", "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self'; worker-src 'self'; manifest-src 'self'")
	header.Set("Permissions-Policy", "camera=(), geolocation=(), payment=(), usb=(), microphone=(self), publickey-credentials-create=(self), publickey-credentials-get=(self)")
	header.Set("Referrer-Policy", "no-referrer")
	header.Set("Cross-Origin-Opener-Policy", "same-origin")
	header.Set("Cross-Origin-Resource-Policy", "same-origin")
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("X-Frame-Options", "DENY")
	if h.production {
		header.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
	}
}
