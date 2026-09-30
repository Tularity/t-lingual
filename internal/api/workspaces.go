package api

import (
	"net/http"
	"strings"

	"github.com/Tularity/t-lingual/internal/webapi"
	"github.com/Tularity/t-lingual/internal/workspace"
)

// listWorkspaces returns the caller's own workspaces, oldest first — creating
// their first one if they have none — and how many sessions others have
// shared with them, which the interface lists apart from their workspaces.
func (a *API) listWorkspaces(response http.ResponseWriter, request *http.Request, current identity) error {
	items, err := a.workspace.Workspaces(request.Context(), current.User.ID)
	if err != nil {
		return err
	}
	shared := 0
	if a.sharing != nil {
		accessible, err := a.sharing.ListAccessibleSessionsIn(request.Context(), userViewer(current), sharedOnly, 1, 0)
		if err != nil {
			return err
		}
		shared = len(accessible)
	}
	webapi.WriteJSON(response, http.StatusOK, map[string]any{"items": items, "hasShared": shared > 0})
	return nil
}

func (a *API) createWorkspace(response http.ResponseWriter, request *http.Request, current identity) error {
	var input workspace.WorkspaceInput
	if err := webapi.DecodeJSON(response, request, a.config.MaxJSONBytes, &input); err != nil {
		return err
	}
	created, err := a.workspace.CreateWorkspace(request.Context(), current.User.ID, input)
	if err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusCreated, created)
	return nil
}

// updateWorkspace sets a workspace's name and icon; both are sent each time.
func (a *API) updateWorkspace(response http.ResponseWriter, request *http.Request, current identity) error {
	var input workspace.WorkspaceInput
	if err := webapi.DecodeJSON(response, request, a.config.MaxJSONBytes, &input); err != nil {
		return err
	}
	updated, err := a.workspace.UpdateWorkspace(request.Context(), current.User.ID, request.PathValue("workspaceID"), input)
	if err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusOK, updated)
	return nil
}

// pinWorkspace pins one of the caller's workspaces above the others, or
// unpins it; only their own workspace can be found.
func (a *API) pinWorkspace(response http.ResponseWriter, request *http.Request, current identity) error {
	var input struct {
		Pinned *bool `json:"pinned"`
	}
	if err := webapi.DecodeJSON(response, request, a.config.MaxJSONBytes, &input); err != nil {
		return err
	}
	if input.Pinned == nil {
		return webapi.BadRequest("INVALID_WORKSPACE", "Say whether the workspace is pinned.")
	}
	updated, err := a.workspace.PinWorkspace(request.Context(), current.User.ID, request.PathValue("workspaceID"), *input.Pinned)
	if err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusOK, updated)
	return nil
}

// useWorkspace records that the caller has just opened the workspace, which
// is how the interface knows which ones they use most.
func (a *API) useWorkspace(response http.ResponseWriter, request *http.Request, current identity) error {
	if err := a.workspace.UseWorkspace(request.Context(), current.User.ID, request.PathValue("workspaceID")); err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusNoContent, nil)
	return nil
}

// deleteWorkspace removes a workspace; `moveTo` names the caller's workspace
// that receives its sessions, and is required whenever it has any.
func (a *API) deleteWorkspace(response http.ResponseWriter, request *http.Request, current identity) error {
	moveTo := strings.TrimSpace(request.URL.Query().Get("moveTo"))
	moved, err := a.workspace.DeleteWorkspace(request.Context(), current.User.ID, request.PathValue("workspaceID"), moveTo)
	if err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusOK, map[string]any{"moved": moved})
	return nil
}

type moveSessionInput struct {
	WorkspaceID string `json:"workspaceId"`
}

// moveSession keeps one of the caller's sessions in another of their workspaces.
func (a *API) moveSession(response http.ResponseWriter, request *http.Request, current identity) error {
	var input moveSessionInput
	if err := webapi.DecodeJSON(response, request, a.config.MaxJSONBytes, &input); err != nil {
		return err
	}
	moved, err := a.workspace.MoveSession(request.Context(), current.User.ID, request.PathValue("sessionID"), input.WorkspaceID)
	if err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusOK, moved)
	return nil
}
