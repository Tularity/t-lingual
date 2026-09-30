package admin

import (
	"context"
	"errors"
	"fmt"

	"github.com/Tularity/t-lingual/internal/store"
)

var ErrInvalidSiteSettings = errors.New("admin: invalid site settings")

func (s *Service) SiteSettings(ctx context.Context, web WebAuthority) (store.SiteSettings, error) {
	authority, err := mutationAuthorityForWeb(web)
	if err != nil {
		return store.SiteSettings{}, err
	}
	value, err := s.store.GetSiteSettingsAsAdmin(ctx, authority.actorUserID,
		authority.browserSessionID, authority.checkedAt)
	return value, mapAuthorizationError(err)
}

func (s *Service) UpdateSiteSettings(ctx context.Context, web WebAuthority, value store.SiteSettings) (store.SiteSettings, error) {
	if err := store.ValidateSiteSettings(value); err != nil {
		return store.SiteSettings{}, fmt.Errorf("%w: %v", ErrInvalidSiteSettings, err)
	}
	authority, err := mutationAuthorityForWeb(web)
	if err != nil {
		return store.SiteSettings{}, err
	}
	audit, err := s.newAuditEvent(authority.actorPointer(), "site_settings.update", "site_settings", "1",
		map[string]any{"codeAttemptsPerMinute": value.CodeAttemptsPerMinute,
			"draftTranslationIntervalMs": value.DraftTranslationIntervalMS,
			"markdownBytes":              len(value.RegistrationHelpMarkdown)}, authority.checkedAt)
	if err != nil {
		return store.SiteSettings{}, err
	}
	updated, err := s.store.UpdateSiteSettingsAsAdmin(ctx, authority.actorUserID,
		authority.browserSessionID, authority.checkedAt, value, audit)
	return updated, mapAuthorizationError(err)
}
