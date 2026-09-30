package api

import (
	"net/http"
	"strings"
	"testing"
)

func sharedIDs(t *testing.T, fixture *apiFixture, user string) []string {
	t.Helper()
	response := fixture.request(t, http.MethodGet, "/api/v1/view/sessions?shared=true", "", user, false)
	if response.Code != http.StatusOK {
		t.Fatalf("shared list = %d: %s", response.Code, response.Body.String())
	}
	var ids []string
	for _, item := range decodeObject(t, response)["items"].([]any) {
		ids = append(ids, item.(map[string]any)["id"].(string))
	}
	return ids
}

func TestMembersLinkLetsInOnlySignedInPeopleUntilItEnds(t *testing.T) {
	fixture := newSharedAPIFixture(t)
	session := sharedSession(t, fixture)
	sharePath := "/api/v1/sessions/" + session.ID + "/shares"
	viewPath := "/api/v1/view/sessions/" + session.ID
	bob := fixture.users["bob"]

	// An audience belongs to links alone, and only the two there are.
	if bad := fixture.request(t, http.MethodPost, sharePath, `{"type":"user","userId":"`+bob.ID+`","audience":"members","permission":"view"}`, "alice", true); bad.Code != http.StatusBadRequest {
		t.Fatalf("user share with audience = %d: %s", bad.Code, bad.Body.String())
	}
	if bad := fixture.request(t, http.MethodPost, sharePath, `{"type":"link","audience":"everyone","permission":"view"}`, "alice", true); bad.Code != http.StatusBadRequest {
		t.Fatalf("unknown audience = %d: %s", bad.Code, bad.Body.String())
	}
	link := fixture.request(t, http.MethodPost, sharePath, `{"type":"link","audience":"members","permission":"view","expiresAt":null}`, "alice", true)
	body := decodeObject(t, link)
	if link.Code != http.StatusCreated || body["audience"] != "members" || len(body["members"].([]any)) != 0 {
		t.Fatalf("members link = %d: %s", link.Code, link.Body.String())
	}
	token, shareID := body["token"].(string), body["id"].(string)
	join := `{"token":"` + token + `"}`

	// A guest cannot use it, and gets no guest cookie trying.
	guest := guestRequest(fixture, http.MethodPost, "/api/v1/share-access", `{"token":"`+token+`","language":"en"}`, "", true)
	if guest.Code != http.StatusForbidden || !strings.Contains(guest.Body.String(), "SIGN_IN_REQUIRED") || len(guest.Result().Cookies()) != 0 {
		t.Fatalf("guest redeemed a members link = %d: %s", guest.Code, guest.Body.String())
	}
	if anonymous := guestRequest(fixture, http.MethodPost, "/api/v1/share-membership", join, "", true); anonymous.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous join = %d", anonymous.Code)
	}
	if foreign := fixture.request(t, http.MethodPost, "/api/v1/share-membership", join, "bob", false); foreign.Code != http.StatusForbidden {
		t.Fatalf("join without origin = %d", foreign.Code)
	}
	if unknown := fixture.request(t, http.MethodPost, "/api/v1/share-membership", `{"token":"not-a-token"}`, "bob", true); unknown.Code != http.StatusNotFound {
		t.Fatalf("join with a bad token = %d", unknown.Code)
	}
	if before := fixture.request(t, http.MethodGet, viewPath, "", "bob", false); before.Code != http.StatusNotFound {
		t.Fatalf("bob saw the session before joining = %d", before.Code)
	}

	// Bob joins, twice, and sees it as himself.
	for range 2 {
		joined := fixture.request(t, http.MethodPost, "/api/v1/share-membership", join, "bob", true)
		if joined.Code != http.StatusOK || decodeObject(t, joined)["sessionId"] != session.ID {
			t.Fatalf("join = %d: %s", joined.Code, joined.Body.String())
		}
	}
	view := fixture.request(t, http.MethodGet, viewPath, "", "bob", false)
	access, _ := decodeObject(t, view)["access"].(map[string]any)
	if view.Code != http.StatusOK || access["viewerId"] != "user:"+bob.ID || access["permission"] != "view" || access["isOwner"] != false {
		t.Fatalf("member view = %d: %s", view.Code, view.Body.String())
	}
	if ids := sharedIDs(t, fixture, "bob"); len(ids) != 1 || ids[0] != session.ID {
		t.Fatalf("bob's shared list = %v", ids)
	}
	// The owner opening their own link is only led back to it.
	if own := fixture.request(t, http.MethodPost, "/api/v1/share-membership", join, "alice", true); own.Code != http.StatusOK {
		t.Fatalf("owner join = %d", own.Code)
	}
	shares := fixture.request(t, http.MethodGet, sharePath, "", "alice", false)
	members := decodeObject(t, shares)["items"].([]any)[0].(map[string]any)["members"].([]any)
	if len(members) != 1 || members[0].(map[string]any)["id"] != bob.ID {
		t.Fatalf("link members = %v", members)
	}
	// Someone else holding no link sees nothing.
	if other := fixture.request(t, http.MethodGet, viewPath, "", "admin", false); other.Code != http.StatusNotFound {
		t.Fatalf("admin without the link = %d", other.Code)
	}

	// Ending the link ends every member's access with it.
	if revoked := fixture.request(t, http.MethodDelete, sharePath+"/"+shareID, "", "alice", true); revoked.Code != http.StatusNoContent {
		t.Fatalf("revoke = %d", revoked.Code)
	}
	if after := fixture.request(t, http.MethodGet, viewPath, "", "bob", false); after.Code != http.StatusNotFound {
		t.Fatalf("member after revocation = %d", after.Code)
	}
	if ids := sharedIDs(t, fixture, "bob"); len(ids) != 0 {
		t.Fatalf("revoked session still listed: %v", ids)
	}
	if again := fixture.request(t, http.MethodPost, "/api/v1/share-membership", join, "bob", true); again.Code != http.StatusNotFound {
		t.Fatalf("join after revocation = %d", again.Code)
	}
}

