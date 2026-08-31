package store

import (
	"context"
	"testing"
	"time"
)

func TestMasterKeyBindingRejectsReplacement(t *testing.T) {
	database, _ := newTestStore(t)
	var first [32]byte
	var replacement [32]byte
	first[0] = 1
	replacement[0] = 2
	if err := database.BindMasterKey(context.Background(), first); err != nil {
		t.Fatal(err)
	}
	if err := database.BindMasterKey(context.Background(), first); err != nil {
		t.Fatalf("same key was rejected: %v", err)
	}
	if err := database.BindMasterKey(context.Background(), replacement); err == nil {
		t.Fatal("replacement key was accepted")
	}
}

func TestWrongMasterKeyCannotTriggerLegacyInvitationRevocation(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	var correct, wrong [32]byte
	correct[0] = 11
	wrong[0] = 12
	if err := database.BindMasterKey(ctx, correct); err != nil {
		t.Fatal(err)
	}
	invitation := testInvitation("inv_legacy_key_order")
	if err := database.CreateInvitation(ctx, invitation, invitationDigest("777777")); err != nil {
		t.Fatal(err)
	}
	if err := database.BindMasterKey(ctx, wrong); err == nil {
		t.Fatal("replacement key was accepted")
	}
	stored, err := database.GetInvitationByID(ctx, invitation.ID)
	if err != nil || stored.RevokedAt != nil {
		t.Fatalf("wrong key mutated invitation: %#v, %v", stored, err)
	}
	if err := database.BindMasterKey(ctx, correct); err != nil {
		t.Fatal(err)
	}
	stored, err = database.GetInvitationByID(ctx, invitation.ID)
	if err != nil || stored.RevokedAt == nil || stored.RevocationReason != "security_upgrade" {
		t.Fatalf("verified security upgrade did not revoke legacy invite: %#v, %v", stored, err)
	}
}

func TestWrongMasterKeyCannotTriggerDestructiveUniquenessUpgrade(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	var correct, wrong [32]byte
	correct[0] = 21
	wrong[0] = 22
	if err := database.BindMasterKey(ctx, correct); err != nil {
		t.Fatal(err)
	}
	// Recreate a pre-bind/multi-process invariant: the bucket index was non-unique and
	// a historical/multi-process path could have inserted two active rows.
	if _, err := database.db.ExecContext(ctx, `
		DROP INDEX invitations_failure_bucket_v2_idx;
		CREATE INDEX invitations_failure_bucket_v2_idx
			ON invitations(failure_bucket, expires_at)
			WHERE used_at IS NULL AND revoked_at IS NULL;
		INSERT INTO invitations(id, code_hash, created_at, expires_at, failure_bucket)
			VALUES ('inv_duplicate_a', ?, ?, ?, 7), ('inv_duplicate_b', ?, ?, ?, 7)`,
		invitationDigest("111111"), encodeTime(testNow), encodeTime(testNow.Add(time.Hour)),
		invitationDigest("222222"), encodeTime(testNow.Add(time.Second)), encodeTime(testNow.Add(time.Hour)),
	); err != nil {
		t.Fatal(err)
	}
	if err := database.BindMasterKey(ctx, wrong); err == nil {
		t.Fatal("wrong key was accepted")
	}
	var active int
	if err := database.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM invitations
		WHERE failure_bucket = 7 AND used_at IS NULL AND revoked_at IS NULL`,
	).Scan(&active); err != nil {
		t.Fatal(err)
	}
	if active != 2 {
		t.Fatalf("wrong key destructively reconciled duplicate buckets: active=%d", active)
	}

	if err := database.BindMasterKey(ctx, correct); err != nil {
		t.Fatal(err)
	}
	if err := database.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM invitations
		WHERE failure_bucket = 7 AND used_at IS NULL AND revoked_at IS NULL`,
	).Scan(&active); err != nil {
		t.Fatal(err)
	}
	if active != 1 {
		t.Fatalf("verified uniqueness upgrade left %d active bucket rows", active)
	}
	if _, err := database.db.ExecContext(ctx, `
		INSERT INTO invitations(id, code_hash, created_at, expires_at, failure_bucket)
		VALUES ('inv_duplicate_c', ?, ?, ?, 7)`,
		invitationDigest("333333"), encodeTime(testNow.Add(2*time.Second)), encodeTime(testNow.Add(time.Hour)),
	); err == nil {
		t.Fatal("verified upgrade did not enforce active bucket uniqueness")
	}
}
