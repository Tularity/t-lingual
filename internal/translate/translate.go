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
}

type Usage struct {
	InputTokens  uint32 `json:"input_tokens"`
	OutputTokens uint32 `json:"output_tokens"`
}

type Response struct {
	RequestID      string `json:"request_id"`
	SourceLanguage string `json:"source_language"`
	TargetLanguage string `json:"target_language"`
	Translation    string `json:"translation"`
	Model          string `json:"model"`
	Usage          Usage  `json:"usage"`
}

type Provider interface {
	Ready(context.Context) error
	Translate(context.Context, Request) (Response, error)
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
