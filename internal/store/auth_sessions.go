package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/id"
)

const maxBrowserSessionsPerUser = 20

func (s *Store) CreateBrowserSession(
	ctx context.Context,
	session domain.BrowserSession,
	clearToken string,
) error {
	return s.createBrowserSession(ctx, session, clearToken, nil)
}

// CreateBrowserSessionForCredential atomically requires that the credential
// used for this login still belongs to the active user and is not quarantined.
// If a concurrent clone-warning transaction wins first, no post-quarantine
// session can escape the logout-all response; if this insert wins first, that
// transaction subsequently deletes it.
func (s *Store) CreateBrowserSessionForCredential(
	ctx context.Context,
	session domain.BrowserSession,
	clearToken string,
	credentialID []byte,
) error {
	if len(credentialID) == 0 {
		return ErrNotFound
	}
	return s.createBrowserSession(ctx, session, clearToken, credentialID)
}

func (s *Store) createBrowserSession(
	ctx context.Context,
	session domain.BrowserSession,
	clearToken string,
	credentialID []byte,
) error {
	if session.ID == "" || session.UserID == "" || clearToken == "" {
		return errors.New("store: browser session id, user id, and token are required")
	}
	if session.CreatedAt.IsZero() || session.ExpiresAt.IsZero() || session.LastSeen.IsZero() {
		return errors.New("store: browser session timestamps are required")
	}
	if !session.ExpiresAt.After(session.CreatedAt) {
		return errors.New("store: browser session expiry must follow creation")
	}
	digest := id.HashSecret(clearToken)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: begin browser session creation: %w", err)
	}
	defer tx.Rollback()
	insert := `
		INSERT INTO browser_sessions(
			id, user_id, token_hash, created_at, expires_at, last_seen, user_agent, ip_address
		)
		SELECT ?, u.id, ?, ?, ?, ?, ?, ?
		FROM users u WHERE u.id = ? AND u.status = 'active'`
	args := []any{
		session.ID, digest[:], encodeTime(session.CreatedAt),
		encodeTime(session.ExpiresAt), encodeTime(session.LastSeen),
		session.UserAgent, session.IPAddress, session.UserID,
	}
	if len(credentialID) > 0 {
		insert = `
			INSERT INTO browser_sessions(
				id, user_id, token_hash, created_at, expires_at, last_seen, user_agent, ip_address
			)
			SELECT ?, u.id, ?, ?, ?, ?, ?, ?
			FROM users u
			JOIN webauthn_credentials credential ON credential.user_id = u.id
			WHERE u.id = ? AND u.status = 'active'
				AND credential.credential_id = ? AND credential.compromised_at IS NULL`
		args = append(args, credentialID)
	}
	result, err := tx.ExecContext(ctx, insert, args...)
	if err != nil {
		return fmt.Errorf("store: create browser session: %w", mapSQLError(err))
	}
	if err := requireAffected(result, nil, "create browser session for active user"); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM browser_sessions
		WHERE id IN (
			SELECT id FROM browser_sessions
			WHERE user_id = ?
			ORDER BY last_seen DESC, created_at DESC, id DESC
			LIMIT -1 OFFSET ?
		)`, session.UserID, maxBrowserSessionsPerUser); err != nil {
		return fmt.Errorf("store: enforce browser session quota: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: commit browser session creation: %w", err)
	}
	return nil
}

func (s *Store) LookupBrowserSession(
	ctx context.Context,
	clearToken string,
	now time.Time,
) (domain.BrowserSession, error) {
	if clearToken == "" {
		return domain.BrowserSession{}, ErrNotFound
	}
	digest := id.HashSecret(clearToken)
	return scanBrowserSession(s.db.QueryRowContext(ctx, `
		SELECT bs.id, bs.user_id, bs.created_at, bs.expires_at, bs.last_seen,
			bs.user_agent, bs.ip_address
		FROM browser_sessions bs
		JOIN users u ON u.id = bs.user_id
		WHERE bs.token_hash = ? AND bs.expires_at > ? AND u.status = 'active'`,
		digest[:], encodeTime(now),
	))
}

// ValidateBrowserSession verifies that browserSessionID belongs to userID, has
// not expired at now, and belongs to an active user. All negative validation
// results return ErrNotFound so callers cannot distinguish an unknown session
// from one owned by another user, expired, deleted, or disabled.
func (s *Store) ValidateBrowserSession(
	ctx context.Context,
	userID string,
	browserSessionID string,
	now time.Time,
) error {
	if userID == "" || browserSessionID == "" {
		return ErrNotFound
	}

	var exists int
	err := s.db.QueryRowContext(ctx, `
		SELECT 1
		FROM browser_sessions bs
		JOIN users u ON u.id = bs.user_id
		WHERE bs.id = ? AND bs.user_id = ?
			AND bs.expires_at > ? AND u.status = 'active'`,
		browserSessionID, userID, encodeTime(now),
	).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("store: validate browser session: %w", err)
	}
	return nil
}

func scanBrowserSession(row rowScanner) (domain.BrowserSession, error) {
	var session domain.BrowserSession
	var createdAt, expiresAt, lastSeen int64
	if err := row.Scan(
		&session.ID, &session.UserID, &createdAt, &expiresAt, &lastSeen,
		&session.UserAgent, &session.IPAddress,
	); err != nil {
		return domain.BrowserSession{}, mapSQLError(err)
	}
	session.CreatedAt = decodeTime(createdAt)
	session.ExpiresAt = decodeTime(expiresAt)
	session.LastSeen = decodeTime(lastSeen)
	return session, nil
}

// ListActiveBrowserSessions returns only unexpired sessions owned by userID.
// The owner predicate is part of the query so callers can never list another
// account's browser metadata by supplying a session identifier.
func (s *Store) ListActiveBrowserSessions(
	ctx context.Context,
	userID string,
	now time.Time,
) ([]domain.BrowserSession, error) {
	if userID == "" || now.IsZero() {
		return nil, ErrNotFound
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT bs.id, bs.user_id, bs.created_at, bs.expires_at, bs.last_seen,
			bs.user_agent, bs.ip_address
		FROM browser_sessions bs
		JOIN users u ON u.id = bs.user_id
		WHERE bs.user_id = ? AND bs.expires_at > ? AND u.status = 'active'
		ORDER BY bs.last_seen DESC, bs.created_at DESC, bs.id DESC`,
		userID, encodeTime(now),
	)
	if err != nil {
		return nil, fmt.Errorf("store: list active browser sessions: %w", err)
	}
	defer rows.Close()
	sessions := make([]domain.BrowserSession, 0)
	for rows.Next() {
		session, err := scanBrowserSession(rows)
		if err != nil {
			return nil, fmt.Errorf("store: scan active browser session: %w", err)
		}
		sessions = append(sessions, session)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list active browser sessions: %w", err)
	}
	return sessions, nil
}

