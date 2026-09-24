// Package workspace owns personal interpretation sessions and preferences.
// Every store call takes the authenticated owner ID so authorization cannot be
// accidentally omitted by an HTTP handler.
package workspace

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/id"
	"github.com/Tularity/t-lingual/internal/language"
	"github.com/Tularity/t-lingual/internal/store"
)

var (
	ErrInvalidSession  = errors.New("workspace: invalid session")
	ErrSessionLive     = errors.New("workspace: live session cannot be changed")
	ErrSessionArchived = errors.New("workspace: archived session is read-only")
	ErrInvalidSettings = errors.New("workspace: invalid settings")
	ErrQuota           = errors.New("workspace: storage quota exhausted")
)

type Service struct {
	store *store.Store
	now   func() time.Time
}

func New(database *store.Store) (*Service, error) {
	if database == nil {
		return nil, errors.New("workspace store is required")
	}
	return &Service{store: database, now: time.Now}, nil
}

type CreateInput struct {
	Title                string   `json:"title"`
	SourceLanguage       string   `json:"sourceLanguage"`
	TargetLanguage       string   `json:"targetLanguage"`
	RecognitionLanguages []string `json:"recognitionLanguages"`
	Diarization          bool     `json:"diarization"`
}

type UpdateInput struct {
	Title                string   `json:"title"`
	SourceLanguage       string   `json:"sourceLanguage"`
	TargetLanguage       string   `json:"targetLanguage"`
	RecognitionLanguages []string `json:"recognitionLanguages"`
	Diarization          *bool    `json:"diarization"`
}

func (s *Service) Create(ctx context.Context, ownerID string, input CreateInput) (domain.InterpretationSession, error) {
	if ownerID == "" {
		return domain.InterpretationSession{}, store.ErrForbidden
	}
	input.Title = strings.TrimSpace(input.Title)
	input.SourceLanguage = strings.TrimSpace(input.SourceLanguage)
	input.TargetLanguage = strings.TrimSpace(input.TargetLanguage)
	if input.SourceLanguage == "" || input.TargetLanguage == "" {
		settings, err := s.store.GetUserSettings(ctx, ownerID)
		if err != nil {
			return domain.InterpretationSession{}, err
		}
		if input.SourceLanguage == "" {
			input.SourceLanguage = settings.DefaultSourceLanguage
		}
		if input.TargetLanguage == "" {
			input.TargetLanguage = settings.DefaultTargetLanguage
		}
	}
	if input.Title == "" {
		input.Title = "Untitled interpretation"
	}
	if err := validateTitle(input.Title); err != nil {
		return domain.InterpretationSession{}, err
	}
	sourceLanguage, targetLanguage, recognition, err := normalizeRecordingLanguages(input.SourceLanguage, input.TargetLanguage, input.RecognitionLanguages)
	if err != nil {
		return domain.InterpretationSession{}, err
	}
	sessionID, err := id.New("int")
	if err != nil {
		return domain.InterpretationSession{}, err
	}
	now := s.now().UTC()
	session := domain.InterpretationSession{
		ID:                   sessionID,
		UserID:               ownerID,
		Title:                input.Title,
		SourceLanguage:       sourceLanguage,
		TargetLanguage:       targetLanguage,
		RecognitionLanguages: recognition,
		Diarization:          true,
		Status:               domain.InterpretationCreated,
		CreatedAt:            now,
		UpdatedAt:            now,
	}
	if err := s.store.CreateInterpretationSession(ctx, session); err != nil {
		if errors.Is(err, store.ErrCapacity) {
			return domain.InterpretationSession{}, ErrQuota
		}
		return domain.InterpretationSession{}, err
	}
	return session, nil
}

func (s *Service) Get(ctx context.Context, ownerID, sessionID string) (domain.InterpretationSession, error) {
	return s.store.GetInterpretationSession(ctx, ownerID, sessionID)
}

func (s *Service) List(ctx context.Context, ownerID string, status *domain.InterpretationStatus, limit, offset int) ([]domain.InterpretationSession, error) {
	return s.store.ListInterpretationSessions(ctx, ownerID, status, limit, offset)
}

