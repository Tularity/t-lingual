package api

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/profile"
	"github.com/Tularity/t-lingual/internal/store"
	"github.com/Tularity/t-lingual/internal/webapi"
)

type profileInput struct {
	DisplayName  *string `json:"displayName"`
	Discoverable *bool   `json:"discoverable"`
}

// updateProfile changes the name the caller is shown by, and whether others
// can find them by it.
func (a *API) updateProfile(response http.ResponseWriter, request *http.Request, current identity) error {
	var input profileInput
	if err := webapi.DecodeJSON(response, request, a.config.MaxJSONBytes, &input); err != nil {
		return err
	}
	if input.DisplayName == nil && input.Discoverable == nil {
		return webapi.BadRequest("INVALID_INPUT", "Choose something to change.")
	}
	update := store.ProfileUpdate{Discoverable: input.Discoverable}
	if input.DisplayName != nil {
		name, err := profile.DisplayName(*input.DisplayName)
		if err != nil {
			return err
		}
		update.DisplayName = &name
	}
	updated, err := a.store.UpdateProfile(request.Context(), current.User.ID, update, time.Now().UTC())
	if err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusOK, updated)
	return nil
}

// setAvatar keeps the caller's picture: the request body is the image
// itself, a PNG or JPEG named by its Content-Type.
func (a *API) setAvatar(response http.ResponseWriter, request *http.Request, current identity) error {
	declared, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || (declared != "image/png" && declared != "image/jpeg") {
		return &webapi.Error{Status: http.StatusUnsupportedMediaType, Code: "UNSUPPORTED_IMAGE", Message: "Upload a PNG or JPEG image."}
	}
	body := http.MaxBytesReader(response, request.Body, profile.MaxUploadBytes)
	data, err := io.ReadAll(body)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return &webapi.Error{Status: http.StatusRequestEntityTooLarge, Code: "REQUEST_TOO_LARGE", Message: "The picture is too large.", Cause: err}
		}
		return webapi.BadRequest("INVALID_IMAGE", "The picture could not be read.")
	}
	contentType, clean, err := profile.Avatar(declared, data)
	if err != nil {
		return err
	}
	updated, err := a.store.SetUserAvatar(request.Context(), current.User.ID, contentType, clean, time.Now().UTC())
	if err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusOK, updated)
	return nil
}

// removeAvatar forgets the caller's picture.
func (a *API) removeAvatar(response http.ResponseWriter, request *http.Request, current identity) error {
	updated, err := a.store.DeleteUserAvatar(request.Context(), current.User.ID, time.Now().UTC())
	if err != nil {
		return err
	}
	webapi.WriteJSON(response, http.StatusOK, updated)
	return nil
}

// userAvatar serves one person's picture — to that person, to an
// administrator, who sees everyone in the people list, and to anyone signed
// in when the person has chosen to be found. Anyone else is told there is
// nothing there, as if the person had no picture.
func (a *API) userAvatar(response http.ResponseWriter, request *http.Request, current identity) error {
	userID := request.PathValue("userID")
	if userID != current.User.ID && current.User.Role != domain.RoleAdmin {
		target, err := a.store.GetUserByID(request.Context(), userID)
		if err != nil || !target.Discoverable || target.Status != domain.UserActive {
			return store.ErrNotFound
		}
	}
	return a.writeAvatar(response, request, userID)
}

// sessionPersonAvatar serves the picture of someone who may see this
// session, to someone else who may: the faces beside a shared transcript.
func (a *API) sessionPersonAvatar(response http.ResponseWriter, request *http.Request, viewer domain.Viewer) error {
	sessionID, userID := request.PathValue("sessionID"), request.PathValue("userID")
	if _, err := a.sharing.Resolve(request.Context(), viewer, sessionID); err != nil {
		return err
	}
	allowed, err := a.store.UserCanSeeSession(request.Context(), userID, sessionID, time.Now().UTC())
	if err != nil {
		return err
	}
	if !allowed {
		return store.ErrNotFound
	}
	return a.writeAvatar(response, request, userID)
}

func (a *API) writeAvatar(response http.ResponseWriter, request *http.Request, userID string) error {
	contentType, data, err := a.store.GetUserAvatar(request.Context(), userID)
	if err != nil {
		return err
	}
	header := response.Header()
	header.Set("Content-Type", contentType)
	header.Set("Content-Length", strconv.Itoa(len(data)))
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	header.Set("Content-Disposition", "inline")
	// The address carries the avatar version, so a changed picture has a new
	// address; the old one may be kept, but only by this browser.
	header.Set("Cache-Control", "private, max-age=86400")
	response.WriteHeader(http.StatusOK)
	_, _ = response.Write(data)
	return nil
}
