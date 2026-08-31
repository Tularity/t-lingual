package id

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"errors"
	"strings"
)

var encoding = base32.StdEncoding.WithPadding(base32.NoPadding)

// New returns a non-guessable identifier with an optional human-readable prefix.
func New(prefix string) (string, error) {
	if strings.ContainsAny(prefix, "_/ \\:\t\r\n") {
		return "", errors.New("identifier prefix contains a reserved character")
	}

	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	value := strings.ToLower(encoding.EncodeToString(raw))
	if prefix == "" {
		return value, nil
	}
	return prefix + "_" + value, nil
}

// Secret returns a URL-safe, cryptographically random bearer value.
func Secret(bytes int) (string, error) {
	if bytes < 16 {
		return "", errors.New("secret must contain at least 128 bits")
	}
	raw := make([]byte, bytes)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return strings.ToLower(encoding.EncodeToString(raw)), nil
}

func HashSecret(value string) [sha256.Size]byte {
	return sha256.Sum256([]byte(value))
}