func TestAnyoneLinkStillAdmitsGuestsAndSignedInPeopleAsThemselves(t *testing.T) {
	fixture := newSharedAPIFixture(t)
	session := sharedSession(t, fixture)
	link := fixture.request(t, http.MethodPost, "/api/v1/sessions/"+session.ID+"/shares", `{"type":"link","permission":"view","expiresAt":null}`, "alice", true)
	body := decodeObject(t, link)
	if link.Code != http.StatusCreated || body["audience"] != "anyone" {
		t.Fatalf("default link = %d: %s", link.Code, link.Body.String())
	}
	token := body["token"].(string)
	if guest := guestRequest(fixture, http.MethodPost, "/api/v1/share-access", `{"token":"`+token+`","language":"en"}`, "", true); guest.Code != http.StatusOK {
		t.Fatalf("guest redeem = %d: %s", guest.Code, guest.Body.String())
	}
	if joined := fixture.request(t, http.MethodPost, "/api/v1/share-membership", `{"token":"`+token+`"}`, "bob", true); joined.Code != http.StatusOK {
		t.Fatalf("signed-in join = %d: %s", joined.Code, joined.Body.String())
	}
	view := fixture.request(t, http.MethodGet, "/api/v1/view/sessions/"+session.ID, "", "bob", false)
	if view.Code != http.StatusOK || decodeObject(t, view)["access"].(map[string]any)["viewerId"] != "user:"+fixture.users["bob"].ID {
		t.Fatalf("signed-in link view = %d: %s", view.Code, view.Body.String())
	}
}

