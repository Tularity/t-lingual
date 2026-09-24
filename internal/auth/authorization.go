package auth

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/id"
	"github.com/Tularity/t-lingual/internal/store"
)

const (
	// AuthorizationScopePasskeyManagement is the backwards-compatible default
	// scope used when a passkey authorization ceremony omits a scope.
	AuthorizationScopePasskeyManagement  = store.ActionPasskeyManagement
	AuthorizationScopeRecoveryPasskeyAdd = "passkeys:add"

	authorizationTokenVersion = "tlpa1"
	maxAuthorizationScopeLen  = 512
	maxAuthorizationTokenLen  = 2048
)

var authorizationTargetPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

// NormalizeAuthorizationScope accepts only the small set of actions that may
// be authorized by the shared passkey step-up ceremony. An omitted scope keeps
// the original passkey-management behavior.
func NormalizeAuthorizationScope(raw string) (string, error) {
	if raw == "" {
		return AuthorizationScopePasskeyManagement, nil
	}
	if len(raw) > maxAuthorizationScopeLen || strings.TrimSpace(raw) != raw {
		return "", fmt.Errorf("%w: authorization scope", ErrInvalidInput)
	}
	if raw == AuthorizationScopePasskeyManagement {
		return raw, nil
	}
	if raw == AuthorizationScopeRecoveryPasskeyAdd {
		return raw, nil
	}

	parts := strings.Split(raw, ":")
	if len(parts) < 4 || parts[0] != "admin" {
		return "", fmt.Errorf("%w: authorization scope", ErrInvalidInput)
	}
	switch {
	case len(parts) == 4 && parts[1] == "providers" && parts[2] == "update":
		if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(parts[3]) {
			return "", fmt.Errorf("%w: authorization scope", ErrInvalidInput)
		}
	case len(parts) == 4 && parts[1] == "invitation" && parts[2] == "create":
		hours, err := strconv.Atoi(parts[3])
		if err != nil || hours < 0 || hours > 720 || strconv.Itoa(hours) != parts[3] {
			return "", fmt.Errorf("%w: authorization scope", ErrInvalidInput)
		}
	case len(parts) == 4 && parts[1] == "invitation" && parts[2] == "revoke":
		if !validAuthorizationTarget(parts[3], "inv") {
			return "", fmt.Errorf("%w: authorization scope", ErrInvalidInput)
		}
	case len(parts) == 4 && parts[1] == "code" && parts[2] == "create":
		if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(parts[3]) {
			return "", fmt.Errorf("%w: authorization scope", ErrInvalidInput)
		}
	case len(parts) == 4 && parts[1] == "site-settings" && parts[2] == "update":
		if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(parts[3]) {
			return "", fmt.Errorf("%w: authorization scope", ErrInvalidInput)
		}
	case len(parts) == 6 && parts[1] == "user" && parts[2] == "update":
		if !validAuthorizationTarget(parts[3], "usr") ||
			(parts[4] != "-" && parts[4] != string(domain.RoleUser) && parts[4] != string(domain.RoleAdmin)) ||
			(parts[5] != "-" && parts[5] != string(domain.UserActive) && parts[5] != string(domain.UserDisabled)) ||
			(parts[4] == "-" && parts[5] == "-") {
			return "", fmt.Errorf("%w: authorization scope", ErrInvalidInput)
		}
	default:
		return "", fmt.Errorf("%w: authorization scope", ErrInvalidInput)
	}
	return raw, nil
}

// AdminInvitationCreateAuthorizationScope binds step-up authorization to the
// exact expiresInHours request value. Zero represents the API's omitted/default
// value; positive values match the validated JSON field directly.
func AdminInvitationCreateAuthorizationScope(hours int) (string, error) {
	return NormalizeAuthorizationScope(fmt.Sprintf("admin:invitation:create:%d", hours))
}

// AdminCodeCreateAuthorizationScope binds every caller-supplied schedule and
// target field. Frontends hash UTF-8 `kind|targetUserId|notBefore|expiresAt|ttlSeconds`
// with SHA-256 and prefix the lowercase hex digest with admin:code:create:.
func AdminCodeCreateAuthorizationScope(kind, target, notBefore, expiresAt string, ttlSeconds int) (string, error) {
	if strings.ContainsAny(kind+target+notBefore+expiresAt, "|\r\n") || ttlSeconds < 0 {
		return "", fmt.Errorf("%w: authorization scope", ErrInvalidInput)
	}
	payload := fmt.Sprintf("%s|%s|%s|%s|%d", kind, target, notBefore, expiresAt, ttlSeconds)
	hash := sha256.Sum256([]byte(payload))
	return NormalizeAuthorizationScope(fmt.Sprintf("admin:code:create:%x", hash))
}

