package main

import (
	"os"

	"github.com/Tularity/t-lingual/internal/control"
)

func main() {
	os.Exit(run(os.Args[1:], os.LookupEnv, os.Stdout, os.Stderr, func(socketPath string) (adminClient, error) {
		return control.NewClient(socketPath)
	}))
}
