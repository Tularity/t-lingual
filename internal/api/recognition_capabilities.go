package api

import (
	"context"
	"net/http"
	"time"

	"github.com/Tularity/t-lingual/internal/asr"
	"github.com/Tularity/t-lingual/internal/webapi"
)

func (a *API) getRecognitionCapabilities(w http.ResponseWriter, r *http.Request, _ identity) error {
	if a.providers == nil || a.providers.Snapshot().ASR == nil {
		webapi.WriteJSON(w, 200, map[string]any{"configured": false, "languages": []string{}, "automatic": false, "diarization": false})
		return nil
	}
	provider, ok := a.providers.Snapshot().ASR.(asr.CapabilityProvider)
	if !ok {
		return &webapi.Error{Status: 503, Code: "ASR_CAPABILITIES_UNAVAILABLE", Message: "Recognition languages are temporarily unavailable."}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	capabilities, err := provider.Capabilities(ctx)
	if err != nil {
		return &webapi.Error{Status: 503, Code: "ASR_CAPABILITIES_UNAVAILABLE", Message: "Recognition languages are temporarily unavailable."}
	}
	_, automaticErr := asr.NormalizeLanguage("auto", capabilities)
	// Whether a recording could start now: recognition is up and has room.
	available := a.rooms == nil || a.rooms.RecognitionAvailable(r.Context())
	webapi.WriteJSON(w, 200, map[string]any{"configured": true, "available": available, "languages": asr.RecognitionLanguages(capabilities), "automatic": automaticErr == nil, "diarization": capabilities.Diarization})
	return nil
}
