package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/coder/websocket"
)

func TestRecognitionEditIsOwnerOnlyAndRejectsReservedRecorder(t *testing.T) {
	f, _, roomService := newFileMediaFixture(t)
	server := httptest.NewServer(f.handler)
	defer server.Close()
	session := sharedSession(t, f)
	view := "/api/v1/view/sessions/" + session.ID
	header := http.Header{}
	header.Set("Origin", f.config.RPOrigins[0])
	header.Set("Cookie", f.config.SessionCookieName+"="+f.tokens["alice"])
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+view+"/record", &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		if response != nil {
			t.Fatalf("record handshake %d: %v", response.StatusCode, err)
		}
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for !roomService.State(session.ID).Active && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !roomService.State(session.ID).Active {
		t.Fatal("reserved recorder not active")
	}
	update := f.request(t, http.MethodPut, view+"/recognition", `{"recognitionLanguages":["en","zh-Hans"],"diarization":false}`, "alice", true)
	if update.Code != http.StatusConflict {
		t.Fatalf("active config edit=%d %s", update.Code, update.Body.String())
	}
	bundle := f.request(t, http.MethodGet, "/api/v1/sessions/"+session.ID+"/bundle", "", "alice", false)
	if bundle.Code != http.StatusConflict {
		t.Fatalf("active export=%d %s", bundle.Code, bundle.Body.String())
	}
	conn.CloseNow()
	deadline = time.Now().Add(3 * time.Second)
	for roomService.State(session.ID).Active && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if roomService.State(session.ID).Active {
		t.Fatal("recorder did not release")
	}
	sharePath := "/api/v1/sessions/" + session.ID + "/shares"
	share := f.request(t, http.MethodPost, sharePath, `{"type":"user","userId":"usr_bob","permission":"record","expiresAt":null}`, "alice", true)
	if share.Code != http.StatusCreated {
		t.Fatalf("share=%d %s", share.Code, share.Body.String())
	}
	forbidden := f.request(t, http.MethodPut, view+"/recognition", `{"recognitionLanguages":["en"],"diarization":false}`, "bob", true)
	if forbidden.Code != http.StatusForbidden {
		t.Fatalf("collaborator edit=%d %s", forbidden.Code, forbidden.Body.String())
	}
	update = f.request(t, http.MethodPut, view+"/recognition", `{"recognitionLanguages":["en","zh-Hans"],"diarization":false}`, "alice", true)
	if update.Code != http.StatusOK || !strings.Contains(update.Body.String(), `"recognitionLanguages":["en","zh-Hans"]`) ||
		!strings.Contains(update.Body.String(), `"diarization":true`) {
		t.Fatalf("idle config edit=%d %s", update.Code, update.Body.String())
	}
	refreshed, err := f.store.GetInterpretationSession(context.Background(), session.UserID, session.ID)
	if err != nil || refreshed.SourceLanguage != "auto" || len(refreshed.RecognitionLanguages) != 2 || !refreshed.Diarization {
		t.Fatalf("persisted config %#v %v", refreshed, err)
	}
	if bad := f.request(t, http.MethodPut, view+"/recognition", `{"recognitionLanguages":[],"diarization":false}`, "alice", true); bad.Code != http.StatusBadRequest {
		t.Fatalf("empty recognition=%d %s", bad.Code, bad.Body.String())
	}
	if traversed := f.request(t, http.MethodPut, "/api/v1/view/sessions/%2e%2e%2f"+session.ID+"/recognition", `{"recognitionLanguages":["en"]}`, "alice", true); traversed.Code == http.StatusOK {
		t.Fatal("recognition traversal accepted")
	}
}
func TestTimeSeekWindowRespectsOwnerAndSharePermissions(t *testing.T) {
	f, _, _ := newFileMediaFixture(t)
	session := sharedSession(t, f)
	ctx := context.Background()
	for sequence, at := range []int64{0, 1000, 2000, 3000} {
		segment := domain.Segment{ID: "seg_seek_" + string(rune('1'+sequence)), SessionID: session.ID, UserID: session.UserID, Sequence: int64(sequence + 1), SourceText: "phrase", Final: true, StartMS: at, EndMS: at + 600, CreatedAt: time.Now().UTC().Add(time.Duration(sequence) * time.Second)}
		if err := f.store.AppendSegment(ctx, session.UserID, segment); err != nil {
			t.Fatal(err)
		}
	}
	view := "/api/v1/view/sessions/" + session.ID + "/segments?atMs=2500&limit=2"
	if stranger := f.request(t, http.MethodGet, view, "", "bob", false); stranger.Code != http.StatusNotFound {
		t.Fatalf("stranger time seek=%d %s", stranger.Code, stranger.Body.String())
	}
	owner := f.request(t, http.MethodGet, view, "", "alice", false)
	if owner.Code != http.StatusOK || !strings.Contains(owner.Body.String(), `"id":"seg_seek_3"`) {
		t.Fatalf("owner seek=%d %s", owner.Code, owner.Body.String())
	}
	share := f.request(t, http.MethodPost, "/api/v1/sessions/"+session.ID+"/shares", `{"type":"user","userId":"usr_bob","permission":"view","expiresAt":null}`, "alice", true)
	if share.Code != http.StatusCreated {
		t.Fatalf("share=%d %s", share.Code, share.Body.String())
	}
	viewer := f.request(t, http.MethodGet, view, "", "bob", false)
	if viewer.Code != http.StatusOK || !strings.Contains(viewer.Body.String(), `"id":"seg_seek_3"`) {
		t.Fatalf("shared seek=%d %s", viewer.Code, viewer.Body.String())
	}
	for _, query := range []string{"atMs=-1", "atMs=2500&after=1", "atMs=315360000001", "atMs=abc"} {
		response := f.request(t, http.MethodGet, "/api/v1/view/sessions/"+session.ID+"/segments?"+query, "", "alice", false)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("invalid %s=%d %s", query, response.Code, response.Body.String())
		}
	}
}