func TestPeopleAreFoundAndPicturedOnlyOnceTheyChooseTo(t *testing.T) {
	fixture := newSharedAPIFixture(t)
	alice := fixture.users["alice"]
	if response := fixture.rawRequest(t, http.MethodPut, "/api/v1/account/avatar", "image/png", avatarPNG(t), "alice", true); response.Code != http.StatusOK {
		t.Fatalf("avatar = %d", response.Code)
	}
	search := func() []any {
		response := fixture.request(t, http.MethodGet, "/api/v1/share-recipients?q=alice", "", "bob", false)
		if response.Code != http.StatusOK {
			t.Fatalf("search = %d: %s", response.Code, response.Body.String())
		}
		return decodeObject(t, response)["items"].([]any)
	}
	picture := "/api/v1/users/" + alice.ID + "/avatar"
	if found := search(); len(found) != 0 {
		t.Fatalf("hidden person found: %v", found)
	}
	if response := fixture.request(t, http.MethodGet, picture, "", "bob", false); response.Code != http.StatusNotFound {
		t.Fatalf("hidden person's picture = %d", response.Code)
	}
	if response := fixture.request(t, http.MethodPatch, "/api/v1/account/profile", `{}`, "alice", true); response.Code != http.StatusBadRequest {
		t.Fatalf("empty profile change = %d", response.Code)
	}
	opened := fixture.request(t, http.MethodPatch, "/api/v1/account/profile", `{"discoverable":true}`, "alice", true)
	if opened.Code != http.StatusOK || !decodeUser(t, opened).Discoverable || decodeUser(t, opened).DisplayName != alice.DisplayName {
		t.Fatalf("become discoverable = %d: %s", opened.Code, opened.Body.String())
	}
	found := search()
	if len(found) != 1 || found[0].(map[string]any)["id"] != alice.ID || found[0].(map[string]any)["avatarVersion"].(float64) == 0 {
		t.Fatalf("discoverable search = %v", found)
	}
	if response := fixture.request(t, http.MethodGet, picture, "", "bob", false); response.Code != http.StatusOK {
		t.Fatalf("discoverable picture = %d", response.Code)
	}
	if response := fixture.request(t, http.MethodPatch, "/api/v1/account/profile", `{"discoverable":false}`, "alice", true); response.Code != http.StatusOK || decodeUser(t, response).Discoverable {
		t.Fatalf("hide again = %d", response.Code)
	}
	if found := search(); len(found) != 0 {
		t.Fatalf("hidden again but found: %v", found)
	}
}

func TestSessionFacesAreShownOnlyAmongPeopleWhoMaySeeIt(t *testing.T) {
	fixture := newSharedAPIFixture(t)
	session := sharedSession(t, fixture)
	for _, user := range []string{"alice", "bob", "admin"} {
		if response := fixture.rawRequest(t, http.MethodPut, "/api/v1/account/avatar", "image/png", avatarPNG(t), user, true); response.Code != http.StatusOK {
			t.Fatalf("%s avatar = %d", user, response.Code)
		}
	}
	face := func(user string) string {
		return "/api/v1/view/sessions/" + session.ID + "/people/" + fixture.users[user].ID + "/avatar"
	}
	if response := fixture.request(t, http.MethodGet, face("alice"), "", "bob", false); response.Code != http.StatusNotFound {
		t.Fatalf("bob saw the owner's face before being let in = %d", response.Code)
	}
	if created := fixture.request(t, http.MethodPost, "/api/v1/sessions/"+session.ID+"/shares", `{"type":"user","userId":"`+fixture.users["bob"].ID+`","permission":"view","expiresAt":null}`, "alice", true); created.Code != http.StatusCreated {
		t.Fatalf("share = %d", created.Code)
	}
	owner := fixture.request(t, http.MethodGet, face("alice"), "", "bob", false)
	if owner.Code != http.StatusOK || owner.Header().Get("Content-Type") != "image/png" || owner.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("owner's face for bob = %d %v", owner.Code, owner.Header())
	}
	if response := fixture.request(t, http.MethodGet, face("bob"), "", "alice", false); response.Code != http.StatusOK {
		t.Fatalf("bob's face for the owner = %d", response.Code)
	}
	// Someone who cannot see the session is never pictured beside it, nor sees anyone there.
	if response := fixture.request(t, http.MethodGet, face("admin"), "", "alice", false); response.Code != http.StatusNotFound {
		t.Fatalf("an outsider's face = %d", response.Code)
	}
	if response := fixture.request(t, http.MethodGet, face("alice"), "", "admin", false); response.Code != http.StatusNotFound {
		t.Fatalf("an outsider saw the owner's face = %d", response.Code)
	}
	link := fixture.request(t, http.MethodPost, "/api/v1/sessions/"+session.ID+"/shares", `{"type":"link","permission":"view","expiresAt":null}`, "alice", true)
	redeem := guestRequest(fixture, http.MethodPost, "/api/v1/share-access", `{"token":"`+decodeObject(t, link)["token"].(string)+`","language":"en"}`, "", true)
	cookie := redeem.Result().Cookies()[0].Value
	if response := guestRequest(fixture, http.MethodGet, face("alice"), "", cookie, false); response.Code != http.StatusOK {
		t.Fatalf("guest sees the owner's face = %d", response.Code)
	}
	detail := fixture.request(t, http.MethodGet, "/api/v1/view/sessions/"+session.ID, "", "bob", false)
	presence, ok := decodeObject(t, detail)["presence"].(map[string]any)
	if !ok || presence["people"] == nil {
		t.Fatalf("detail without presence: %s", detail.Body.String())
	}
}