func (s *Store) TouchBrowserSession(ctx context.Context, clearToken string, now time.Time) error {
	if clearToken == "" {
		return ErrNotFound
	}
	digest := id.HashSecret(clearToken)
	result, err := s.db.ExecContext(ctx, `
		UPDATE browser_sessions
		SET last_seen = CASE WHEN last_seen < ? THEN ? ELSE last_seen END
		WHERE token_hash = ? AND expires_at > ?
			AND EXISTS (
				SELECT 1 FROM users
				WHERE users.id = browser_sessions.user_id AND users.status = 'active'
			)`,
		encodeTime(now), encodeTime(now), digest[:], encodeTime(now),
	)
	return requireAffected(result, err, "touch browser session")
}

func (s *Store) DeleteBrowserSession(ctx context.Context, clearToken string) error {
	if clearToken == "" {
		return ErrNotFound
	}
	digest := id.HashSecret(clearToken)
	result, err := s.db.ExecContext(ctx,
		"DELETE FROM browser_sessions WHERE token_hash = ?", digest[:],
	)
	return requireAffected(result, err, "delete browser session")
}

// DeleteBrowserSessionByID deletes exactly one session owned by userID. An
// unknown session and a session belonging to another account are deliberately
// indistinguishable.
func (s *Store) DeleteBrowserSessionByID(ctx context.Context, userID, browserSessionID string) error {
	if userID == "" || browserSessionID == "" {
		return ErrNotFound
	}
	result, err := s.db.ExecContext(ctx, `
		DELETE FROM browser_sessions WHERE id = ? AND user_id = ?`,
		browserSessionID, userID,
	)
	return requireAffected(result, err, "delete owned browser session")
}

