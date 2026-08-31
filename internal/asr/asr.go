package asr

import (
	"context"
	"errors"
	"fmt"
	"net/http"
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

type StartRequest struct {
	Language         string    `json:"lang"`
	Audio            AudioSpec `json:"audio"`
	CacheLines       int       `json:"cache_lines,omitempty"`
	AudioSense       bool      `json:"audio_sense,omitempty"`
	Diarize          bool      `json:"diarize,omitempty"`
	SpeakerEmbedding string    `json:"speaker_embeddings,omitempty"`
}

type StartResponse struct {
	SessionID    string    `json:"session_id"`
	WebSocketURL string    `json:"ws_url"`
	CreatedAt    float64   `json:"created_at"`
	Language     string    `json:"lang"`
	CacheLines   int       `json:"cache_lines"`
	Audio        AudioSpec `json:"audio"`
	ChunkMS      int       `json:"chunk_ms"`
}

type Event struct {
	Type     string  `json:"type"`
	Sequence int64   `json:"seq,omitempty"`
	Line     int64   `json:"line,omitempty"`
	Text     string  `json:"text,omitempty"`
	StartMS  int64   `json:"t0,omitempty"`
	EndMS    int64   `json:"t1,omitempty"`
	WallMS   int64   `json:"w,omitempty"`
	Wall0MS  int64   `json:"w0,omitempty"`
	Wall1MS  int64   `json:"w1,omitempty"`
	Language string  `json:"lang,omitempty"`
	Code     string  `json:"code,omitempty"`
	Message  string  `json:"message,omitempty"`
	PongTS   float64 `json:"ts,omitempty"`
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
