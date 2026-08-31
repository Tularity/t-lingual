package secret

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

const (
	masterKeyBytes = 32
	sealedVersion  = byte(1)
)

type Keyring struct {
	inviteKey       [sha256.Size]byte
	inviteBucketKey [sha256.Size]byte
	encryptionKey   [sha256.Size]byte
}

// Verifier is a non-secret, domain-separated fingerprint used to detect a
// wrong or accidentally replaced master key before encrypted records are read.
func (k *Keyring) Verifier() [sha256.Size]byte {
	mac := hmac.New(sha256.New, k.encryptionKey[:])
	_, _ = mac.Write([]byte("t-lingual/master-key-verifier/v1"))
	var verifier [sha256.Size]byte
	copy(verifier[:], mac.Sum(nil))
	return verifier
}

// OpenOrCreate loads the persistent application master key or atomically
// creates it on first boot. The key file must live on the persistent data
// volume and must never be copied into an image or repository.
func OpenOrCreate(path string) (*Keyring, error) {
	if path == "" {
		return nil, errors.New("master key path is required")
	}
	raw, err := readExistingMasterKey(path)
	if err == nil {
		return New(raw)
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("read master key: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create master key directory: %w", err)
	}
	raw = make([]byte, masterKeyBytes)
	if _, err := io.ReadFull(rand.Reader, raw); err != nil {
		return nil, fmt.Errorf("generate master key: %w", err)
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		// Another process won the first-start race. Never overwrite its key.
		loaded, readErr := readExistingMasterKey(path)
		if readErr != nil {
			return nil, fmt.Errorf("read concurrently created master key: %w", readErr)
		}
		return New(loaded)
	}
	if err != nil {
		return nil, fmt.Errorf("create master key: %w", err)
	}
	written := false
	defer func() {
		_ = file.Close()
		if !written {
			_ = os.Remove(path)
		}
	}()
	if _, err := file.Write(raw); err != nil {
		return nil, fmt.Errorf("write master key: %w", err)
	}
	if err := file.Sync(); err != nil {
		return nil, fmt.Errorf("sync master key: %w", err)
	}
	if err := file.Close(); err != nil {
		return nil, fmt.Errorf("close master key: %w", err)
	}
	if err := syncKeyDirectory(filepath.Dir(path)); err != nil {
		return nil, fmt.Errorf("sync master key directory: %w", err)
	}
	written = true
	return New(raw)
}

func readExistingMasterKey(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("master key must not be a symbolic link")
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("master key must be a regular file")
	}
	if err := validateKeyFileSecurity(info); err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	openedInfo, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !os.SameFile(info, openedInfo) {
		return nil, errors.New("master key changed while it was being opened")
	}
	raw, err := io.ReadAll(io.LimitReader(file, masterKeyBytes+1))
	if err != nil {
		return nil, err
	}
	return raw, nil
}

func New(master []byte) (*Keyring, error) {
	if len(master) != masterKeyBytes {
		return nil, fmt.Errorf("master key must be exactly %d bytes", masterKeyBytes)
	}
	return &Keyring{
		inviteKey:       derive(master, "t-lingual/invitation-hmac/v1"),
		inviteBucketKey: derive(master, "t-lingual/invitation-bucket/v1"),
		encryptionKey:   derive(master, "t-lingual/record-encryption/v1"),
	}, nil
}

func derive(master []byte, purpose string) [sha256.Size]byte {
	mac := hmac.New(sha256.New, master)
	_, _ = mac.Write([]byte(purpose))
	var key [sha256.Size]byte
	copy(key[:], mac.Sum(nil))
	return key
}

func (k *Keyring) InvitationDigest(code string) [sha256.Size]byte {
	mac := hmac.New(sha256.New, k.inviteKey[:])
	_, _ = mac.Write([]byte(code))
	var digest [sha256.Size]byte
	copy(digest[:], mac.Sum(nil))
	return digest
}

// InvitationBucket assigns a code to a keyed, non-observable failure bucket.
// Invalid online guesses against the same bucket consume each active invite's
// durable attempt budget without disclosing which bucket an invite occupies.
func (k *Keyring) InvitationBucket(code string) uint16 {
	mac := hmac.New(sha256.New, k.inviteBucketKey[:])
	_, _ = mac.Write([]byte(code))
	digest := mac.Sum(nil)
	// Twelve keyed bits make a random distributed availability attack require
	// roughly 20,480 completed UV ceremonies to revoke a chosen invitation at
	// the five-failure threshold, while still grouping the one-million-code
	// space tightly enough to stop exhaustive online guessing before success.
	return uint16(digest[0])<<4 | uint16(digest[1]>>4)
}

func (k *Keyring) Seal(purpose string, plaintext []byte) ([]byte, error) {
	aead, err := k.aead()
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("generate encryption nonce: %w", err)
	}
	sealed := aead.Seal(nil, nonce, plaintext, []byte(purpose))
	payload := make([]byte, 1+len(nonce)+len(sealed))
	payload[0] = sealedVersion
	copy(payload[1:], nonce)
	copy(payload[1+len(nonce):], sealed)
	encoded := make([]byte, base64.RawURLEncoding.EncodedLen(len(payload)))
	base64.RawURLEncoding.Encode(encoded, payload)
	return encoded, nil
}

func (k *Keyring) Open(purpose string, encoded []byte) ([]byte, error) {
	payload := make([]byte, base64.RawURLEncoding.DecodedLen(len(encoded)))
	n, err := base64.RawURLEncoding.Decode(payload, encoded)
	if err != nil {
		return nil, errors.New("sealed record has invalid encoding")
	}
	payload = payload[:n]
	aead, err := k.aead()
	if err != nil {
		return nil, err
	}
	if len(payload) < 1+aead.NonceSize()+aead.Overhead() || payload[0] != sealedVersion {
		return nil, errors.New("sealed record has an unsupported format")
	}
	nonce := payload[1 : 1+aead.NonceSize()]
	ciphertext := payload[1+aead.NonceSize():]
	plaintext, err := aead.Open(nil, nonce, ciphertext, []byte(purpose))
	if err != nil {
		return nil, errors.New("sealed record authentication failed")
	}
	return plaintext, nil
}

func (k *Keyring) aead() (cipher.AEAD, error) {
	block, err := aes.NewCipher(k.encryptionKey[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// InvitationCode returns a uniformly sampled six-digit code including leading
// zeroes. Rejection sampling avoids modulo bias.
func InvitationCode() (string, error) {
	const max = uint32(1_000_000)
	const limit = uint32(4_294_000_000) // floor(2^32 / max) * max
	var raw [4]byte
	for {
		if _, err := io.ReadFull(rand.Reader, raw[:]); err != nil {
			return "", err
		}
		value := uint32(raw[0])<<24 | uint32(raw[1])<<16 | uint32(raw[2])<<8 | uint32(raw[3])
		if value < limit {
			return fmt.Sprintf("%06d", value%max), nil
		}
	}
}
