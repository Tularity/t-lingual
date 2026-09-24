package store

import (
	"context"
	"time"
)

const providerSettingsKey = "provider_endpoints_v1"

func (s *Store) ProviderSettings(ctx context.Context) ([]byte, error) {
	var data []byte
	err := s.db.QueryRowContext(ctx, "SELECT value FROM application_metadata WHERE key = ?", providerSettingsKey).Scan(&data)
	return data, mapSQLError(err)
}

func (s *Store) SaveProviderSettingsAsAdmin(ctx context.Context, userID, browserID string, data []byte) error {
	authority, err := webAdminMutationAuthority(userID, browserID, time.Now().UTC())
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := requireAdminMutationAuthority(ctx, tx, authority); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO application_metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", providerSettingsKey, data); err != nil {
		return err
	}
	return commitAdminMutation(ctx, tx, "provider settings")
}