func (s *Service) Update(ctx context.Context, ownerID, sessionID string, input UpdateInput) (domain.InterpretationSession, error) {
	current, err := s.store.GetInterpretationSession(ctx, ownerID, sessionID)
	if err != nil {
		return domain.InterpretationSession{}, err
	}
	input.Title = strings.TrimSpace(input.Title)
	input.SourceLanguage = strings.TrimSpace(input.SourceLanguage)
	input.TargetLanguage = strings.TrimSpace(input.TargetLanguage)
	sourceChanged := input.SourceLanguage != "" && input.SourceLanguage != current.SourceLanguage
	if input.SourceLanguage == "" {
		input.SourceLanguage = current.SourceLanguage
	}
	if input.TargetLanguage == "" {
		input.TargetLanguage = current.TargetLanguage
	}
	if input.RecognitionLanguages == nil && !sourceChanged {
		input.RecognitionLanguages = current.RecognitionLanguages
	}
	// Existing transcript rows remain untouched. Every new or reconfigured
	// recording keeps speaker attribution enabled, including legacy clients
	// that still send diarization:false.
	diarization := true
	if err := validateTitle(input.Title); err != nil {
		return domain.InterpretationSession{}, err
	}
	sourceLanguage, targetLanguage, recognition, err := normalizeRecordingLanguages(input.SourceLanguage, input.TargetLanguage, input.RecognitionLanguages)
	if err != nil {
		return domain.InterpretationSession{}, err
	}
	updated, err := s.store.UpdateInterpretationSessionConfiguration(
		ctx, ownerID, sessionID, input.Title, sourceLanguage,
		targetLanguage, recognition, diarization, s.now().UTC(),
	)
	if errors.Is(err, store.ErrArchived) {
		return domain.InterpretationSession{}, ErrSessionArchived
	}
	if errors.Is(err, store.ErrConflict) {
		return domain.InterpretationSession{}, ErrSessionLive
	}
	if err != nil {
		return domain.InterpretationSession{}, err
	}
	return updated, nil
}

func (s *Service) Delete(ctx context.Context, ownerID, sessionID string) error {
	err := s.store.DeleteInterpretationSessionIfNotLive(ctx, ownerID, sessionID)
	if errors.Is(err, store.ErrConflict) {
		return ErrSessionLive
	}
	return err
}

func (s *Service) Archive(ctx context.Context, ownerID, sessionID string) (domain.InterpretationSession, error) {
	if ownerID == "" {
		return domain.InterpretationSession{}, store.ErrForbidden
	}
	session, err := s.store.ArchiveInterpretationSession(ctx, ownerID, sessionID, s.now().UTC())
	if errors.Is(err, store.ErrConflict) {
		return domain.InterpretationSession{}, ErrSessionLive
	}
	return session, err
}

func (s *Service) Unarchive(ctx context.Context, ownerID, sessionID string) (domain.InterpretationSession, error) {
	if ownerID == "" {
		return domain.InterpretationSession{}, store.ErrForbidden
	}
	return s.store.UnarchiveInterpretationSession(ctx, ownerID, sessionID, s.now().UTC())
}

func (s *Service) SegmentPage(
	ctx context.Context,
	ownerID string,
	sessionID string,
	afterSequence int64,
	limit int,
) (store.SegmentPage, error) {
	return s.store.ListSegmentsPage(ctx, ownerID, sessionID, afterSequence, limit)
}

func (s *Service) SegmentWindow(
	ctx context.Context,
	ownerID string,
	sessionID string,
	query store.SegmentPageQuery,
) (store.SegmentPage, error) {
	return s.store.ListSegmentsWindow(ctx, ownerID, sessionID, query)
}