// AdminSiteSettingsAuthorizationScope hashes the compact UTF-8 JSON object
// with keys in this order: registrationHelpMarkdown, codeAttemptsPerMinute.
// HTML escaping is disabled so JS JSON.stringify of those two fields matches.
func AdminSiteSettingsAuthorizationScope(markdown string, attempts int) (string, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(struct {
		RegistrationHelpMarkdown string `json:"registrationHelpMarkdown"`
		CodeAttemptsPerMinute    int    `json:"codeAttemptsPerMinute"`
	}{markdown, attempts}); err != nil {
		return "", err
	}
	encoded := bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'})
	hash := sha256.Sum256(encoded)
	return NormalizeAuthorizationScope(fmt.Sprintf("admin:site-settings:update:%x", hash))
}

func AdminInvitationRevokeAuthorizationScope(invitationID string) (string, error) {
	return NormalizeAuthorizationScope("admin:invitation:revoke:" + invitationID)
}

func AdminUserUpdateAuthorizationScope(
	userID string,
	role *domain.Role,
	status *domain.UserStatus,
) (string, error) {
	roleValue := "-"
	if role != nil {
		roleValue = string(*role)
	}
	statusValue := "-"
	if status != nil {
		statusValue = string(*status)
	}
	return NormalizeAuthorizationScope(
		"admin:user:update:" + userID + ":" + roleValue + ":" + statusValue,
	)
}

func validAuthorizationTarget(value, prefix string) bool {
	return strings.HasPrefix(value, prefix+"_") && authorizationTargetPattern.MatchString(value)
}

// NewScopedAuthorizationToken returns an opaque bearer value whose database
// digest covers both its canonical scope and a 256-bit random secret.
// The scope prefix is only parsed server-side; clients must treat the whole
// value as opaque.
func NewScopedAuthorizationToken(rawScope string) (string, error) {
	scope, err := NormalizeAuthorizationScope(rawScope)
	if err != nil {
		return "", err
	}
	secretValue, err := id.Secret(32)
	if err != nil {
		return "", err
	}
	encodedScope := base64.RawURLEncoding.EncodeToString([]byte(scope))
	return authorizationTokenVersion + "." + encodedScope + "." + secretValue, nil
}

func authorizationTokenScope(token string) (string, bool) {
	if token == "" || len(token) > maxAuthorizationTokenLen || strings.TrimSpace(token) != token {
		return "", false
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != authorizationTokenVersion || len(parts[2]) != 52 {
		return "", false
	}
	for _, character := range parts[2] {
		if (character < 'a' || character > 'z') && (character < '2' || character > '7') {
			return "", false
		}
	}
	decoded, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || base64.RawURLEncoding.EncodeToString(decoded) != parts[1] {
		return "", false
	}
	scope := string(decoded)
	normalized, err := NormalizeAuthorizationScope(scope)
	if err != nil || normalized != scope {
		return "", false
	}
	return scope, true
}

// ConsumeCredentialAuthorization verifies that the opaque token was minted
// for the exact expected operation before atomically deleting its session-bound
// action-grant row. Scope mismatches do not consume a token that is still valid
// for its intended operation.
func (s *Service) ConsumeCredentialAuthorization(
	ctx context.Context,
	userID string,
	browserSessionID string,
	authorizationToken string,
	expectedScope string,
) error {
	normalizedScope, err := NormalizeAuthorizationScope(expectedScope)
	if err != nil || authorizationToken == "" || len(authorizationToken) > maxAuthorizationTokenLen {
		return ErrInvalidAuthorization
	}

	if strings.HasPrefix(authorizationToken, authorizationTokenVersion+".") {
		tokenScope, valid := authorizationTokenScope(authorizationToken)
		if !valid || subtle.ConstantTimeCompare([]byte(tokenScope), []byte(normalizedScope)) != 1 {
			return ErrInvalidAuthorization
		}
	} else if normalizedScope != AuthorizationScopePasskeyManagement {
		// Pre-scope grants remain valid only for their original passkey-management
		// purpose during a rolling deployment.
		return ErrInvalidAuthorization
	}

	if err := s.store.ConsumeActionGrant(
		ctx, authorizationToken, userID, browserSessionID,
		store.ActionPasskeyManagement, s.now().UTC(),
	); err != nil {
		return ErrInvalidAuthorization
	}
	return nil
}
