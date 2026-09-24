package rooms

import (
	"unicode"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/language"
)

// ASR's `lang:auto` is a decoding setting, not a language prediction. The
// explicit bilingual session permits conservative script-based routing, but
// its provenance must remain visible and must never be reported as ASR LID.
func segmentLanguage(session domain.InterpretationSession, upstream, text string) (string, string) {
	if session.SourceLanguage != "auto" {
		if canonical, err := language.Canonicalize(session.SourceLanguage); err == nil {
			return canonical, "session"
		}
		return "", ""
	}
	if upstream != "" && upstream != "auto" {
		if canonical, err := language.Canonicalize(upstream); err == nil {
			return canonical, "recognizer"
		}
	}
	selected := make(map[string]bool)
	for _, tag := range session.RecognitionLanguages {
		canonical, err := language.Canonicalize(tag)
		if err != nil {
			return "", ""
		}
		selected[canonical] = true
	}
	if len(selected) != 2 || !selected["en"] || !selected["zh-Hans"] {
		return "", ""
	}
	han, latin := 0, 0
	for _, r := range text {
		switch {
		case unicode.Is(unicode.Han, r):
			han++
		case r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z':
			latin++
		case unicode.IsLetter(r):
			return "", "" // Other scripts and Latin languages remain unresolved.
		}
	}
	if han >= 2 && han*2 >= latin {
		return "zh-Hans", "text"
	}
	if latin >= 2 && (han == 0 || latin >= han*6) {
		return "en", "text"
	}
	return "", ""
}
