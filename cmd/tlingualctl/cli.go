package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"strings"
	"text/tabwriter"
	"time"
	"unicode"

	"github.com/Tularity/t-lingual/internal/control"
	"github.com/Tularity/t-lingual/internal/domain"
)

const (
	exitSuccess = 0
	exitFailure = 1
	exitUsage   = 2

	commandTimeout = 15 * time.Second
)

type adminClient interface {
	Status(context.Context) (control.StatusResponse, error)
	CreateInvitation(context.Context, time.Duration) (control.CreateInvitationResponse, error)
	CreateCode(context.Context, control.CreateCodeRequest) (control.CreateCodeResponse, error)
	ListInvitations(context.Context, int, int) (control.InvitationListResponse, error)
	RevokeInvitation(context.Context, string) error
	ListUsers(context.Context, int, int) (control.UserListResponse, error)
	SetUserRole(context.Context, string, domain.Role) error
	SetUserStatus(context.Context, string, domain.UserStatus) error
	CloseIdleConnections()
}

type clientFactory func(string) (adminClient, error)

type commandKind int

const (
	commandHelp commandKind = iota
	commandStatus
	commandInviteCreate
	commandCodeCreate
	commandInviteList
	commandInviteRevoke
	commandUsersList
	commandUsersSetRole
	commandUsersSetStatus
)

type invocation struct {
	kind      commandKind
	ttl       time.Duration
	id        string
	codeKind  string
	notBefore string
	expiresAt string
	role      domain.Role
	status    domain.UserStatus
}

type rootOptions struct {
	json       bool
	help       bool
	socketPath string
	arguments  []string
}

type usageError struct{ message string }

func (e *usageError) Error() string { return e.message }

func run(
	args []string,
	lookupEnv func(string) (string, bool),
	stdout io.Writer,
	stderr io.Writer,
	openClient clientFactory,
) int {
	options, err := parseRootOptions(args)
	if err != nil {
		writeUsageError(stderr, err)
		return exitUsage
	}
	if options.help {
		writeUsage(stdout)
		return exitSuccess
	}
	command, err := parseInvocation(options.arguments)
	if err != nil {
		writeUsageError(stderr, err)
		return exitUsage
	}
	if command.kind == commandHelp {
		writeUsage(stdout)
		return exitSuccess
	}

	socketPath := options.socketPath
	if socketPath == "" {
		if configured, ok := lookupEnv("TLINGUAL_ADMIN_SOCKET"); ok {
			socketPath = strings.TrimSpace(configured)
		}
		if socketPath == "" {
			socketPath = control.DefaultSocketPath()
		}
	}
	client, err := openClient(socketPath)
	if err != nil {
		writeOperationalError(stderr, options.json, err)
		return exitFailure
	}
	defer client.CloseIdleConnections()

	ctx, cancel := context.WithTimeout(context.Background(), commandTimeout)
	defer cancel()
	if err := execute(ctx, client, command, options.json, stdout); err != nil {
		writeOperationalError(stderr, options.json, err)
		return exitFailure
	}
	return exitSuccess
}

func parseRootOptions(args []string) (rootOptions, error) {
	options := rootOptions{arguments: make([]string, 0, len(args))}
	for index := 0; index < len(args); index++ {
		argument := args[index]
		switch {
		case argument == "--json":
			options.json = true
		case argument == "--socket":
			index++
			if index >= len(args) || strings.TrimSpace(args[index]) == "" {
				return rootOptions{}, &usageError{message: "--socket requires a non-empty path"}
			}
			options.socketPath = strings.TrimSpace(args[index])
		case strings.HasPrefix(argument, "--socket="):
			options.socketPath = strings.TrimSpace(strings.TrimPrefix(argument, "--socket="))
			if options.socketPath == "" {
				return rootOptions{}, &usageError{message: "--socket requires a non-empty path"}
			}
		case argument == "--help" || argument == "-h":
			options.help = true
		default:
			options.arguments = append(options.arguments, argument)
		}
	}
	return options, nil
}

func parseInvocation(args []string) (invocation, error) {
	if len(args) == 0 {
		return invocation{}, &usageError{message: "a command is required"}
	}
	switch args[0] {
	case "help":
		if len(args) != 1 {
			return invocation{}, &usageError{message: "help does not accept arguments"}
		}
		return invocation{kind: commandHelp}, nil
	case "status":
		if len(args) != 1 {
			return invocation{}, &usageError{message: "status does not accept arguments"}
		}
		return invocation{kind: commandStatus}, nil
	case "invite":
		return parseInviteInvocation(args[1:])
	case "code":
		return parseCodeInvocation(args[1:])
	case "users":
		return parseUsersInvocation(args[1:])
	default:
		return invocation{}, &usageError{message: fmt.Sprintf("unknown command %q", args[0])}
	}
}

