package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
)

func validShare(kind domain.ShareKind, permission domain.SharePermission) bool {
	return (kind == domain.ShareUser || kind == domain.ShareLink) &&
		(permission == domain.ShareView || permission == domain.ShareRecord)
}

func (s *Store) CreateSessionShare(ctx context.Context, ownerID string, share domain.SessionShare, tokenHash, tokenSealed []byte) error {
	if ownerID == "" || share.ID == "" || share.SessionID == "" || share.OwnerUserID != ownerID ||
		!validShare(share.Kind, share.Permission) || share.CreatedAt.IsZero() || share.RevokedAt != nil ||
		(share.ExpiresAt != nil && !share.ExpiresAt.After(share.CreatedAt)) {
		return errors.New("store: invalid session share")
	}
	audience := share.Audience
	if share.Kind == domain.ShareLink {
		if share.RecipientUserID != nil || len(tokenHash) != sha256.Size || len(tokenSealed) == 0 ||
			(audience != domain.ShareAnyone && audience != domain.ShareMembers) {
			return errors.New("store: invalid link share")
		}
	} else if share.RecipientUserID == nil || *share.RecipientUserID == ownerID || len(tokenHash) != 0 || len(tokenSealed) != 0 ||
		(audience != "" && audience != domain.ShareAnyone) {
		return errors.New("store: invalid user share")
	} else {
		audience = domain.ShareAnyone
	}
	result, err := s.db.ExecContext(ctx, `
		INSERT INTO session_shares(id, session_id, owner_user_id, kind, audience, permission,
			recipient_user_id, token_hash, token_sealed, created_at, expires_at)
		SELECT ?, session.id, session.user_id, ?, ?, ?, ?, ?, ?, ?, ?
		FROM interpretation_sessions session
		JOIN users owner ON owner.id = session.user_id AND owner.status = 'active'
		WHERE session.id = ? AND session.user_id = ?
			AND (? IS NULL OR EXISTS (SELECT 1 FROM users recipient
				WHERE recipient.id = ? AND recipient.status = 'active'))`,
		share.ID, share.Kind, audience, share.Permission, share.RecipientUserID, nullableBytes(tokenHash), nullableBytes(tokenSealed),
		encodeTime(share.CreatedAt), encodeOptionalTime(share.ExpiresAt), share.SessionID, ownerID,
		share.RecipientUserID, share.RecipientUserID,
	)
	if err != nil {
		return fmt.Errorf("store: create session share: %w", mapSQLError(err))
	}
	return requireAffected(result, nil, "create session share")
}

func nullableBytes(value []byte) any {
	if len(value) == 0 {
		return nil
	}
	return value
}

func scanSessionShare(row rowScanner) (domain.SessionShare, []byte, error) {
	var share domain.SessionShare
	var recipient sql.NullString
	var sealed []byte
	var createdAt int64
	var expiresAt, revokedAt sql.NullInt64
	if err := row.Scan(&share.ID, &share.SessionID, &share.OwnerUserID, &share.Kind, &share.Audience, &share.Permission,
		&recipient, &sealed, &createdAt, &expiresAt, &revokedAt); err != nil {
		return domain.SessionShare{}, nil, mapSQLError(err)
	}
	share.RecipientUserID = optionalString(recipient)
	share.CreatedAt = decodeTime(createdAt)
	share.ExpiresAt = decodeOptionalTime(expiresAt)
	share.RevokedAt = decodeOptionalTime(revokedAt)
	return share, sealed, nil
}

const shareColumns = `share.id, share.session_id, share.owner_user_id, share.kind, share.audience, share.permission,
	share.recipient_user_id, share.token_sealed, share.created_at, share.expires_at, share.revoked_at`
const shareReturningColumns = `id, session_id, owner_user_id, kind, audience, permission,
	recipient_user_id, token_sealed, created_at, expires_at, revoked_at`

