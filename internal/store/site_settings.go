package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

type SiteSettings struct {
	RegistrationHelpMarkdown string    `json:"registrationHelpMarkdown"`
	CodeAttemptsPerMinute    int       `json:"codeAttemptsPerMinute"`
	UpdatedAt                time.Time `json:"updatedAt"`
}

func ValidateSiteSettings(value SiteSettings) error {
	text := value.RegistrationHelpMarkdown
	if value.CodeAttemptsPerMinute < 1 || value.CodeAttemptsPerMinute > 10 ||
		len(text) == 0 || len(text) > 8192 || !utf8.ValidString(text) || strings.TrimSpace(text) == "" {
		return errors.New("store: invalid site settings")
	}
	for _, r := range text {
		if r == '\u2028' || r == '\u2029' ||
			(unicode.IsControl(r) && r != '\n' && r != '\t') {
			return errors.New("store: unsupported site help markup or control character")
		}
	}
	return nil
}

func scanSiteSettings(row rowScanner) (SiteSettings, error) {
	var value SiteSettings
	var updated int64
	if err := row.Scan(&value.RegistrationHelpMarkdown, &value.CodeAttemptsPerMinute, &updated); err != nil {
		return SiteSettings{}, mapSQLError(err)
	}
	value.UpdatedAt = decodeTime(updated)
	return value, nil
}

// GetSiteSettings serves public content and the hot per-IP code budget. It
// never returns credentials, admin identities, or an authorization token.
func (s *Store) GetSiteSettings(ctx context.Context) (SiteSettings, error) {
	return scanSiteSettings(s.db.QueryRowContext(ctx, `SELECT registration_help_markdown,
		code_attempts_per_minute,updated_at FROM site_settings WHERE id=1`))
}

func (s *Store) GetSiteSettingsAsAdmin(ctx context.Context, actorID, browserID string, checkedAt time.Time) (SiteSettings, error) {
	authority, err := webAdminMutationAuthority(actorID, browserID, checkedAt)
	if err != nil {
		return SiteSettings{}, err
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return SiteSettings{}, fmt.Errorf("store: begin site settings read: %w", err)
	}
	defer tx.Rollback()
	if err := requireAdminMutationAuthority(ctx, tx, authority); err != nil {
		return SiteSettings{}, err
	}
	value, err := scanSiteSettings(tx.QueryRowContext(ctx, `SELECT registration_help_markdown,
		code_attempts_per_minute,updated_at FROM site_settings WHERE id=1`))
	if err != nil {
		return SiteSettings{}, err
	}
	if err := tx.Commit(); err != nil {
		return SiteSettings{}, fmt.Errorf("store: commit site settings read: %w", err)
	}
	return value, nil
}

func (s *Store) UpdateSiteSettingsAsAdmin(ctx context.Context, actorID, browserID string, checkedAt time.Time,
	value SiteSettings, audit AuditEvent) (SiteSettings, error) {
	if err := ValidateSiteSettings(value); err != nil {
		return SiteSettings{}, err
	}
	authority, err := webAdminMutationAuthority(actorID, browserID, checkedAt)
	if err != nil {
		return SiteSettings{}, err
	}
	audit, err = validateAdminAudit(authority, audit, "site_settings.update", "site_settings", "1")
	if err != nil {
		return SiteSettings{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return SiteSettings{}, fmt.Errorf("store: begin site settings update: %w", err)
	}
	defer tx.Rollback()
	if err := requireAdminMutationAuthority(ctx, tx, authority); err != nil {
		return SiteSettings{}, err
	}
	result, err := tx.ExecContext(ctx, `UPDATE site_settings SET registration_help_markdown=?,
		code_attempts_per_minute=?,updated_at=? WHERE id=1`,
		value.RegistrationHelpMarkdown, value.CodeAttemptsPerMinute, encodeTime(checkedAt))
	if err := requireSingleAffected(result, "update site settings"); err != nil {
		return SiteSettings{}, fmt.Errorf("store: update site settings: %w", err)
	}
	if err := appendAuditEventTx(ctx, tx, audit); err != nil {
		return SiteSettings{}, err
	}
	if err := commitAdminMutation(ctx, tx, "site settings update"); err != nil {
		return SiteSettings{}, err
	}
	value.UpdatedAt = checkedAt.UTC()
	return value, nil
}
