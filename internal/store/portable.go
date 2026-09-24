package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// FlushPortableSession rebuilds a standalone, secret-free transcript.sqlite
// from the central owner's current rows. The attached SQLite transaction
// replaces all projection tables atomically; a failed rebuild leaves the prior
// complete snapshot available. Call after finals, translations, speaker edits,
// stop and immediately before an export.
func (s *Store) FlushPortableSession(ctx context.Context, ownerID, sessionID string) error {
	if s.dataRoot == "" {
		return nil
	} // ephemeral in-memory test database
	if !safeRecordingID.MatchString(sessionID) {
		return errors.New("store: invalid portable session id")
	}
	session, err := s.GetInterpretationSession(ctx, ownerID, sessionID)
	if err != nil {
		return err
	}
	dir := filepath.Join(s.dataRoot, "sessions", sessionID)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("store: create portable session: %w", err)
	}
	if info, err := os.Lstat(dir); err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("store: unsafe portable session directory")
	}
	dest := filepath.Join(dir, "transcript.sqlite")
	if info, err := os.Lstat(dest); err == nil && (!info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0) {
		return errors.New("store: unsafe portable transcript")
	}
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	// Authorization is rechecked on the same database connection as the copy.
	var owned int
	if err := conn.QueryRowContext(ctx, `SELECT 1 FROM interpretation_sessions WHERE id=? AND user_id=?`, sessionID, ownerID).Scan(&owned); err != nil {
		return mapSQLError(err)
	}
	if _, err := conn.ExecContext(ctx, `ATTACH DATABASE ? AS portable`, dest); err != nil {
		return fmt.Errorf("store: attach portable transcript: %w", err)
	}
	defer conn.ExecContext(context.Background(), `DETACH DATABASE portable`)
	if _, err := conn.ExecContext(ctx, `PRAGMA portable.synchronous=FULL`); err != nil {
		return err
	}
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	statements := []string{
		`DROP TABLE IF EXISTS portable.session`,
		`DROP TABLE IF EXISTS portable.segments`,
		`DROP TABLE IF EXISTS portable.translations`,
		`DROP TABLE IF EXISTS portable.recordings`,
		`CREATE TABLE portable.session AS SELECT id,title,source_language,target_language,status,
      created_at,updated_at,started_at,ended_at,archived_at,recognition_languages_json,diarization
      FROM main.interpretation_sessions WHERE id=? AND user_id=?`,
		`CREATE TABLE portable.segments AS SELECT id,session_id,sequence,source_text,translation,
      translation_status,translation_error,translator_request_id,final,start_ms,end_ms,created_at,
      detected_language,language_source,speaker_id,wall0_ms,wall1_ms
      FROM main.segments WHERE session_id=? AND user_id=? ORDER BY sequence`,
		`CREATE TABLE portable.translations AS SELECT t.segment_id,t.target_language,t.status,t.text,t.error,t.request_id,t.updated_at,t.resolved_source_language,t.source_detection_json
      FROM main.segment_translations t JOIN main.segments seg ON seg.id=t.segment_id
      WHERE seg.session_id=? AND seg.user_id=? ORDER BY seg.sequence,t.target_language`,
		`CREATE TABLE portable.recordings AS SELECT id,session_id,run_id,part_index,sample_rate,
      offset_frames,frames,bytes,created_at FROM main.recording_parts
      WHERE session_id=? AND user_id=? ORDER BY created_at,part_index`,
		`CREATE UNIQUE INDEX portable.portable_segment_sequence ON segments(sequence)`,
		`CREATE INDEX portable.portable_translation_segment ON translations(segment_id,target_language)`,
	}
	for i, statement := range statements {
		var args []any
		if i >= 4 && i <= 7 {
			args = []any{sessionID, ownerID}
		}
		if _, err := tx.ExecContext(ctx, statement, args...); err != nil {
			return fmt.Errorf("store: project transcript table %d: %w", i, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: commit portable transcript: %w", err)
	}
	if _, err := conn.ExecContext(ctx, `DETACH DATABASE portable`); err != nil {
		return fmt.Errorf("store: detach portable transcript: %w", err)
	}
	if err := conn.Close(); err != nil {
		return err
	}
	if err := os.Chmod(dest, 0600); err != nil {
		return err
	}
	// Manifest is small and atomically renamed after the durable transcript.
	parts, err := s.ListRecordingParts(ctx, ownerID, sessionID)
	if err != nil {
		return err
	}
	manifest := struct {
		Format      string          `json:"format"`
		Version     int             `json:"version"`
		Session     any             `json:"session"`
		Audio       []RecordingPart `json:"audio"`
		GeneratedAt time.Time       `json:"generatedAt"`
	}{Format: "t-lingual-session", Version: 1, Session: session, Audio: parts, GeneratedAt: time.Now().UTC()}
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	temp, err := os.CreateTemp(dir, ".manifest-*")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	if err := temp.Chmod(0600); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Rename(temp.Name(), filepath.Join(dir, "manifest.json")); err != nil {
		return fmt.Errorf("store: publish session manifest: %w", err)
	}
	return nil
}
