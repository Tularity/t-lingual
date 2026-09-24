// Package control exposes the process-local administrative control plane.
//
// The HTTP handler in this package is intended exclusively for a Unix-domain
// listener owned by the running t-lingual server. It must never be mounted on a
// TCP listener: possession of the filesystem socket is the authentication
// boundary for bootstrap administration.
package control

import (
	"errors"
	"path/filepath"

	"github.com/Tularity/t-lingual/internal/domain"
)

const (
	StatusPath                 = "/v1/status"
	InvitationsPath            = "/v1/invitations"
	CodesPath                  = "/v1/codes"
	InvitationRevokePath       = "/v1/invitations/revoke"
	UsersPath                  = "/v1/users"
	UserRolePath               = "/v1/users/set-role"
	UserStatusPath             = "/v1/users/set-status"
	DefaultMaxJSONBytes  int64 = 64 << 10
)

var ErrSocketInUse = errors.New("control: admin socket is already in use")

func DefaultSocketPath() string { return filepath.Join("data", "admin.sock") }

type StatusResponse struct {
	Status     string `json:"status"`
	APIVersion string `json:"apiVersion"`
}

type CreateInvitationRequest struct {
	TTL string `json:"ttl,omitempty"`
}

type CreateInvitationResponse struct {
	Invitation domain.Invitation `json:"invitation"`
	Code       string            `json:"code"`
}

type CreateCodeRequest struct {
	Kind         string `json:"kind"`
	TargetUserID string `json:"targetUserId,omitempty"`
	NotBefore    string `json:"notBefore,omitempty"`
	ExpiresAt    string `json:"expiresAt,omitempty"`
	TTL          string `json:"ttl,omitempty"`
}

type CreateCodeResponse struct {
	Invitation domain.Invitation `json:"invitation"`
	Code       string            `json:"code"`
}

type InvitationListResponse struct {
	Invitations []domain.Invitation `json:"invitations"`
}

type RevokeInvitationRequest struct {
	ID string `json:"id"`
}

type UserListResponse struct {
	Users []domain.User `json:"users"`
}

type SetUserRoleRequest struct {
	ID   string      `json:"id"`
	Role domain.Role `json:"role"`
}

type SetUserStatusRequest struct {
	ID     string            `json:"id"`
	Status domain.UserStatus `json:"status"`
}

type OperationResponse struct {
	Status string `json:"status"`
}

type errorEnvelope struct {
	Error errorBody `json:"error"`
}

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
