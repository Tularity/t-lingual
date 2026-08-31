package store

import (
	"context"
	"fmt"
	"time"
)

// HandleCredentialCloneWarning permanently quarantines the credential,
// revokes every browser session, and records the counter anomaly in one
// transaction. A cloned credential must never become usable again merely by
// incrementing past the previously stored counter.
func (s *Store) HandleCredentialCloneWarning(
	ctx context.Context,
	userID string,
	credentialRecordID string,
	auditEventID string,
	now time.Time,
) error {
	if userID == "" || credentialRecordID == "" || auditEventID == "" || now.IsZero() {
		return fmt.Errorf("store: clone-warning identity, audit id, and time are required")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: begin clone-warning response: %w", err)
	}
	defer tx.Rollback()
	var exists int
	if err := tx.QueryRowContext(ctx, `
		SELECT 1 FROM webauthn_credentials WHERE id = ? AND user_id = ?`,
		credentialRecordID, userID,
	).Scan(&exists); err != nil {
		return fmt.Errorf("store: verify clone-warning credential: %w", mapSQLError(err))
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE webauthn_credentials SET compromised_at = COALESCE(compromised_at, ?)
		WHERE id = ? AND user_id = ?`, encodeTime(now), credentialRecordID, userID,
	); err != nil {
		return fmt.Errorf("store: quarantine clone-warning credential: %w", err)
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM browser_sessions WHERE user_id = ?", userID); err != nil {
		return fmt.Errorf("store: revoke sessions after clone warning: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO audit_events(
			id, actor_user_id, action, target_type, target_id, metadata_json, created_at
		) VALUES (?, NULL, 'credential.clone_warning', 'credential', ?,
			'{"reason":"signature_counter_regression"}', ?)`,
		auditEventID, credentialRecordID, encodeTime(now),
	); err != nil {
		return fmt.Errorf("store: audit clone warning: %w", mapSQLError(err))
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: commit clone-warning response: %w", err)
	}
	return nil
}
