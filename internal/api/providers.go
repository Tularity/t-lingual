package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"

	"github.com/Tularity/t-lingual/internal/providers"
	"github.com/Tularity/t-lingual/internal/webapi"
)

func (a *API) getProviders(w http.ResponseWriter, r *http.Request, current identity) error {
	if _, err := a.admin.ListUsers(r.Context(), currentAdminAuthority(current), 1, 0); err != nil {
		return err
	}
	webapi.WriteJSON(w, 200, a.providers.Endpoints())
	return nil
}
func (a *API) setProviders(w http.ResponseWriter, r *http.Request, current identity) error {
	var input providers.Endpoints
	if err := webapi.DecodeJSON(w, r, 8192, &input); err != nil {
		return err
	}
	if err := a.providers.Validate(input); err != nil {
		return webapi.BadRequest("INVALID_PROVIDER_URL", err.Error())
	}
	var payload bytes.Buffer
	encoder := json.NewEncoder(&payload)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(input); err != nil {
		return err
	}
	data := bytes.TrimSuffix(payload.Bytes(), []byte("\n"))
	hash := sha256.Sum256(data)
	scope := "admin:providers:update:" + hex.EncodeToString(hash[:])
	if err := a.consumeAdminAuthorization(r, current, scope); err != nil {
		return err
	}
	a.providerUpdateMu.Lock()
	defer a.providerUpdateMu.Unlock()
	if err := a.store.SaveProviderSettingsAsAdmin(r.Context(), current.User.ID, current.Session.ID, data); err != nil {
		return err
	}
	status, err := a.providers.Update(input)
	if err != nil {
		return err
	}
	a.readyMu.Lock()
	a.readyCache = readinessSnapshot{}
	a.readyMu.Unlock()
	webapi.WriteJSON(w, 200, status)
	return nil
}
