package asr

import (
	"context"
	"fmt"
	"net/http"
)

// Monitor is implemented by a provider that reports its own load. Every
// figure is an aggregate: no session, transcript or audio is ever included.
type Monitor interface {
	Load(context.Context) (Load, error)
	Diagnostics(context.Context) (Diagnostics, error)
}

// Load is the provider's instantaneous admission and pressure snapshot. It is
// read even when the provider answers "not ready", since that is when it
// matters most.
type Load struct {
	ObservedAtMS        int64    `json:"observed_at_ms"`
	Ready               bool     `json:"ready"`
	CanAcceptNewSession bool     `json:"can_accept_new_session"`
	AdmissionReason     string   `json:"admission_reason"`
	Health              string   `json:"health"`
	Backend             string   `json:"asr_backend"`
	Slots               *Slots   `json:"slots"`
	Queue               *Queue   `json:"queue"`
	Pressure            Pressure `json:"pressure"`
	Engine              *Engine  `json:"engine"`
	Worker              *Worker  `json:"worker"`
	EventLoop           *Loop    `json:"event_loop"`
	InputDroppedMSTotal *float64 `json:"input_dropped_ms_total"`
	InputDropAgeMS      *int64   `json:"input_drop_age_ms"`
}

type Slots struct {
	Active        int   `json:"active"`
	Free          int   `json:"free"`
	Max           int   `json:"max"`
	RejectedTotal int64 `json:"rejected_total"`
}

type Queue struct {
	SampledSessions        int     `json:"sampled_sessions"`
	Complete               bool    `json:"complete"`
	LimitMS                float64 `json:"limit_ms"`
	PendingP50             float64 `json:"pending_ms_p50"`
	PendingP95             float64 `json:"pending_ms_p95"`
	PendingMax             float64 `json:"pending_ms_max"`
	SessionsAboveHalfLimit int     `json:"sessions_above_half_limit"`
	SessionsAtLimit        int     `json:"sessions_at_limit"`
}

type Pressure struct {
	State   string   `json:"state"`
	Signals []string `json:"signals"`
}

type Engine struct {
	ChunkMS         float64  `json:"chunk_ms"`
	TickP50         float64  `json:"tick_ms_p50"`
	TickP95         float64  `json:"tick_ms_p95"`
	TickMax         float64  `json:"tick_ms_max"`
	TickAvg         float64  `json:"tick_ms_avg"`
	BatchSizeMax    int      `json:"batch_size_max"`
	ActiveSlots     int      `json:"active_slots"`
	FatalErrors     *int64   `json:"fatal_errors_total"`
	VRAMAllocatedMB *float64 `json:"vram_allocated_mb"`
}

type Worker struct {
	Alive          bool     `json:"alive"`
	LastTickAgeMS  *float64 `json:"last_tick_age_ms"`
	Stalled        bool     `json:"stalled"`
	TickErrorTotal int64    `json:"tick_errors_total"`
}

type Loop struct {
	LagP95    *float64 `json:"lag_ms_p95"`
	Saturated *bool    `json:"saturated"`
}

// Diagnostics is the slower-moving detail: memory, ingest and the auxiliary
// models, read less often than Load.
type Diagnostics struct {
	Ingest struct {
		MessagesPerSecond float64 `json:"msg_per_sec"`
		Megabytes         float64 `json:"mbytes"`
		CPUMSPerSecond    float64 `json:"cpu_ms_per_sec"`
	} `json:"ws_ingest"`
	Engine struct {
		DecodeStreamsTotal  int64 `json:"decode_streams_total"`
		LanguageSwitchTotal int64 `json:"language_switch_total"`
		ResetStreamTotal    int64 `json:"reset_stream_total"`
		ForceBarrierTotal   int64 `json:"force_barrier_total"`
		CAPIErrors          int64 `json:"c_api_errors"`
	} `json:"engine"`
	Diarization struct {
		Enabled     bool     `json:"enabled"`
		ActiveSlots int      `json:"active_slots"`
		MaxSpeakers int      `json:"max_speakers"`
		StepP50     *float64 `json:"step_ms_p50"`
		StepP95     *float64 `json:"step_ms_p95"`
		BudgetMS    float64  `json:"budget_ms"`
	} `json:"diar"`
	Embedding struct {
		Enabled         bool   `json:"enabled"`
		Model           string `json:"model"`
		ActiveSlots     int    `json:"active_slots"`
		EmbeddingsTotal int64  `json:"embeddings_total"`
	} `json:"embedding"`
	VRAM struct {
		Live struct {
			AllocatedMB    float64 `json:"allocated_mb"`
			ReservedMB     float64 `json:"reserved_mb"`
			MaxAllocatedMB float64 `json:"max_allocated_mb"`
			DriverUsedMB   float64 `json:"driver_used_mb"`
			DriverTotalMB  float64 `json:"driver_total_mb"`
		} `json:"live"`
		ByStage []struct {
			Stage        string  `json:"stage"`
			DriverUsedMB float64 `json:"driver_used_mb"`
		} `json:"by_stage"`
	} `json:"vram"`
	Sessions struct {
		MaxSlots     int `json:"max_slots"`
		Active       int `json:"active"`
		TotalTracked int `json:"total_tracked"`
	} `json:"sessions"`
}

func (c *Client) Load(ctx context.Context) (Load, error) {
	var load Load
	err := c.getJSON(ctx, "/v1/load", &load, http.StatusServiceUnavailable)
	return load, err
}

func (c *Client) Diagnostics(ctx context.Context) (Diagnostics, error) {
	var diagnostics Diagnostics
	err := c.getJSON(ctx, "/v1/diag", &diagnostics)
	return diagnostics, err
}

// getJSON reads one bounded JSON document; statuses in also are read as
// answers rather than failures.
func (c *Client) getJSON(ctx context.Context, suffix string, target any, also ...int) error {
	request, err := c.request(ctx, http.MethodGet, suffix, nil)
	if err != nil {
		return err
	}
	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer response.Body.Close()
	accepted := response.StatusCode == http.StatusOK
	for _, status := range also {
		accepted = accepted || response.StatusCode == status
	}
	if !accepted {
		return decodeProviderError(response)
	}
	return decodeLimited(response.Body, target)
}
