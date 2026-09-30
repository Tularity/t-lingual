package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealthcheckAsksTheLocalServerWhetherItIsLive(t *testing.T) {
	status := http.StatusOK
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health/live" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(status)
	}))
	defer server.Close()
	_, port, _ := net.SplitHostPort(server.Listener.Addr().String())

	// The server listens on every interface; the check asks it on loopback.
	if err := healthcheck(":" + port); err != nil {
		t.Fatalf("live server = %v", err)
	}
	status = http.StatusServiceUnavailable
	if err := healthcheck(":" + port); err == nil {
		t.Fatal("a server answering 503 passed the check")
	}
	if err := healthcheck("not an address"); err == nil {
		t.Fatal("a malformed listen address passed the check")
	}
}