func (s *Store) ListSessionShares(ctx context.Context, ownerID, sessionID string) ([]domain.SessionShare, error) {
	if _, err := s.GetInterpretationSession(ctx, ownerID, sessionID); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+shareColumns+`
		FROM session_shares share WHERE share.owner_user_id = ? AND share.session_id = ?
		ORDER BY share.created_at DESC, share.id`, ownerID, sessionID)
	if err != nil {
		return nil, fmt.Errorf("store: list session shares: %w", err)
	}
	defer rows.Close()
	shares := make([]domain.SessionShare, 0)
	for rows.Next() {
		share, _, err := scanSessionShare(rows)
		if err != nil {
			return nil, fmt.Errorf("store: scan session share: %w", err)
		}
		shares = append(shares, share)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list session shares: %w", err)
	}
	return shares, nil
}

func (s *Store) GetSessionShare(ctx context.Context, ownerID, sessionID, shareID string) (domain.SessionShare, []byte, error) {
	share, sealed, err := scanSessionShare(s.db.QueryRowContext(ctx, `SELECT `+shareColumns+`
		FROM session_shares share JOIN interpretation_sessions session
			ON session.id = share.session_id AND session.user_id = share.owner_user_id
		WHERE share.id = ? AND share.session_id = ? AND share.owner_user_id = ?`,
		shareID, sessionID, ownerID))
	if err != nil {
		return domain.SessionShare{}, nil, fmt.Errorf("store: get session share: %w", err)
	}
	return share, sealed, nil
}

func (s *Store) UpdateSessionShare(ctx context.Context, ownerID, sessionID, shareID string, permission domain.SharePermission, expiresAt *time.Time, now time.Time) (domain.SessionShare, error) {
	if permission != domain.ShareView && permission != domain.ShareRecord || now.IsZero() ||
		(expiresAt != nil && !expiresAt.After(now)) {
		return domain.SessionShare{}, errors.New("store: invalid share update")
	}
	share, _, err := scanSessionShare(s.db.QueryRowContext(ctx, `
		UPDATE session_shares SET permission = ?, expires_at = ?
		WHERE id = ? AND session_id = ? AND owner_user_id = ? AND revoked_at IS NULL
		RETURNING `+shareReturningColumns,
		permission, encodeOptionalTime(expiresAt), shareID, sessionID, ownerID))
	if errors.Is(err, ErrNotFound) {
		current, _, lookupErr := s.GetSessionShare(ctx, ownerID, sessionID, shareID)
		if lookupErr != nil {
			return domain.SessionShare{}, lookupErr
		}
		if current.RevokedAt != nil {
			return domain.SessionShare{}, ErrConflict
		}
	}
	if err != nil {
		return domain.SessionShare{}, fmt.Errorf("store: update session share: %w", err)
	}
	return share, nil
}

func (s *Store) RevokeSessionShare(ctx context.Context, ownerID, sessionID, shareID string, now time.Time) (domain.SessionShare, error) {
	if now.IsZero() {
		return domain.SessionShare{}, errors.New("store: revocation time is required")
	}
	share, _, err := scanSessionShare(s.db.QueryRowContext(ctx, `
		UPDATE session_shares SET revoked_at = ?
		WHERE id = ? AND session_id = ? AND owner_user_id = ? AND revoked_at IS NULL
		RETURNING `+shareReturningColumns, encodeTime(now), shareID, sessionID, ownerID))
	if errors.Is(err, ErrNotFound) {
		current, _, lookupErr := s.GetSessionShare(ctx, ownerID, sessionID, shareID)
		return current, lookupErr
	}
	if err != nil {
		return domain.SessionShare{}, fmt.Errorf("store: revoke session share: %w", err)
	}
	return share, nil
}

func (s *Store) SearchShareRecipients(ctx context.Context, requesterID, query string, limit int) ([]domain.User, error) {
	if requesterID == "" || strings.TrimSpace(query) == "" || limit < 1 || limit > 20 {
		return nil, errors.New("store: invalid recipient search")
	}
	requester, err := s.GetUserByID(ctx, requesterID)
	if err != nil || requester.Status != domain.UserActive {
		if err != nil {
			return nil, err
		}
		return nil, ErrForbidden
	}
	pattern := "%" + escapeSegmentLike(query) + "%"
	rows, err := s.db.QueryContext(ctx, `
		SELECT `+userColumns+`
		FROM users WHERE status = 'active' AND discoverable = 1 AND id <> ?
			AND (username LIKE ? ESCAPE '\' OR display_name LIKE ? ESCAPE '\')
		ORDER BY username LIMIT ?`, requesterID, pattern, pattern, limit)
	if err != nil {
		return nil, fmt.Errorf("store: search share recipients: %w", err)
	}
	defer rows.Close()
	users := make([]domain.User, 0)
	for rows.Next() {
		user, err := scanUser(rows)
		if err != nil {
			return nil, fmt.Errorf("store: scan share recipient: %w", err)
		}
		users = append(users, user)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: search share recipients: %w", err)
	}
	return users, nil
}