func TestTurningOffGuestLinksLeavesAnOwnersLinksToSignedInPeople(t *testing.T) {
	fixture := newSharedAPIFixture(t)
	session := sharedSession(t, fixture)
	sharePath := "/api/v1/sessions/" + session.ID + "/shares"
	link := fixture.request(t, http.MethodPost, sharePath, `{"type":"link","permission":"view","expiresAt":null}`, "alice", true)
	token := decodeObject(t, link)["token"].(string)
	redeemed := guestRequest(fixture, http.MethodPost, "/api/v1/share-access", `{"token":"`+token+`","language":"en"}`, "", true)
	cookie := redeemed.Result().Cookies()[0].Value

	alice := fixture.users["alice"].ID
	body := `{"concurrentRecordings":null,"monthlyRecordingMinutes":null,"storageMb":null,"workspaces":null,"guestLinks":false}`
	if response := fixture.requestWithAuthorization(t, http.MethodPut, "/api/v1/admin/users/"+alice+"/limits", body, "admin", true,
		fixture.changeGrant(t, "admin", "limits", alice, body)); response.Code != http.StatusOK {
		t.Fatalf("limits = %d: %s", response.Code, response.Body.String())
	}
	if refused := fixture.request(t, http.MethodPost, sharePath, `{"type":"link","permission":"view","expiresAt":null}`, "alice", true); refused.Code != http.StatusForbidden || !strings.Contains(refused.Body.String(), "GUEST_LINKS_DISABLED") {
		t.Fatalf("new guest link = %d: %s", refused.Code, refused.Body.String())
	}
	if members := fixture.request(t, http.MethodPost, sharePath, `{"type":"link","audience":"members","permission":"view","expiresAt":null}`, "alice", true); members.Code != http.StatusCreated {
		t.Fatalf("members link = %d: %s", members.Code, members.Body.String())
	}
	// The existing link now asks guests to sign in, and its guests are out…
	if again := guestRequest(fixture, http.MethodPost, "/api/v1/share-access", `{"token":"`+token+`","language":"en"}`, "", true); again.Code != http.StatusForbidden || !strings.Contains(again.Body.String(), "SIGN_IN_REQUIRED") {
		t.Fatalf("guest redeem = %d: %s", again.Code, again.Body.String())
	}
	if view := guestRequest(fixture, http.MethodGet, "/api/v1/view/sessions/"+session.ID, "", cookie, false); view.Code != http.StatusNotFound {
		t.Fatalf("existing guest view = %d", view.Code)
	}
	// …while someone signed in still opens it as themselves.
	if joined := fixture.request(t, http.MethodPost, "/api/v1/share-membership", `{"token":"`+token+`"}`, "bob", true); joined.Code != http.StatusOK {
		t.Fatalf("signed-in join = %d: %s", joined.Code, joined.Body.String())
	}
}
