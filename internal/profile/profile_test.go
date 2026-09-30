package profile

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"strings"
	"testing"
)

func square(side int) image.Image {
	img := image.NewRGBA(image.Rect(0, 0, side, side))
	for x := 0; x < side; x++ {
		for y := 0; y < side; y++ {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), 120, 255})
		}
	}
	return img
}

func encodePNG(t *testing.T, img image.Image) []byte {
	t.Helper()
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, img); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestDisplayName(t *testing.T) {
	if name, err := DisplayName("  Alex Morgan  "); err != nil || name != "Alex Morgan" {
		t.Fatalf("trimmed name = %q %v", name, err)
	}
	for _, bad := range []string{"", "   ", "Tab\tname", strings.Repeat("名", 81)} {
		if _, err := DisplayName(bad); !errors.Is(err, ErrInvalidName) {
			t.Fatalf("name %q accepted: %v", bad, err)
		}
	}
	if _, err := DisplayName(strings.Repeat("名", 80)); err != nil {
		t.Fatalf("80-character name rejected: %v", err)
	}
}

func TestAvatarKeepsOnlyPixels(t *testing.T) {
	original := encodePNG(t, square(64))
	// Anything after the image — a script, a second file — is not kept.
	polyglot := append(append([]byte{}, original...), []byte("<script>alert(1)</script>")...)
	contentType, clean, err := Avatar("image/png", polyglot)
	if err != nil || contentType != "image/png" {
		t.Fatalf("png = %q %v", contentType, err)
	}
	if bytes.Contains(clean, []byte("<script>")) {
		t.Fatal("trailing script survived re-encoding")
	}
	if decoded, format, err := image.Decode(bytes.NewReader(clean)); err != nil || format != "png" || decoded.Bounds().Dx() != 64 {
		t.Fatalf("re-encoded png = %v %q %v", decoded, format, err)
	}

	var jpegBytes bytes.Buffer
	if err := jpeg.Encode(&jpegBytes, square(64), nil); err != nil {
		t.Fatal(err)
	}
	if contentType, _, err := Avatar("image/jpeg", jpegBytes.Bytes()); err != nil || contentType != "image/jpeg" {
		t.Fatalf("jpeg = %q %v", contentType, err)
	}
}

func TestAvatarRefusesWhatIsNotAPicture(t *testing.T) {
	png64 := encodePNG(t, square(64))
	cases := map[string]struct {
		declared string
		data     []byte
	}{
		"declared type differs":  {"image/jpeg", png64},
		"svg":                    {"image/png", []byte(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>`)},
		"empty":                  {"image/png", nil},
		"too small":              {"image/png", encodePNG(t, square(8))},
		"too large across":       {"image/png", encodePNG(t, image.NewGray(image.Rect(0, 0, MaxSide+1, 20)))},
		"over the upload bound":  {"image/png", make([]byte, MaxUploadBytes+1)},
		"unsupported given type": {"image/gif", png64},
	}
	for name, test := range cases {
		if _, _, err := Avatar(test.declared, test.data); !errors.Is(err, ErrInvalidImage) {
			t.Fatalf("%s accepted: %v", name, err)
		}
	}
}
