package operations

import (
	"context"
	"errors"
	"testing"

	"github.com/Tularity/t-lingual/internal/asr"
	"github.com/Tularity/t-lingual/internal/providers"
	"github.com/Tularity/t-lingual/internal/translate"
)

type monitoredASR struct {
	asr.Provider
	load asr.Load
	err  error
}

func (m *monitoredASR) Load(context.Context) (asr.Load, error) { return m.load, m.err }
func (m *monitoredASR) Diagnostics(context.Context) (asr.Diagnostics, error) {
	return asr.Diagnostics{}, m.err
}

type monitoredTranslator struct {
	translate.Provider
	status translate.ServiceStatus
}

func (m *monitoredTranslator) Status(context.Context) (translate.ServiceStatus, error) {
	return m.status, nil
}

type fixedSource struct{ snapshot providers.Snapshot }

func (s fixedSource) Snapshot() providers.Snapshot { return s.snapshot }

func TestCollectorKeepsHistoryAndSaysWhetherProvidersHaveRoom(t *testing.T) {
	recognizer := &monitoredASR{load: asr.Load{Ready: true, CanAcceptNewSession: true,
		Slots: &asr.Slots{Active: 3, Free: 61, Max: 64}, Pressure: asr.Pressure{State: "normal"}}}
	translator := &monitoredTranslator{}
	translator.status.Status, translator.status.CanAcceptNow = "ready", true
	translator.status.Capacity.AvailableAdmission = 20
	collector := New(fixedSource{providers.Snapshot{ASR: recognizer, Translator: translator}}, "", 0, nil)
	collector.SetActivity(func() Activity { return Activity{Recordings: 2, Watchers: 5} })
	if collector.ASRHealth().Known {
		t.Fatal("health known before any sample")
	}
	collector.Sample(context.Background())
	health := collector.ASRHealth()
	if !health.Known || !health.Ready || !health.CanAccept || health.Elevated || health.Room != 61 {
		t.Fatalf("recognition health = %#v", health)
	}
	if room := collector.TranslatorHealth(); !room.Ready || room.Room != 20 {
		t.Fatalf("translation health = %#v", room)
	}
	recognizer.load.Pressure.State = "elevated"
	collector.Sample(context.Background())
	if !collector.ASRHealth().Elevated {
		t.Fatal("pressure not reported")
	}
	// A provider that stops answering is known to be down, not idle.
	recognizer.err = errors.New("connection refused")
	collector.Sample(context.Background())
	if health := collector.ASRHealth(); !health.Known || health.Ready {
		t.Fatalf("unreachable recognition = %#v", health)
	}
	snapshot := collector.Snapshot()
	if len(snapshot.History) != 3 || snapshot.History[0].ASRActive == nil || *snapshot.History[0].ASRActive != 3 ||
		snapshot.History[2].ASRUp || snapshot.Activity.Recordings != 2 || snapshot.ASR.Reachable {
		t.Fatalf("snapshot = %#v", snapshot)
	}
}

func TestGPUQueryOutputIsParsedWithUnreportedFieldsLeftEmpty(t *testing.T) {
	gpus, err := parseGPUs([]byte("0, NVIDIA GeForce RTX 5090, 610.88, 32607, 25334, 2, 1, 51, 51.85, 575.00, [N/A], 412, 14001, P0\n"))
	if err != nil || len(gpus) != 1 {
		t.Fatalf("parse = %#v, %v", gpus, err)
	}
	gpu := gpus[0]
	if gpu.Name != "NVIDIA GeForce RTX 5090" || *gpu.MemoryTotalMB != 32607 || *gpu.TemperatureC != 51 || gpu.FanSpeed != nil || gpu.PState != "P0" {
		t.Fatalf("gpu = %#v", gpu)
	}
	if _, err := parseGPUs([]byte("0, too, few\n")); err == nil {
		t.Fatal("short record accepted")
	}
}
