// Package operations keeps a rolling picture of the services recording
// depends on — recognition, translation and the GPU they share — for the
// administrators' monitoring page and for work that must wait for them.
package operations

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/Tularity/t-lingual/internal/asr"
	"github.com/Tularity/t-lingual/internal/providers"
	"github.com/Tularity/t-lingual/internal/translate"
)

const (
	// DefaultInterval is how often the providers are sampled.
	DefaultInterval = 5 * time.Second
	// historyLength keeps an hour of samples at the default interval.
	historyLength = 720
	// diagnosticsEvery spaces out the heavier recognition diagnostics.
	diagnosticsEvery = 30 * time.Second
)

// Source is where the current providers come from.
type Source interface {
	Snapshot() providers.Snapshot
}

// Activity is this application's own share of the load.
type Activity struct {
	Recordings int `json:"recordings"`
	Watchers   int `json:"watchers"`
	Rooms      int `json:"rooms"`
}

// Sample is one point of the history: the few figures worth drawing over time.
type Sample struct {
	At            time.Time `json:"t"`
	ASRUp         bool      `json:"asrUp"`
	ASRActive     *int      `json:"asrActive"`
	ASRMax        *int      `json:"asrMax"`
	ASRPendingP95 *float64  `json:"asrPendingP95"`
	ASRTickP95    *float64  `json:"asrTickP95"`
	ASRLagP95     *float64  `json:"asrLagP95"`
	ASRElevated   bool      `json:"asrElevated"`
	TrUp          bool      `json:"trUp"`
	TrActive      *int      `json:"trActive"`
	TrQueued      *int      `json:"trQueued"`
	TrRunning     *int      `json:"trRunning"`
	TrWaiting     *int      `json:"trWaiting"`
	TrKV          *float64  `json:"trKv"`
	GPUUtil       *float64  `json:"gpuUtil"`
	GPUMemUsedMB  *float64  `json:"gpuMemUsedMb"`
	GPUMemTotalMB *float64  `json:"gpuMemTotalMb"`
	GPUTempC      *float64  `json:"gpuTempC"`
	GPUPowerW     *float64  `json:"gpuPowerW"`
	Recordings    int       `json:"recordings"`
	Watchers      int       `json:"watchers"`
}

// Reading is the latest sample of one provider.
type Reading[T any] struct {
	Configured bool      `json:"configured"`
	Reachable  bool      `json:"reachable"`
	Error      string    `json:"error,omitempty"`
	At         time.Time `json:"at"`
	Value      *T        `json:"value"`
}

// Snapshot is everything the monitoring page shows.
type Snapshot struct {
	SampledAt       time.Time                        `json:"sampledAt"`
	IntervalSeconds float64                          `json:"intervalSeconds"`
	ASR             Reading[asr.Load]                `json:"asr"`
	Diagnostics     Reading[asr.Diagnostics]         `json:"diagnostics"`
	Translator      Reading[translate.ServiceStatus] `json:"translator"`
	GPU             Reading[[]GPU]                   `json:"gpu"`
	Activity        Activity                         `json:"activity"`
	History         []Sample                         `json:"history"`
}

type Collector struct {
	source     Source
	gpuCommand string
	interval   time.Duration
	logger     *slog.Logger

	mu          sync.RWMutex
	activity    func() Activity
	asr         Reading[asr.Load]
	diagnostics Reading[asr.Diagnostics]
	translator  Reading[translate.ServiceStatus]
	gpu         Reading[[]GPU]
	history     []Sample
	sampledAt   time.Time
}

// New makes a collector; gpuCommand may be "" where no GPU can be queried.
func New(source Source, gpuCommand string, interval time.Duration, logger *slog.Logger) *Collector {
	if interval <= 0 {
		interval = DefaultInterval
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Collector{source: source, gpuCommand: gpuCommand, interval: interval, logger: logger,
		history: make([]Sample, 0, historyLength)}
}

// SetActivity names where the application's own counts are read.
func (c *Collector) SetActivity(read func() Activity) {
	c.mu.Lock()
	c.activity = read
	c.mu.Unlock()
}

// Run samples until ctx ends.
func (c *Collector) Run(ctx context.Context) {
	c.Sample(ctx)
	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.Sample(ctx)
		}
	}
}

