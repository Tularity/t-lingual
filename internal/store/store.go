// Package store provides the durable SQLite persistence layer for t-lingual.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

var (
	ErrNotFound = errors.New("store: not found")
	ErrConflict = errors.New("store: conflict")
	// ErrArchived remains an ErrConflict for callers that already handle
	// conflicts, while allowing the API to report a precise archive state.
	ErrArchived      = fmt.Errorf("%w: archived interpretation", ErrConflict)
	ErrInvalidInvite = errors.New("store: invalid invitation")
	ErrForbidden     = errors.New("store: forbidden")
	ErrCapacity      = errors.New("store: capacity exhausted")
)

// Store serializes access through one SQLite connection. SQLite still permits
// concurrent readers from other processes in WAL mode, while the single local
// connection makes transaction behavior deterministic and ensures connection-
// local pragmas (notably foreign_keys) are always active.
type Store struct {
	db       *sql.DB
	dataRoot string
}

// Open opens path, creates its parent directory when needed, applies the
// connection safety pragmas, and runs all schema migrations.
func Open(path string) (*Store, error) {
	return OpenContext(context.Background(), path)
}

// OpenContext is the context-aware form of Open.
func OpenContext(ctx context.Context, path string) (*Store, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("store: database path is empty")
	}

	isMemory := path == ":memory:" || strings.HasPrefix(path, "file::memory:")
	if !isMemory {
		if strings.HasPrefix(path, "file:") {
			return nil, errors.New("store: file URI paths are not supported")
		}
		path = filepath.Clean(path)
		parent := filepath.Dir(path)
		if err := os.MkdirAll(parent, 0o700); err != nil {
			return nil, fmt.Errorf("store: create database directory: %w", err)
		}
	}

	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("store: open sqlite: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)
	db.SetConnMaxIdleTime(0)

	closeOnError := func(openErr error) (*Store, error) {
		_ = db.Close()
		return nil, openErr
	}
	if err := db.PingContext(ctx); err != nil {
		return closeOnError(fmt.Errorf("store: ping sqlite: %w", err))
	}

	pragmas := []string{
		"PRAGMA foreign_keys = ON",
		"PRAGMA busy_timeout = 5000",
		// Authentication revocation, credential quarantine, and transcript data
		// share this database. FULL prevents an OS/power failure from reviving a
		// security-sensitive row whose deletion was already acknowledged.
		"PRAGMA synchronous = FULL",
	}
	if !isMemory {
		pragmas = append([]string{"PRAGMA journal_mode = WAL"}, pragmas...)
	}
	for _, statement := range pragmas {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			return closeOnError(fmt.Errorf("store: apply %q: %w", statement, err))
		}
	}

	dataRoot := ""
	if !isMemory {
		dataRoot = filepath.Dir(path)
	}
	s := &Store{db: db, dataRoot: dataRoot}
	if err := s.migrate(ctx); err != nil {
		return closeOnError(err)
	}
	if !isMemory {
		// Best effort on platforms whose filesystem supports POSIX-style modes.
		if err := os.Chmod(path, 0o600); err != nil && !errors.Is(err, os.ErrPermission) {
			return closeOnError(fmt.Errorf("store: secure database file: %w", err))
		}
	}
	return s, nil
}

func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *Store) Ping(ctx context.Context) error {
	if s == nil || s.db == nil {
		return errors.New("store: database is not open")
	}
	if err := s.db.PingContext(ctx); err != nil {
		return fmt.Errorf("store: ping: %w", err)
	}
	return nil
}

