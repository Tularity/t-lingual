package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/control"
	"github.com/Tularity/t-lingual/internal/domain"
)

type fakeAdminClient struct {
	status               control.StatusResponse
	created              control.CreateInvitationResponse
	invitations          control.InvitationListResponse
	users                control.UserListResponse
	err                  error
	createdTTL           time.Duration
	revokedID            string
	roleID               string
	role                 domain.Role
	statusID             string
	userStatus           domain.UserStatus
	closedIdleConnection bool
}

func (f *fakeAdminClient) Status(context.Context) (control.StatusResponse, error) {
	return f.status, f.err
}

func (f *fakeAdminClient) CreateInvitation(_ context.Context, ttl time.Duration) (control.CreateInvitationResponse, error) {
	f.createdTTL = ttl
	return f.created, f.err
}

func (f *fakeAdminClient) ListInvitations(context.Context, int, int) (control.InvitationListResponse, error) {
	return f.invitations, f.err
}

func (f *fakeAdminClient) RevokeInvitation(_ context.Context, id string) error {
	f.revokedID = id
	return f.err
}

func (f *fakeAdminClient) ListUsers(context.Context, int, int) (control.UserListResponse, error) {
	return f.users, f.err
}

func (f *fakeAdminClient) SetUserRole(_ context.Context, id string, role domain.Role) error {
	f.roleID, f.role = id, role
	return f.err
}

func (f *fakeAdminClient) SetUserStatus(_ context.Context, id string, status domain.UserStatus) error {
	f.statusID, f.userStatus = id, status
	return f.err
}

func (f *fakeAdminClient) CloseIdleConnections() { f.closedIdleConnection = true }

func testLookup(values map[string]string) func(string) (string, bool) {
	return func(key string) (string, bool) {
		value, ok := values[key]
		return value, ok
	}
}

func TestInviteCreateShowsClearCodeExactlyOnce(t *testing.T) {
	now := time.Now().UTC()
	fake := &fakeAdminClient{created: control.CreateInvitationResponse{
		Invitation: domain.Invitation{ID: "inv_test", CreatedAt: now, ExpiresAt: now.Add(2 * time.Hour)},
		Code:       "123456",
	}}
	var openedSocket string
	factory := func(path string) (adminClient, error) {
		openedSocket = path
		return fake, nil
	}
	var stdout, stderr bytes.Buffer
	exitCode := run(
		[]string{"invite", "create", "--ttl", "2h"},
		testLookup(map[string]string{"TLINGUAL_ADMIN_SOCKET": "/run/t-lingual/admin.sock"}),
		&stdout, &stderr, factory,
	)
	if exitCode != exitSuccess {
		t.Fatalf("exit=%d stderr=%s", exitCode, stderr.String())
	}
	if openedSocket != "/run/t-lingual/admin.sock" || fake.createdTTL != 2*time.Hour {
		t.Fatalf("socket=%q ttl=%v", openedSocket, fake.createdTTL)
	}
	if strings.Count(stdout.String(), "123456") != 1 {
		t.Fatalf("clear code was not printed exactly once: %q", stdout.String())
	}
	if !strings.Contains(stdout.String(), "inv_test") || stderr.Len() != 0 || !fake.closedIdleConnection {
		t.Fatalf("stdout=%q stderr=%q closed=%v", stdout.String(), stderr.String(), fake.closedIdleConnection)
	}
}

func TestJSONOutputAndSocketFlag(t *testing.T) {
	now := time.Now().UTC()
	fake := &fakeAdminClient{created: control.CreateInvitationResponse{
		Invitation: domain.Invitation{ID: "inv_json", CreatedAt: now, ExpiresAt: now.Add(time.Hour)},
		Code:       "654321",
	}}
	var openedSocket string
	var stdout, stderr bytes.Buffer
	exitCode := run(
		[]string{"invite", "create", "--json", "--socket=/custom/admin.sock"},
		testLookup(nil), &stdout, &stderr,
		func(path string) (adminClient, error) { openedSocket = path; return fake, nil },
	)
	if exitCode != exitSuccess || openedSocket != "/custom/admin.sock" || stderr.Len() != 0 {
		t.Fatalf("exit=%d socket=%q stderr=%q", exitCode, openedSocket, stderr.String())
	}
	var response control.CreateInvitationResponse
	if err := json.Unmarshal(stdout.Bytes(), &response); err != nil {
		t.Fatalf("invalid JSON output: %v; %q", err, stdout.String())
	}
	if response.Code != "654321" || strings.Count(stdout.String(), "654321") != 1 {
		t.Fatalf("unexpected JSON output: %s", stdout.String())
	}
}