// Sample reads every provider once, concurrently, and records the result.
func (c *Collector) Sample(ctx context.Context) {
	now := time.Now().UTC()
	snapshot := c.source.Snapshot()
	var wait sync.WaitGroup
	var load Reading[asr.Load]
	var diagnostics *Reading[asr.Diagnostics]
	var status Reading[translate.ServiceStatus]
	var gpus *Reading[[]GPU]
	c.mu.RLock()
	diagnosticsDue := now.Sub(c.diagnostics.At) >= diagnosticsEvery
	c.mu.RUnlock()

	monitor, _ := snapshot.ASR.(asr.Monitor)
	load.Configured, load.At = snapshot.ASR != nil, now
	if monitor != nil {
		wait.Add(1)
		go func() {
			defer wait.Done()
			callCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
			defer cancel()
			value, err := monitor.Load(callCtx)
			load.Reachable, load.Error = err == nil, errorText(err)
			if err == nil {
				load.Value = &value
			}
		}()
		if diagnosticsDue {
			wait.Add(1)
			go func() {
				defer wait.Done()
				callCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
				defer cancel()
				value, err := monitor.Diagnostics(callCtx)
				reading := Reading[asr.Diagnostics]{Configured: true, Reachable: err == nil, Error: errorText(err), At: now}
				if err == nil {
					reading.Value = &value
				}
				diagnostics = &reading
			}()
		}
	}
	trMonitor, _ := snapshot.Translator.(translate.Monitor)
	status.Configured, status.At = snapshot.Translator != nil, now
	if trMonitor != nil {
		wait.Add(1)
		go func() {
			defer wait.Done()
			callCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
			defer cancel()
			value, err := trMonitor.Status(callCtx)
			status.Reachable, status.Error = err == nil, errorText(err)
			if err == nil {
				status.Value = &value
			}
		}()
	}
	if c.gpuCommand != "" {
		wait.Add(1)
		go func() {
			defer wait.Done()
			value, err := sampleGPUs(ctx, c.gpuCommand)
			reading := Reading[[]GPU]{Configured: true, Reachable: err == nil, Error: errorText(err), At: now}
			if err == nil {
				reading.Value = &value
			}
			gpus = &reading
		}()
	}
	wait.Wait()

	c.mu.Lock()
	defer c.mu.Unlock()
	c.asr, c.translator, c.sampledAt = load, status, now
	if diagnostics != nil {
		c.diagnostics = *diagnostics
	}
	if gpus != nil {
		c.gpu = *gpus
	}
	activity := Activity{}
	if c.activity != nil {
		activity = c.activity()
	}
	point := Sample{At: now, Recordings: activity.Recordings, Watchers: activity.Watchers}
	if value := load.Value; value != nil {
		point.ASRUp, point.ASRElevated = value.Ready, value.Pressure.State == "elevated"
		if value.Slots != nil {
			point.ASRActive, point.ASRMax = &value.Slots.Active, &value.Slots.Max
		}
		if value.Queue != nil && value.Queue.Complete {
			point.ASRPendingP95 = &value.Queue.PendingP95
		}
		if value.Engine != nil {
			point.ASRTickP95 = &value.Engine.TickP95
		}
		if value.EventLoop != nil {
			point.ASRLagP95 = value.EventLoop.LagP95
		}
	}
	if value := status.Value; value != nil {
		point.TrUp = value.Status == "ready" || value.Status == "busy"
		point.TrActive, point.TrQueued = &value.Capacity.Active, &value.Capacity.Queued
		point.TrRunning, point.TrWaiting, point.TrKV = value.EngineMetrics.Running, value.EngineMetrics.Waiting, value.EngineMetrics.KVCacheUsageRatio
	}
	if c.gpu.Value != nil && len(*c.gpu.Value) > 0 && c.gpu.At.Equal(now) {
		device := (*c.gpu.Value)[0]
		point.GPUUtil, point.GPUMemUsedMB, point.GPUMemTotalMB = device.Utilization, device.MemoryUsedMB, device.MemoryTotalMB
		point.GPUTempC, point.GPUPowerW = device.TemperatureC, device.PowerDrawW
	}
	if len(c.history) == historyLength {
		copy(c.history, c.history[1:])
		c.history = c.history[:historyLength-1]
	}
	c.history = append(c.history, point)
}

func errorText(err error) string {
	if err == nil {
		return ""
	}
	text := err.Error()
	if len(text) > 160 {
		text = text[:160]
	}
	return text
}

// Snapshot is the latest readings with their history.
func (c *Collector) Snapshot() Snapshot {
	c.mu.RLock()
	defer c.mu.RUnlock()
	activity := Activity{}
	if c.activity != nil {
		activity = c.activity()
	}
	return Snapshot{SampledAt: c.sampledAt, IntervalSeconds: c.interval.Seconds(), ASR: c.asr,
		Diagnostics: c.diagnostics, Translator: c.translator, GPU: c.gpu, Activity: activity,
		History: append([]Sample(nil), c.history...)}
}

// fresh: a reading older than three intervals says nothing about now.
func (c *Collector) fresh(at time.Time) bool {
	return !at.IsZero() && time.Since(at) <= 3*c.interval
}

// ASRHealth is recognition's latest known state.
func (c *Collector) ASRHealth() providers.Health {
	c.mu.RLock()
	defer c.mu.RUnlock()
	value := c.asr.Value
	if value == nil || !c.fresh(c.asr.At) {
		return providers.Health{Known: c.asr.Configured && c.asr.Error != "" && c.fresh(c.asr.At), At: c.asr.At}
	}
	health := providers.Health{Known: true, Ready: value.Ready, CanAccept: value.CanAcceptNewSession,
		Elevated: value.Pressure.State != "normal", At: c.asr.At}
	if value.Slots != nil {
		health.Room = value.Slots.Free
	}
	return health
}

// TranslatorHealth is translation's latest known state.
func (c *Collector) TranslatorHealth() providers.Health {
	c.mu.RLock()
	defer c.mu.RUnlock()
	value := c.translator.Value
	if value == nil || !c.fresh(c.translator.At) {
		return providers.Health{Known: c.translator.Configured && c.translator.Error != "" && c.fresh(c.translator.At), At: c.translator.At}
	}
	return providers.Health{Known: true, Ready: value.Status == "ready" || value.Status == "busy",
		CanAccept: value.CanAcceptNow, Elevated: value.Status != "ready", Room: value.Capacity.AvailableAdmission, At: c.translator.At}
}
