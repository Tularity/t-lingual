package media

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"github.com/Tularity/t-lingual/internal/id"
	"github.com/Tularity/t-lingual/internal/store"
)

const maxPartBytes int64 = 512 << 20

var mediaID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,96}$`)

func validID(value string) bool { return mediaID.MatchString(value) }

// AudioPart is the public, playable timeline projection. Start and duration
// derive from actual saved PCM frames rather than recognition speech bounds.
type AudioPart struct {
	ID         string    `json:"id"`
	SessionID  string    `json:"sessionId"`
	StartMS    int64     `json:"startMs"`
	DurationMS int64     `json:"durationMs"`
	SampleRate int       `json:"sampleRate"`
	Channels   int       `json:"channels"`
	Bytes      int64     `json:"bytes"`
	CreatedAt  time.Time `json:"createdAt"`
	State      string    `json:"state"`
}

func project(p store.RecordingPart) AudioPart {
	start := p.OffsetFrames * 1000 / int64(p.SampleRate)
	end := (p.OffsetFrames + p.Frames) * 1000 / int64(p.SampleRate)
	return AudioPart{ID: p.ID, SessionID: p.SessionID, StartMS: start, DurationMS: end - start,
		SampleRate: p.SampleRate, Channels: 1, Bytes: p.Bytes, CreatedAt: p.CreatedAt, State: "ready"}
}

type Manager struct {
	root string
	db   *store.Store
}

func New(db *store.Store, dataRoot string) (*Manager, error) {
	if db == nil || dataRoot == "" {
		return nil, errors.New("media: store and data root required")
	}
	root, err := filepath.Abs(filepath.Join(dataRoot, "sessions"))
	if err != nil {
		return nil, err
	}
	return &Manager{root: root, db: db}, nil
}

var fileLocks [128]sync.Mutex

func (m *Manager) lock(sessionID string) *sync.Mutex {
	h := fnv.New32a()
	_, _ = h.Write([]byte(m.root))
	_, _ = h.Write([]byte{0})
	_, _ = h.Write([]byte(sessionID))
	return &fileLocks[h.Sum32()%uint32(len(fileLocks))]
}
func (m *Manager) path(sessionID, partID string) string {
	return filepath.Join(m.root, sessionID, "audio", partID+".pcm")
}
func (m *Manager) reconcile(ctx context.Context, ownerID, sessionID string) ([]store.RecordingPart, error) {
	if !validID(sessionID) {
		return nil, store.ErrNotFound
	}
	parts, err := m.db.ListRecordingParts(ctx, ownerID, sessionID)
	if err != nil {
		return nil, err
	}
	for i := range parts {
		info, err := os.Lstat(m.path(sessionID, parts[i].ID))
		if err != nil {
			return nil, fmt.Errorf("media: recording file missing: %w", err)
		}
		if !info.Mode().IsRegular() || info.Size()%4 != 0 || info.Size() > maxPartBytes {
			return nil, errors.New("media: recording file corrupt or unsafe")
		}
		if info.Size() < parts[i].Bytes {
			return nil, errors.New("media: recording truncated below committed length")
		}
		if info.Size() > parts[i].Bytes {
			if err := m.db.AdvanceRecordingPart(ctx, ownerID, sessionID, parts[i].ID, info.Size()); err != nil {
				return nil, err
			}
			parts[i].Bytes, parts[i].Frames = info.Size(), info.Size()/4
		}
	}
	return parts, nil
}
func duration(parts []store.RecordingPart) int64 {
	var ms int64
	for _, p := range parts {
		end := (p.OffsetFrames + p.Frames) * 1000 / int64(p.SampleRate)
		if end > ms {
			ms = end
		}
	}
	return ms
}
func (m *Manager) DurationMS(ctx context.Context, ownerID, sessionID string) (int64, error) {
	guard := m.lock(sessionID)
	guard.Lock()
	defer guard.Unlock()
	parts, err := m.reconcile(ctx, ownerID, sessionID)
	if err != nil {
		return 0, err
	}
	return duration(parts), nil
}
func (m *Manager) List(ctx context.Context, ownerID, sessionID string) ([]AudioPart, error) {
	guard := m.lock(sessionID)
	guard.Lock()
	defer guard.Unlock()
	parts, err := m.reconcile(ctx, ownerID, sessionID)
	if err != nil {
		return nil, err
	}
	result := make([]AudioPart, len(parts))
	for i, p := range parts {
		result[i] = project(p)
	}
	return result, nil
}

type Writer struct {
	manager                   *Manager
	ownerID, sessionID, runID string
	rate, index               int
	nextOffsetFrames          int64
	current                   store.RecordingPart
	file                      *os.File
	closed                    bool
}

func (m *Manager) Begin(ctx context.Context, ownerID, sessionID, runID string, sampleRate int, minimumOffsetMS ...int64) (*Writer, int64, error) {
	if sampleRate < 8000 || sampleRate > 192000 {
		return nil, 0, errors.New("media: invalid sample rate")
	}
	guard := m.lock(sessionID)
	guard.Lock()
	defer guard.Unlock()
	parts, err := m.reconcile(ctx, ownerID, sessionID)
	if err != nil {
		return nil, 0, err
	}
	offset := duration(parts)
	if len(parts) == 0 && len(minimumOffsetMS) > 0 && minimumOffsetMS[0] > offset {
		offset = minimumOffsetMS[0]
	}
	frames := (offset*int64(sampleRate) + 999) / 1000
	return &Writer{manager: m, ownerID: ownerID, sessionID: sessionID, runID: runID, rate: sampleRate, nextOffsetFrames: frames}, offset, nil
}
func (w *Writer) start(ctx context.Context) error {
	partID, err := id.New("aud")
	if err != nil {
		return err
	}
	part := store.RecordingPart{ID: partID, SessionID: w.sessionID, RunID: w.runID, Index: w.index, SampleRate: w.rate, OffsetFrames: w.nextOffsetFrames, CreatedAt: time.Now().UTC()}
	dir := filepath.Dir(w.manager.path(w.sessionID, partID))
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	file, err := os.OpenFile(w.manager.path(w.sessionID, partID), os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	if err := w.manager.db.CreateRecordingPart(ctx, w.ownerID, w.sessionID, part); err != nil {
		file.Close()
		os.Remove(file.Name())
		return err
	}
	w.file, w.current = file, part
	w.index++
	return nil
}
func (w *Writer) Append(ctx context.Context, pcm []byte) error {
	guard := w.manager.lock(w.sessionID)
	guard.Lock()
	defer guard.Unlock()
	if w.closed || len(pcm) == 0 || len(pcm)%4 != 0 || int64(len(pcm)) > maxPartBytes {
		return errors.New("media: invalid audio frame")
	}
	if w.file == nil || w.current.Bytes+int64(len(pcm)) > maxPartBytes {
		if w.file != nil {
			if err := w.file.Sync(); err != nil {
				return err
			}
			if err := w.file.Close(); err != nil {
				return err
			}
			w.file = nil
			w.nextOffsetFrames = w.current.OffsetFrames + w.current.Frames
		}
		if err := w.start(ctx); err != nil {
			return err
		}
	}
	before := w.current.Bytes
	n, err := w.file.Write(pcm)
	if err == nil && n != len(pcm) {
		err = io.ErrShortWrite
	}
	if err == nil {
		err = w.file.Sync()
	}
	if err == nil {
		err = w.manager.db.AdvanceRecordingPart(ctx, w.ownerID, w.sessionID, w.current.ID, before+int64(n))
	}
	if err != nil {
		if truncErr := w.file.Truncate(before); truncErr != nil {
			return fmt.Errorf("media: append: %w; rollback: %v", err, truncErr)
		}
		_, _ = w.file.Seek(before, io.SeekStart)
		_ = w.file.Sync()
		return err
	}
	w.current.Bytes += int64(n)
	w.current.Frames = w.current.Bytes / 4
	return nil
}
func (w *Writer) Close() error {
	guard := w.manager.lock(w.sessionID)
	guard.Lock()
	defer guard.Unlock()
	if w.closed {
		return nil
	}
	w.closed = true
	if w.file == nil {
		return nil
	}
	err := w.file.Sync()
	closeErr := w.file.Close()
	if err != nil {
		return err
	}
	return closeErr
}
func (m *Manager) OpenWAV(ctx context.Context, ownerID, sessionID, partID string) (io.ReadSeekCloser, int64, error) {
	guard := m.lock(sessionID)
	guard.Lock()
	defer guard.Unlock()
	parts, err := m.reconcile(ctx, ownerID, sessionID)
	if err != nil {
		return nil, 0, err
	}
	var part *store.RecordingPart
	for i := range parts {
		if parts[i].ID == partID {
			part = &parts[i]
			break
		}
	}
	if part == nil {
		return nil, 0, store.ErrNotFound
	}
	file, err := os.Open(m.path(sessionID, partID))
	if err != nil {
		return nil, 0, err
	}
	header := make([]byte, 44)
	copy(header[:4], "RIFF")
	binary.LittleEndian.PutUint32(header[4:], uint32(part.Bytes+36))
	copy(header[8:12], "WAVE")
	copy(header[12:16], "fmt ")
	binary.LittleEndian.PutUint32(header[16:], 16)
	binary.LittleEndian.PutUint16(header[20:], 3)
	binary.LittleEndian.PutUint16(header[22:], 1)
	binary.LittleEndian.PutUint32(header[24:], uint32(part.SampleRate))
	binary.LittleEndian.PutUint32(header[28:], uint32(part.SampleRate*4))
	binary.LittleEndian.PutUint16(header[32:], 4)
	binary.LittleEndian.PutUint16(header[34:], 32)
	copy(header[36:40], "data")
	binary.LittleEndian.PutUint32(header[40:], uint32(part.Bytes))
	r := &wavReader{file: file, header: header, length: part.Bytes + 44}
	return r, r.length, nil
}

type wavReader struct {
	file        *os.File
	header      []byte
	pos, length int64
}

func (r *wavReader) Close() error { return r.file.Close() }
func (r *wavReader) Seek(offset int64, whence int) (int64, error) {
	base := int64(0)
	switch whence {
	case io.SeekStart:
	case io.SeekCurrent:
		base = r.pos
	case io.SeekEnd:
		base = r.length
	default:
		return 0, errors.New("media: invalid seek")
	}
	if base+offset < 0 {
		return 0, errors.New("media: negative seek")
	}
	r.pos = base + offset
	return r.pos, nil
}
func (r *wavReader) Read(dst []byte) (int, error) {
	if r.pos >= r.length {
		return 0, io.EOF
	}
	n := 0
	if r.pos < 44 {
		n = copy(dst, r.header[r.pos:])
		r.pos += int64(n)
		dst = dst[n:]
	}
	if len(dst) > 0 && r.pos < r.length {
		maxRead := min(int64(len(dst)), r.length-r.pos)
		read, err := r.file.ReadAt(dst[:maxRead], r.pos-44)
		n += read
		r.pos += int64(read)
		if err != nil && err != io.EOF {
			return n, err
		}
	}
	return n, nil
}
