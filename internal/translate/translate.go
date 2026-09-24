// Package translate isolates t-lingual from the independently deployed
// llm-translator API contract.
package translate

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"
)

var (
	ErrDisabled    = errors.New("translation provider is not configured")
	ErrUnavailable = errors.New("translation provider is unavailable")
)

type Request struct {
	SourceLanguage string `json:"source_language"`
	TargetLanguage string `json:"target_language"`
	Text           string `json:"text"`
	SourceContext  string `json:"source_context,omitempty"`
}

type SourceDetection struct {
	Method      string  `json:"method"`
	Confidence  float64 `json:"confidence"`
	Rank        uint8   `json:"rank"`
	Uncertain   bool    `json:"uncertain"`
	ContextUsed bool    `json:"context_used"`
}

type Usage struct {
	InputTokens  uint32 `json:"input_tokens"`
	OutputTokens uint32 `json:"output_tokens"`
}

type Response struct {
	RequestID       string           `json:"request_id"`
	SourceLanguage  string           `json:"source_language"`
	SourceDetection *SourceDetection `json:"source_detection,omitempty"`
	TargetLanguage  string           `json:"target_language"`
	Translation     string           `json:"translation"`
	Model           string           `json:"model"`
	Usage           Usage            `json:"usage"`
}

type Provider interface {
	Ready(context.Context) error
	Translate(context.Context, Request) (Response, error)
}

// StreamUpdate contains cumulative provisional text, never a committed
// translation. Only TranslateStream's successful Response may be persisted.
type StreamUpdate struct {
	RequestID string
	Index     uint64
	Text      string
}

// StreamingProvider is optional; the synchronous Provider contract remains
// available for deployments without the progressive GPU endpoint.
type StreamingProvider interface {
	TranslateStream(context.Context, Request, func(StreamUpdate) error) (Response, error)
}

type ProviderError struct {
	StatusCode int
	Code       string
	Message    string
	RequestID  string
	RetryAfter time.Duration
}

func (e *ProviderError) Error() string {
	if e.Code == "" {
		return fmt.Sprintf("translation provider returned HTTP %d", e.StatusCode)
	}
	return fmt.Sprintf("translation provider returned %s (HTTP %d, request %s)", e.Code, e.StatusCode, e.RequestID)
}

func (e *ProviderError) Temporary() bool {
	return e.StatusCode == http.StatusTooManyRequests || e.StatusCode == http.StatusServiceUnavailable || e.StatusCode == http.StatusGatewayTimeout || e.StatusCode >= 500
}
