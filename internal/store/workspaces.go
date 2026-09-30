package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
)

// MaxWorkspacesPerUser bounds how many workspaces one account can hold,
// unless an administrator has set it a lower limit.
const MaxWorkspacesPerUser = domain.MaxWorkspaces

var (
	// ErrWorkspaceNotEmpty: a workspace that still holds sessions can only be
	// deleted by moving them into another of the owner's workspaces.
	ErrWorkspaceNotEmpty = fmt.Errorf("%w: workspace holds sessions", ErrConflict)
	// ErrLastWorkspace: every account keeps at least one workspace.
	ErrLastWorkspace = fmt.Errorf("%w: last workspace", ErrConflict)
)

const workspaceColumns = `workspace.id, workspace.user_id, workspace.name, workspace.icon, workspace.created_at,
	workspace.updated_at, workspace.last_used_at, workspace.pinned_at,
	(SELECT COUNT(*) FROM interpretation_sessions session WHERE session.workspace_id = workspace.id)`

func scanWorkspace(row rowScanner) (domain.Workspace, error) {
	var workspace domain.Workspace
	var createdAt, updatedAt, lastUsedAt int64
	var pinnedAt sql.NullInt64
	if err := row.Scan(&workspace.ID, &workspace.UserID, &workspace.Name, &workspace.Icon, &createdAt, &updatedAt, &lastUsedAt, &pinnedAt, &workspace.SessionCount); err != nil {
		return domain.Workspace{}, mapSQLError(err)
	}
	workspace.CreatedAt = decodeTime(createdAt)
	workspace.UpdatedAt = decodeTime(updatedAt)
	workspace.LastUsedAt = decodeTime(lastUsedAt)
	workspace.PinnedAt = decodeOptionalTime(pinnedAt)
	return workspace, nil
}

// EnsureWorkspaces returns the owner's workspaces in the order they were
// created, first making sure there is one: an account that has none — new,
// or older than workspaces — gets an unnamed first workspace, and any session
// not yet kept in a workspace is placed in the one used most recently.
// newID supplies the id for a workspace that has to be created.
func (s *Store) EnsureWorkspaces(ctx context.Context, ownerID string, now time.Time, newID func() (string, error)) ([]domain.Workspace, error) {
	if ownerID == "" {
		return nil, ErrForbidden
	}
	var existing int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM workspaces WHERE user_id = ?`, ownerID).Scan(&existing); err != nil {
		return nil, fmt.Errorf("store: count workspaces: %w", err)
	}
	if existing == 0 {
		workspaceID, err := newID()
		if err != nil {
			return nil, err
		}
		// Only if there is still none: two first requests at once create one.
		if _, err := s.db.ExecContext(ctx, `
			INSERT INTO workspaces(id, user_id, name, created_at, updated_at, last_used_at)
			SELECT ?, ?, '', ?, ?, ?
			WHERE NOT EXISTS (SELECT 1 FROM workspaces WHERE user_id = ?)
				AND EXISTS (SELECT 1 FROM users WHERE id = ?)`,
			workspaceID, ownerID, encodeTime(now), encodeTime(now), encodeTime(now), ownerID, ownerID,
		); err != nil {
			return nil, fmt.Errorf("store: create first workspace: %w", mapSQLError(err))
		}
	}
	if _, err := s.db.ExecContext(ctx, `
		UPDATE interpretation_sessions SET workspace_id = (
			SELECT id FROM workspaces WHERE user_id = ? ORDER BY last_used_at DESC, created_at LIMIT 1)
		WHERE user_id = ? AND workspace_id IS NULL`, ownerID, ownerID,
	); err != nil {
		return nil, fmt.Errorf("store: place sessions in a workspace: %w", err)
	}
	return s.ListWorkspaces(ctx, ownerID)
}

// recentWorkspaceID is the owner's most recently used workspace, creating
// their first if they have none.
func (s *Store) recentWorkspaceID(ctx context.Context, ownerID string, now time.Time) (string, error) {
	if now.IsZero() {
		now = time.Now()
	}
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO workspaces(id, user_id, name, created_at, updated_at, last_used_at)
		SELECT 'wsp_' || lower(hex(randomblob(16))), ?, '', ?, ?, ?
		WHERE NOT EXISTS (SELECT 1 FROM workspaces WHERE user_id = ?)
			AND EXISTS (SELECT 1 FROM users WHERE id = ?)`,
		ownerID, encodeTime(now), encodeTime(now), encodeTime(now), ownerID, ownerID,
	); err != nil {
		return "", fmt.Errorf("store: create first workspace: %w", mapSQLError(err))
	}
	var workspaceID string
	if err := s.db.QueryRowContext(ctx, `SELECT id FROM workspaces WHERE user_id = ?
		ORDER BY last_used_at DESC, created_at LIMIT 1`, ownerID).Scan(&workspaceID); err != nil {
		return "", mapSQLError(err)
	}
	return workspaceID, nil
}