// sharedWithPerson matches a share that lets the person bound first in: one
// made out to them by name, or a link they joined while signed in.
const sharedWithPerson = `((share.kind = 'user' AND share.recipient_user_id = ?)
	OR (share.kind = 'link' AND EXISTS (SELECT 1 FROM share_members member
		WHERE member.share_id = share.id AND member.user_id = ?)))`

// FindActiveUserShare finds the strongest share a signed-in person holds on
// a session: by name, or through a link they joined.
func (s *Store) FindActiveUserShare(ctx context.Context, userID, sessionID string, now time.Time) (domain.SessionShare, error) {
	share, _, err := scanSessionShare(s.db.QueryRowContext(ctx, `SELECT `+shareColumns+`
		FROM session_shares share
		JOIN interpretation_sessions session ON session.id = share.session_id AND session.user_id = share.owner_user_id
		JOIN users owner ON owner.id = session.user_id AND owner.status = 'active'
		JOIN users person ON person.id = ? AND person.status = 'active'
		WHERE share.session_id = ? AND `+sharedWithPerson+`
			AND share.revoked_at IS NULL AND (share.expires_at IS NULL OR share.expires_at > ?)
		ORDER BY CASE share.permission WHEN 'record' THEN 0 ELSE 1 END, share.created_at DESC LIMIT 1`,
		userID, sessionID, userID, userID, encodeTime(now)))
	if err != nil {
		return domain.SessionShare{}, fmt.Errorf("store: resolve user share: %w", err)
	}
	return share, nil
}

func (s *Store) FindActiveLinkShare(ctx context.Context, digest [sha256.Size]byte, now time.Time) (domain.SessionShare, error) {
	share, _, err := scanSessionShare(s.db.QueryRowContext(ctx, `SELECT `+shareColumns+`
		FROM session_shares share
		JOIN interpretation_sessions session ON session.id = share.session_id AND session.user_id = share.owner_user_id
		JOIN users owner ON owner.id = session.user_id AND owner.status = 'active'
		WHERE share.kind = 'link' AND share.token_hash = ? AND share.revoked_at IS NULL
			AND (share.expires_at IS NULL OR share.expires_at > ?)`, digest[:], encodeTime(now)))
	if err != nil {
		return domain.SessionShare{}, fmt.Errorf("store: resolve link share: %w", err)
	}
	return share, nil
}

// JoinLinkShare makes a signed-in person a member of a link they opened, so
// the session stays theirs to see while the link lasts. Joining again changes
// nothing; the session's owner is never a member of their own link.
func (s *Store) JoinLinkShare(ctx context.Context, shareID, userID string, now time.Time) error {
	if shareID == "" || userID == "" || now.IsZero() {
		return errors.New("store: invalid share membership")
	}
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO share_members(share_id, user_id, joined_at)
		SELECT share.id, person.id, ?
		FROM session_shares share
		JOIN interpretation_sessions session ON session.id = share.session_id AND session.user_id = share.owner_user_id
		JOIN users owner ON owner.id = session.user_id AND owner.status = 'active'
		JOIN users person ON person.id = ? AND person.status = 'active' AND person.id <> owner.id
		WHERE share.id = ? AND share.kind = 'link' AND share.revoked_at IS NULL
			AND (share.expires_at IS NULL OR share.expires_at > ?)
		ON CONFLICT(share_id, user_id) DO NOTHING`,
		encodeTime(now), userID, shareID, encodeTime(now)); err != nil {
		return fmt.Errorf("store: join link share: %w", mapSQLError(err))
	}
	var joined bool
	if err := s.db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM share_members
		WHERE share_id = ? AND user_id = ?)`, shareID, userID).Scan(&joined); err != nil {
		return fmt.Errorf("store: confirm share membership: %w", err)
	}
	if !joined {
		return ErrNotFound
	}
	return nil
}

