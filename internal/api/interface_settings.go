package api

import (
	"net/http"

	"github.com/Tularity/t-lingual/internal/language"
	"github.com/Tularity/t-lingual/internal/webapi"
)

func (a *API) patchInterfaceSettings(w http.ResponseWriter, r *http.Request, current identity) error {
	var input struct {
		InterfaceLanguage *string `json:"interfaceLanguage,omitempty"`
		ThemePreference   *string `json:"themePreference,omitempty"`
	}
	if err := webapi.DecodeJSON(w, r, 4096, &input); err != nil {
		return err
	}
	if (input.InterfaceLanguage == nil && input.ThemePreference == nil) ||
		(input.InterfaceLanguage != nil && !language.ValidInterface(*input.InterfaceLanguage)) ||
		(input.ThemePreference != nil && *input.ThemePreference != "system" &&
			*input.ThemePreference != "light" && *input.ThemePreference != "dark") {
		return webapi.BadRequest("INVALID_INTERFACE_SETTINGS", "Choose a supported interface language or theme.")
	}
	settings, err := a.store.PatchUserInterfaceSettings(r.Context(), current.User.ID,
		input.InterfaceLanguage, input.ThemePreference)
	if err != nil {
		return err
	}
	webapi.WriteJSON(w, http.StatusOK, settings)
	return nil
}
