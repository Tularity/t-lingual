package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/language"
	"time"
)

func (s *Store) GetUserSettings(ctx context.Context, userID string) (domain.UserSettings, error) {
	var settings domain.UserSettings
	var autoStart, showPartial, compact, onboarding int
	err := s.db.QueryRowContext(ctx, `SELECT user_id,default_source_language,default_target_language,
 auto_start_microphone,show_partial_transcripts,compact_transcript_layout,auto_archive_hours,
 interface_language,theme_preference,u.onboarding_complete FROM user_settings
 JOIN users u ON u.id=user_settings.user_id WHERE user_settings.user_id=?`, userID).Scan(
		&settings.UserID, &settings.DefaultSourceLanguage, &settings.DefaultTargetLanguage,
		&autoStart, &showPartial, &compact, &settings.AutoArchiveHours, &settings.InterfaceLanguage, &settings.ThemePreference, &onboarding)
	if err == nil {
		settings.AutoStartMicrophone = autoStart != 0
		settings.ShowPartialTranscripts = showPartial != 0
		settings.CompactTranscriptLayout = compact != 0
		settings.OnboardingComplete = onboarding != 0
		return settings, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return domain.UserSettings{}, fmt.Errorf("store: get user settings: %w", err)
	}
	err = s.db.QueryRowContext(ctx, "SELECT onboarding_complete FROM users WHERE id = ?", userID).Scan(&onboarding)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.UserSettings{}, ErrNotFound
	}
	if err != nil {
		return domain.UserSettings{}, fmt.Errorf("store: verify settings user: %w", err)
	}
	defaults := domain.DefaultUserSettings(userID)
	defaults.OnboardingComplete = onboarding != 0
	return defaults, nil
}
func (s *Store) UpsertUserSettings(ctx context.Context, settings domain.UserSettings) error {
	writeInterface := settings.InterfaceLanguage != ""
	writeTheme := settings.ThemePreference != ""
	if settings.InterfaceLanguage == "" {
		settings.InterfaceLanguage = "system"
	}
	if settings.ThemePreference == "" {
		settings.ThemePreference = "system"
	}
	if settings.UserID == "" || settings.DefaultSourceLanguage == "" || settings.DefaultTargetLanguage == "" ||
		settings.AutoArchiveHours < 0 || settings.AutoArchiveHours > 8760 ||
		!language.ValidInterface(settings.InterfaceLanguage) ||
		(settings.ThemePreference != "system" && settings.ThemePreference != "light" && settings.ThemePreference != "dark") {
		return errors.New("store: invalid user settings")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: begin settings update: %w", err)
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, `INSERT INTO user_settings(user_id,default_source_language,default_target_language,
 auto_start_microphone,show_partial_transcripts,compact_transcript_layout,auto_archive_hours,interface_language,theme_preference)
 VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET
 default_source_language=excluded.default_source_language,default_target_language=excluded.default_target_language,
 auto_start_microphone=excluded.auto_start_microphone,show_partial_transcripts=excluded.show_partial_transcripts,
 compact_transcript_layout=excluded.compact_transcript_layout,auto_archive_hours=excluded.auto_archive_hours,
 interface_language=CASE WHEN ? THEN excluded.interface_language ELSE user_settings.interface_language END,
 theme_preference=CASE WHEN ? THEN excluded.theme_preference ELSE user_settings.theme_preference END`,
		settings.UserID, settings.DefaultSourceLanguage, settings.DefaultTargetLanguage,
		boolInt(settings.AutoStartMicrophone), boolInt(settings.ShowPartialTranscripts), boolInt(settings.CompactTranscriptLayout),
		settings.AutoArchiveHours, settings.InterfaceLanguage, settings.ThemePreference,
		boolInt(writeInterface), boolInt(writeTheme))
	if err != nil {
		return fmt.Errorf("store: upsert user settings: %w", mapSQLError(err))
	}
	result, err := tx.ExecContext(ctx, `UPDATE users SET onboarding_complete=MAX(onboarding_complete,?) WHERE id=?`,
		boolInt(settings.OnboardingComplete), settings.UserID)
	if err := requireAffected(result, err, "update user onboarding"); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: commit settings update: %w", err)
	}
	return nil
}

