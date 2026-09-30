package rooms

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Tularity/t-lingual/internal/asr"
)

const (
	// feedSpeedup is how much faster than speech recognition is sent audio
	// that waited, as what a returning recorder kept through a dropped
	// connection. Speaker labels are dropped for good by recognition that
	// falls four seconds behind, so audio is not sent all at once.
	feedSpeedup = 3.0
	// feedBurst is how much audio, in seconds, may be sent at once.
	feedBurst = 1.0
	// feedMostWaiting is the most audio, in seconds, left waiting to be sent
	// before recognition is paused and the rest recognized later instead.
	feedMostWaiting = 30
	// feedSendDeadline bounds one piece: recognition that takes no audio for
	// this long has gone.
	feedSendDeadline = 10 * time.Second
	// defaultChunkMS is the piece size when recognition does not name its own.
	defaultChunkMS = 160
)

var (
	errFeedBehind = errors.New("recognition fell too far behind the audio")
	errFeedClosed = errors.New("recognition feed closed")
)

type feedItem struct {
	audio []byte
	// flushed is closed once everything before it, however little, was sent.
	flushed chan struct{}
}

// feeder hands one recognition stream its audio: in pieces of the stream's
// own chunk rather than each browser frame, and no faster than feedSpeedup
// times speech. Recognition works a chunk at a time, so nothing is recognized
// later for it; far fewer messages reach it, and audio that waited catches up
// at a pace it keeps up with.
type feeder struct {
	stream     asr.Stream
	chunkBytes int
	rate       float64
	burst      float64
	mostQueued int64
	items      chan feedItem
	failed     chan error
	quit       chan struct{}
	done       chan struct{}
	queued     atomic.Int64
	closeOnce  sync.Once
}

func newFeeder(ctx context.Context, stream asr.Stream, bytesPerSecond int) *feeder {
	chunkMS := stream.Info().ChunkMS
	if chunkMS <= 0 {
		chunkMS = defaultChunkMS
	}
	chunk := bytesPerSecond * chunkMS / 1000
	chunk -= chunk % 4
	f := &feeder{stream: stream, chunkBytes: max(4, chunk), rate: float64(bytesPerSecond) * feedSpeedup,
		burst: float64(bytesPerSecond) * feedBurst, mostQueued: int64(bytesPerSecond) * feedMostWaiting,
		items: make(chan feedItem, 4096), failed: make(chan error, 1), quit: make(chan struct{}), done: make(chan struct{})}
	go f.run(ctx)
	return f
}

// push queues audio to send. It reports false when too much is waiting, or
// the feeder has stopped: recognition cannot keep up with this audio.
func (f *feeder) push(audio []byte) bool {
	if f.queued.Load()+int64(len(audio)) > f.mostQueued {
		return false
	}
	f.queued.Add(int64(len(audio)))
	select {
	case f.items <- feedItem{audio: audio}:
		return true
	case <-f.done:
		return false
	default:
		f.queued.Add(-int64(len(audio)))
		return false
	}
}

// flush sends what is waiting, even less than a chunk, and waits for it.
func (f *feeder) flush(wait time.Duration) error {
	flushed := make(chan struct{})
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case f.items <- feedItem{flushed: flushed}:
	case <-f.done:
		return errFeedClosed
	case <-timer.C:
		return context.DeadlineExceeded
	}
	select {
	case <-flushed:
		return nil
	case <-f.done:
		return errFeedClosed
	case <-timer.C:
		return context.DeadlineExceeded
	}
}

// close stops sending; what is still waiting is not sent.
func (f *feeder) close() {
	f.closeOnce.Do(func() { close(f.quit) })
}

func (f *feeder) run(ctx context.Context) {
	defer close(f.done)
	pending := make([]byte, 0, f.chunkBytes*2)
	tokens, last := f.burst, time.Now()
	send := func(piece []byte) error {
		for {
			now := time.Now()
			tokens = min(f.burst, tokens+now.Sub(last).Seconds()*f.rate)
			last = now
			if size := float64(len(piece)); tokens >= size || size > f.burst {
				tokens -= size
				break
			}
			wait := time.Duration((float64(len(piece)) - tokens) / f.rate * float64(time.Second))
			select {
			case <-time.After(wait):
			case <-f.quit:
				return errFeedClosed
			case <-ctx.Done():
				return context.Cause(ctx)
			}
		}
		sendCtx, cancel := context.WithTimeout(ctx, feedSendDeadline)
		defer cancel()
		return f.stream.SendAudio(sendCtx, piece)
	}
	fail := func(err error) {
		if !errors.Is(err, errFeedClosed) {
			select {
			case f.failed <- err:
			default:
			}
		}
	}
	for {
		var item feedItem
		select {
		case item = <-f.items:
		case <-f.quit:
			return
		case <-ctx.Done():
			return
		}
		if item.audio != nil {
			f.queued.Add(-int64(len(item.audio)))
			pending = append(pending, item.audio...)
			for len(pending) >= f.chunkBytes {
				piece := append([]byte(nil), pending[:f.chunkBytes]...)
				pending = append(pending[:0], pending[f.chunkBytes:]...)
				if err := send(piece); err != nil {
					fail(err)
					return
				}
			}
		}
		if item.flushed != nil {
			if len(pending) > 0 {
				piece := append([]byte(nil), pending...)
				pending = pending[:0]
				if err := send(piece); err != nil {
					fail(err)
					return
				}
			}
			close(item.flushed)
		}
	}
}
