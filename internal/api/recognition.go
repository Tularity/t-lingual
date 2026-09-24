package api

import (
	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/webapi"
	"github.com/Tularity/t-lingual/internal/workspace"
	"net/http"
)

func (a *API) setRecognition(w http.ResponseWriter, r *http.Request, viewer domain.Viewer) error {
	var input struct {
		Languages   []string `json:"recognitionLanguages"`
		Diarization *bool    `json:"diarization"`
	}
	if err := webapi.DecodeJSON(w, r, 4096, &input); err != nil {
		return err
	}
	if len(input.Languages) == 0 || len(input.Languages) > 46 {
		return webapi.BadRequest("INVALID_RECOGNITION_LANGUAGES", "Choose at least one recognition language.")
	}
	source := "auto"
	if len(input.Languages) == 1 {
		source = input.Languages[0]
	}
	updated, err := a.rooms.UpdateIdleSession(r.Context(), viewer, r.PathValue("sessionID"), func(access domain.SessionAccess) (domain.InterpretationSession, error) {
		return a.workspace.Update(r.Context(), access.Session.UserID, access.Session.ID, workspace.UpdateInput{
			Title: access.Session.Title, SourceLanguage: source, RecognitionLanguages: input.Languages, Diarization: input.Diarization,
		})
	})
	if err != nil {
		return err
	}
	a.rooms.RefreshSession(updated.ID)
	if err := a.store.FlushPortableSession(r.Context(), updated.UserID, updated.ID); err != nil {
		return err
	}
	access, err := a.sharing.Resolve(r.Context(), viewer, updated.ID)
	if err != nil {
		return err
	}
	webapi.WriteJSON(w, http.StatusOK, sessionJSON(access))
	return nil
}
