package language

import "strings"

// Recognition tags are independent from the translator's supported targets.
// Keep Norwegian Bokmål and Nynorsk distinct, as the ASR uses different prompts.
func CanonicalizeRecognition(value string) (string, error) {
	aliases := map[string]string{"zh-ZH": "zh-Hans", "enGB": "en-GB", "esES": "es-ES"}
	if alias, ok := aliases[value]; ok {
		value = alias
	}
	if value == "auto" {
		return value, nil
	}
	if len(value) > maxTagBytes || !isASCII(value) {
		return "", ErrUnsupported
	}
	parts := strings.Split(value, "-")
	if len(parts) == 1 || len(parts) == 2 && validRegion(parts[1]) {
		switch strings.ToLower(parts[0]) {
		case "uk", "lt", "et", "lv", "mt", "nb", "nn":
			return strings.ToLower(parts[0]), nil
		}
	}
	return Canonicalize(value)
}

// ValidInterface limits persisted UI preferences to shipped interface languages.
func ValidInterface(value string) bool {
	switch value {
	case "system", "en", "zh-Hans", "ar", "bg", "cs", "da", "de", "el", "es", "et", "fi", "fr", "he", "hi", "hr", "hu", "it", "ja", "ko", "lt", "lv", "mt", "nb", "nn", "nl", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "th", "tr", "uk", "vi":
		return true
	}
	return false
}