// ListWorkspaces returns only ownerID's workspaces, oldest first.
func (s *Store) ListWorkspaces(ctx context.Context, ownerID string) ([]domain.Workspace, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+workspaceColumns+`
		FROM workspaces workspace WHERE workspace.user_id = ?
		ORDER BY workspace.created_at, workspace.id`, ownerID)
	if err != nil {
		return nil, fmt.Errorf("store: list workspaces: %w", err)
	}
	defer rows.Close()
	workspaces := make([]domain.Workspace, 0)
	for rows.Next() {
		workspace, err := scanWorkspace(rows)
		if err != nil {
			return nil, fmt.Errorf("store: list workspaces: %w", err)
		}
		workspaces = append(workspaces, workspace)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list workspaces: %w", err)
	}
	return workspaces, nil
}

func (s *Store) GetWorkspace(ctx context.Context, ownerID, workspaceID string) (domain.Workspace, error) {
	return scanWorkspace(s.db.QueryRowContext(ctx, `SELECT `+workspaceColumns+`
		FROM workspaces workspace WHERE workspace.id = ? AND workspace.user_id = ?`, workspaceID, ownerID))
}

// CreateWorkspace adds a workspace for workspace.UserID, within the limit.
func (s *Store) CreateWorkspace(ctx context.Context, workspace domain.Workspace) error {
	if workspace.ID == "" || workspace.UserID == "" {
		return errors.New("store: workspace id and owner are required")
	}
	result, err := s.db.ExecContext(ctx, `
		INSERT INTO workspaces(id, user_id, name, icon, created_at, updated_at, last_used_at)
		SELECT ?, ?, ?, ?, ?, ?, ?
		WHERE (SELECT COUNT(*) FROM workspaces WHERE user_id = ?)
			< COALESCE((SELECT workspaces FROM user_limits WHERE user_id = ?),
				(SELECT workspaces FROM default_limits WHERE id = 1), ?)`,
		workspace.ID, workspace.UserID, workspace.Name, workspace.Icon, encodeTime(workspace.CreatedAt),
		encodeTime(workspace.UpdatedAt), encodeTime(workspace.LastUsedAt),
		workspace.UserID, workspace.UserID, MaxWorkspacesPerUser,
	)
	if err != nil {
		return fmt.Errorf("store: create workspace: %w", mapSQLError(err))
	}
	if count, err := result.RowsAffected(); err != nil {
		return fmt.Errorf("store: inspect workspace creation: %w", err)
	} else if count == 0 {
		return ErrCapacity
	}
	return nil
}

