package language

import "testing"

func TestSupportedLanguagesAreStableAndIsolated(t *testing.T) {
	first := Supported()
	if len(first) != 46 || first[0] != "ar" || first[len(first)-1] != "zh-Hant" {
		t.Fatalf("unexpected supported language catalogue: %#v", first)
	}
	first[0] = "mutated"
	if Supported()[0] != "ar" {
		t.Fatal("caller mutated the supported language catalogue")
	}
}

func TestCanonicalizeMatchesPublicTranslationBoundary(t *testing.T) {
	tests := map[string]string{
		"en": "en", "en-us": "en", "pt-BR": "pt", "ja-JP": "ja",
		"fil-PH": "tl", "yue-HK": "yue", "zh-CN": "zh-Hans",
		"zh-Hant-HK": "zh-Hant", "zh-TW": "zh-Hant",
	}
	for input, expected := range tests {
		actual, err := Canonicalize(input)
		if err != nil || actual != expected {
			t.Fatalf("Canonicalize(%q) = %q, %v; want %q", input, actual, err, expected)
		}
	}
	for _, input := range []string{"", "auto", "zh", "zh-Hans-HK", "fil", "en_Latn", "xx", "english"} {
		if actual, err := Canonicalize(input); err == nil {
			t.Fatalf("Canonicalize(%q) unexpectedly accepted %q", input, actual)
		}
	}
	if actual, err := CanonicalizeSource("auto"); err != nil || actual != "auto" {
		t.Fatalf("source auto = %q, %v", actual, err)
	}
}
