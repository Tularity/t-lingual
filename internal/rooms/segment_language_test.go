package rooms

import (
	"github.com/Tularity/t-lingual/internal/domain"
	"testing"
)

func TestLanguageRoutingPreservesEvidenceAndDoesNotInventASRDetection(t *testing.T) {
	bilingual := domain.InterpretationSession{SourceLanguage: "auto", RecognitionLanguages: []string{"en", "zh-Hans"}}
	for _, test := range []struct{ text, upstream, want, origin string }{
		{"The service is ready.", "auto", "en", "text"},
		{"会议现在开始。", "auto", "zh-Hans", "text"},
		{"我们讨论 API 接口。", "auto", "zh-Hans", "text"},
		{"12345", "auto", "", ""},
		{"Today in北京", "auto", "", ""},
		{"Bonjour à tous", "auto", "", ""},
		{"こんにちは", "auto", "", ""},
		{"A brief reply.", "en-US", "en", "recognizer"},
	} {
		got, origin := segmentLanguage(bilingual, test.upstream, test.text)
		if got != test.want || origin != test.origin {
			t.Errorf("%q -> %q/%q, want %q/%q", test.text, got, origin, test.want, test.origin)
		}
	}
	other := domain.InterpretationSession{SourceLanguage: "auto", RecognitionLanguages: []string{"en", "fr"}}
	if got, _ := segmentLanguage(other, "auto", "Bonjour tout le monde"); got != "" {
		t.Fatal("Latin script does not identify English vs French")
	}
	fixed := domain.InterpretationSession{SourceLanguage: "en"}
	if got, origin := segmentLanguage(fixed, "en", "Hello"); got != "en" || origin != "session" {
		t.Fatal("fixed hint mislabeled as detected")
	}
}