// DeleteOtherBrowserSessions atomically verifies that currentBrowserSessionID
// is still an active session owned by userID, preserves it, and deletes every
// other session for the same account. Deleted IDs are returned so process-local
// live connections can be cancelled immediately after the durable revocation.
func (s *Store) DeleteOtherBrowserSessions(
	ctx context.Context,
	userID string,
	currentBrowserSessionID string,
	now time.Time,
) ([]string, error) {
	if userID == "" || currentBrowserSessionID == "" || now.IsZero() {
		return nil, ErrNotFound
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("store: begin other browser session deletion: %w", err)
	}
	defer tx.Rollback()
	var currentExists int
	if err := tx.QueryRowContext(ctx, `
		SELECT 1 FROM browser_sessions bs
		JOIN users u ON u.id = bs.user_id
		WHERE bs.id = ? AND bs.user_id = ?
			AND bs.expires_at > ? AND u.status = 'active'`,
		currentBrowserSessionID, userID, encodeTime(now),
	).Scan(&currentExists); err != nil {
		return nil, fmt.Errorf("store: verify current browser session: %w", mapSQLError(err))
	}
	rows, err := tx.QueryContext(ctx, `
		DELETE FROM browser_sessions
		WHERE user_id = ? AND id <> ?
		RETURNING id`, userID, currentBrowserSessionID)
	if err != nil {
		return nil, fmt.Errorf("store: delete other browser sessions: %w", mapSQLError(err))
	}
	deleted := make([]string, 0)
	for rows.Next() {
		var browserSessionID string
		if err := rows.Scan(&browserSessionID); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("store: scan deleted browser session: %w", err)
		}
		deleted = append(deleted, browserSessionID)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, fmt.Errorf("store: delete other browser sessions: %w", err)
	}
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("store: close deleted browser sessions: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("store: commit other browser session deletion: %w", err)
	}
	return deleted, nil
}

