package api

import (
	"net/http"
	"sync"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/webapi"
)

type mediaAdmission struct {
	mu      sync.Mutex
	active  int
	viewers map[string]int
}

func (a *mediaAdmission) acquire(viewer string) (func(), bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.active >= 32 || a.viewers[viewer] >= 4 {
		return nil, false
	}
	if a.viewers == nil {
		a.viewers = make(map[string]int)
	}
	a.active++
	a.viewers[viewer]++
	return func() {
		a.mu.Lock()
		defer a.mu.Unlock()
		a.active--
		a.viewers[viewer]--
		if a.viewers[viewer] == 0 {
			delete(a.viewers, viewer)
		}
	}, true
}

// Each body write is bounded; playback/export are allowed to outlive the
// ordinary HTTP request deadline without pinning authentication admission.
type mediaWriter struct {
	http.ResponseWriter
	controller *http.ResponseController
}

func (w mediaWriter) Write(data []byte) (int, error) {
	_ = w.controller.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return w.ResponseWriter.Write(data)
}
func (w mediaWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

type bundleWriter struct {
	mediaWriter
	started bool
}

func (w *bundleWriter) Write(data []byte) (int, error) {
	if !w.started {
		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Content-Disposition", `attachment; filename="t-lingual-session.zip"`)
		w.started = true
	}
	return w.mediaWriter.Write(data)
}

func (a *API) listAudio(w http.ResponseWriter, r *http.Request, viewer domain.Viewer) error {
	access, err := a.sharing.Resolve(r.Context(), viewer, r.PathValue("sessionID"))
	if err != nil {
		return err
	}
	parts, err := a.media.List(r.Context(), access.Session.UserID, access.Session.ID)
	if err != nil {
		return err
	}
	var duration int64
	for _, part := range parts {
		duration = max(duration, part.StartMS+part.DurationMS)
	}
	webapi.WriteJSON(w, http.StatusOK, map[string]any{"parts": parts, "durationMs": duration})
	return nil
}

func (a *API) getAudio(w http.ResponseWriter, r *http.Request, viewer domain.Viewer) error {
	access, err := a.sharing.Resolve(r.Context(), viewer, r.PathValue("sessionID"))
	if err != nil {
		return err
	}
	release, ok := a.mediaAdmission.acquire(access.Viewer.ID)
	if !ok {
		return &webapi.Error{Status: 429, Code: "AUDIO_CAPACITY", Message: "Too many audio downloads. Try again shortly."}
	}
	defer release()
	file, _, err := a.media.OpenWAV(r.Context(), access.Session.UserID, access.Session.ID, r.PathValue("partID"))
	if err != nil {
		return err
	}
	defer file.Close()
	controller := http.NewResponseController(w)
	defer controller.SetWriteDeadline(time.Time{})
	w.Header().Set("Content-Type", "audio/wav")
	w.Header().Set("Content-Disposition", `inline; filename="recording.wav"`)
	http.ServeContent(mediaWriter{w, controller}, r, "recording.wav", time.Time{}, file)
	return nil
}

func (a *API) getSessionBundle(w http.ResponseWriter, r *http.Request, current identity) error {
	sessionID := r.PathValue("sessionID")
	if _, err := a.workspace.Get(r.Context(), current.User.ID, sessionID); err != nil {
		return err
	}
	if a.rooms.State(sessionID).Active {
		return webapi.Conflict("SESSION_LIVE", "Stop recording before exporting the full session.")
	}
	release, ok := a.mediaAdmission.acquire("user:" + current.User.ID)
	if !ok {
		return &webapi.Error{Status: 429, Code: "AUDIO_CAPACITY", Message: "Too many audio downloads. Try again shortly."}
	}
	defer release()
	controller := http.NewResponseController(w)
	defer controller.SetWriteDeadline(time.Time{})
	writer := &bundleWriter{mediaWriter: mediaWriter{w, controller}}
	err := a.media.WriteBundle(r.Context(), current.User.ID, sessionID, writer)
	if err != nil && writer.started {
		a.logger.Warn("session export interrupted", "session_id", sessionID, "error", err)
		return nil
	}
	return err
}