// ListShareMembers lists who has joined one of the owner's links, by name.
func (s *Store) ListShareMembers(ctx context.Context, ownerID, sessionID, shareID string, limit int) ([]domain.User, error) {
	if limit < 1 || limit > 200 {
		return nil, errors.New("store: invalid member page")
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+userColumns+`
		FROM users WHERE status = 'active' AND id IN (
			SELECT member.user_id FROM share_members member
			JOIN session_shares share ON share.id = member.share_id
			WHERE share.id = ? AND share.session_id = ? AND share.owner_user_id = ?)
		ORDER BY display_name, id LIMIT ?`, shareID, sessionID, ownerID, limit)
	if err != nil {
		return nil, fmt.Errorf("store: list share members: %w", err)
	}
	defer rows.Close()
	users := make([]domain.User, 0)
	for rows.Next() {
		user, err := scanUser(rows)
		if err != nil {
			return nil, fmt.Errorf("store: scan share member: %w", err)
		}
		users = append(users, user)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list share members: %w", err)
	}
	return users, nil
}

// UserCanSeeSession reports whether a signed-in person may see a session
// now: they own it, it is shared with them by name, or they joined a link.
func (s *Store) UserCanSeeSession(ctx context.Context, userID, sessionID string, now time.Time) (bool, error) {
	var allowed bool
	err := s.db.QueryRowContext(ctx, `SELECT EXISTS (
		SELECT 1 FROM interpretation_sessions session
		JOIN users owner ON owner.id = session.user_id AND owner.status = 'active'
		JOIN users person ON person.id = ? AND person.status = 'active'
		WHERE session.id = ? AND (session.user_id = person.id OR EXISTS (
			SELECT 1 FROM session_shares share
			WHERE share.session_id = session.id AND share.owner_user_id = session.user_id
				AND share.revoked_at IS NULL AND (share.expires_at IS NULL OR share.expires_at > ?)
				AND `+sharedWithPerson+`)))`,
		userID, sessionID, encodeTime(now), userID, userID).Scan(&allowed)
	if err != nil {
		return false, fmt.Errorf("store: check session visibility: %w", err)
	}
	return allowed, nil
}

func (s *Store) CreateGuestSession(ctx context.Context, guest domain.GuestSession, digest [sha256.Size]byte, now time.Time) error {
	if guest.ID == "" || guest.ShareID == "" || guest.DisplayName == "" || guest.TargetLanguage == "" ||
		guest.CreatedAt.IsZero() || !guest.ExpiresAt.After(guest.CreatedAt) {
		return errors.New("store: invalid guest session")
	}
	result, err := s.db.ExecContext(ctx, `
		INSERT INTO guest_sessions(id, share_id, token_hash, display_name, target_language, created_at, expires_at)
		SELECT ?, share.id, ?, ?, ?, ?, ?
		FROM session_shares share
		JOIN interpretation_sessions session ON session.id = share.session_id AND session.user_id = share.owner_user_id
		JOIN users owner ON owner.id = session.user_id AND owner.status = 'active'
		WHERE share.id = ? AND share.kind = 'link' AND share.audience = 'anyone' AND share.revoked_at IS NULL
			AND (share.expires_at IS NULL OR share.expires_at > ?)`,
		guest.ID, digest[:], guest.DisplayName, guest.TargetLanguage,
		encodeTime(guest.CreatedAt), encodeTime(guest.ExpiresAt), guest.ShareID, encodeTime(now),
	)
	if err != nil {
		return fmt.Errorf("store: create guest session: %w", mapSQLError(err))
	}
	return requireAffected(result, nil, "create guest session")
}

func scanGuestSession(row rowScanner) (domain.GuestSession, error) {
	var guest domain.GuestSession
	var createdAt, expiresAt int64
	if err := row.Scan(&guest.ID, &guest.ShareID, &guest.SessionID, &guest.DisplayName,
		&guest.TargetLanguage, &createdAt, &expiresAt); err != nil {
		return domain.GuestSession{}, mapSQLError(err)
	}
	guest.CreatedAt = decodeTime(createdAt)
	guest.ExpiresAt = decodeTime(expiresAt)
	return guest, nil
}

