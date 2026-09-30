package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"time"
)

// healthcheck asks the server in this container whether it is live, for the
// image's HEALTHCHECK: the image carries no HTTP client of its own.
func healthcheck(listen string) error {
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		return fmt.Errorf("listen address %q: %w", listen, err)
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+net.JoinHostPort(host, port)+"/health/live", nil)
	if err != nil {
		return err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("liveness answered %d", response.StatusCode)
	}
	return nil
}

// listenAddress is where the server listens, as its configuration reads it.
func listenAddress() string {
	if value := os.Getenv("TLINGUAL_LISTEN_ADDR"); value != "" {
		return value
	}
	return ":8080"
}