func TestUserCommandsMapToControlAPI(t *testing.T) {
	tests := []struct {
		name       string
		args       []string
		assertCall func(*testing.T, *fakeAdminClient)
	}{
		{name: "set role", args: []string{"users", "set-role", "usr_one", "admin"}, assertCall: func(t *testing.T, f *fakeAdminClient) {
			if f.roleID != "usr_one" || f.role != domain.RoleAdmin {
				t.Fatalf("role call = %q %q", f.roleID, f.role)
			}
		}},
		{name: "enable", args: []string{"users", "enable", "usr_two"}, assertCall: func(t *testing.T, f *fakeAdminClient) {
			if f.statusID != "usr_two" || f.userStatus != domain.UserActive {
				t.Fatalf("enable call = %q %q", f.statusID, f.userStatus)
			}
		}},
		{name: "disable", args: []string{"users", "disable", "usr_three"}, assertCall: func(t *testing.T, f *fakeAdminClient) {
			if f.statusID != "usr_three" || f.userStatus != domain.UserDisabled {
				t.Fatalf("disable call = %q %q", f.statusID, f.userStatus)
			}
		}},
		{name: "revoke", args: []string{"invite", "revoke", "inv_one"}, assertCall: func(t *testing.T, f *fakeAdminClient) {
			if f.revokedID != "inv_one" {
				t.Fatalf("revoke call = %q", f.revokedID)
			}
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fake := &fakeAdminClient{}
			var stdout, stderr bytes.Buffer
			exitCode := run(test.args, testLookup(nil), &stdout, &stderr,
				func(string) (adminClient, error) { return fake, nil })
			if exitCode != exitSuccess {
				t.Fatalf("exit=%d stderr=%s", exitCode, stderr.String())
			}
			test.assertCall(t, fake)
		})
	}
}

func TestUsageErrorsDoNotContactServer(t *testing.T) {
	called := false
	var stdout, stderr bytes.Buffer
	exitCode := run([]string{"users", "set-role", "usr_one", "owner"}, testLookup(nil), &stdout, &stderr,
		func(string) (adminClient, error) { called = true; return &fakeAdminClient{}, nil })
	if exitCode != exitUsage || called {
		t.Fatalf("exit=%d called=%v", exitCode, called)
	}
	if !strings.Contains(stderr.String(), "role must be user or admin") || !strings.Contains(stderr.String(), "Exit codes:") {
		t.Fatalf("unclear usage output: %q", stderr.String())
	}
}

func TestJSONErrorsAreStableAndDoNotExposeInternalDetails(t *testing.T) {
	tests := []struct {
		name     string
		failure  error
		wantCode string
		wantText string
	}{
		{name: "remote", failure: &control.RemoteError{StatusCode: 404, Code: "NOT_FOUND", Message: "The requested resource does not exist."}, wantCode: "NOT_FOUND", wantText: "does not exist"},
		{name: "transport", failure: errors.New("dial failed with super-secret diagnostic"), wantCode: "CONTROL_UNAVAILABLE", wantText: "Could not communicate"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fake := &fakeAdminClient{err: test.failure}
			var stdout, stderr bytes.Buffer
			exitCode := run([]string{"--json", "status"}, testLookup(nil), &stdout, &stderr,
				func(string) (adminClient, error) { return fake, nil })
			if exitCode != exitFailure || stdout.Len() != 0 {
				t.Fatalf("exit=%d stdout=%q", exitCode, stdout.String())
			}
			var envelope struct {
				Error struct {
					Code    string `json:"code"`
					Message string `json:"message"`
				} `json:"error"`
			}
			if err := json.Unmarshal(stderr.Bytes(), &envelope); err != nil {
				t.Fatalf("invalid JSON error: %v; %q", err, stderr.String())
			}
			if envelope.Error.Code != test.wantCode || !strings.Contains(envelope.Error.Message, test.wantText) {
				t.Fatalf("unexpected error: %#v", envelope)
			}
			if strings.Contains(stderr.String(), "super-secret") {
				t.Fatalf("internal detail leaked: %s", stderr.String())
			}
		})
	}
}
