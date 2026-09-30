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
	// AvatarVersion changes whenever the person's picture does; zero means
	// they have none and are shown by their initials.
	AvatarVersion int64 `json:"avatarVersion,omitempty"`
	// Discoverable people can be found by name when others share a session;
	// everyone else is reached only through a link they are given.
	Discoverable bool `json:"discoverable"`
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
	// WorkspaceID is the owner's workspace the session is kept in. It is the
	// owner's own organisation, so it is never shown to anyone else.
	WorkspaceID string `json:"workspaceId,omitempty"`
}

// Workspace is one of a user's own collections of sessions. Every user has at
// least one; the first is created for them and has no name until they give it
// one (the interface shows its own words for it).
type Workspace struct {
	ID     string `json:"id"`
	UserID string `json:"-"`
	Name   string `json:"name"`
	// Icon names the icon the workspace is shown with; empty is the default.
	Icon       string    `json:"icon"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
	LastUsedAt time.Time `json:"lastUsedAt"`
	// PinnedAt is when the owner pinned it; pinned workspaces come first.
	PinnedAt     *time.Time `json:"pinnedAt"`
	SessionCount int        `json:"sessionCount"`
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

// ShareAudience says who a link lets in.
type ShareAudience string

const (
	// ShareAnyone lets in whoever holds the link, signed in or not.
	ShareAnyone ShareAudience = "anyone"
	// ShareMembers lets in only people signed in to an account here; each
	// becomes a member of the link and keeps access until it ends.
	ShareMembers ShareAudience = "members"
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
	Audience        ShareAudience   `json:"audience,omitempty"`
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
	AvatarVersion    int64  `json:"avatarVersion,omitempty"`
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

// UserLimits are what one account may use of the shared service. A zero
// MonthlyRecordingMinutes or StorageMB means no limit of that kind.
type UserLimits struct {
	// ConcurrentRecordings counts every recording of the account's own
	// sessions, including those someone it shared with is recording.
	ConcurrentRecordings    int  `json:"concurrentRecordings"`
	MonthlyRecordingMinutes int  `json:"monthlyRecordingMinutes"`
	StorageMB               int  `json:"storageMb"`
	Workspaces              int  `json:"workspaces"`
	GuestLinks              bool `json:"guestLinks"`
}

// DefaultUserLimits apply to every account an administrator has not set
// apart, until an administrator changes the defaults themselves.
var DefaultUserLimits = UserLimits{ConcurrentRecordings: 1, Workspaces: 100, GuestLinks: true}

// Bounds of what an administrator may set.
const (
	MaxConcurrentRecordings    = 16
	MaxMonthlyRecordingMinutes = 1_000_000
	MaxStorageMB               = 10_000_000
	MaxWorkspaces              = 100
)

// LimitOverrides set one account apart from the defaults; a nil field keeps
// the default for that limit.
type LimitOverrides struct {
	ConcurrentRecordings    *int  `json:"concurrentRecordings"`
	MonthlyRecordingMinutes *int  `json:"monthlyRecordingMinutes"`
	StorageMB               *int  `json:"storageMb"`
	Workspaces              *int  `json:"workspaces"`
	GuestLinks              *bool `json:"guestLinks"`
}

// Valid reports whether every limit is within its bounds.
func (l UserLimits) Valid() bool {
	within := func(value, low, high int) bool { return value >= low && value <= high }
	return within(l.ConcurrentRecordings, 1, MaxConcurrentRecordings) &&
		within(l.MonthlyRecordingMinutes, 0, MaxMonthlyRecordingMinutes) &&
		within(l.StorageMB, 0, MaxStorageMB) &&
		within(l.Workspaces, 1, MaxWorkspaces)
}

// Valid reports whether every set limit is within its bounds.
func (o LimitOverrides) Valid() bool {
	within := func(value *int, low, high int) bool { return value == nil || (*value >= low && *value <= high) }
	return within(o.ConcurrentRecordings, 1, MaxConcurrentRecordings) &&
		within(o.MonthlyRecordingMinutes, 0, MaxMonthlyRecordingMinutes) &&
		within(o.StorageMB, 0, MaxStorageMB) &&
		within(o.Workspaces, 1, MaxWorkspaces)
}

// Apply is the limits in effect: each override, or else its default.
func (o LimitOverrides) Apply(defaults UserLimits) UserLimits {
	limits := defaults
	if o.ConcurrentRecordings != nil {
		limits.ConcurrentRecordings = *o.ConcurrentRecordings
	}
	if o.MonthlyRecordingMinutes != nil {
		limits.MonthlyRecordingMinutes = *o.MonthlyRecordingMinutes
	}
	if o.StorageMB != nil {
		limits.StorageMB = *o.StorageMB
	}
	if o.Workspaces != nil {
		limits.Workspaces = *o.Workspaces
	}
	if o.GuestLinks != nil {
		limits.GuestLinks = *o.GuestLinks
	}
	return limits
}

// RecognitionGapState is how far the recognition of an interrupted stretch
// of a recording has got.
type RecognitionGapState string

const (
	GapPending RecognitionGapState = "pending"
	GapFilling RecognitionGapState = "filling"
	GapFilled  RecognitionGapState = "filled"
	GapFailed  RecognitionGapState = "failed"
)

// RecognitionGap is a stretch of recorded audio that recognition missed while
// it was unavailable. Its lines are recognized later from the saved audio and
// take the sequence numbers kept free for them, so they read in their place.
type RecognitionGap struct {
	ID             string              `json:"id"`
	SessionID      string              `json:"sessionId"`
	UserID         string              `json:"-"`
	StartMS        int64               `json:"startMs"`
	EndMS          int64               `json:"endMs"`
	SequenceFrom   int64               `json:"sequenceFrom"`
	SequenceTo     int64               `json:"sequenceTo"`
	State          RecognitionGapState `json:"state"`
	Attempts       int                 `json:"attempts"`
	FilledSegments int                 `json:"filledSegments"`
	LastError      string              `json:"-"`
	CreatedAt      time.Time           `json:"createdAt"`
	UpdatedAt      time.Time           `json:"updatedAt"`
}
