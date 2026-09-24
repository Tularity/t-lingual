package domain

import (
	"encoding/json"
	"time"
)

type Role string

const (
	RoleUser  Role = "user"
	RoleAdmin Role = "admin"
)

func (r Role) Valid() bool { return r == RoleUser || r == RoleAdmin }

type UserStatus string

const (
	UserActive   UserStatus = "active"
	UserDisabled UserStatus = "disabled"
)

type User struct {
	ID          string     `json:"id"`
	WebAuthnID  []byte     `json:"-"`
	Username    string     `json:"username"`
	DisplayName string     `json:"displayName"`
	Role        Role       `json:"role"`
	Status      UserStatus `json:"status"`
	CreatedAt   time.Time  `json:"createdAt"`
	UpdatedAt   time.Time  `json:"updatedAt"`
}

type Credential struct {
	ID             string     `json:"id"`
	UserID         string     `json:"userId"`
	CredentialID   []byte     `json:"-"`
	Name           string     `json:"name"`
	CredentialJSON []byte     `json:"-"`
	CreatedAt      time.Time  `json:"createdAt"`
	LastUsedAt     *time.Time `json:"lastUsedAt"`
	CompromisedAt  *time.Time `json:"compromisedAt,omitempty"`
}

type Invitation struct {
	ID               string     `json:"id"`
	Kind             string     `json:"kind"`
	TargetUserID     string     `json:"targetUserId,omitempty"`
	NotBefore        time.Time  `json:"notBefore"`
	CreatedBy        *string    `json:"createdBy"`
	CreatedAt        time.Time  `json:"createdAt"`
	ExpiresAt        time.Time  `json:"expiresAt"`
	UsedAt           *time.Time `json:"usedAt"`
	UsedBy           *string    `json:"usedBy"`
	RevokedAt        *time.Time `json:"revokedAt"`
	RevocationReason string     `json:"revocationReason,omitempty"`
}

type BrowserSession struct {
	ID        string    `json:"id"`
	UserID    string    `json:"userId"`
	CreatedAt time.Time `json:"createdAt"`
	ExpiresAt time.Time `json:"expiresAt"`
	LastSeen  time.Time `json:"lastSeen"`
	UserAgent string    `json:"userAgent"`
	IPAddress string    `json:"ipAddress"`
}

type InterpretationStatus string

const (
	InterpretationCreated   InterpretationStatus = "created"
	InterpretationLive      InterpretationStatus = "live"
	InterpretationCompleted InterpretationStatus = "completed"
	InterpretationFailed    InterpretationStatus = "failed"
)

type InterpretationSession struct {
	ID                   string               `json:"id"`
	UserID               string               `json:"-"`
	Title                string               `json:"title"`
	SourceLanguage       string               `json:"sourceLanguage"`
	TargetLanguage       string               `json:"targetLanguage"`
	Status               InterpretationStatus `json:"status"`
	CreatedAt            time.Time            `json:"createdAt"`
	UpdatedAt            time.Time            `json:"updatedAt"`
	StartedAt            *time.Time           `json:"startedAt"`
	EndedAt              *time.Time           `json:"endedAt"`
	ArchivedAt           *time.Time           `json:"archivedAt"`
	ArchiveReason        string               `json:"archiveReason,omitempty"`
	RecognitionLanguages []string             `json:"recognitionLanguages"`
	Diarization          bool                 `json:"diarization"`
}

type Segment struct {
	ID                  string            `json:"id"`
	SessionID           string            `json:"sessionId"`
	UserID              string            `json:"-"`
	Sequence            int64             `json:"sequence"`
	SourceText          string            `json:"sourceText"`
	Translation         string            `json:"translation"`
	TranslationStatus   TranslationStatus `json:"translationStatus"`
	TranslationRevision int64             `json:"translationRevision,omitempty"`
	TranslationError    string            `json:"translationError,omitempty"`
	TranslatorRequestID string            `json:"translatorRequestId,omitempty"`
	Final               bool              `json:"final"`
	StartMS             int64             `json:"startMs"`
	EndMS               int64             `json:"endMs"`
	CreatedAt           time.Time         `json:"createdAt"`
	LanguageSource      string            `json:"languageSource,omitempty"`
	DetectedLanguage    string            `json:"detectedLanguage,omitempty"`
	SourceDetection     *SourceDetection  `json:"sourceDetection,omitempty"`
	SpeakerID           string            `json:"speakerId,omitempty"`
	Wall0MS             int64             `json:"wall0Ms,omitempty"`
	Wall1MS             int64             `json:"wall1Ms,omitempty"`
}

