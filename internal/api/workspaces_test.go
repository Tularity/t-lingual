package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/workspace"
)

func decodeWorkspaces(t *testing.T, body string) []domain.Workspace {
	t.Helper()
	var result struct {
		Items []domain.Workspace `json:"items"`
	}
	if err := json.Unmarshal([]byte(body), &result); err != nil {
		t.Fatalf("decode workspaces: %v: %s", err, body)
	}
	return result.Items
}

func TestWorkspaceAPIKeepsEachAccountsWorkspacesItsOwn(t *testing.T) {
	fixture := newSharedAPIFixture(t)

	// The first list gives the account its first, unnamed workspace.
	response := fixture.request(t, http.MethodGet, "/api/v1/workspaces", "", "alice", false)
	if response.Code != http.StatusOK {
		t.Fatalf("list = %d: %s", response.Code, response.Body.String())
	}
	first := decodeWorkspaces(t, response.Body.String())
	if len(first) != 1 || first[0].Name != "" {
		t.Fatalf("first workspaces = %#v", first)
	}

	// Mutations need the origin, like every other change.
	if response := fixture.request(t, http.MethodPost, "/api/v1/workspaces", `{"name":"Research"}`, "alice", false); response.Code != http.StatusForbidden {
		t.Fatalf("create without origin = %d", response.Code)
	}
	response = fixture.request(t, http.MethodPost, "/api/v1/workspaces", `{"name":"  Research  ","icon":"globe"}`, "alice", true)
	if response.Code != http.StatusCreated {
		t.Fatalf("create = %d: %s", response.Code, response.Body.String())
	}
	var research domain.Workspace
	if err := json.Unmarshal(response.Body.Bytes(), &research); err != nil || research.Name != "Research" || research.Icon != "globe" {
		t.Fatalf("created %#v %v", research, err)
	}
	if response := fixture.request(t, http.MethodPost, "/api/v1/workspaces", `{"name":"   "}`, "alice", true); response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("blank name = %d", response.Code)
	}
	// Only the icons the interface offers are kept.
	if response := fixture.request(t, http.MethodPost, "/api/v1/workspaces", `{"name":"Odd","icon":"<svg onload=x>"}`, "alice", true); response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("unknown icon = %d", response.Code)
	}
	response = fixture.request(t, http.MethodPatch, "/api/v1/workspaces/"+research.ID, `{"name":"Field research","icon":"users"}`, "alice", true)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"name":"Field research"`) || !strings.Contains(response.Body.String(), `"icon":"users"`) {
		t.Fatalf("update = %d: %s", response.Code, response.Body.String())
	}
	if response := fixture.request(t, http.MethodPatch, "/api/v1/workspaces/"+research.ID, `{"name":"Field research","icon":"bomb"}`, "alice", true); response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("update to an unknown icon = %d", response.Code)
	}

	// Another account sees none of it and can change none of it.
	path := "/api/v1/workspaces/" + research.ID
	for _, attempt := range []struct{ method, path, body string }{
		{http.MethodPatch, path, `{"name":"Taken"}`},
		{http.MethodPost, path + "/use", ""},
		{http.MethodDelete, path + "?moveTo=" + first[0].ID, ""},
	} {
		response := fixture.request(t, attempt.method, attempt.path, attempt.body, "bob", true)
		if response.Code != http.StatusNotFound || strings.Contains(response.Body.String(), "research") {
			t.Fatalf("bob %s %s = %d: %s", attempt.method, attempt.path, response.Code, response.Body.String())
		}
	}
	bobs := decodeWorkspaces(t, fixture.request(t, http.MethodGet, "/api/v1/workspaces", "", "bob", false).Body.String())
	if len(bobs) != 1 || bobs[0].ID == research.ID || bobs[0].ID == first[0].ID {
		t.Fatalf("bob lists %#v", bobs)
	}
	if response := fixture.request(t, http.MethodGet, "/api/v1/view/sessions?workspace="+research.ID, "", "bob", false); response.Code != http.StatusOK || strings.Contains(response.Body.String(), "int_") {
		t.Fatalf("bob listing alice's workspace = %d: %s", response.Code, response.Body.String())
	}

	// A session goes where it is asked to, and only into the owner's own.
	session, err := fixture.workspace.Create(context.Background(), fixture.users["alice"].ID, workspace.CreateInput{Title: "Kept", WorkspaceID: research.ID, SourceLanguage: "en", TargetLanguage: "fr"})
	if err != nil || session.WorkspaceID != research.ID {
		t.Fatalf("create session in workspace = %#v %v", session, err)
	}
	if response := fixture.request(t, http.MethodPut, "/api/v1/sessions/"+session.ID+"/workspace", `{"workspaceId":"`+bobs[0].ID+`"}`, "alice", true); response.Code != http.StatusNotFound {
		t.Fatalf("move into bob's workspace = %d", response.Code)
	}
	if response := fixture.request(t, http.MethodPut, "/api/v1/sessions/"+session.ID+"/workspace", `{"workspaceId":"`+bobs[0].ID+`"}`, "bob", true); response.Code != http.StatusNotFound {
		t.Fatalf("bob moved alice's session = %d", response.Code)
	}
	listed := fixture.request(t, http.MethodGet, "/api/v1/view/sessions?workspace="+research.ID, "", "alice", false)
	if !strings.Contains(listed.Body.String(), session.ID) || !strings.Contains(listed.Body.String(), `"workspaceId":"`+research.ID+`"`) {
		t.Fatalf("alice's workspace list = %s", listed.Body.String())
	}

	// Deleting a workspace that holds sessions needs a destination.
	response = fixture.request(t, http.MethodDelete, path, "", "alice", true)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "WORKSPACE_NOT_EMPTY") {
		t.Fatalf("delete without destination = %d: %s", response.Code, response.Body.String())
	}
	response = fixture.request(t, http.MethodDelete, path+"?moveTo="+first[0].ID, "", "alice", true)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"moved":1`) {
		t.Fatalf("delete with destination = %d: %s", response.Code, response.Body.String())
	}
	moved, err := fixture.workspace.Get(context.Background(), fixture.users["alice"].ID, session.ID)
	if err != nil || moved.WorkspaceID != first[0].ID {
		t.Fatalf("session after its workspace was deleted = %#v %v", moved, err)
	}
	// And the last one stays.
	response = fixture.request(t, http.MethodDelete, "/api/v1/workspaces/"+first[0].ID, "", "alice", true)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "LAST_WORKSPACE") {
		t.Fatalf("delete last = %d: %s", response.Code, response.Body.String())
	}
}