const guestColumns = `guest.id, guest.share_id, share.session_id, guest.display_name,
	guest.target_language, guest.created_at, guest.expires_at`

func (s *Store) FindActiveGuestSession(ctx context.Context, guestID string, digest *[sha256.Size]byte, now time.Time) (domain.GuestSession, domain.SessionShare, error) {
	where := "guest.id = ?"
	arg := any(guestID)
	if digest != nil {
		where = "guest.token_hash = ?"
		arg = digest[:]
	}
	row := s.db.QueryRowContext(ctx, `SELECT `+guestColumns+`, `+shareColumns+`
		FROM guest_sessions guest
		JOIN session_shares share ON share.id = guest.share_id
		JOIN interpretation_sessions session ON session.id = share.session_id AND session.user_id = share.owner_user_id
		JOIN users owner ON owner.id = session.user_id AND owner.status = 'active'
		WHERE `+where+` AND guest.expires_at > ? AND share.kind = 'link' AND share.audience = 'anyone'
			AND share.revoked_at IS NULL AND (share.expires_at IS NULL OR share.expires_at > ?)`,
		arg, encodeTime(now), encodeTime(now))
	var guest domain.GuestSession
	var share domain.SessionShare
	var guestCreated, guestExpires, shareCreated int64
	var recipient sql.NullString
	var shareExpires, revoked sql.NullInt64
	var sealed []byte
	if err := row.Scan(&guest.ID, &guest.ShareID, &guest.SessionID, &guest.DisplayName,
		&guest.TargetLanguage, &guestCreated, &guestExpires,
		&share.ID, &share.SessionID, &share.OwnerUserID, &share.Kind, &share.Audience, &share.Permission,
		&recipient, &sealed, &shareCreated, &shareExpires, &revoked); err != nil {
		return domain.GuestSession{}, domain.SessionShare{}, fmt.Errorf("store: resolve guest session: %w", mapSQLError(err))
	}
	guest.CreatedAt = decodeTime(guestCreated)
	guest.ExpiresAt = decodeTime(guestExpires)
	share.RecipientUserID = optionalString(recipient)
	share.CreatedAt = decodeTime(shareCreated)
	share.ExpiresAt = decodeOptionalTime(shareExpires)
	share.RevokedAt = decodeOptionalTime(revoked)
	return guest, share, nil
}

func (s *Store) GetViewerTargetLanguage(ctx context.Context, sessionID, viewerID string) (string, error) {
	var target string
	if err := s.db.QueryRowContext(ctx, `SELECT target_language FROM viewer_preferences
		WHERE session_id = ? AND viewer_id = ?`, sessionID, viewerID).Scan(&target); err != nil {
		return "", fmt.Errorf("store: get viewer language: %w", mapSQLError(err))
	}
	return target, nil
}