// SourceDetection is the Translator's validated auto-LID decision, scoped to
// one target-language translation rather than the immutable ASR source row.
type SourceDetection struct {
	Method      string  `json:"method"`
	Confidence  float64 `json:"confidence"`
	Rank        uint8   `json:"rank"`
	Uncertain   bool    `json:"uncertain"`
	ContextUsed bool    `json:"contextUsed"`
}

type ShareKind string

const (
	ShareUser ShareKind = "user"
	ShareLink ShareKind = "link"
)

type SharePermission string

const (
	ShareView   SharePermission = "view"
	ShareRecord SharePermission = "record"
)

type SessionShare struct {
	ID              string          `json:"id"`
	SessionID       string          `json:"sessionId"`
	OwnerUserID     string          `json:"-"`
	Kind            ShareKind       `json:"kind"`
	Permission      SharePermission `json:"permission"`
	RecipientUserID *string         `json:"recipientUserId,omitempty"`
	CreatedAt       time.Time       `json:"createdAt"`
	ExpiresAt       *time.Time      `json:"expiresAt"`
	RevokedAt       *time.Time      `json:"revokedAt"`
}

type GuestSession struct {
	ID             string    `json:"id"`
	ShareID        string    `json:"shareId"`
	SessionID      string    `json:"sessionId"`
	DisplayName    string    `json:"displayName"`
	TargetLanguage string    `json:"targetLanguage"`
	CreatedAt      time.Time `json:"createdAt"`
	ExpiresAt      time.Time `json:"expiresAt"`
}

type Viewer struct {
	ID               string `json:"id"`
	UserID           string `json:"userId,omitempty"`
	BrowserSessionID string `json:"-"`
	GuestID          string `json:"guestId,omitempty"`
	DisplayName      string `json:"displayName"`
}

type SessionAccess struct {
	Session        InterpretationSession `json:"session"`
	Viewer         Viewer                `json:"viewer"`
	Permission     SharePermission       `json:"permission"`
	IsOwner        bool                  `json:"isOwner"`
	TargetLanguage string                `json:"targetLanguage"`
	ShareID        string                `json:"shareId,omitempty"`
}

type ProviderEndpoint struct {
	ID               string          `json:"id"`
	UserID           string          `json:"-"`
	Provider         string          `json:"provider"`
	Name             string          `json:"name"`
	BaseURL          string          `json:"baseUrl"`
	CredentialSealed []byte          `json:"-"`
	HasCredential    bool            `json:"hasCredential"`
	Configuration    json.RawMessage `json:"configuration"`
	Enabled          bool            `json:"enabled"`
	CreatedAt        time.Time       `json:"createdAt"`
	UpdatedAt        time.Time       `json:"updatedAt"`
}

type TranslationStatus string

const (
	TranslationNotRequested TranslationStatus = "not_requested"
	TranslationPending      TranslationStatus = "pending"
	TranslationSucceeded    TranslationStatus = "succeeded"
	TranslationFailed       TranslationStatus = "failed"
)

func (s TranslationStatus) Valid() bool {
	return s == TranslationNotRequested || s == TranslationPending || s == TranslationSucceeded || s == TranslationFailed
}

type UserSettings struct {
	UserID                  string `json:"-"`
	OnboardingComplete      bool   `json:"onboardingComplete"`
	DefaultSourceLanguage   string `json:"defaultSourceLanguage"`
	DefaultTargetLanguage   string `json:"defaultTargetLanguage"`
	AutoStartMicrophone     bool   `json:"autoStartMicrophone"`
	ShowPartialTranscripts  bool   `json:"showPartialTranscripts"`
	CompactTranscriptLayout bool   `json:"compactTranscriptLayout"`
	AutoArchiveHours        int    `json:"autoArchiveHours"`
	InterfaceLanguage       string `json:"interfaceLanguage"`
	ThemePreference         string `json:"themePreference"`
}

func DefaultUserSettings(userID string) UserSettings {
	return UserSettings{
		UserID:                 userID,
		DefaultSourceLanguage:  "auto",
		DefaultTargetLanguage:  "en",
		ShowPartialTranscripts: true,
		AutoArchiveHours:       24,
		InterfaceLanguage:      "system",
		ThemePreference:        "system",
	}
}
