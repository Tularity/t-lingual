package asr

import (
	"encoding/json"
	"math"
	"testing"
)

func TestAudioSenseAndDiarizationAreAcknowledgedByProvider(t *testing.T) {
	request := StartRequest{Language: "auto", Audio: AudioSpec{Encoding: "pcm32f", SampleRate: 48000, Channels: 1}, AudioSense: true, Diarize: true}
	response := validStartResponse("sense-check", request.Audio)
	if err := validateStartResponse(request, response); err == nil {
		t.Fatal("provider silently omitted requested audio sense and diarization")
	}
	response.AudioSense = true
	if err := validateStartResponse(request, response); err == nil {
		t.Fatal("provider silently omitted requested diarization")
	}
	response.Diarize = true
	if err := validateStartResponse(request, response); err != nil {
		t.Fatal(err)
	}
	response.CreatedAt = math.NaN()
	if err := validateStartResponse(request, response); err == nil {
		t.Fatal("non-finite ASR session origin accepted")
	}
}

func TestAudioStateReceiveClockDecodedSeparatelyFromASRClock(t *testing.T) {
	var event Event
	if err := json.Unmarshal([]byte(`{"type":"audio_state","state":"speech","t":10300,"asr_t":2800}`), &event); err != nil {
		t.Fatal(err)
	}
	if err := validateEvent(&event); err != nil {
		t.Fatal(err)
	}
	if event.AudioPositionMS != 10300 || event.AudioClockMS != 2800 {
		t.Fatalf("received and gated clocks were conflated: %#v", event)
	}
	event.AudioPositionMS = -1
	if err := validateEvent(&event); err == nil {
		t.Fatal("negative received audio clock accepted")
	}
}