// PatchUserInterfaceSettings modifies only the two presentation preferences.
// It never writes stale transcript, recognition, or onboarding values from a
// concurrent whole-settings form or quick-setup completion.
func (s *Store) PatchUserInterfaceSettings(ctx context.Context, userID string,
	interfaceLanguage, themePreference *string) (domain.UserSettings, error) {
	if userID == "" || (interfaceLanguage == nil && themePreference == nil) ||
		(interfaceLanguage != nil && !language.ValidInterface(*interfaceLanguage)) ||
		(themePreference != nil && *themePreference != "system" && *themePreference != "light" && *themePreference != "dark") {
		return domain.UserSettings{}, errors.New("store: invalid interface preferences")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return domain.UserSettings{}, fmt.Errorf("store: begin interface preference patch: %w", err)
	}
	defer tx.Rollback()
	var owned int
	if err := tx.QueryRowContext(ctx, `SELECT 1 FROM users WHERE id=?`, userID).Scan(&owned); err != nil {
		return domain.UserSettings{}, mapSQLError(err)
	}
	defaults := domain.DefaultUserSettings(userID)
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO user_settings(user_id,default_source_language,
		default_target_language,auto_start_microphone,show_partial_transcripts,compact_transcript_layout,
		auto_archive_hours,interface_language,theme_preference) VALUES(?,?,?,?,?,?,?,?,?)`,
		userID, defaults.DefaultSourceLanguage, defaults.DefaultTargetLanguage,
		boolInt(defaults.AutoStartMicrophone), boolInt(defaults.ShowPartialTranscripts),
		boolInt(defaults.CompactTranscriptLayout), defaults.AutoArchiveHours,
		defaults.InterfaceLanguage, defaults.ThemePreference); err != nil {
		return domain.UserSettings{}, fmt.Errorf("store: initialize interface preferences: %w", mapSQLError(err))
	}
	var nextLanguage, nextTheme any
	if interfaceLanguage != nil {
		nextLanguage = *interfaceLanguage
	}
	if themePreference != nil {
		nextTheme = *themePreference
	}
	if _, err := tx.ExecContext(ctx, `UPDATE user_settings SET
		interface_language=COALESCE(?,interface_language), theme_preference=COALESCE(?,theme_preference)
		WHERE user_id=?`, nextLanguage, nextTheme, userID); err != nil {
		return domain.UserSettings{}, fmt.Errorf("store: patch interface preferences: %w", mapSQLError(err))
	}
	if err := tx.Commit(); err != nil {
		return domain.UserSettings{}, fmt.Errorf("store: commit interface preferences: %w", err)
	}
	return s.GetUserSettings(ctx, userID)
}

type AuditEvent struct {
	ID          string          `json:"id"`
	ActorUserID *string         `json:"actorUserId"`
	Action      string          `json:"action"`
	TargetType  string          `json:"targetType"`
	TargetID    string          `json:"targetId"`
	Metadata    json.RawMessage `json:"metadata"`
	CreatedAt   time.Time       `json:"createdAt"`
}

func (s *Store) AppendAuditEvent(ctx context.Context, event AuditEvent) error {
	return appendAuditEvent(ctx, s.db, event)
}

type auditExecer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func validateAuditEvent(event AuditEvent) (AuditEvent, error) {
	if event.ID == "" || event.Action == "" || event.TargetType == "" || event.TargetID == "" {
		return AuditEvent{}, errors.New("store: audit id, action, target type, and target id are required")
	}
	if event.CreatedAt.IsZero() {
		return AuditEvent{}, errors.New("store: audit creation time is required")
	}
	if len(event.Metadata) == 0 {
		event.Metadata = json.RawMessage("{}")
	}
	if !json.Valid(event.Metadata) {
		return AuditEvent{}, errors.New("store: audit metadata is not valid JSON")
	}
	return event, nil
}

func appendAuditEvent(ctx context.Context, execer auditExecer, event AuditEvent) error {
	event, err := validateAuditEvent(event)
	if err != nil {
		return err
	}
	_, err = execer.ExecContext(ctx, `
		INSERT INTO audit_events(
			id, actor_user_id, action, target_type, target_id, metadata_json, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		event.ID, event.ActorUserID, event.Action, event.TargetType, event.TargetID,
		[]byte(event.Metadata), encodeTime(event.CreatedAt),
	)
	if err != nil {
		return fmt.Errorf("store: append audit event: %w", mapSQLError(err))
	}
	return nil
}

func appendAuditEventTx(ctx context.Context, tx *sql.Tx, event AuditEvent) error {
	return appendAuditEvent(ctx, tx, event)
}

// ListAuditEventsAsTrustedControl is the explicit authorization-free control
// plane variant. Web callers must use ListAuditEventsAsAdmin.
func (s *Store) ListAuditEventsAsTrustedControl(ctx context.Context, limit, offset int) ([]AuditEvent, error) {
	return listAuditEvents(ctx, s.db, limit, offset)
}

func listAuditEvents(ctx context.Context, queryer rowsQueryer, limit, offset int) ([]AuditEvent, error) {
	limit, offset = pagination(limit, offset)
	rows, err := queryer.QueryContext(ctx, `
		SELECT id, actor_user_id, action, target_type, target_id, metadata_json, created_at
		FROM audit_events ORDER BY created_at DESC, id LIMIT ? OFFSET ?`, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("store: list audit events: %w", err)
	}
	defer rows.Close()
	events := make([]AuditEvent, 0)
	for rows.Next() {
		var event AuditEvent
		var actor sql.NullString
		var metadata []byte
		var createdAt int64
		if err := rows.Scan(
			&event.ID, &actor, &event.Action, &event.TargetType,
			&event.TargetID, &metadata, &createdAt,
		); err != nil {
			return nil, fmt.Errorf("store: scan audit event: %w", err)
		}
		event.ActorUserID = optionalString(actor)
		event.Metadata = json.RawMessage(metadata)
		event.CreatedAt = decodeTime(createdAt)
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list audit events: %w", err)
	}
	return events, nil
}