func (s *Store) DeleteUserBrowserSessions(ctx context.Context, userID string) (int64, error) {
	result, err := s.db.ExecContext(ctx,
		"DELETE FROM browser_sessions WHERE user_id = ?", userID,
	)
	if err != nil {
		return 0, fmt.Errorf("store: delete user browser sessions: %w", err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("store: delete user browser sessions affected rows: %w", err)
	}
	return count, nil
}

const (
	CeremonyRegistration   = "registration"
	CeremonyAuthentication = "authentication"
)

type WebAuthnCeremony struct {
	ID               string
	Kind             string
	SessionJSON      []byte
	PendingUserJSON  []byte
	InvitationID     *string
	OwnerUserID      string
	BrowserSessionID string
	CreatedAt        time.Time
	ExpiresAt        time.Time
}

func (s *Store) CreateWebAuthnCeremony(
	ctx context.Context,
	ceremony WebAuthnCeremony,
	clearToken string,
) error {
	return s.createWebAuthnCeremony(ctx, ceremony, clearToken, 0, 0, 0)
}

// CreateWebAuthnCeremonyBounded atomically expires stale ceremonies, checks
// global outstanding capacity, and inserts the new ceremony. The durable
// bound prevents distributed unauthenticated begin requests (and process
// restarts) from growing the ceremony table without limit.
func (s *Store) CreateWebAuthnCeremonyBounded(
	ctx context.Context,
	ceremony WebAuthnCeremony,
	clearToken string,
	maxOutstanding, maxOwnedOutstanding, maxPerOwner int,
) error {
	if maxOutstanding <= 0 || maxOwnedOutstanding <= 0 || maxPerOwner <= 0 || maxOwnedOutstanding > maxOutstanding {
		return errors.New("store: ceremony capacities must be positive and ordered")
	}
	return s.createWebAuthnCeremony(ctx, ceremony, clearToken, maxOutstanding, maxOwnedOutstanding, maxPerOwner)
}

func (s *Store) createWebAuthnCeremony(
	ctx context.Context,
	ceremony WebAuthnCeremony,
	clearToken string,
	maxOutstanding, maxOwnedOutstanding, maxPerOwner int,
) error {
	if ceremony.ID == "" || ceremony.Kind == "" || clearToken == "" || len(ceremony.SessionJSON) == 0 {
		return errors.New("store: ceremony id, kind, token, and session JSON are required")
	}
	if ceremony.CreatedAt.IsZero() || ceremony.ExpiresAt.IsZero() {
		return errors.New("store: ceremony timestamps are required")
	}
	if !ceremony.ExpiresAt.After(ceremony.CreatedAt) {
		return errors.New("store: ceremony expiry must follow creation")
	}
	if (ceremony.OwnerUserID == "") != (ceremony.BrowserSessionID == "") {
		return errors.New("store: ceremony owner and browser session must be provided together")
	}
	digest := id.HashSecret(clearToken)
	if maxOutstanding > 0 {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return fmt.Errorf("store: begin bounded WebAuthn ceremony: %w", err)
		}
		defer tx.Rollback()
		if _, err := tx.ExecContext(ctx,
			"DELETE FROM webauthn_ceremonies WHERE expires_at <= ?", encodeTime(ceremony.CreatedAt),
		); err != nil {
			return fmt.Errorf("store: expire WebAuthn ceremonies before insert: %w", err)
		}
		var count int
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM webauthn_ceremonies").Scan(&count); err != nil {
			return fmt.Errorf("store: count WebAuthn ceremonies: %w", err)
		}
		if count >= maxOutstanding {
			return ErrCapacity
		}
		if ceremony.OwnerUserID != "" {
			var active int
			if err := tx.QueryRowContext(ctx, `
				SELECT 1 FROM browser_sessions bs
				JOIN users u ON u.id = bs.user_id
				WHERE bs.id = ? AND bs.user_id = ? AND bs.expires_at > ?
					AND u.status = 'active'`,
				ceremony.BrowserSessionID, ceremony.OwnerUserID, encodeTime(ceremony.CreatedAt),
			).Scan(&active); err != nil {
				if errors.Is(err, sql.ErrNoRows) {
					return ErrForbidden
				}
				return fmt.Errorf("store: validate WebAuthn ceremony owner: %w", err)
			}
			var ownedCount, ownerCount int
			if err := tx.QueryRowContext(ctx,
				"SELECT COUNT(*) FROM webauthn_ceremonies WHERE owner_user_id IS NOT NULL",
			).Scan(&ownedCount); err != nil {
				return fmt.Errorf("store: count owned WebAuthn ceremonies: %w", err)
			}
			if err := tx.QueryRowContext(ctx,
				"SELECT COUNT(*) FROM webauthn_ceremonies WHERE owner_user_id = ?", ceremony.OwnerUserID,
			).Scan(&ownerCount); err != nil {
				return fmt.Errorf("store: count owner WebAuthn ceremonies: %w", err)
			}
			if ownedCount >= maxOwnedOutstanding || ownerCount >= maxPerOwner {
				return ErrCapacity
			}
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO webauthn_ceremonies(
				id, token_hash, kind, session_json, pending_user_json,
				invitation_id, owner_user_id, browser_session_id, created_at, expires_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			ceremony.ID, digest[:], ceremony.Kind, ceremony.SessionJSON,
			nullBytes(ceremony.PendingUserJSON), ceremony.InvitationID,
			nullText(ceremony.OwnerUserID), nullText(ceremony.BrowserSessionID),
			encodeTime(ceremony.CreatedAt), encodeTime(ceremony.ExpiresAt),
		); err != nil {
			return fmt.Errorf("store: create bounded WebAuthn ceremony: %w", mapSQLError(err))
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("store: commit bounded WebAuthn ceremony: %w", err)
		}
		return nil
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO webauthn_ceremonies(
			id, token_hash, kind, session_json, pending_user_json,
			invitation_id, owner_user_id, browser_session_id, created_at, expires_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		ceremony.ID, digest[:], ceremony.Kind, ceremony.SessionJSON,
		nullBytes(ceremony.PendingUserJSON), ceremony.InvitationID,
		nullText(ceremony.OwnerUserID), nullText(ceremony.BrowserSessionID),
		encodeTime(ceremony.CreatedAt), encodeTime(ceremony.ExpiresAt),
	)
	if err != nil {
		return fmt.Errorf("store: create WebAuthn ceremony: %w", mapSQLError(err))
	}
	return nil
}

func nullBytes(value []byte) any {
	if value == nil {
		return nil
	}
	return value
}

func nullText(value string) any {
	if value == "" {
		return nil
	}
	return value
}

// ConsumeWebAuthnCeremony deletes and returns a valid ceremony in one SQLite
// statement. Concurrent or replayed consumers therefore observe ErrNotFound.
func (s *Store) ConsumeWebAuthnCeremony(
	ctx context.Context,
	clearToken string,
	now time.Time,
) (WebAuthnCeremony, error) {
	if clearToken == "" {
		return WebAuthnCeremony{}, ErrNotFound
	}
	digest := id.HashSecret(clearToken)
	return scanWebAuthnCeremony(s.db.QueryRowContext(ctx, `
		DELETE FROM webauthn_ceremonies
		WHERE token_hash = ? AND expires_at > ?
		RETURNING id, kind, session_json, pending_user_json,
			invitation_id, owner_user_id, browser_session_id, created_at, expires_at`,
		digest[:], encodeTime(now),
	))
}

func scanWebAuthnCeremony(row rowScanner) (WebAuthnCeremony, error) {
	var ceremony WebAuthnCeremony
	var pendingUserJSON []byte
	var invitationID, ownerUserID, browserSessionID sql.NullString
	var createdAt, expiresAt int64
	if err := row.Scan(
		&ceremony.ID, &ceremony.Kind, &ceremony.SessionJSON, &pendingUserJSON,
		&invitationID, &ownerUserID, &browserSessionID, &createdAt, &expiresAt,
	); err != nil {
		return WebAuthnCeremony{}, mapSQLError(err)
	}
	ceremony.PendingUserJSON = pendingUserJSON
	ceremony.InvitationID = optionalString(invitationID)
	ceremony.OwnerUserID = ownerUserID.String
	ceremony.BrowserSessionID = browserSessionID.String
	ceremony.CreatedAt = decodeTime(createdAt)
	ceremony.ExpiresAt = decodeTime(expiresAt)
	return ceremony, nil
}

func (s *Store) DeleteExpiredWebAuthnCeremonies(ctx context.Context, now time.Time) (int64, error) {
	result, err := s.db.ExecContext(ctx,
		"DELETE FROM webauthn_ceremonies WHERE expires_at <= ?", encodeTime(now),
	)
	if err != nil {
		return 0, fmt.Errorf("store: delete expired WebAuthn ceremonies: %w", err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("store: delete expired WebAuthn ceremonies affected rows: %w", err)
	}
	return count, nil
}

func (s *Store) DeleteExpiredBrowserSessions(ctx context.Context, now time.Time) (int64, error) {
	result, err := s.db.ExecContext(ctx,
		"DELETE FROM browser_sessions WHERE expires_at <= ?", encodeTime(now),
	)
	if err != nil {
		return 0, fmt.Errorf("store: delete expired browser sessions: %w", err)
	}
	return result.RowsAffected()
}
