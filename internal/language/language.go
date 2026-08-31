// Package language defines the public language boundary shared by workspace
// validation and the independently deployed MiLMMT translation API.
package language

import (
	"errors"
	"sort"
	"strings"
)

var ErrUnsupported = errors.New("unsupported language tag")

const maxTagBytes = 10

var canonical = map[string]string{
	"ar": "ar", "az": "az", "bg": "bg", "bn": "bn", "ca": "ca", "cs": "cs",
	"da": "da", "de": "de", "el": "el", "en": "en", "es": "es", "fa": "fa",
	"fi": "fi", "fr": "fr", "he": "he", "hi": "hi", "hr": "hr", "hu": "hu",
	"id": "id", "it": "it", "ja": "ja", "kk": "kk", "km": "km", "ko": "ko",
	"lo": "lo", "ms": "ms", "my": "my", "no": "no", "nl": "nl", "pl": "pl",
	"pt": "pt", "ro": "ro", "ru": "ru", "sk": "sk", "sl": "sl", "sv": "sv",
	"ta": "ta", "th": "th", "tl": "tl", "tr": "tr", "ur": "ur", "uz": "uz",
	"vi": "vi", "yue": "yue",
}

// Canonicalize implements the translation service's case-insensitive BCP-47
// region boundary and returns one of its exact 46 model language codes.
func Canonicalize(value string) (string, error) {
	if value == "" || len(value) > maxTagBytes || !isASCII(value) {
		return "", ErrUnsupported
	}
	parts := strings.Split(value, "-")
	if len(parts) == 0 || len(parts) > 3 || parts[0] == "" {
		return "", ErrUnsupported
	}
	base := strings.ToLower(parts[0])
	if base == "zh" {
		return canonicalChinese(parts)
	}
	if base == "fil" {
		if len(parts) == 2 && strings.EqualFold(parts[1], "PH") {
			return "tl", nil
		}
		return "", ErrUnsupported
	}
	language, ok := canonical[base]
	if !ok {
		return "", ErrUnsupported
	}
	if len(parts) == 1 || (len(parts) == 2 && validRegion(parts[1])) {
		return language, nil
	}
	return "", ErrUnsupported
}

func CanonicalizeSource(value string) (string, error) {
	if value == "auto" {
		return value, nil
	}
	return Canonicalize(value)
}

// Supported returns the stable canonical translation language codes. Callers
// receive a fresh slice so the package's validation boundary cannot be mutated.
func Supported() []string {
	result := make([]string, 0, len(canonical)+2)
	for code := range canonical {
		result = append(result, code)
	}
	result = append(result, "zh-Hans", "zh-Hant")
	sort.Strings(result)
	return result
}

func canonicalChinese(parts []string) (string, error) {
	if len(parts) == 2 {
		switch {
		case strings.EqualFold(parts[1], "Hans"), strings.EqualFold(parts[1], "CN"), strings.EqualFold(parts[1], "SG"):
			return "zh-Hans", nil
		case strings.EqualFold(parts[1], "Hant"), strings.EqualFold(parts[1], "TW"), strings.EqualFold(parts[1], "HK"), strings.EqualFold(parts[1], "MO"):
			return "zh-Hant", nil
		}
	}
	if len(parts) == 3 {
		if strings.EqualFold(parts[1], "Hans") &&
			(strings.EqualFold(parts[2], "CN") || strings.EqualFold(parts[2], "SG")) {
			return "zh-Hans", nil
		}
		if strings.EqualFold(parts[1], "Hant") &&
			(strings.EqualFold(parts[2], "TW") || strings.EqualFold(parts[2], "HK") || strings.EqualFold(parts[2], "MO")) {
			return "zh-Hant", nil
		}
	}
	return "", ErrUnsupported
}

func validRegion(value string) bool {
	if len(value) == 2 {
		return isAlpha(value[0]) && isAlpha(value[1])
	}
	if len(value) == 3 {
		return isDigit(value[0]) && isDigit(value[1]) && isDigit(value[2])
	}
	return false
}

func isASCII(value string) bool {
	for index := range len(value) {
		if value[index] > 0x7f {
			return false
		}
	}
	return true
}

func isAlpha(value byte) bool { return value >= 'A' && value <= 'Z' || value >= 'a' && value <= 'z' }
func isDigit(value byte) bool { return value >= '0' && value <= '9' }