func TestSharedSessionsStayOutOfTheRecipientsWorkspaces(t *testing.T) {
	fixture := newSharedAPIFixture(t)
	session := sharedSession(t, fixture)
	if session.WorkspaceID == "" {
		t.Fatal("a new session has no workspace")
	}
	bobs := decodeWorkspaces(t, fixture.request(t, http.MethodGet, "/api/v1/workspaces", "", "bob", false).Body.String())
	if len(bobs) != 1 {
		t.Fatalf("bob's workspaces = %#v", bobs)
	}
	if response := fixture.request(t, http.MethodGet, "/api/v1/workspaces", "", "bob", false); !strings.Contains(response.Body.String(), `"hasShared":false`) {
		t.Fatalf("bob before the share = %s", response.Body.String())
	}
	if created := fixture.request(t, http.MethodPost, "/api/v1/sessions/"+session.ID+"/shares", `{"type":"user","userId":"usr_bob","permission":"view","expiresAt":null}`, "alice", true); created.Code != http.StatusCreated {
		t.Fatalf("share = %d: %s", created.Code, created.Body.String())
	}

	// The recipient is told there is something shared with them, and finds it
	// there — never in a workspace of their own, and never told where the
	// owner keeps it.
	if response := fixture.request(t, http.MethodGet, "/api/v1/workspaces", "", "bob", false); !strings.Contains(response.Body.String(), `"hasShared":true`) {
		t.Fatalf("bob after the share = %s", response.Body.String())
	}
	shared := fixture.request(t, http.MethodGet, "/api/v1/view/sessions?shared=true", "", "bob", false)
	if shared.Code != http.StatusOK || !strings.Contains(shared.Body.String(), session.ID) || strings.Contains(shared.Body.String(), "workspaceId") {
		t.Fatalf("bob's shared list = %d: %s", shared.Code, shared.Body.String())
	}
	own := fixture.request(t, http.MethodGet, "/api/v1/view/sessions?workspace="+bobs[0].ID, "", "bob", false)
	if own.Code != http.StatusOK || strings.Contains(own.Body.String(), session.ID) {
		t.Fatalf("bob's workspace = %d: %s", own.Code, own.Body.String())
	}
	view := fixture.request(t, http.MethodGet, "/api/v1/view/sessions/"+session.ID, "", "bob", false)
	if view.Code != http.StatusOK || strings.Contains(view.Body.String(), "workspaceId") || strings.Contains(view.Body.String(), session.WorkspaceID) {
		t.Fatalf("bob's view = %d: %s", view.Code, view.Body.String())
	}
	// Nor can they move it anywhere.
	if moved := fixture.request(t, http.MethodPut, "/api/v1/sessions/"+session.ID+"/workspace", `{"workspaceId":"`+bobs[0].ID+`"}`, "bob", true); moved.Code != http.StatusNotFound {
		t.Fatalf("bob moved a shared session = %d", moved.Code)
	}
	// The owner still sees where it is kept, and it is not in their shared list.
	if view := fixture.request(t, http.MethodGet, "/api/v1/view/sessions/"+session.ID, "", "alice", false); !strings.Contains(view.Body.String(), `"workspaceId":"`+session.WorkspaceID+`"`) {
		t.Fatalf("alice's view = %s", view.Body.String())
	}
	if list := fixture.request(t, http.MethodGet, "/api/v1/view/sessions?shared=true", "", "alice", false); strings.Contains(list.Body.String(), session.ID) {
		t.Fatalf("alice's shared list = %s", list.Body.String())
	}
}

