package asr

import (
	"context"
	"errors"
	"fmt"
	"github.com/Tularity/t-lingual/internal/language"
	"net/http"
	"sort"
	"time"
)

var (
	ErrDisabled    = errors.New("ASR provider is not configured")
	ErrUnavailable = errors.New("ASR provider is unavailable")
)

type AudioSpec struct {
	Encoding   string `json:"encoding"`
	SampleRate int    `json:"sample_rate"`
	Channels   int    `json:"channels"`
}

// LanguageRegion is a half-open interval on the upstream 16 kHz source-PCM
// clock. It is not a candidate-language allowlist or automatic language ID.
type LanguageRegion struct {
	StartMS  int64  `json:"start_ms"`
	EndMS    *int64 `json:"end_ms"`
	Language string `json:"lang"`
}

type LanguageRegionCapabilities struct {
	Clock         string `json:"clock"`
	Mode          string `json:"mode"`
	FutureUpdates bool   `json:"future_updates"`
}

type Capabilities struct {
	Backend            string                     `json:"asr_backend"`
	SupportedLanguages []string                   `json:"supported_langs"`
	LanguageRegions    LanguageRegionCapabilities `json:"language_regions"`
	Diarization        bool                       `json:"diarization"`
	SpeakerEmbeddings  bool                       `json:"speaker_embeddings"`
	AudioSense         bool                       `json:"audio_sense"`
}

type StartRequest struct {
	Language         string           `json:"lang"`
	Audio            AudioSpec        `json:"audio"`
	CacheLines       int              `json:"cache_lines,omitempty"`
	AudioSense       bool             `json:"audio_sense,omitempty"`
	Diarize          bool             `json:"diarize,omitempty"`
	SpeakerEmbedding string           `json:"speaker_embeddings,omitempty"`
	LanguageRegions  []LanguageRegion `json:"language_regions,omitempty"`
}

type StartResponse struct {
	SessionID          string           `json:"session_id"`
	WebSocketURL       string           `json:"ws_url"`
	CreatedAt          float64          `json:"created_at"`
	Language           string           `json:"lang"`
	CacheLines         int              `json:"cache_lines"`
	Audio              AudioSpec        `json:"audio"`
	ChunkMS            int              `json:"chunk_ms"`
	LanguageRegions    []LanguageRegion `json:"language_regions"`
	LanguageRegionMode string           `json:"language_region_mode"`
	AudioSense         bool             `json:"audio_sense"`
	Diarize            bool             `json:"diarize"`
	DiarLatencyMS      *int             `json:"diar_latency_ms"`
	MaxSpeakers        *int             `json:"max_speakers"`
	SpeakerEmbedding   string           `json:"speaker_embeddings"`
}

// Event is one upstream message. For an info event, CutoffMS and Reason
// describe a degraded auxiliary branch, as when speaker labels stop at
// CutoffMS of the stream's audio so recognition keeps up.
type Event struct {
	Type            string           `json:"type"`
	Sequence        int64            `json:"seq,omitempty"`
	Line            int64            `json:"line,omitempty"`
	Text            string           `json:"text,omitempty"`
	StartMS         int64            `json:"t0,omitempty"`
	EndMS           int64            `json:"t1,omitempty"`
	AudioPositionMS int64            `json:"t,omitempty"`
	WallMS          int64            `json:"w,omitempty"`
	Wall0MS         int64            `json:"w0,omitempty"`
	Wall1MS         int64            `json:"w1,omitempty"`
	Language        string           `json:"lang,omitempty"`
	Code            string           `json:"code,omitempty"`
	Message         string           `json:"message,omitempty"`
	PongTS          float64          `json:"ts,omitempty"`
	Speaker         *int             `json:"spk,omitempty"`
	State           string           `json:"state,omitempty"`
	AudioClockMS    int64            `json:"asr_t,omitempty"`
	InfoEvent       string           `json:"event,omitempty"`
	CutoffMS        int64            `json:"cutoff_ms,omitempty"`
	Reason          string           `json:"reason,omitempty"`
	LanguageRegions []LanguageRegion `json:"language_regions,omitempty"`
}

func (e Event) Final() bool { return e.Type == "final" }

type Stream interface {
	Info() StartResponse
	SendAudio(context.Context, []byte) error
	ForceEndOfUtterance(context.Context) error
	Reset(context.Context) error
	Ping(context.Context) error
	End(context.Context) error
	Events() <-chan Event
	Wait() error
	Close(context.Context) error
}

type Provider interface {
	Ready(context.Context) error
	Start(context.Context, StartRequest) (Stream, error)
}

// CapabilityProvider is optional so non-HTTP test providers remain small.
type CapabilityProvider interface {
	Capabilities(context.Context) (Capabilities, error)
}

// NormalizeLanguage maps only known application labels to an exact language
// advertised by this deployed ASR backend. It never guesses from a language
// prefix or invents a detected language for `auto`.
func NormalizeLanguage(requested string, capabilities Capabilities) (string, error) {
	for _, supported := range capabilities.SupportedLanguages {
		if supported == requested {
			return requested, nil
		}
	}
	canonical, err := language.CanonicalizeRecognition(requested)
	if err == nil {
		for _, supported := range capabilities.SupportedLanguages {
			candidate, candidateErr := language.CanonicalizeRecognition(supported)
			if candidateErr == nil && candidate == canonical {
				return supported, nil
			}
		}
	}
	return "", fmt.Errorf("ASR language %q is unavailable on this provider", requested)
}

// RecognitionLanguages exposes deduplicated application labels from the live provider.
func RecognitionLanguages(capabilities Capabilities) []string {
	seen := make(map[string]bool)
	result := make([]string, 0, len(capabilities.SupportedLanguages))
	for _, value := range capabilities.SupportedLanguages {
		code, err := language.CanonicalizeRecognition(value)
		if err == nil && code != "auto" && !seen[code] {
			seen[code] = true
			result = append(result, code)
		}
	}
	sort.Strings(result)
	return result
}

type ProviderError struct {
	StatusCode int
	Code       string
	Message    string
	RetryAfter time.Duration
}

func (e *ProviderError) Error() string {
	if e.Code == "" {
		return fmt.Sprintf("ASR provider returned HTTP %d", e.StatusCode)
	}
	// Provider messages are retained for typed handling but are intentionally
	// omitted here: errors are logged and an upstream service must not be able
	// to inject recognized speech or other sensitive text into application logs.
	return fmt.Sprintf("ASR provider returned %s (HTTP %d)", e.Code, e.StatusCode)
}

func (e *ProviderError) Temporary() bool {
	return e.StatusCode == http.StatusTooManyRequests || e.StatusCode >= http.StatusInternalServerError
}