func (s *Store) UpsertViewerTargetLanguage(ctx context.Context, sessionID, viewerID, target string, now time.Time) error {
	if sessionID == "" || viewerID == "" || target == "" || now.IsZero() {
		return errors.New("store: invalid viewer language")
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO viewer_preferences(session_id, viewer_id, target_language, updated_at)
		VALUES (?, ?, ?, ?) ON CONFLICT(session_id, viewer_id) DO UPDATE SET
		target_language = excluded.target_language, updated_at = excluded.updated_at`,
		sessionID, viewerID, target, encodeTime(now))
	if err != nil {
		return fmt.Errorf("store: set viewer language: %w", mapSQLError(err))
	}
	return nil
}

const accessibleSessionColumns = `session.id, session.user_id, session.title,
	session.source_language, session.target_language, session.status,
	session.created_at, session.updated_at, session.started_at, session.ended_at,
	session.archived_at, session.archive_reason, session.recognition_languages_json, session.diarization,
	COALESCE(session.workspace_id, '')`

// AccessibleSessionFilter narrows what a signed-in viewer lists: the sessions
// in one of their own workspaces, or only those others have shared with them.
// The zero value lists everything they can see.
type AccessibleSessionFilter struct {
	WorkspaceID string
	SharedOnly  bool
}

func (s *Store) ListAccessibleInterpretationSessions(ctx context.Context, viewer domain.Viewer, now time.Time, limit, offset int) ([]domain.InterpretationSession, error) {
	return s.ListAccessibleInterpretationSessionsFiltered(ctx, viewer, now, AccessibleSessionFilter{}, limit, offset)
}

func (s *Store) ListAccessibleInterpretationSessionsFiltered(ctx context.Context, viewer domain.Viewer, now time.Time, filter AccessibleSessionFilter, limit, offset int) ([]domain.InterpretationSession, error) {
	if limit < 1 || limit > 200 || offset < 0 || offset > 1_000_000 {
		return nil, errors.New("store: invalid accessible session pagination")
	}
	if filter.WorkspaceID != "" && filter.SharedOnly {
		return nil, errors.New("store: a workspace holds only its owner's sessions")
	}
	query := `SELECT ` + accessibleSessionColumns + `
		FROM interpretation_sessions session
		JOIN users owner ON owner.id = session.user_id AND owner.status = 'active'`
	var args []any
	if viewer.UserID != "" {
		userShare := `EXISTS (
				SELECT 1 FROM session_shares share
				WHERE share.session_id = session.id AND share.owner_user_id = session.user_id
					AND share.revoked_at IS NULL AND (share.expires_at IS NULL OR share.expires_at > ?)
					AND ` + sharedWithPerson + `
			)`
		shareArgs := []any{encodeTime(now), viewer.UserID, viewer.UserID}
		if viewer.GuestID != "" {
			userShare += ` OR EXISTS (
				SELECT 1 FROM guest_sessions guest
				JOIN session_shares share ON share.id = guest.share_id
				WHERE guest.id = ? AND guest.expires_at > ?
					AND share.session_id = session.id AND share.owner_user_id = session.user_id
					AND share.kind = 'link' AND share.audience = 'anyone' AND share.revoked_at IS NULL
					AND (share.expires_at IS NULL OR share.expires_at > ?)
			)`
			shareArgs = append(shareArgs, viewer.GuestID, encodeTime(now), encodeTime(now))
		}
		query += ` JOIN users current_user ON current_user.id = ? AND current_user.status = 'active'`
		args = []any{viewer.UserID}
		switch {
		case filter.WorkspaceID != "":
			query += ` WHERE session.user_id = ? AND session.workspace_id = ?`
			args = append(args, viewer.UserID, filter.WorkspaceID)
		case filter.SharedOnly:
			query += ` WHERE session.user_id <> ? AND (` + userShare + `)`
			args = append(append(args, viewer.UserID), shareArgs...)
		default:
			query += ` WHERE (session.user_id = ? OR ` + userShare + `)`
			args = append(append(args, viewer.UserID), shareArgs...)
		}
	} else if viewer.GuestID != "" && viewer.UserID == "" {
		if filter.WorkspaceID != "" {
			return nil, ErrForbidden
		}
		query += ` JOIN session_shares share ON share.session_id = session.id AND share.owner_user_id = session.user_id
			JOIN guest_sessions guest ON guest.share_id = share.id
			WHERE guest.id = ? AND guest.expires_at > ? AND share.kind = 'link' AND share.audience = 'anyone'
				AND share.revoked_at IS NULL AND (share.expires_at IS NULL OR share.expires_at > ?)`
		args = []any{viewer.GuestID, encodeTime(now), encodeTime(now)}
	} else {
		return nil, ErrForbidden
	}
	query += ` ORDER BY session.updated_at DESC, session.id LIMIT ? OFFSET ?`
	args = append(args, limit, offset)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("store: list accessible sessions: %w", err)
	}
	defer rows.Close()
	sessions := make([]domain.InterpretationSession, 0)
	for rows.Next() {
		session, err := scanInterpretationSession(rows)
		if err != nil {
			return nil, fmt.Errorf("store: scan accessible session: %w", err)
		}
		sessions = append(sessions, session)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list accessible sessions: %w", err)
	}
	return sessions, nil
}

func (s *Store) UpsertProviderEndpoint(ctx context.Context, ownerID string, endpoint domain.ProviderEndpoint) error {
	if ownerID == "" || endpoint.UserID != ownerID || endpoint.ID == "" || endpoint.Name == "" || endpoint.BaseURL == "" ||
		(endpoint.Provider != "asr" && endpoint.Provider != "translator") ||
		endpoint.CreatedAt.IsZero() || endpoint.UpdatedAt.IsZero() || len(endpoint.CredentialSealed) > 8192 ||
		len(endpoint.Configuration) > 8192 {
		return errors.New("store: invalid provider endpoint")
	}
	if len(endpoint.Configuration) == 0 {
		endpoint.Configuration = json.RawMessage("{}")
	}
	if !json.Valid(endpoint.Configuration) {
		return errors.New("store: invalid provider endpoint configuration")
	}
	result, err := s.db.ExecContext(ctx, `
		INSERT INTO provider_endpoints(id, user_id, provider, name, base_url, credential_sealed,
			configuration_json, enabled, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, name = excluded.name,
			base_url = excluded.base_url, credential_sealed = excluded.credential_sealed,
			configuration_json = excluded.configuration_json, enabled = excluded.enabled,
			updated_at = excluded.updated_at WHERE provider_endpoints.user_id = ?`,
		endpoint.ID, ownerID, endpoint.Provider, endpoint.Name, endpoint.BaseURL,
		nullableBytes(endpoint.CredentialSealed), string(endpoint.Configuration), boolInt(endpoint.Enabled),
		encodeTime(endpoint.CreatedAt), encodeTime(endpoint.UpdatedAt), ownerID)
	if err != nil {
		return fmt.Errorf("store: upsert provider endpoint: %w", mapSQLError(err))
	}
	return requireAffected(result, nil, "upsert provider endpoint")
}

func scanProviderEndpoint(row rowScanner) (domain.ProviderEndpoint, error) {
	var endpoint domain.ProviderEndpoint
	var credential []byte
	var configuration string
	var enabled int
	var createdAt, updatedAt int64
	if err := row.Scan(&endpoint.ID, &endpoint.UserID, &endpoint.Provider, &endpoint.Name,
		&endpoint.BaseURL, &credential, &configuration, &enabled, &createdAt, &updatedAt); err != nil {
		return domain.ProviderEndpoint{}, mapSQLError(err)
	}
	endpoint.CredentialSealed = credential
	endpoint.HasCredential = len(credential) > 0
	endpoint.Configuration = json.RawMessage(configuration)
	endpoint.Enabled = enabled != 0
	endpoint.CreatedAt = decodeTime(createdAt)
	endpoint.UpdatedAt = decodeTime(updatedAt)
	return endpoint, nil
}

const providerColumns = `id, user_id, provider, name, base_url, credential_sealed,
	configuration_json, enabled, created_at, updated_at`

func (s *Store) GetProviderEndpoint(ctx context.Context, ownerID, endpointID string) (domain.ProviderEndpoint, error) {
	endpoint, err := scanProviderEndpoint(s.db.QueryRowContext(ctx,
		`SELECT `+providerColumns+` FROM provider_endpoints WHERE id = ? AND user_id = ?`, endpointID, ownerID))
	if err != nil {
		return domain.ProviderEndpoint{}, fmt.Errorf("store: get provider endpoint: %w", err)
	}
	return endpoint, nil
}

func (s *Store) ListProviderEndpoints(ctx context.Context, ownerID string) ([]domain.ProviderEndpoint, error) {
	if _, err := s.GetUserByID(ctx, ownerID); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+providerColumns+`
		FROM provider_endpoints WHERE user_id = ? ORDER BY provider, name, id`, ownerID)
	if err != nil {
		return nil, fmt.Errorf("store: list provider endpoints: %w", err)
	}
	defer rows.Close()
	items := make([]domain.ProviderEndpoint, 0)
	for rows.Next() {
		item, err := scanProviderEndpoint(rows)
		if err != nil {
			return nil, fmt.Errorf("store: scan provider endpoint: %w", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list provider endpoints: %w", err)
	}
	return items, nil
}

func (s *Store) DeleteProviderEndpoint(ctx context.Context, ownerID, endpointID string) error {
	result, err := s.db.ExecContext(ctx,
		`DELETE FROM provider_endpoints WHERE id = ? AND user_id = ?`, endpointID, ownerID)
	return requireAffected(result, err, "delete provider endpoint")
}
