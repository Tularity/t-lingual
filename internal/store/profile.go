package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
)

// ProfileUpdate changes what is set and keeps the rest.
type ProfileUpdate struct {
	DisplayName  *string
	Discoverable *bool
}

// UpdateProfile gives one account a new name to be shown by, or lets it be
// found by others, or both.
func (s *Store) UpdateProfile(ctx context.Context, userID string, update ProfileUpdate, now time.Time) (domain.User, error) {
	if update.DisplayName == nil && update.Discoverable == nil {
		return domain.User{}, errors.New("store: empty profile update")
	}
	var discoverable any
	if update.Discoverable != nil {
		discoverable = 0
		if *update.Discoverable {
			discoverable = 1
		}
	}
	result, err := s.db.ExecContext(ctx, `UPDATE users SET display_name = COALESCE(?, display_name),
		discoverable = COALESCE(?, discoverable), updated_at = ? WHERE id = ?`,
		update.DisplayName, discoverable, encodeTime(now), userID)
	if err != nil {
		return domain.User{}, fmt.Errorf("store: update profile: %w", mapSQLError(err))
	}
	if err := requireAffected(result, nil, "update profile"); err != nil {
		return domain.User{}, err
	}
	return s.GetUserByID(ctx, userID)
}

// SetUserAvatar keeps one account's picture, replacing any it had. The
// account's avatar version moves on, so a picture cached under the old one is
// never shown for the new.
func (s *Store) SetUserAvatar(ctx context.Context, userID, contentType string, data []byte, now time.Time) (domain.User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return domain.User{}, fmt.Errorf("store: begin avatar update: %w", err)
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `UPDATE users SET avatar_version = MAX(avatar_version + 1, ?), updated_at = ? WHERE id = ?`,
		now.UnixMilli(), encodeTime(now), userID)
	if err != nil {
		return domain.User{}, fmt.Errorf("store: update avatar version: %w", err)
	}
	if err := requireAffected(result, nil, "update avatar version"); err != nil {
		return domain.User{}, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO user_avatars(user_id, content_type, data, updated_at) VALUES (?, ?, ?, ?)
		ON CONFLICT(user_id) DO UPDATE SET content_type = excluded.content_type, data = excluded.data, updated_at = excluded.updated_at`,
		userID, contentType, data, encodeTime(now)); err != nil {
		return domain.User{}, fmt.Errorf("store: save avatar: %w", mapSQLError(err))
	}
	if err := tx.Commit(); err != nil {
		return domain.User{}, fmt.Errorf("store: commit avatar update: %w", err)
	}
	return s.GetUserByID(ctx, userID)
}

// DeleteUserAvatar removes one account's picture; it is shown by its
// initials again.
func (s *Store) DeleteUserAvatar(ctx context.Context, userID string, now time.Time) (domain.User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return domain.User{}, fmt.Errorf("store: begin avatar removal: %w", err)
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `UPDATE users SET avatar_version = 0, updated_at = ? WHERE id = ?`, encodeTime(now), userID)
	if err != nil {
		return domain.User{}, fmt.Errorf("store: clear avatar version: %w", err)
	}
	if err := requireAffected(result, nil, "clear avatar version"); err != nil {
		return domain.User{}, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM user_avatars WHERE user_id = ?`, userID); err != nil {
		return domain.User{}, fmt.Errorf("store: remove avatar: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return domain.User{}, fmt.Errorf("store: commit avatar removal: %w", err)
	}
	return s.GetUserByID(ctx, userID)
}

// GetUserAvatar reads one account's picture. Deciding who may see it is the
// caller's job; this only reads it.
func (s *Store) GetUserAvatar(ctx context.Context, userID string) (string, []byte, error) {
	var contentType string
	var data []byte
	err := s.db.QueryRowContext(ctx, `SELECT content_type, data FROM user_avatars WHERE user_id = ?`, userID).Scan(&contentType, &data)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil, ErrNotFound
	}
	if err != nil {
		return "", nil, fmt.Errorf("store: read avatar: %w", err)
	}
	return contentType, data, nil
}