func (s *Store) migrate(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			applied_at INTEGER NOT NULL
		)`); err != nil {
		return fmt.Errorf("store: create migration table: %w", err)
	}

	for _, migration := range migrations {
		var exists int
		err := s.db.QueryRowContext(ctx,
			"SELECT 1 FROM schema_migrations WHERE version = ?", migration.version,
		).Scan(&exists)
		if err == nil {
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("store: inspect migration %d: %w", migration.version, err)
		}

		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return fmt.Errorf("store: begin migration %d: %w", migration.version, err)
		}
		if _, err = tx.ExecContext(ctx, migration.sql); err == nil {
			_, err = tx.ExecContext(ctx,
				"INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
				migration.version, encodeTime(time.Now()),
			)
		}
		if err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("store: apply migration %d: %w", migration.version, err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("store: commit migration %d: %w", migration.version, err)
		}
	}
	return nil
}

type migration struct {
	version int
	sql     string
}

var migrations = []migration{{version: 1, sql: `
	CREATE TABLE users (
		id TEXT PRIMARY KEY,
		webauthn_id BLOB NOT NULL UNIQUE,
		username TEXT NOT NULL COLLATE NOCASE UNIQUE,
		display_name TEXT NOT NULL,
		role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
		status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE INDEX users_status_idx ON users(status, created_at DESC);

	CREATE TABLE webauthn_credentials (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		credential_id BLOB NOT NULL UNIQUE,
		name TEXT NOT NULL,
		credential_json BLOB NOT NULL,
		created_at INTEGER NOT NULL,
		last_used_at INTEGER
	);
	CREATE INDEX webauthn_credentials_user_idx
		ON webauthn_credentials(user_id, created_at);

	CREATE TABLE invitations (
		id TEXT PRIMARY KEY,
		code_hash BLOB NOT NULL UNIQUE CHECK (length(code_hash) = 32),
		created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL,
		used_at INTEGER,
		used_by TEXT REFERENCES users(id) ON DELETE SET NULL,
		revoked_at INTEGER,
		CHECK (expires_at > created_at)
	);
	CREATE INDEX invitations_validity_idx
		ON invitations(code_hash, expires_at) WHERE used_at IS NULL AND revoked_at IS NULL;
	CREATE INDEX invitations_creator_idx ON invitations(created_by, created_at DESC);

	CREATE TABLE browser_sessions (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		token_hash BLOB NOT NULL UNIQUE CHECK (length(token_hash) = 32),
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL,
		last_seen INTEGER NOT NULL,
		user_agent TEXT NOT NULL,
		ip_address TEXT NOT NULL,
		CHECK (expires_at > created_at)
	);
	CREATE INDEX browser_sessions_user_idx ON browser_sessions(user_id, last_seen DESC);
	CREATE INDEX browser_sessions_expiry_idx ON browser_sessions(expires_at);

	CREATE TABLE webauthn_ceremonies (
		id TEXT PRIMARY KEY,
		token_hash BLOB NOT NULL UNIQUE CHECK (length(token_hash) = 32),
		kind TEXT NOT NULL CHECK (length(kind) > 0),
		session_json BLOB NOT NULL,
		pending_user_json BLOB,
		invitation_id TEXT REFERENCES invitations(id) ON DELETE SET NULL,
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL,
		CHECK (expires_at > created_at)
	);
	CREATE INDEX webauthn_ceremonies_expiry_idx ON webauthn_ceremonies(expires_at);

	CREATE TABLE interpretation_sessions (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		title TEXT NOT NULL,
		source_language TEXT NOT NULL,
		target_language TEXT NOT NULL,
		status TEXT NOT NULL CHECK (status IN ('created', 'live', 'completed', 'failed')),
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		started_at INTEGER,
		ended_at INTEGER,
		UNIQUE (id, user_id)
	);
	CREATE INDEX interpretation_sessions_owner_idx
		ON interpretation_sessions(user_id, updated_at DESC, id);
	CREATE INDEX interpretation_sessions_owner_status_idx
		ON interpretation_sessions(user_id, status, updated_at DESC);

	CREATE TABLE segments (
		id TEXT PRIMARY KEY,
		session_id TEXT NOT NULL,
		user_id TEXT NOT NULL,
		sequence INTEGER NOT NULL CHECK (sequence >= 0),
		source_text TEXT NOT NULL,
		translation TEXT NOT NULL,
		final INTEGER NOT NULL CHECK (final IN (0, 1)),
		start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
		end_ms INTEGER NOT NULL CHECK (end_ms >= start_ms),
		created_at INTEGER NOT NULL,
		FOREIGN KEY (session_id, user_id)
			REFERENCES interpretation_sessions(id, user_id) ON DELETE CASCADE,
		UNIQUE (session_id, sequence)
	);
	CREATE INDEX segments_owner_session_idx
		ON segments(user_id, session_id, sequence);

	CREATE TABLE user_settings (
		user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
		default_source_language TEXT NOT NULL,
		default_target_language TEXT NOT NULL,
		auto_start_microphone INTEGER NOT NULL CHECK (auto_start_microphone IN (0, 1)),
		show_partial_transcripts INTEGER NOT NULL CHECK (show_partial_transcripts IN (0, 1)),
		compact_transcript_layout INTEGER NOT NULL CHECK (compact_transcript_layout IN (0, 1))
	);

	CREATE TABLE audit_events (
		id TEXT PRIMARY KEY,
		actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
		action TEXT NOT NULL,
		target_type TEXT NOT NULL,
		target_id TEXT NOT NULL,
		metadata_json BLOB NOT NULL,
		created_at INTEGER NOT NULL
	);
	CREATE INDEX audit_events_created_idx ON audit_events(created_at DESC, id);
	CREATE INDEX audit_events_actor_idx ON audit_events(actor_user_id, created_at DESC);
	CREATE INDEX audit_events_target_idx
		ON audit_events(target_type, target_id, created_at DESC);
`}, {version: 2, sql: `
	ALTER TABLE segments ADD COLUMN translation_status TEXT NOT NULL DEFAULT 'not_requested'
		CHECK (translation_status IN ('not_requested', 'pending', 'succeeded', 'failed'));
	ALTER TABLE segments ADD COLUMN translation_error TEXT NOT NULL DEFAULT '';
	ALTER TABLE segments ADD COLUMN translator_request_id TEXT NOT NULL DEFAULT '';
	CREATE INDEX segments_translation_status_idx
		ON segments(user_id, session_id, translation_status, sequence);
`}, {version: 3, sql: `
	CREATE TABLE application_metadata (
		key TEXT PRIMARY KEY,
		value BLOB NOT NULL
	);
`}, {version: 4, sql: `
	ALTER TABLE invitations ADD COLUMN code_bucket INTEGER
		CHECK (code_bucket IS NULL OR (code_bucket >= 0 AND code_bucket < 32));
	ALTER TABLE invitations ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0
		CHECK (failed_attempts >= 0);
	ALTER TABLE invitations ADD COLUMN revocation_reason TEXT NOT NULL DEFAULT ''
		CHECK (revocation_reason IN ('', 'administrator', 'failed_attempts', 'security_upgrade'));
	CREATE INDEX invitations_failure_bucket_idx
		ON invitations(code_bucket, expires_at)
		WHERE used_at IS NULL AND revoked_at IS NULL;
`}, {version: 5, sql: `
	CREATE TABLE invitation_failure_padding (
		bucket INTEGER PRIMARY KEY CHECK (bucket >= 0 AND bucket < 32),
		counter INTEGER NOT NULL DEFAULT 0 CHECK (counter >= 0)
	);
	INSERT INTO invitation_failure_padding(bucket, counter) VALUES
		(0, 0), (1, 0), (2, 0), (3, 0), (4, 0), (5, 0), (6, 0), (7, 0),
		(8, 0), (9, 0), (10, 0), (11, 0), (12, 0), (13, 0), (14, 0), (15, 0),
		(16, 0), (17, 0), (18, 0), (19, 0), (20, 0), (21, 0), (22, 0), (23, 0),
		(24, 0), (25, 0), (26, 0), (27, 0), (28, 0), (29, 0), (30, 0), (31, 0);
`}, {version: 6, sql: `
	CREATE TABLE action_grants (
		id TEXT PRIMARY KEY,
		token_hash BLOB NOT NULL UNIQUE CHECK (length(token_hash) = 32),
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		browser_session_id TEXT NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE,
		action TEXT NOT NULL CHECK (action IN ('passkey_management')),
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL,
		CHECK (expires_at > created_at)
	);
	CREATE INDEX action_grants_expiry_idx ON action_grants(expires_at);
	CREATE INDEX action_grants_session_idx
		ON action_grants(browser_session_id, expires_at);
`}, {version: 7, sql: `
	ALTER TABLE webauthn_ceremonies ADD COLUMN owner_user_id TEXT
		REFERENCES users(id) ON DELETE CASCADE;
	ALTER TABLE webauthn_ceremonies ADD COLUMN browser_session_id TEXT
		REFERENCES browser_sessions(id) ON DELETE CASCADE;
	CREATE INDEX webauthn_ceremonies_owner_idx
		ON webauthn_ceremonies(owner_user_id, expires_at)
		WHERE owner_user_id IS NOT NULL;
`}, {version: 8, sql: `
	ALTER TABLE webauthn_credentials ADD COLUMN compromised_at INTEGER;
	CREATE INDEX webauthn_credentials_compromised_idx
		ON webauthn_credentials(user_id, compromised_at)
		WHERE compromised_at IS NOT NULL;
`}, {version: 9, sql: `
	ALTER TABLE interpretation_sessions ADD COLUMN segment_count INTEGER NOT NULL DEFAULT 0
		CHECK (segment_count >= 0);
	ALTER TABLE interpretation_sessions ADD COLUMN transcript_bytes INTEGER NOT NULL DEFAULT 0
		CHECK (transcript_bytes >= 0);
	UPDATE interpretation_sessions
	SET segment_count = (
			SELECT COUNT(*) FROM segments WHERE segments.session_id = interpretation_sessions.id
		),
		transcript_bytes = COALESCE((
			SELECT SUM(
				length(CAST(source_text AS BLOB)) + length(CAST(translation AS BLOB))
			) FROM segments WHERE segments.session_id = interpretation_sessions.id
		), 0);
	CREATE INDEX interpretation_sessions_usage_idx
		ON interpretation_sessions(user_id, transcript_bytes);
`}, {version: 10, sql: `
	ALTER TABLE invitations ADD COLUMN failure_bucket INTEGER
		CHECK (failure_bucket IS NULL OR (failure_bucket >= 0 AND failure_bucket < 4096));
	CREATE INDEX invitations_failure_bucket_v2_idx
		ON invitations(failure_bucket, expires_at)
		WHERE used_at IS NULL AND revoked_at IS NULL;
	CREATE TABLE invitation_failure_padding_v2 (
		bucket INTEGER PRIMARY KEY CHECK (bucket >= 0 AND bucket < 4096),
		counter INTEGER NOT NULL DEFAULT 0 CHECK (counter >= 0)
	);
	WITH RECURSIVE buckets(value) AS (
		SELECT 0
		UNION ALL
		SELECT value + 1 FROM buckets WHERE value < 4095
	)
	INSERT INTO invitation_failure_padding_v2(bucket, counter)
		SELECT value, 0 FROM buckets;
`}, {version: 11, sql: `
	ALTER TABLE interpretation_sessions ADD COLUMN archived_at INTEGER;
	ALTER TABLE interpretation_sessions ADD COLUMN archive_reason TEXT NOT NULL DEFAULT ''
		CHECK (archive_reason IN ('', 'manual', 'inactivity'));
	ALTER TABLE user_settings ADD COLUMN auto_archive_hours INTEGER NOT NULL DEFAULT 24
		CHECK (auto_archive_hours BETWEEN 0 AND 8760);
	CREATE INDEX interpretation_sessions_auto_archive_idx
		ON interpretation_sessions(status, updated_at)
		WHERE archived_at IS NULL;
	CREATE INDEX segments_owner_end_idx
		ON segments(user_id, session_id, end_ms DESC);
`}, {version: 12, sql: `
	ALTER TABLE interpretation_sessions ADD COLUMN recognition_languages_json TEXT NOT NULL DEFAULT '[]';
	ALTER TABLE interpretation_sessions ADD COLUMN diarization INTEGER NOT NULL DEFAULT 0 CHECK (diarization IN (0, 1));
	ALTER TABLE segments ADD COLUMN detected_language TEXT NOT NULL DEFAULT '';
	ALTER TABLE segments ADD COLUMN speaker_id TEXT NOT NULL DEFAULT '';
	ALTER TABLE segments ADD COLUMN wall0_ms INTEGER NOT NULL DEFAULT 0 CHECK (wall0_ms >= 0);
	ALTER TABLE segments ADD COLUMN wall1_ms INTEGER NOT NULL DEFAULT 0 CHECK (wall1_ms >= 0);
	CREATE TABLE session_shares (
		id TEXT PRIMARY KEY,
		session_id TEXT NOT NULL,
		owner_user_id TEXT NOT NULL,
		kind TEXT NOT NULL CHECK (kind IN ('user', 'link')),
		permission TEXT NOT NULL CHECK (permission IN ('view', 'record')),
		recipient_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
		token_hash BLOB UNIQUE CHECK (token_hash IS NULL OR length(token_hash) = 32),
		token_sealed BLOB,
		created_at INTEGER NOT NULL,
		expires_at INTEGER,
		revoked_at INTEGER,
		FOREIGN KEY (session_id, owner_user_id) REFERENCES interpretation_sessions(id, user_id) ON DELETE CASCADE,
		CHECK (expires_at IS NULL OR expires_at > created_at),
		CHECK ((kind = 'user' AND recipient_user_id IS NOT NULL AND token_hash IS NULL AND token_sealed IS NULL)
			OR (kind = 'link' AND recipient_user_id IS NULL AND length(token_hash) = 32 AND length(token_sealed) > 0))
	);
	CREATE INDEX session_shares_owner_idx ON session_shares(owner_user_id, session_id, created_at DESC);
	CREATE INDEX session_shares_recipient_idx ON session_shares(recipient_user_id, session_id, revoked_at, expires_at);
	CREATE TABLE guest_sessions (
		id TEXT PRIMARY KEY,
		share_id TEXT NOT NULL REFERENCES session_shares(id) ON DELETE CASCADE,
		token_hash BLOB NOT NULL UNIQUE CHECK (length(token_hash) = 32),
		display_name TEXT NOT NULL,
		target_language TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL,
		CHECK (expires_at > created_at)
	);
	CREATE INDEX guest_sessions_share_idx ON guest_sessions(share_id, expires_at);
	CREATE TABLE viewer_preferences (
		session_id TEXT NOT NULL REFERENCES interpretation_sessions(id) ON DELETE CASCADE,
		viewer_id TEXT NOT NULL,
		target_language TEXT NOT NULL,
		updated_at INTEGER NOT NULL,
		PRIMARY KEY (session_id, viewer_id)
	);
	CREATE TABLE segment_translations (
		segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
		session_id TEXT NOT NULL REFERENCES interpretation_sessions(id) ON DELETE CASCADE,
		target_language TEXT NOT NULL,
		status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
		text TEXT NOT NULL DEFAULT '',
		error TEXT NOT NULL DEFAULT '',
		request_id TEXT NOT NULL DEFAULT '',
		updated_at INTEGER NOT NULL,
		PRIMARY KEY (segment_id, target_language)
	);
	CREATE INDEX segment_translations_session_idx ON segment_translations(session_id, target_language, segment_id);
	CREATE TABLE provider_endpoints (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		provider TEXT NOT NULL CHECK (provider IN ('asr', 'translator')),
		name TEXT NOT NULL,
		base_url TEXT NOT NULL,
		credential_sealed BLOB,
		configuration_json TEXT NOT NULL DEFAULT '{}',
		enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE INDEX provider_endpoints_user_idx ON provider_endpoints(user_id, provider, enabled);
`}, {version: 13, sql: `
 ALTER TABLE segments ADD COLUMN language_source TEXT NOT NULL DEFAULT '' CHECK (language_source IN ('', 'session', 'recognizer', 'text'));
`}, {version: 14, sql: `
 CREATE TABLE recording_parts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  part_index INTEGER NOT NULL CHECK(part_index >= 0),
  sample_rate INTEGER NOT NULL CHECK(sample_rate BETWEEN 8000 AND 192000),
  offset_frames INTEGER NOT NULL CHECK(offset_frames >= 0),
  frames INTEGER NOT NULL DEFAULT 0 CHECK(frames >= 0),
  bytes INTEGER NOT NULL DEFAULT 0 CHECK(bytes >= 0 AND bytes = frames * 4),
  created_at INTEGER NOT NULL,
  FOREIGN KEY(session_id,user_id) REFERENCES interpretation_sessions(id,user_id) ON DELETE CASCADE,
  UNIQUE(session_id,run_id,part_index)
 );
 CREATE INDEX recording_parts_owner_idx ON recording_parts(user_id,session_id,created_at);
 CREATE INDEX segments_session_time_idx ON segments(session_id,start_ms,sequence);
 ALTER TABLE user_settings ADD COLUMN interface_language TEXT NOT NULL DEFAULT 'system'
  CHECK(interface_language IN ('system','en','zh-Hans'));
 ALTER TABLE user_settings ADD COLUMN theme_preference TEXT NOT NULL DEFAULT 'system'
  CHECK(theme_preference IN ('system','light','dark'));
`}, {version: 15, sql: `
 ALTER TABLE segment_translations ADD COLUMN resolved_source_language TEXT NOT NULL DEFAULT '';
 ALTER TABLE segment_translations ADD COLUMN source_detection_json TEXT NOT NULL DEFAULT '';
`}, {version: 16, sql: `
 ALTER TABLE invitations ADD COLUMN kind TEXT NOT NULL DEFAULT 'registration'
  CHECK(kind IN ('registration','login'));
 ALTER TABLE invitations ADD COLUMN target_user_id TEXT NOT NULL DEFAULT '';
 ALTER TABLE invitations ADD COLUMN not_before INTEGER NOT NULL DEFAULT 0;
 UPDATE invitations SET not_before = created_at WHERE not_before = 0;
 CREATE INDEX invitations_kind_target_idx ON invitations(kind,target_user_id,expires_at)
  WHERE used_at IS NULL AND revoked_at IS NULL;
`}, {version: 17, sql: `
 ALTER TABLE user_settings RENAME COLUMN interface_language TO previous_interface_language;
 ALTER TABLE user_settings ADD COLUMN interface_language TEXT NOT NULL DEFAULT 'system'
  CHECK(length(interface_language) BETWEEN 2 AND 16);
 UPDATE user_settings SET interface_language = previous_interface_language;
 ALTER TABLE user_settings DROP COLUMN previous_interface_language;
`}, {version: 18, sql: `
 CREATE TABLE site_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  registration_help_markdown TEXT NOT NULL,
  code_attempts_per_minute INTEGER NOT NULL CHECK(code_attempts_per_minute BETWEEN 1 AND 10),
  updated_at INTEGER NOT NULL
 );
 INSERT INTO site_settings(id,registration_help_markdown,code_attempts_per_minute,updated_at)
 VALUES (1,'Ask an administrator for a one-time six-digit registration code. Enter the code to begin registration, then create a passkey to secure your account.',3,
  CAST(strftime('%s','now') AS INTEGER)*1000000000);
