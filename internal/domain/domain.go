package domain

import "time"

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
	ID             string               `json:"id"`
	UserID         string               `json:"-"`
	Title          string               `json:"title"`
	SourceLanguage string               `json:"sourceLanguage"`
	TargetLanguage string               `json:"targetLanguage"`
	Status         InterpretationStatus `json:"status"`
	CreatedAt      time.Time            `json:"createdAt"`
	UpdatedAt      time.Time            `json:"updatedAt"`
	StartedAt      *time.Time           `json:"startedAt"`
	EndedAt        *time.Time           `json:"endedAt"`
}

type Segment struct {
	ID                  string            `json:"id"`
	SessionID           string            `json:"sessionId"`
	UserID              string            `json:"-"`
	Sequence            int64             `json:"sequence"`
	SourceText          string            `json:"sourceText"`
	Translation         string            `json:"translation"`
	TranslationStatus   TranslationStatus `json:"translationStatus"`
	TranslationError    string            `json:"translationError,omitempty"`
	TranslatorRequestID string            `json:"translatorRequestId,omitempty"`
	Final               bool              `json:"final"`
	StartMS             int64             `json:"startMs"`
	EndMS               int64             `json:"endMs"`
	CreatedAt           time.Time         `json:"createdAt"`
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
	DefaultSourceLanguage   string `json:"defaultSourceLanguage"`
	DefaultTargetLanguage   string `json:"defaultTargetLanguage"`
	AutoStartMicrophone     bool   `json:"autoStartMicrophone"`
	ShowPartialTranscripts  bool   `json:"showPartialTranscripts"`
	CompactTranscriptLayout bool   `json:"compactTranscriptLayout"`
}

func DefaultUserSettings(userID string) UserSettings {
	return UserSettings{
		UserID:                 userID,
		DefaultSourceLanguage:  "auto",
		DefaultTargetLanguage:  "en",
		ShowPartialTranscripts: true,
	}
}
