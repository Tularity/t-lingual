package store

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

const masterKeyVerifierName = "master_key_verifier_v1"

// BindMasterKey initializes the database's non-secret key verifier once and
// rejects a different key on every subsequent start. This prevents silent data
// loss when an operator replaces or forgets to mount master.key.
func (s *Store) BindMasterKey(ctx context.Context, verifier [32]byte) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: begin master key verification: %w", err)
	}
	defer tx.Rollback()
	var stored []byte
	err = tx.QueryRowContext(ctx,
		"SELECT value FROM application_metadata WHERE key = ?", masterKeyVerifierName,
	).Scan(&stored)
	if errors.Is(err, sql.ErrNoRows) {
		if _, err := tx.ExecContext(ctx,
			"INSERT INTO application_metadata(key, value) VALUES (?, ?)",
			masterKeyVerifierName, verifier[:],
		); err != nil {
			return fmt.Errorf("store: initialize master key verifier: %w", err)
		}
	} else if err != nil {
		return fmt.Errorf("store: read master key verifier: %w", err)
	} else if len(stored) != len(verifier) || subtle.ConstantTimeCompare(stored, verifier[:]) != 1 {
		return errors.New("store: configured master key does not match this database")
	}

	// Security upgrades that can revoke or delete rows happen only after key
	// verification succeeds. Open/migrate intentionally remains non-destructive
	// so an accidentally mounted key can never mutate a recoverable database.
	upgradeAt := encodeTime(time.Now().UTC())
	if _, err := tx.ExecContext(ctx, `
		UPDATE invitations
		SET revoked_at = ?, revocation_reason = 'security_upgrade'
		WHERE used_at IS NULL AND revoked_at IS NULL AND failure_bucket IS NULL`,
		upgradeAt,
	); err != nil {
		return fmt.Errorf("store: revoke legacy-bucket invitations after key verification: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE invitations
		SET revoked_at = ?, revocation_reason = 'security_upgrade'
		WHERE id IN (
			SELECT id FROM (
				SELECT id, ROW_NUMBER() OVER (
					PARTITION BY failure_bucket ORDER BY created_at, id
				) AS bucket_rank
				FROM invitations
				WHERE failure_bucket IS NOT NULL AND used_at IS NULL AND revoked_at IS NULL
			) WHERE bucket_rank > 1
		)`, upgradeAt,
	); err != nil {
		return fmt.Errorf("store: reconcile duplicate invitation buckets after key verification: %w", err)
	}
	if _, err := tx.ExecContext(ctx, "DROP INDEX IF EXISTS invitations_failure_bucket_idx"); err != nil {
		return fmt.Errorf("store: replace invitation bucket index: %w", err)
	}
	if _, err := tx.ExecContext(ctx, "DROP INDEX IF EXISTS invitations_failure_bucket_v2_idx"); err != nil {
		return fmt.Errorf("store: replace expanded invitation bucket index: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		CREATE UNIQUE INDEX invitations_failure_bucket_v2_idx
		ON invitations(failure_bucket)
		WHERE failure_bucket IS NOT NULL AND used_at IS NULL AND revoked_at IS NULL`); err != nil {
		return fmt.Errorf("store: enforce active invitation bucket uniqueness: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM action_grants
		WHERE id IN (
			SELECT id FROM (
				SELECT id, ROW_NUMBER() OVER (
					PARTITION BY browser_session_id, action
					ORDER BY created_at DESC, id DESC
				) AS grant_rank
				FROM action_grants
			) WHERE grant_rank > 1
		)`); err != nil {
		return fmt.Errorf("store: reconcile duplicate action grants after key verification: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		CREATE UNIQUE INDEX IF NOT EXISTS action_grants_session_action_unique
		ON action_grants(browser_session_id, action)`); err != nil {
		return fmt.Errorf("store: enforce action grant uniqueness: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: finish master key verification: %w", err)
	}
	return nil
}