// UpdateWorkspace gives one of the owner's workspaces a new name and icon.
func (s *Store) UpdateWorkspace(ctx context.Context, ownerID, workspaceID, name, icon string, now time.Time) (domain.Workspace, error) {
	result, err := s.db.ExecContext(ctx, `UPDATE workspaces SET name = ?, icon = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
		name, icon, encodeTime(now), workspaceID, ownerID)
	if err != nil {
		return domain.Workspace{}, fmt.Errorf("store: update workspace: %w", mapSQLError(err))
	}
	if err := requireAffected(result, nil, "update workspace"); err != nil {
		return domain.Workspace{}, err
	}
	return s.GetWorkspace(ctx, ownerID, workspaceID)
}

// SetWorkspacePinned pins one of the owner's workspaces, or unpins it. A
// workspace pinned again keeps the time it was first pinned, so pinned ones
// keep their order.
func (s *Store) SetWorkspacePinned(ctx context.Context, ownerID, workspaceID string, pinned bool, now time.Time) (domain.Workspace, error) {
	var pinnedAt any
	if pinned {
		pinnedAt = encodeTime(now)
	}
	result, err := s.db.ExecContext(ctx, `UPDATE workspaces SET pinned_at = CASE WHEN ? IS NULL THEN NULL ELSE COALESCE(pinned_at, ?) END
		WHERE id = ? AND user_id = ?`, pinnedAt, pinnedAt, workspaceID, ownerID)
	if err := requireAffected(result, err, "pin workspace"); err != nil {
		return domain.Workspace{}, err
	}
	return s.GetWorkspace(ctx, ownerID, workspaceID)
}

// TouchWorkspace records that the owner has just used the workspace.
func (s *Store) TouchWorkspace(ctx context.Context, ownerID, workspaceID string, now time.Time) error {
	result, err := s.db.ExecContext(ctx, `UPDATE workspaces SET last_used_at = ? WHERE id = ? AND user_id = ?`,
		encodeTime(now), workspaceID, ownerID)
	if err != nil {
		return fmt.Errorf("store: use workspace: %w", err)
	}
	return requireAffected(result, nil, "use workspace")
}

// MoveInterpretationSession keeps one of the owner's sessions in another of
// their workspaces. Both must be theirs.
func (s *Store) MoveInterpretationSession(ctx context.Context, ownerID, sessionID, workspaceID string) (domain.InterpretationSession, error) {
	result, err := s.db.ExecContext(ctx, `
		UPDATE interpretation_sessions SET workspace_id = ?
		WHERE id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND user_id = ?)`,
		workspaceID, sessionID, ownerID, workspaceID, ownerID)
	if err != nil {
		return domain.InterpretationSession{}, fmt.Errorf("store: move interpretation session: %w", err)
	}
	if err := requireAffected(result, nil, "move interpretation session"); err != nil {
		return domain.InterpretationSession{}, err
	}
	return s.GetInterpretationSession(ctx, ownerID, sessionID)
}

// DeleteWorkspace removes one of the owner's workspaces. Its sessions move to
// moveTo, which must be another of the owner's workspaces; a workspace that
// holds sessions cannot be deleted without one, and the last workspace cannot
// be deleted at all. The move and the deletion happen together or not at all.
// It returns how many sessions moved.
func (s *Store) DeleteWorkspace(ctx context.Context, ownerID, workspaceID, moveTo string) (int, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("store: begin workspace deletion: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var total, sessions int
	if err := tx.QueryRowContext(ctx, `
		SELECT (SELECT COUNT(*) FROM workspaces WHERE user_id = ?),
			(SELECT COUNT(*) FROM interpretation_sessions WHERE workspace_id = ? AND user_id = ?)
		FROM workspaces WHERE id = ? AND user_id = ?`,
		ownerID, workspaceID, ownerID, workspaceID, ownerID,
	).Scan(&total, &sessions); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, ErrNotFound
		}
		return 0, fmt.Errorf("store: inspect workspace deletion: %w", err)
	}
	if total <= 1 {
		return 0, ErrLastWorkspace
	}
	if moveTo != "" {
		if moveTo == workspaceID {
			return 0, ErrConflict
		}
		var owned int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM workspaces WHERE id = ? AND user_id = ?`, moveTo, ownerID).Scan(&owned); err != nil {
			return 0, fmt.Errorf("store: inspect workspace destination: %w", err)
		}
		if owned == 0 {
			return 0, ErrNotFound
		}
		if _, err := tx.ExecContext(ctx, `UPDATE interpretation_sessions SET workspace_id = ? WHERE workspace_id = ? AND user_id = ?`,
			moveTo, workspaceID, ownerID); err != nil {
			return 0, fmt.Errorf("store: move workspace sessions: %w", err)
		}
	} else if sessions > 0 {
		return 0, ErrWorkspaceNotEmpty
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM workspaces WHERE id = ? AND user_id = ?`, workspaceID, ownerID); err != nil {
		return 0, fmt.Errorf("store: delete workspace: %w", mapSQLError(err))
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("store: commit workspace deletion: %w", err)
	}
	return sessions, nil
}