`}, {version: 19, sql: `
 ALTER TABLE users ADD COLUMN onboarding_complete INTEGER NOT NULL DEFAULT 0
  CHECK(onboarding_complete IN (0,1));
 UPDATE users SET onboarding_complete=1;
`}, {version: 20, sql: `
 CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '' CHECK(length(name) <= 240),
  icon TEXT NOT NULL DEFAULT '' CHECK(length(icon) <= 32),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
 );
 CREATE INDEX workspaces_user_idx ON workspaces(user_id,created_at);
 ALTER TABLE interpretation_sessions ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
 INSERT INTO workspaces(id,user_id,name,created_at,updated_at,last_used_at)
  SELECT 'wsp_'||lower(hex(randomblob(16))),id,'',
   CAST(strftime('%s','now') AS INTEGER)*1000000000,
   CAST(strftime('%s','now') AS INTEGER)*1000000000,
   CAST(strftime('%s','now') AS INTEGER)*1000000000
  FROM users;
 UPDATE interpretation_sessions SET workspace_id=(
  SELECT workspace.id FROM workspaces workspace WHERE workspace.user_id=interpretation_sessions.user_id);
 CREATE INDEX interpretation_sessions_workspace_idx ON interpretation_sessions(user_id,workspace_id,updated_at);