func (s *Service) Settings(ctx context.Context, ownerID string) (domain.UserSettings, error) {
	settings, err := s.store.GetUserSettings(ctx, ownerID)
	if err != nil {
		return domain.UserSettings{}, err
	}
	sourceLanguage, targetLanguage, err := normalizeLanguages(
		settings.DefaultSourceLanguage, settings.DefaultTargetLanguage,
	)
	if err != nil {
		return domain.UserSettings{}, fmt.Errorf("%w: stored language preference: %v", ErrInvalidSettings, err)
	}
	settings.DefaultSourceLanguage = sourceLanguage
	settings.DefaultTargetLanguage = targetLanguage
	return settings, nil
}

func (s *Service) UpdateSettings(ctx context.Context, ownerID string, settings domain.UserSettings) (domain.UserSettings, error) {
	settings.UserID = ownerID
	if settings.AutoArchiveHours < 0 || settings.AutoArchiveHours > 8760 {
		return domain.UserSettings{}, fmt.Errorf("%w: auto archive hours must be between 0 and 8760", ErrInvalidSettings)
	}
	sourceLanguage, targetLanguage, err := normalizeLanguages(settings.DefaultSourceLanguage, settings.DefaultTargetLanguage)
	if err != nil {
		return domain.UserSettings{}, fmt.Errorf("%w: %v", ErrInvalidSettings, err)
	}
	settings.DefaultSourceLanguage = sourceLanguage
	settings.DefaultTargetLanguage = targetLanguage
	if err := s.store.UpsertUserSettings(ctx, settings); err != nil {
		return domain.UserSettings{}, err
	}
	return s.Settings(ctx, ownerID)
}

func validateTitle(value string) error {
	if value == "" || !utf8.ValidString(value) {
		return fmt.Errorf("%w: title is required", ErrInvalidSession)
	}
	count := 0
	for _, character := range value {
		if unicode.IsControl(character) {
			return fmt.Errorf("%w: title contains a control character", ErrInvalidSession)
		}
		count++
	}
	if count > 120 {
		return fmt.Errorf("%w: title exceeds 120 characters", ErrInvalidSession)
	}
	return nil
}

func normalizeLanguages(source, target string) (string, string, error) {
	canonicalSource, err := language.CanonicalizeRecognition(source)
	if err != nil {
		return "", "", fmt.Errorf("%w: invalid source language", ErrInvalidSession)
	}
	canonicalTarget, err := language.Canonicalize(target)
	if err != nil {
		return "", "", fmt.Errorf("%w: invalid target language", ErrInvalidSession)
	}
	if canonicalSource == canonicalTarget {
		return "", "", fmt.Errorf("%w: source and target languages must differ", ErrInvalidSession)
	}
	return canonicalSource, canonicalTarget, nil
}

func normalizeRecordingLanguages(source, target string, selected []string) (string, string, []string, error) {
	canonicalSource, err := language.CanonicalizeRecognition(source)
	if err != nil {
		return "", "", nil, fmt.Errorf("%w: invalid source language", ErrInvalidSession)
	}
	canonicalTarget, err := language.Canonicalize(target)
	if err != nil {
		return "", "", nil, fmt.Errorf("%w: invalid target language", ErrInvalidSession)
	}
	if len(selected) > 46 {
		return "", "", nil, fmt.Errorf("%w: too many recognition languages", ErrInvalidSession)
	}
	recognition := make([]string, 0, len(selected))
	seen := make(map[string]bool, len(selected))
	for _, code := range selected {
		canonical, err := language.CanonicalizeRecognition(code)
		if err != nil || canonical == "auto" || seen[canonical] {
			return "", "", nil, fmt.Errorf("%w: invalid or duplicate recognition language", ErrInvalidSession)
		}
		seen[canonical] = true
		recognition = append(recognition, canonical)
	}
	if len(recognition) > 1 {
		canonicalSource = "auto"
	} else if len(recognition) == 1 && canonicalSource != "auto" && recognition[0] != canonicalSource {
		return "", "", nil, fmt.Errorf("%w: spoken and recognition languages differ", ErrInvalidSession)
	} else if len(recognition) == 0 && canonicalSource != "auto" {
		recognition = append(recognition, canonicalSource)
	}
	return canonicalSource, canonicalTarget, recognition, nil
}