func parseCodeInvocation(args []string) (invocation, error) {
	if len(args) == 0 || args[0] != "create" {
		return invocation{}, &usageError{message: "code requires create"}
	}
	flags := flag.NewFlagSet("code create", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	kind := flags.String("kind", "", "registration or login")
	user := flags.String("user", "", "login target user ID")
	ttl := flags.Duration("ttl", 0, "code lifetime")
	notBefore := flags.String("not-before", "", "RFC3339 activation")
	expiresAt := flags.String("expires-at", "", "RFC3339 expiry")
	if err := flags.Parse(args[1:]); err != nil || flags.NArg() != 0 {
		return invocation{}, &usageError{message: "code create accepts only --kind, --user, --not-before, --ttl, and --expires-at"}
	}
	if (*kind != "login" && *kind != "registration") || (*kind == "login" && *user == "") ||
		(*kind == "registration" && *user != "") || (*ttl != 0 && *expiresAt != "") {
		return invocation{}, &usageError{message: "code kind, target, or expiry is invalid"}
	}
	if *ttl < 0 {
		return invocation{}, &usageError{message: "--ttl must be positive"}
	}
	for _, value := range []string{*notBefore, *expiresAt} {
		if value == "" {
			continue
		}
		if _, err := time.Parse(time.RFC3339Nano, value); err != nil {
			return invocation{}, &usageError{message: "--not-before and --expires-at must be RFC3339"}
		}
	}
	return invocation{kind: commandCodeCreate, codeKind: *kind, id: *user, ttl: *ttl,
		notBefore: *notBefore, expiresAt: *expiresAt}, nil
}

func parseInviteInvocation(args []string) (invocation, error) {
	if len(args) == 0 {
		return invocation{}, &usageError{message: "invite requires create, list, or revoke"}
	}
	switch args[0] {
	case "create":
		flags := flag.NewFlagSet("invite create", flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		ttl := flags.Duration("ttl", 0, "invitation lifetime")
		if err := flags.Parse(args[1:]); err != nil {
			return invocation{}, &usageError{message: "invite create: " + err.Error()}
		}
		if flags.NArg() != 0 {
			return invocation{}, &usageError{message: "invite create accepts only the optional --ttl duration"}
		}
		if *ttl != 0 && (*ttl < time.Minute || *ttl > 30*24*time.Hour) {
			return invocation{}, &usageError{message: "--ttl must be between 1m and 720h"}
		}
		return invocation{kind: commandInviteCreate, ttl: *ttl}, nil
	case "list":
		if len(args) != 1 {
			return invocation{}, &usageError{message: "invite list does not accept arguments"}
		}
		return invocation{kind: commandInviteList}, nil
	case "revoke":
		if len(args) != 2 || strings.TrimSpace(args[1]) == "" {
			return invocation{}, &usageError{message: "invite revoke requires exactly one invitation id"}
		}
		return invocation{kind: commandInviteRevoke, id: strings.TrimSpace(args[1])}, nil
	default:
		return invocation{}, &usageError{message: fmt.Sprintf("unknown invite command %q", args[0])}
	}
}

func parseUsersInvocation(args []string) (invocation, error) {
	if len(args) == 0 {
		return invocation{}, &usageError{message: "users requires list, set-role, enable, or disable"}
	}
	switch args[0] {
	case "list":
		if len(args) != 1 {
			return invocation{}, &usageError{message: "users list does not accept arguments"}
		}
		return invocation{kind: commandUsersList}, nil
	case "set-role":
		if len(args) != 3 || strings.TrimSpace(args[1]) == "" {
			return invocation{}, &usageError{message: "users set-role requires a user id and user or admin"}
		}
		role := domain.Role(args[2])
		if !role.Valid() {
			return invocation{}, &usageError{message: "role must be user or admin"}
		}
		return invocation{kind: commandUsersSetRole, id: strings.TrimSpace(args[1]), role: role}, nil
	case "enable", "disable":
		if len(args) != 2 || strings.TrimSpace(args[1]) == "" {
			return invocation{}, &usageError{message: "users " + args[0] + " requires exactly one user id"}
		}
		status := domain.UserActive
		if args[0] == "disable" {
			status = domain.UserDisabled
		}
		return invocation{kind: commandUsersSetStatus, id: strings.TrimSpace(args[1]), status: status}, nil
	default:
		return invocation{}, &usageError{message: fmt.Sprintf("unknown users command %q", args[0])}
	}
}

func execute(ctx context.Context, client adminClient, command invocation, jsonOutput bool, output io.Writer) error {
	switch command.kind {
	case commandStatus:
		response, err := client.Status(ctx)
		if err != nil {
			return err
		}
		if response.Status != "ok" || response.APIVersion != "v1" {
			return errors.New("the running server returned an incompatible status response")
		}
		if jsonOutput {
			return writeJSON(output, response)
		}
		_, err = fmt.Fprintln(output, "t-lingual control plane is ready (API v1)")
		return err
	case commandInviteCreate:
		response, err := client.CreateInvitation(ctx, command.ttl)
		if err != nil {
			return err
		}
		if !validInvitationCode(response.Code) || response.Invitation.ID == "" {
			return errors.New("the running server returned an invalid invitation response")
		}
		if jsonOutput {
			return writeJSON(output, response)
		}
		return writeCreatedInvitation(output, response)
	case commandCodeCreate:
		request := control.CreateCodeRequest{Kind: command.codeKind, TargetUserID: command.id,
			NotBefore: command.notBefore, ExpiresAt: command.expiresAt}
		if command.ttl > 0 {
			request.TTL = command.ttl.String()
		}
		created, err := client.CreateCode(ctx, request)
		if err != nil {
			return err
		}
		if !validInvitationCode(created.Code) || created.Invitation.ID == "" ||
			created.Invitation.Kind != command.codeKind || created.Invitation.TargetUserID != command.id {
			return errors.New("the running server returned an invalid code response")
		}
		if jsonOutput {
			return writeJSON(output, created)
		}
		_, err = fmt.Fprintf(output, "Code created.\nKind: %s\nCode: %s\nID: %s\nActive: %s\nExpires: %s\n",
			created.Invitation.Kind, created.Code, safeCell(created.Invitation.ID),
			created.Invitation.NotBefore.UTC().Format(time.RFC3339),
			created.Invitation.ExpiresAt.UTC().Format(time.RFC3339))
		return err
	case commandInviteList:
		response, err := client.ListInvitations(ctx, 500, 0)
		if err != nil {
			return err
		}
		if jsonOutput {
			return writeJSON(output, response)
		}
		return writeInvitationList(output, response.Invitations, time.Now())
	case commandInviteRevoke:
		if err := client.RevokeInvitation(ctx, command.id); err != nil {
			return err
		}
		if jsonOutput {
			return writeJSON(output, map[string]string{"status": "ok", "invitationId": command.id})
		}
		_, err := fmt.Fprintf(output, "Invitation %s revoked.\n", safeCell(command.id))
		return err
	case commandUsersList:
		response, err := client.ListUsers(ctx, 500, 0)
		if err != nil {
			return err
		}
		if jsonOutput {
			return writeJSON(output, response)
		}
		return writeUserList(output, response.Users)
	case commandUsersSetRole:
		if err := client.SetUserRole(ctx, command.id, command.role); err != nil {
			return err
		}
		if jsonOutput {
			return writeJSON(output, map[string]string{"status": "ok", "userId": command.id, "role": string(command.role)})
		}
		_, err := fmt.Fprintf(output, "User %s now has role %s.\n", safeCell(command.id), command.role)
		return err
	case commandUsersSetStatus:
		if err := client.SetUserStatus(ctx, command.id, command.status); err != nil {
			return err
		}
		if jsonOutput {
			return writeJSON(output, map[string]string{"status": "ok", "userId": command.id, "userStatus": string(command.status)})
		}
		verb := "enabled"
		if command.status == domain.UserDisabled {
			verb = "disabled"
		}
		_, err := fmt.Fprintf(output, "User %s %s.\n", safeCell(command.id), verb)
		return err
	default:
		return errors.New("unsupported command")
	}
}

func writeCreatedInvitation(output io.Writer, response control.CreateInvitationResponse) error {
	// The clear code deliberately appears in exactly one line and is never
	// retained by either the CLI or server after this response is discarded.
	_, err := fmt.Fprintf(output,
		"Invitation created.\nCode: %s\nID: %s\nExpires: %s\n",
		response.Code,
		safeCell(response.Invitation.ID),
		response.Invitation.ExpiresAt.UTC().Format(time.RFC3339),
	)
	return err
}

func writeInvitationList(output io.Writer, invitations []domain.Invitation, now time.Time) error {
	if len(invitations) == 0 {
		_, err := fmt.Fprintln(output, "No invitations found.")
		return err
	}
	writer := tabwriter.NewWriter(output, 0, 4, 2, ' ', 0)
	if _, err := fmt.Fprintln(writer, "ID\tSTATE\tEXPIRES\tCREATED BY"); err != nil {
		return err
	}
	for _, invitation := range invitations {
		creator := "local"
		if invitation.CreatedBy != nil {
			creator = safeCell(*invitation.CreatedBy)
		}
		if _, err := fmt.Fprintf(writer, "%s\t%s\t%s\t%s\n",
			safeCell(invitation.ID), invitationState(invitation, now),
			invitation.ExpiresAt.UTC().Format(time.RFC3339), creator,
		); err != nil {
			return err
		}
	}
	return writer.Flush()
}

func writeUserList(output io.Writer, users []domain.User) error {
	if len(users) == 0 {
		_, err := fmt.Fprintln(output, "No users found.")
		return err
	}
	writer := tabwriter.NewWriter(output, 0, 4, 2, ' ', 0)
	if _, err := fmt.Fprintln(writer, "ID\tUSERNAME\tDISPLAY NAME\tROLE\tSTATUS"); err != nil {
		return err
	}
	for _, user := range users {
		if _, err := fmt.Fprintf(writer, "%s\t%s\t%s\t%s\t%s\n",
			safeCell(user.ID), safeCell(user.Username), safeCell(user.DisplayName), user.Role, user.Status,
		); err != nil {
			return err
		}
	}
	return writer.Flush()
}

func invitationState(invitation domain.Invitation, now time.Time) string {
	switch {
	case invitation.RevokedAt != nil:
		return "revoked"
	case invitation.UsedAt != nil:
		return "used"
	case !invitation.ExpiresAt.After(now):
		return "expired"
	default:
		return "active"
	}
}

func validInvitationCode(code string) bool {
	if len(code) != 6 {
		return false
	}
	for _, character := range code {
		if character < '0' || character > '9' {
			return false
		}
	}
	return true
}

func safeCell(value string) string {
	return strings.Map(func(character rune) rune {
		if unicode.IsControl(character) ||
			(character >= '\u202a' && character <= '\u202e') ||
			(character >= '\u2066' && character <= '\u2069') {
			return '?'
		}
		return character
	}, value)
}

func writeJSON(output io.Writer, value any) error {
	encoder := json.NewEncoder(output)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(value)
}

func writeOperationalError(output io.Writer, jsonOutput bool, err error) {
	var remote *control.RemoteError
	if jsonOutput {
		code := "CONTROL_UNAVAILABLE"
		message := "Could not communicate with the running t-lingual server."
		if errors.As(err, &remote) {
			code = remote.Code
			message = remote.Message
		}
		_ = writeJSON(output, map[string]any{"error": map[string]string{"code": code, "message": message}})
		return
	}
	if errors.As(err, &remote) {
		_, _ = fmt.Fprintf(output, "error: %s: %s\n", safeCell(remote.Code), safeCell(remote.Message))
		return
	}
	_, _ = fmt.Fprintf(output, "error: %s\n", safeCell(err.Error()))
}

func writeUsageError(output io.Writer, err error) {
	_, _ = fmt.Fprintf(output, "error: %s\n\n", safeCell(err.Error()))
	writeUsage(output)
}

func writeUsage(output io.Writer) {
	_, _ = io.WriteString(output, strings.TrimSpace(`
Usage:
  tlingualctl [--json] [--socket PATH] status
  tlingualctl [--json] [--socket PATH] invite create [--ttl DURATION]
  tlingualctl [--json] [--socket PATH] invite list
  tlingualctl [--json] [--socket PATH] invite revoke <invitation-id>
  tlingualctl [--json] [--socket PATH] code create --kind login --user <user-id> [--not-before RFC3339] [--ttl 10m | --expires-at RFC3339]
  tlingualctl [--json] [--socket PATH] code create --kind registration [--not-before RFC3339] [--ttl 24h | --expires-at RFC3339]
  tlingualctl [--json] [--socket PATH] users list
  tlingualctl [--json] [--socket PATH] users set-role <user-id> user|admin
  tlingualctl [--json] [--socket PATH] users enable <user-id>
  tlingualctl [--json] [--socket PATH] users disable <user-id>

The socket defaults to TLINGUAL_ADMIN_SOCKET, then data/admin.sock. The CLI
communicates only with the running server; it never opens the SQLite database.

Exit codes: 0 success, 1 control/server failure, 2 command usage error.
`)+"\n")
}
