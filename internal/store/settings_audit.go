package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
)

func (s *Store) GetUserSettings(ctx context.Context, userID string) (domain.UserSettings, error) {
	var settings domain.UserSettings
	var autoStart, showPartial, compact int
	err := s.db.QueryRowContext(ctx, `
		SELECT user_id, default_source_language, default_target_language,
			auto_start_microphone, show_partial_transcripts, compact_transcript_layout
		FROM user_settings WHERE user_id = ?`, userID).Scan(
		&settings.UserID, &settings.DefaultSourceLanguage, &settings.DefaultTargetLanguage,
		&autoStart, &showPartial, &compact,
	)
	if err == nil {
		settings.AutoStartMicrophone = autoStart != 0
		settings.ShowPartialTranscripts = showPartial != 0
		settings.CompactTranscriptLayout = compact != 0
		return settings, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return domain.UserSettings{}, fmt.Errorf("store: get user settings: %w", err)
	}

	var exists int
	err = s.db.QueryRowContext(ctx, "SELECT 1 FROM users WHERE id = ?", userID).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.UserSettings{}, ErrNotFound
	}
	if err != nil {
		return domain.UserSettings{}, fmt.Errorf("store: verify settings user: %w", err)
	}
	return domain.DefaultUserSettings(userID), nil
}

func (s *Store) UpsertUserSettings(ctx context.Context, settings domain.UserSettings) error {
	if settings.UserID == "" || settings.DefaultSourceLanguage == "" || settings.DefaultTargetLanguage == "" {
		return errors.New("store: settings user and languages are required")
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO user_settings(
			user_id, default_source_language, default_target_language,
			auto_start_microphone, show_partial_transcripts, compact_transcript_layout
		) VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id) DO UPDATE SET
			default_source_language = excluded.default_source_language,
			default_target_language = excluded.default_target_language,
			auto_start_microphone = excluded.auto_start_microphone,
			show_partial_transcripts = excluded.show_partial_transcripts,
			compact_transcript_layout = excluded.compact_transcript_layout`,
		settings.UserID, settings.DefaultSourceLanguage, settings.DefaultTargetLanguage,
		boolInt(settings.AutoStartMicrophone), boolInt(settings.ShowPartialTranscripts),
		boolInt(settings.CompactTranscriptLayout),
	)
	if err != nil {
		return fmt.Errorf("store: upsert user settings: %w", mapSQLError(err))
	}
	return nil
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