`}, {version: 21, sql: `
 ALTER TABLE users ADD COLUMN avatar_version INTEGER NOT NULL DEFAULT 0 CHECK(avatar_version >= 0);
 CREATE TABLE user_avatars (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL CHECK(content_type IN ('image/png','image/jpeg')),
  data BLOB NOT NULL CHECK(length(data) BETWEEN 1 AND 262144),
  updated_at INTEGER NOT NULL
 );
 ALTER TABLE users ADD COLUMN discoverable INTEGER NOT NULL DEFAULT 0 CHECK(discoverable IN (0,1));
 ALTER TABLE session_shares ADD COLUMN audience TEXT NOT NULL DEFAULT 'anyone'
  CHECK(audience IN ('anyone','members'));
 CREATE TABLE share_members (
  share_id TEXT NOT NULL REFERENCES session_shares(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY(share_id, user_id)
 );
 CREATE INDEX share_members_user_idx ON share_members(user_id, share_id);
`}, {version: 22, sql: `
 CREATE TABLE user_limits (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  concurrent_recordings INTEGER CHECK(concurrent_recordings IS NULL OR concurrent_recordings BETWEEN 1 AND 16),
  monthly_recording_minutes INTEGER CHECK(monthly_recording_minutes IS NULL OR monthly_recording_minutes BETWEEN 0 AND 1000000),
  storage_mb INTEGER CHECK(storage_mb IS NULL OR storage_mb BETWEEN 0 AND 10000000),
  workspaces INTEGER CHECK(workspaces IS NULL OR workspaces BETWEEN 1 AND 100),
  guest_links INTEGER CHECK(guest_links IS NULL OR guest_links IN (0,1)),
  updated_at INTEGER NOT NULL
 );
 CREATE TABLE recognition_gaps (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL CHECK(start_ms >= 0),
  end_ms INTEGER NOT NULL CHECK(end_ms > start_ms),
  sequence_from INTEGER NOT NULL CHECK(sequence_from > 0),
  sequence_to INTEGER NOT NULL CHECK(sequence_to >= sequence_from),
  state TEXT NOT NULL CHECK(state IN ('pending','filling','filled','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  filled_segments INTEGER NOT NULL DEFAULT 0 CHECK(filled_segments >= 0),
  last_error TEXT NOT NULL DEFAULT '' CHECK(length(last_error) <= 200),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(session_id,user_id) REFERENCES interpretation_sessions(id,user_id) ON DELETE CASCADE
 );
 CREATE INDEX recognition_gaps_state_idx ON recognition_gaps(state, updated_at);
 CREATE INDEX recognition_gaps_session_idx ON recognition_gaps(session_id, start_ms);
 ALTER TABLE segment_translations ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1 CHECK(attempts >= 0);
`}, {version: 23, sql: `
 CREATE TABLE default_limits (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  concurrent_recordings INTEGER NOT NULL CHECK(concurrent_recordings BETWEEN 1 AND 16),
  monthly_recording_minutes INTEGER NOT NULL CHECK(monthly_recording_minutes BETWEEN 0 AND 1000000),
  storage_mb INTEGER NOT NULL CHECK(storage_mb BETWEEN 0 AND 10000000),
  workspaces INTEGER NOT NULL CHECK(workspaces BETWEEN 1 AND 100),
  guest_links INTEGER NOT NULL CHECK(guest_links IN (0,1)),
  updated_at INTEGER NOT NULL
 );
`}, {version: 24, sql: `
 ALTER TABLE workspaces ADD COLUMN pinned_at INTEGER;
 ALTER TABLE site_settings ADD COLUMN draft_translation_interval_ms INTEGER NOT NULL DEFAULT 1000
  CHECK(draft_translation_interval_ms BETWEEN 0 AND 10000);
`}}

func encodeTime(value time.Time) int64 {
	return value.UTC().UnixNano()
}

func decodeTime(value int64) time.Time {
	return time.Unix(0, value).UTC()
}

func encodeOptionalTime(value *time.Time) any {
	if value == nil {
		return nil
	}
	return encodeTime(*value)
}

func decodeOptionalTime(value sql.NullInt64) *time.Time {
	if !value.Valid {
		return nil
	}
	result := decodeTime(value.Int64)
	return &result
}

func mapSQLError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	message := strings.ToLower(err.Error())
	switch {
	case strings.Contains(message, "foreign key constraint failed"):
		return fmt.Errorf("%w: %v", ErrNotFound, err)
	case strings.Contains(message, "unique constraint failed"),
		strings.Contains(message, "primary key constraint failed"),
		strings.Contains(message, "constraint failed"):
		return fmt.Errorf("%w: %v", ErrConflict, err)
	default:
		return err
	}
}

func pagination(limit, offset int) (int, int) {
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	if offset < 0 {
		offset = 0
	}
	return limit, offset
}
