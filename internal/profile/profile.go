// Package profile checks what a person may change about how they are shown:
// the name others see, and a picture.
package profile

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"strings"
	"unicode"
	"unicode/utf8"
)

// MaxUploadBytes bounds an uploaded picture before it is even decoded.
const MaxUploadBytes = 512 << 10

// MaxStoredBytes bounds a picture as it is kept, after re-encoding.
const MaxStoredBytes = 256 << 10

// MaxSide bounds a picture's width and height. The interface sends a square
// of 256; the bound leaves room without letting a small file decode into an
// enormous image.
const MaxSide = 1024

var (
	// ErrInvalidName: a display name is 1-80 printable characters.
	ErrInvalidName = errors.New("profile: invalid display name")
	// ErrInvalidImage: a picture must be a PNG or JPEG image of a sensible size.
	ErrInvalidImage = errors.New("profile: invalid image")
)

// DisplayName is a trimmed name of 1-80 characters with no control characters.
func DisplayName(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || !utf8.ValidString(value) {
		return "", fmt.Errorf("%w: name is required", ErrInvalidName)
	}
	count := 0
	for _, character := range value {
		if unicode.IsControl(character) {
			return "", fmt.Errorf("%w: name contains a control character", ErrInvalidName)
		}
		count++
	}
	if count > 80 {
		return "", fmt.Errorf("%w: name exceeds 80 characters", ErrInvalidName)
	}
	return value, nil
}

// Avatar decodes an uploaded picture and encodes it afresh, so what is kept
// is only pixels: no metadata, nothing a browser could take for markup or
// script, whatever the upload claimed or carried. Only PNG and JPEG are
// accepted, and the declared type must match what the bytes are.
func Avatar(declaredType string, data []byte) (string, []byte, error) {
	if len(data) == 0 || len(data) > MaxUploadBytes {
		return "", nil, fmt.Errorf("%w: size", ErrInvalidImage)
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return "", nil, fmt.Errorf("%w: %v", ErrInvalidImage, err)
	}
	if !(format == "png" && declaredType == "image/png") && !(format == "jpeg" && declaredType == "image/jpeg") {
		return "", nil, fmt.Errorf("%w: type", ErrInvalidImage)
	}
	if config.Width < 16 || config.Height < 16 || config.Width > MaxSide || config.Height > MaxSide {
		return "", nil, fmt.Errorf("%w: dimensions", ErrInvalidImage)
	}
	decoded, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return "", nil, fmt.Errorf("%w: %v", ErrInvalidImage, err)
	}
	var out bytes.Buffer
	if format == "png" {
		encoder := png.Encoder{CompressionLevel: png.BestCompression}
		err = encoder.Encode(&out, decoded)
	} else {
		err = jpeg.Encode(&out, decoded, &jpeg.Options{Quality: 88})
	}
	if err != nil {
		return "", nil, fmt.Errorf("profile: encode avatar: %w", err)
	}
	if out.Len() > MaxStoredBytes {
		return "", nil, fmt.Errorf("%w: encoded size", ErrInvalidImage)
	}
	return declaredType, out.Bytes(), nil
}
