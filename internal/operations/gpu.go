package operations

import (
	"bytes"
	"context"
	"encoding/csv"
	"errors"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// GPU is one device as nvidia-smi reports it. A field the driver cannot
// report is nil rather than zero, so an idle fan is not mistaken for a
// missing one.
type GPU struct {
	Index             int      `json:"index"`
	Name              string   `json:"name"`
	Driver            string   `json:"driver"`
	MemoryTotalMB     *float64 `json:"memoryTotalMb"`
	MemoryUsedMB      *float64 `json:"memoryUsedMb"`
	Utilization       *float64 `json:"utilization"`
	MemoryUtilization *float64 `json:"memoryUtilization"`
	TemperatureC      *float64 `json:"temperatureC"`
	PowerDrawW        *float64 `json:"powerDrawW"`
	PowerLimitW       *float64 `json:"powerLimitW"`
	FanSpeed          *float64 `json:"fanSpeed"`
	SMClockMHz        *float64 `json:"smClockMhz"`
	MemoryClockMHz    *float64 `json:"memoryClockMhz"`
	PState            string   `json:"pstate"`
}

var gpuFields = []string{"index", "name", "driver_version", "memory.total", "memory.used", "utilization.gpu",
	"utilization.memory", "temperature.gpu", "power.draw", "power.limit", "fan.speed", "clocks.sm", "clocks.mem", "pstate"}

// FindGPUCommand returns nvidia-smi when this host can run it, or "".
func FindGPUCommand() string {
	path, err := exec.LookPath("nvidia-smi")
	if err != nil {
		return ""
	}
	return path
}

// sampleGPUs runs one bounded nvidia-smi query.
func sampleGPUs(ctx context.Context, command string) ([]GPU, error) {
	if command == "" {
		return nil, errors.New("no GPU query command")
	}
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, command, "--query-gpu="+strings.Join(gpuFields, ","),
		"--format=csv,noheader,nounits").Output()
	if err != nil {
		return nil, err
	}
	if len(output) > 64<<10 {
		return nil, errors.New("GPU query output too large")
	}
	return parseGPUs(output)
}

func parseGPUs(output []byte) ([]GPU, error) {
	reader := csv.NewReader(bytes.NewReader(output))
	reader.TrimLeadingSpace = true
	reader.FieldsPerRecord = len(gpuFields)
	records, err := reader.ReadAll()
	if err != nil {
		return nil, err
	}
	gpus := make([]GPU, 0, len(records))
	for _, record := range records {
		number := func(value string) *float64 {
			value = strings.TrimSpace(value)
			parsed, err := strconv.ParseFloat(value, 64)
			if err != nil {
				return nil
			}
			return &parsed
		}
		index, err := strconv.Atoi(strings.TrimSpace(record[0]))
		if err != nil {
			return nil, errors.New("GPU index is not a number")
		}
		gpus = append(gpus, GPU{
			Index: index, Name: strings.TrimSpace(record[1]), Driver: strings.TrimSpace(record[2]),
			MemoryTotalMB: number(record[3]), MemoryUsedMB: number(record[4]), Utilization: number(record[5]),
			MemoryUtilization: number(record[6]), TemperatureC: number(record[7]), PowerDrawW: number(record[8]),
			PowerLimitW: number(record[9]), FanSpeed: number(record[10]), SMClockMHz: number(record[11]),
			MemoryClockMHz: number(record[12]), PState: strings.TrimSpace(record[13]),
		})
	}
	return gpus, nil
}
