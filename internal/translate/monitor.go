package translate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
)

// Monitor is implemented by a provider that reports its own admission state.
// The status carries counts only: no text, client or request content.
type Monitor interface {
	Status(context.Context) (ServiceStatus, error)
}

// ServiceStatus is the translator's instantaneous, non-atomic snapshot.
type ServiceStatus struct {
	Status            string `json:"status"`
	CanAcceptNow      bool   `json:"can_accept_now"`
	RetryAfterSeconds *int   `json:"retry_after_seconds"`
	Model             string `json:"model"`
	Capacity          struct {
		Active             int `json:"active"`
		ActiveLimit        int `json:"active_limit"`
		Queued             int `json:"queued"`
		QueueLimit         int `json:"queue_limit"`
		Admitted           int `json:"admitted"`
		AdmittedLimit      int `json:"admitted_limit"`
		AvailableAdmission int `json:"available_admission"`
	} `json:"capacity"`
	Dependencies struct {
		EngineReady   bool `json:"engine_ready"`
		DetectorReady bool `json:"detector_ready"`
	} `json:"dependencies"`
	EngineMetrics struct {
		Available         bool     `json:"available"`
		Running           *int     `json:"running"`
		Waiting           *int     `json:"waiting"`
		KVCacheUsageRatio *float64 `json:"kv_cache_usage_ratio"`
	} `json:"engine_metrics"`
}

// Status reads /v1/status. The gateway answers 200 even when busy or
// unavailable; its own 503 means only that too many samples are in flight.
func (c *Client) Status(ctx context.Context) (ServiceStatus, error) {
	request, err := c.request(ctx, http.MethodGet, "/v1/status", nil)
	if err != nil {
		return ServiceStatus{}, err
	}
	response, err := c.http.Do(request)
	if err != nil {
		return ServiceStatus{}, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return ServiceStatus{}, decodeError(response)
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return ServiceStatus{}, err
	}
	if len(payload) > maxResponseBytes {
		return ServiceStatus{}, errors.New("translation status exceeded the byte limit")
	}
	var status ServiceStatus
	if err := json.Unmarshal(payload, &status); err != nil {
		return ServiceStatus{}, fmt.Errorf("decode translation status: %w", err)
	}
	return status, nil
}
