package control

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
)

const maxControlResponseBytes = 2 << 20

type Client struct {
	httpClient *http.Client
}

type RemoteError struct {
	StatusCode int
	Code       string
	Message    string
}

func (e *RemoteError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return "control request failed with HTTP status " + strconv.Itoa(e.StatusCode)
}

// NewClient constructs an HTTP client whose transport always dials socketPath
// as a Unix-domain socket, regardless of the URL host. It has no TCP fallback.
func NewClient(socketPath string) (*Client, error) {
	path := strings.TrimSpace(socketPath)
	if path == "" {
		return nil, errors.New("control: admin socket path is required")
	}
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			dialer := net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
			return dialer.DialContext(ctx, "unix", path)
		},
		DisableCompression:  true,
		ForceAttemptHTTP2:   false,
		IdleConnTimeout:     30 * time.Second,
		MaxIdleConns:        2,
		MaxIdleConnsPerHost: 2,
	}
	return &Client{httpClient: &http.Client{Transport: transport, Timeout: 15 * time.Second}}, nil
}

func (c *Client) CloseIdleConnections() { c.httpClient.CloseIdleConnections() }

func (c *Client) Status(ctx context.Context) (StatusResponse, error) {
	var response StatusResponse
	err := c.do(ctx, http.MethodGet, StatusPath, nil, &response)
	return response, err
}

func (c *Client) CreateInvitation(ctx context.Context, ttl time.Duration) (CreateInvitationResponse, error) {
	request := CreateInvitationRequest{}
	if ttl > 0 {
		request.TTL = ttl.String()
	}
	var response CreateInvitationResponse
	err := c.do(ctx, http.MethodPost, InvitationsPath, request, &response)
	return response, err
}

func (c *Client) ListInvitations(ctx context.Context, limit, offset int) (InvitationListResponse, error) {
	var response InvitationListResponse
	err := c.do(ctx, http.MethodGet, paginatedPath(InvitationsPath, limit, offset), nil, &response)
	return response, err
}

func (c *Client) RevokeInvitation(ctx context.Context, id string) error {
	var response OperationResponse
	return c.do(ctx, http.MethodPost, InvitationRevokePath, RevokeInvitationRequest{ID: id}, &response)
}

func (c *Client) ListUsers(ctx context.Context, limit, offset int) (UserListResponse, error) {
	var response UserListResponse
	err := c.do(ctx, http.MethodGet, paginatedPath(UsersPath, limit, offset), nil, &response)
	return response, err
}

func (c *Client) SetUserRole(ctx context.Context, id string, role domain.Role) error {
	var response OperationResponse
	return c.do(ctx, http.MethodPost, UserRolePath, SetUserRoleRequest{ID: id, Role: role}, &response)
}

func (c *Client) SetUserStatus(ctx context.Context, id string, status domain.UserStatus) error {
	var response OperationResponse
	return c.do(ctx, http.MethodPost, UserStatusPath, SetUserStatusRequest{ID: id, Status: status}, &response)
}

func (c *Client) do(ctx context.Context, method, path string, requestBody, responseTarget any) error {
	var body io.Reader
	if requestBody != nil {
		encoded, err := json.Marshal(requestBody)
		if err != nil {
			return fmt.Errorf("control: encode request: %w", err)
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, "http://t-lingual-control"+path, body)
	if err != nil {
		return fmt.Errorf("control: build request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	if requestBody != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("control: communicate with running server: %w", err)
	}
	defer response.Body.Close()

	payload, err := io.ReadAll(io.LimitReader(response.Body, maxControlResponseBytes+1))
	if err != nil {
		return fmt.Errorf("control: read response: %w", err)
	}
	if len(payload) > maxControlResponseBytes {
		return errors.New("control: response exceeded the safe size limit")
	}
	mediaType, _, mediaErr := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if mediaErr != nil || mediaType != "application/json" {
		return errors.New("control: running server returned a non-JSON response")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var envelope errorEnvelope
		if err := decodeResponse(payload, &envelope); err != nil || envelope.Error.Code == "" {
			return &RemoteError{StatusCode: response.StatusCode, Code: "INVALID_RESPONSE", Message: "The running server returned an invalid error response."}
		}
		return &RemoteError{StatusCode: response.StatusCode, Code: envelope.Error.Code, Message: envelope.Error.Message}
	}
	if responseTarget == nil {
		return nil
	}
	if err := decodeResponse(payload, responseTarget); err != nil {
		return fmt.Errorf("control: decode response: %w", err)
	}
	return nil
}

func decodeResponse(payload []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("response contained more than one JSON value")
	}
	return nil
}

func paginatedPath(path string, limit, offset int) string {
	values := make(url.Values)
	if limit > 0 {
		values.Set("limit", strconv.Itoa(limit))
	}
	if offset > 0 {
		values.Set("offset", strconv.Itoa(offset))
	}
	if len(values) == 0 {
		return path
	}
	return path + "?" + values.Encode()
}
