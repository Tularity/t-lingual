package store

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
	_ "modernc.org/sqlite"
)

func TestAutoTranslationDetectionIsAtomicOwnerScopedAndTargetSpecific(t *testing.T) {
	database, session, segment, owner := translationFixture(t)
	ctx := context.Background()
	if _, _, err := database.ClaimTranslation(ctx, owner.ID, session.ID, segment.ID, "zh-Hans", testNow.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := database.ClaimTranslation(ctx, owner.ID, session.ID, segment.ID, "fr", testNow.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	detection := domain.SourceDetection{Method: "fasttext-lid.176", Confidence: .87, Rank: 2, Uncertain: true, ContextUsed: true}
	if _, err := database.FinishTranslationWithDetection(ctx, "another_user", session.ID, segment.ID, "zh-Hans", "你好", "rid", "da", detection, testNow.Add(2*time.Minute)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign translation mutation = %v", err)
	}
	if _, err := database.FinishTranslationWithDetection(ctx, owner.ID, session.ID, segment.ID, "zh-Hans", "你好", "rid", "da", domain.SourceDetection{}, testNow.Add(2*time.Minute)); err == nil {
		t.Fatal("invalid LID committed")
	}
	if _, err := database.FinishTranslationWithDetection(ctx, owner.ID, session.ID, segment.ID, "zh-Hans", "你好", "rid", "da", detection, testNow.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := database.FinishTranslationWithDetection(ctx, owner.ID, session.ID, segment.ID, "zh-Hans", "late", "rid2", "en", detection, testNow.Add(3*time.Minute)); !errors.Is(err, ErrConflict) {
		t.Fatalf("late overwrite = %v", err)
	}
	resolved, observed, err := database.GetTranslationDetection(ctx, owner.ID, session.ID, segment.ID, "zh-Hans")
	if err != nil || resolved != "da" || observed != detection {
		t.Fatalf("saved source = %q %#v %v", resolved, observed, err)
	}
	if _, _, err := database.GetTranslationDetection(ctx, "another_user", session.ID, segment.ID, "zh-Hans"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign source read = %v", err)
	}
	for _, target := range []string{"zh-Hans", "fr"} {
		presented, err := database.PresentSegments(ctx, owner.ID, session.ID, target, []domain.Segment{segment})
		if err != nil {
			t.Fatal(err)
		}
		presented, err = database.ProjectSourceDetection(ctx, owner.ID, session.ID, target, presented)
		if err != nil {
			t.Fatal(err)
		}
		if target == "zh-Hans" {
			if presented[0].DetectedLanguage != "da" || presented[0].LanguageSource != "translator" || presented[0].SourceDetection == nil || *presented[0].SourceDetection != detection {
				t.Fatalf("target projection = %#v", presented[0])
			}
		} else if presented[0].DetectedLanguage != segment.DetectedLanguage || presented[0].SourceDetection != nil {
			t.Fatalf("LID leaked to another target: %#v", presented[0])
		}
	}
	stored, err := database.ListSegments(ctx, owner.ID, session.ID)
	if err != nil || len(stored) != 1 || stored[0].LanguageSource == "translator" || stored[0].SourceDetection != nil {
		t.Fatalf("ASR source row mutated: %#v %v", stored, err)
	}
	if err := database.FlushPortableSession(ctx, owner.ID, session.ID); err != nil {
		t.Fatal(err)
	}
	portable, err := sql.Open("sqlite", filepath.Join(database.DataRoot(), "sessions", session.ID, "transcript.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer portable.Close()
	var source, encoded string
	if err := portable.QueryRow(`SELECT resolved_source_language,source_detection_json FROM translations WHERE target_language='zh-Hans'`).Scan(&source, &encoded); err != nil || source != "da" || encoded == "" {
		t.Fatalf("portable detection = %q %q %v", source, encoded, err)
	}
}
