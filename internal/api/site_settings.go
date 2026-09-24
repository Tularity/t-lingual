package api

import (
	"net/http"

	"github.com/Tularity/t-lingual/internal/auth"
	"github.com/Tularity/t-lingual/internal/store"
	"github.com/Tularity/t-lingual/internal/webapi"
)

func (a *API) siteContent(w http.ResponseWriter, r *http.Request) error {
	settings, err := a.store.GetSiteSettings(r.Context())
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	webapi.WriteJSON(w, http.StatusOK, map[string]string{
		"registrationHelpMarkdown": settings.RegistrationHelpMarkdown,
	})
	return nil
}

func (a *API) getAdminSiteSettings(w http.ResponseWriter, r *http.Request, current identity) error {
	settings, err := a.admin.SiteSettings(r.Context(), currentAdminAuthority(current))
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	webapi.WriteJSON(w, http.StatusOK, settings)
	return nil
}

func (a *API) putAdminSiteSettings(w http.ResponseWriter, r *http.Request, current identity) error {
	var input struct {
		RegistrationHelpMarkdown *string `json:"registrationHelpMarkdown"`
		CodeAttemptsPerMinute    *int    `json:"codeAttemptsPerMinute"`
	}
	if err := webapi.DecodeJSON(w, r, 16<<10, &input); err != nil {
		return err
	}
	if input.RegistrationHelpMarkdown == nil || input.CodeAttemptsPerMinute == nil {
		return webapi.BadRequest("INVALID_SITE_SETTINGS", "Provide both site settings fields.")
	}
	value := store.SiteSettings{RegistrationHelpMarkdown: *input.RegistrationHelpMarkdown,
		CodeAttemptsPerMinute: *input.CodeAttemptsPerMinute}
	if err := store.ValidateSiteSettings(value); err != nil {
		return webapi.BadRequest("INVALID_SITE_SETTINGS", "Check the registration help and code attempt limit.")
	}
	scope, err := auth.AdminSiteSettingsAuthorizationScope(value.RegistrationHelpMarkdown, value.CodeAttemptsPerMinute)
	if err != nil {
		return err
	}
	if err := a.consumeAdminAuthorization(r, current, scope); err != nil {
		return err
	}
	updated, err := a.admin.UpdateSiteSettings(r.Context(), currentAdminAuthority(current), value)
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	webapi.WriteJSON(w, http.StatusOK, updated)
	return nil
}