func TestAnOwnerPinsAndUnpinsOnlyTheirOwnWorkspaces(t *testing.T) {
	fixture := newSharedAPIFixture(t)
	mine := decodeWorkspaces(t, fixture.request(t, http.MethodGet, "/api/v1/workspaces", "", "alice", false).Body.String())[0]
	theirs := decodeWorkspaces(t, fixture.request(t, http.MethodGet, "/api/v1/workspaces", "", "bob", false).Body.String())[0]
	path := "/api/v1/workspaces/" + mine.ID + "/pinned"

	if response := fixture.request(t, http.MethodPut, path, `{"pinned":true}`, "alice", false); response.Code != http.StatusForbidden {
		t.Fatalf("pin without origin = %d", response.Code)
	}
	if response := fixture.request(t, http.MethodPut, path, `{}`, "alice", true); response.Code != http.StatusBadRequest {
		t.Fatalf("pin without a state = %d", response.Code)
	}
	if response := fixture.request(t, http.MethodPut, "/api/v1/workspaces/"+theirs.ID+"/pinned", `{"pinned":true}`, "alice", true); response.Code != http.StatusNotFound {
		t.Fatalf("pin another account's workspace = %d", response.Code)
	}
	response := fixture.request(t, http.MethodPut, path, `{"pinned":true}`, "alice", true)
	var pinned domain.Workspace
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &pinned) != nil || pinned.PinnedAt == nil {
		t.Fatalf("pin = %d: %s", response.Code, response.Body.String())
	}
	// Pinning again keeps when it was first pinned.
	response = fixture.request(t, http.MethodPut, path, `{"pinned":true}`, "alice", true)
	var again domain.Workspace
	if json.Unmarshal(response.Body.Bytes(), &again) != nil || again.PinnedAt == nil || !again.PinnedAt.Equal(*pinned.PinnedAt) {
		t.Fatalf("pinned twice = %s", response.Body.String())
	}
	listed := decodeWorkspaces(t, fixture.request(t, http.MethodGet, "/api/v1/workspaces", "", "alice", false).Body.String())
	if listed[0].PinnedAt == nil {
		t.Fatalf("pin not listed: %#v", listed)
	}
	if bobs := decodeWorkspaces(t, fixture.request(t, http.MethodGet, "/api/v1/workspaces", "", "bob", false).Body.String()); bobs[0].PinnedAt != nil {
		t.Fatalf("another account's workspace pinned: %#v", bobs)
	}
	response = fixture.request(t, http.MethodPut, path, `{"pinned":false}`, "alice", true)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"pinnedAt":null`) {
		t.Fatalf("unpin = %d: %s", response.Code, response.Body.String())
	}
}
