package api

import (
	"context"
	"net/http"

	"github.com/Tularity/t-lingual/internal/diskspace"
	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/webapi"
)

// accountStorageView is how much room one account's recordings take and how
// much it has left. AvailableBytes is the smaller of what its storage limit
// leaves and what the disk holding recordings has free; nil when neither is
// known. LimitBytes is zero when the account has no storage limit.
type accountStorageView struct {
	UsedBytes         int64  `json:"usedBytes"`
	AudioBytes        int64  `json:"audioBytes"`
	TranscriptBytes   int64  `json:"transcriptBytes"`
	LimitBytes        int64  `json:"limitBytes"`
	AvailableBytes    *int64 `json:"availableBytes"`
	Sessions          int    `json:"sessions"`
	ArchivedSessions  int    `json:"archivedSessions"`
	SessionsWithAudio int    `json:"sessionsWithAudio"`
	Workspaces        int    `json:"workspaces"`
	WorkspaceLimit    int    `json:"workspaceLimit"`
}

// storageFull reports whether an account has used all the storage its limit allows.
func (a *API) storageFull(ctx context.Context, userID string) (bool, error) {
	limits, err := a.store.EffectiveLimits(ctx, userID)
	if err != nil || limits.StorageMB == 0 {
		return false, err
	}
	used, err := a.store.StorageBytes(ctx, userID)
	if err != nil {
		return false, err
	}
	return used >= int64(limits.StorageMB)<<20, nil
}

// recordingAdmission says whether the viewer could start recording a session now.
func (a *API) recordingAdmission(response http.ResponseWriter, request *http.Request, viewer domain.Viewer) error {
	admission, err := a.rooms.Admission(request.Context(), viewer, request.PathValue("sessionID"))
	if err != nil {
		return err
	}
	response.Header().Set("Cache-Control", "no-store")
	webapi.WriteJSON(response, http.StatusOK, admission)
	return nil
}

// accountStorage is the signed-in account's own storage, for the sidebar.
func (a *API) accountStorage(response http.ResponseWriter, request *http.Request, current identity) error {
	userID := current.User.ID
	storage, err := a.store.AccountStorageOf(request.Context(), userID)
	if err != nil {
		return err
	}
	limits, err := a.store.EffectiveLimits(request.Context(), userID)
	if err != nil {
		return err
	}
	view := accountStorageView{UsedBytes: storage.AudioBytes + storage.TranscriptBytes, AudioBytes: storage.AudioBytes,
		TranscriptBytes: storage.TranscriptBytes, LimitBytes: int64(limits.StorageMB) << 20, Sessions: storage.Sessions,
		ArchivedSessions: storage.ArchivedSessions, SessionsWithAudio: storage.SessionsWithAudio,
		Workspaces: storage.Workspaces, WorkspaceLimit: limits.Workspaces}
	var available *int64
	if view.LimitBytes > 0 {
		left := max(0, view.LimitBytes-view.UsedBytes)
		available = &left
	}
	if root := a.store.DataRoot(); root != "" {
		if disk, err := diskspace.Of(root); err == nil {
			free := int64(min(disk.Free, uint64(1)<<62))
			if available == nil || free < *available {
				available = &free
			}
		}
	}
	view.AvailableBytes = available
	response.Header().Set("Cache-Control", "no-store")
	webapi.WriteJSON(response, http.StatusOK, view)
	return nil
}
