package rooms

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/asr"
)

// pieceStream is a recognition stream that notes each piece of audio it is
// sent, and when.
type pieceStream struct {
	testASRStream
	mu     sync.Mutex
	sizes  []int
	times  []time.Time
	chunkM int
}

func (s *pieceStream) Info() asr.StartResponse { return asr.StartResponse{ChunkMS: s.chunkM} }
func (s *pieceStream) SendAudio(_ context.Context, audio []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sizes = append(s.sizes, len(audio))
	s.times = append(s.times, time.Now())
	return nil
}
func (s *pieceStream) sent() ([]int, []time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]int(nil), s.sizes...), append([]time.Time(nil), s.times...)
}

// Recognition hears audio in pieces of its own chunk, and audio that waited
// no faster than a few times speech.
func TestTheFeederSendsWholeChunksAtAPaceRecognitionKeepsUpWith(t *testing.T) {
	const bytesPerSecond = 16000 * 4
	stream := &pieceStream{chunkM: 160}
	feed := newFeeder(context.Background(), stream, bytesPerSecond)
	defer feed.close()
	frame := make([]byte, bytesPerSecond/50) // 20 ms, as a browser sends
	started := time.Now()
	for range 150 { // three seconds kept through a dropped connection, all at once
		if !feed.push(frame) {
			t.Fatal("three seconds were refused")
		}
	}
	if err := feed.flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	sizes, times := stream.sent()
	chunk := bytesPerSecond * 160 / 1000
	total := 0
	for index, size := range sizes {
		total += size
		if index < len(sizes)-1 && size != chunk {
			t.Fatalf("piece %d is %d bytes, not a %d-byte chunk", index, size, chunk)
		}
	}
	if total != 150*len(frame) {
		t.Fatalf("sent %d bytes of %d", total, 150*len(frame))
	}
	// A second may go at once; the other two at three times speech.
	if took := times[len(times)-1].Sub(started); took < 500*time.Millisecond || took > 2*time.Second {
		t.Fatalf("three seconds of audio took %v to send", took)
	}
}

// Audio recognition cannot take in time is refused, so recognition can be
// paused and the audio recognized later.
func TestTheFeederRefusesMoreThanItCanHoldWaiting(t *testing.T) {
	const bytesPerSecond = 16000 * 4
	stream := &pieceStream{chunkM: 160}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	feed := newFeeder(ctx, stream, bytesPerSecond)
	defer feed.close()
	second := make([]byte, bytesPerSecond)
	refused := false
	for range feedMostWaiting + 5 {
		if !feed.push(second) {
			refused = true
			break
		}
	}
	if !refused {
		t.Fatal("more than it can hold was taken")
	}
}
