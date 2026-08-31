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
	ErrNotFound      = errors.New("store: not found")
	ErrConflict      = errors.New("store: conflict")
	ErrInvalidInvite = errors.New("store: invalid invitation")
	ErrForbidden     = errors.New("store: forbidden")
	ErrCapacity      = errors.New("store: capacity exhausted")
)

// Store serializes access through one SQLite connection. SQLite still permits
// concurrent readers from other processes in WAL mode, while the single local
// connection makes transaction behavior deterministic and ensures connection-
// local pragmas (notably foreign_keys) are always active.
type Store struct {
	db *sql.DB
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

	s := &Store{db: db}
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
