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
	Title          string `json:"title"`
	SourceLanguage string `json:"sourceLanguage"`
	TargetLanguage string `json:"targetLanguage"`
}

type UpdateInput struct {
	Title          string `json:"title"`
	SourceLanguage string `json:"sourceLanguage"`
	TargetLanguage string `json:"targetLanguage"`
}

func (s *Service) Create(ctx context.Context, ownerID string, input CreateInput) (domain.InterpretationSession, error) {
	if ownerID == "" {
		return domain.InterpretationSession{}, store.ErrForbidden
	}
	input.Title = strings.TrimSpace(input.Title)
	input.SourceLanguage = strings.TrimSpace(input.SourceLanguage)
	input.TargetLanguage = strings.TrimSpace(input.TargetLanguage)
	if input.Title == "" {
		input.Title = "Untitled interpretation"
	}
	if err := validateTitle(input.Title); err != nil {
		return domain.InterpretationSession{}, err
	}
	sourceLanguage, targetLanguage, err := normalizeLanguages(input.SourceLanguage, input.TargetLanguage)
	if err != nil {
		return domain.InterpretationSession{}, err
	}
	sessionID, err := id.New("int")
	if err != nil {
		return domain.InterpretationSession{}, err
	}
	now := s.now().UTC()
	session := domain.InterpretationSession{
		ID:             sessionID,
		UserID:         ownerID,
		Title:          input.Title,
		SourceLanguage: sourceLanguage,
		TargetLanguage: targetLanguage,
		Status:         domain.InterpretationCreated,
		CreatedAt:      now,
		UpdatedAt:      now,
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
	input.Title = strings.TrimSpace(input.Title)
	input.SourceLanguage = strings.TrimSpace(input.SourceLanguage)
	input.TargetLanguage = strings.TrimSpace(input.TargetLanguage)
	if err := validateTitle(input.Title); err != nil {
		return domain.InterpretationSession{}, err
	}
	sourceLanguage, targetLanguage, err := normalizeLanguages(input.SourceLanguage, input.TargetLanguage)
	if err != nil {
		return domain.InterpretationSession{}, err
	}
	updated, err := s.store.UpdateInterpretationSessionMetadata(
		ctx, ownerID, sessionID, input.Title, sourceLanguage,
		targetLanguage, s.now().UTC(),
	)
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

func (s *Service) SegmentPage(
	ctx context.Context,
	ownerID string,
	sessionID string,
	afterSequence int64,
	limit int,
) (store.SegmentPage, error) {
	return s.store.ListSegmentsPage(ctx, ownerID, sessionID, afterSequence, limit)
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
	sourceLanguage, targetLanguage, err := normalizeLanguages(settings.DefaultSourceLanguage, settings.DefaultTargetLanguage)
	if err != nil {
		return domain.UserSettings{}, fmt.Errorf("%w: %v", ErrInvalidSettings, err)
	}
	settings.DefaultSourceLanguage = sourceLanguage
	settings.DefaultTargetLanguage = targetLanguage
	if err := s.store.UpsertUserSettings(ctx, settings); err != nil {
		return domain.UserSettings{}, err
	}
	return settings, nil
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
	canonicalSource, err := language.CanonicalizeSource(source)
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
