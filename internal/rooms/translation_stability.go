package rooms

import (
	"strings"
	"unicode/utf8"
)

// stableTranslationText keeps the last complete visible prefix while a new
// cumulative provider stream catches up. The threshold is measured in Unicode
// code points, never UTF-8 bytes, and grows if this stream already extended
// the previously visible text before revising its own prefix.
func stableTranslationText(visible, candidate string, floor int) string {
	if candidate == "" || candidate == visible {
		return visible
	}
	if strings.HasPrefix(candidate, visible) {
		return candidate
	}
	threshold := max(floor, utf8.RuneCountInString(visible))
	if utf8.RuneCountInString(candidate) >= threshold {
		return candidate
	}
	return visible
}
