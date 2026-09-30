package store

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
)

func workspaceIDs() func() (string, error) {
	next := 0
	return func() (string, error) {
		next++
		return "wsp_test" + string(rune('a'+next)), nil
	}
}

func testSession(id, ownerID, workspaceID string) domain.InterpretationSession {
	return domain.InterpretationSession{
		ID: id, UserID: ownerID, WorkspaceID: workspaceID, Title: id,
		SourceLanguage: "en", TargetLanguage: "fr", Status: domain.InterpretationCompleted,
		CreatedAt: testNow, UpdatedAt: testNow,
	}
}

func mustCreateWorkspace(t *testing.T, store *Store, id, ownerID, name string, usedAt time.Time) {
	t.Helper()
	if err := store.CreateWorkspace(context.Background(), domain.Workspace{ID: id, UserID: ownerID, Name: name, CreatedAt: usedAt, UpdatedAt: usedAt, LastUsedAt: usedAt}); err != nil {
		t.Fatalf("create workspace %s: %v", id, err)
	}
}

func TestWorkspaceMigrationPlacesEveryExistingSessionInItsOwnersFirstWorkspace(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", t.TempDir()+"/pre-workspace.sqlite")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if _, err := db.ExecContext(ctx, `CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	for _, migration := range migrations {
		if migration.version > 19 {
			break
		}
		if _, err := db.ExecContext(ctx, migration.sql); err != nil {
			t.Fatalf("seed migration %d: %v", migration.version, err)
		}
		if _, err := db.ExecContext(ctx, `INSERT INTO schema_migrations(version, applied_at) VALUES (?,?)`, migration.version, encodeTime(testNow)); err != nil {
			t.Fatal(err)
		}
	}
	for _, user := range []string{"usr_alice", "usr_bob", "usr_empty"} {
		if _, err := db.ExecContext(ctx, `INSERT INTO users(id,webauthn_id,username,display_name,role,status,created_at,updated_at)
			VALUES (?,?,?,?,'user','active',?,?)`, user, []byte(user), user, user, encodeTime(testNow), encodeTime(testNow)); err != nil {
			t.Fatal(err)
		}
	}
	for _, session := range [][2]string{{"int_a1", "usr_alice"}, {"int_a2", "usr_alice"}, {"int_b1", "usr_bob"}} {
		if _, err := db.ExecContext(ctx, `INSERT INTO interpretation_sessions(id,user_id,title,source_language,target_language,status,created_at,updated_at)
			VALUES (?,?,?,'en','fr','completed',?,?)`, session[0], session[1], session[0], encodeTime(testNow), encodeTime(testNow)); err != nil {
			t.Fatal(err)
		}
	}
	database := &Store{db: db}
	if err := database.migrate(ctx); err != nil {
		t.Fatalf("upgrade old database: %v", err)
	}
	for _, owner := range []string{"usr_alice", "usr_bob", "usr_empty"} {
		workspaces, err := database.ListWorkspaces(ctx, owner)
		if err != nil || len(workspaces) != 1 || workspaces[0].Name != "" {
			t.Fatalf("%s workspaces after migration = %#v %v", owner, workspaces, err)
		}
	}
	alice, _ := database.ListWorkspaces(ctx, "usr_alice")
	if alice[0].SessionCount != 2 {
		t.Fatalf("alice's sessions were not placed in her workspace: %#v", alice[0])
	}
	for _, check := range [][2]string{{"int_a1", "usr_alice"}, {"int_b1", "usr_bob"}} {
		session, err := database.GetInterpretationSession(ctx, check[1], check[0])
		owned, _ := database.ListWorkspaces(ctx, check[1])
		if err != nil || session.WorkspaceID != owned[0].ID {
			t.Fatalf("%s kept in %q, want its owner's workspace %q (%v)", check[0], session.WorkspaceID, owned[0].ID, err)
		}
	}
}

func TestEnsureWorkspacesCreatesTheFirstOnceAndPlacesStraySessions(t *testing.T) {
	ctx := context.Background()
	store, _ := newTestStore(t)
	mustCreateUser(t, store, testUser("usr_new", "newcomer", domain.RoleUser))
	first, err := store.EnsureWorkspaces(ctx, "usr_new", testNow, workspaceIDs())
	if err != nil || len(first) != 1 || first[0].Name != "" {
		t.Fatalf("first workspaces = %#v %v", first, err)
	}
	again, err := store.EnsureWorkspaces(ctx, "usr_new", testNow, workspaceIDs())
	if err != nil || len(again) != 1 || again[0].ID != first[0].ID {
		t.Fatalf("a second call made another workspace: %#v %v", again, err)
	}
	// A session created without naming a workspace lands in the most recent one.
	mustCreateWorkspace(t, store, "wsp_recent", "usr_new", "Recent", testNow.Add(time.Hour))
	session := testSession("int_stray", "usr_new", "")
	if err := store.CreateInterpretationSession(ctx, session); err != nil {
		t.Fatal(err)
	}
	if got, _ := store.GetInterpretationSession(ctx, "usr_new", "int_stray"); got.WorkspaceID != "wsp_recent" {
		t.Fatalf("session without a workspace kept in %q, want the most recently used", got.WorkspaceID)
	}
}

func TestWorkspacesBelongOnlyToTheirOwner(t *testing.T) {
	ctx := context.Background()
	store, _ := newTestStore(t)
	mustCreateUser(t, store, testUser("usr_alice", "alice", domain.RoleUser))
	mustCreateUser(t, store, testUser("usr_mallory", "mallory", domain.RoleUser))
	mustCreateWorkspace(t, store, "wsp_alice", "usr_alice", "Alice", testNow)
	mustCreateWorkspace(t, store, "wsp_mallory", "usr_mallory", "Mallory", testNow)
	if err := store.CreateInterpretationSession(ctx, testSession("int_alice", "usr_alice", "wsp_alice")); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateInterpretationSession(ctx, testSession("int_mallory", "usr_mallory", "wsp_mallory")); err != nil {
		t.Fatal(err)
	}

	if listed, _ := store.ListWorkspaces(ctx, "usr_mallory"); len(listed) != 1 || listed[0].ID != "wsp_mallory" {
		t.Fatalf("mallory lists %#v", listed)
	}
	if _, err := store.GetWorkspace(ctx, "usr_mallory", "wsp_alice"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("mallory read alice's workspace: %v", err)
	}
	if _, err := store.UpdateWorkspace(ctx, "usr_mallory", "wsp_alice", "Mine", "users", testNow); !errors.Is(err, ErrNotFound) {
		t.Fatalf("mallory renamed alice's workspace: %v", err)
	}
	if err := store.TouchWorkspace(ctx, "usr_mallory", "wsp_alice", testNow); !errors.Is(err, ErrNotFound) {
		t.Fatalf("mallory used alice's workspace: %v", err)
	}
	if _, err := store.DeleteWorkspace(ctx, "usr_mallory", "wsp_alice", "wsp_mallory"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("mallory deleted alice's workspace: %v", err)
	}
	// Neither a session nor a workspace can cross between accounts.
	if _, err := store.MoveInterpretationSession(ctx, "usr_mallory", "int_mallory", "wsp_alice"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("mallory moved a session into alice's workspace: %v", err)
	}
	if _, err := store.MoveInterpretationSession(ctx, "usr_mallory", "int_alice", "wsp_mallory"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("mallory moved alice's session: %v", err)
	}
	if err := store.CreateInterpretationSession(ctx, testSession("int_intrude", "usr_mallory", "wsp_alice")); !errors.Is(err, ErrNotFound) {
		t.Fatalf("mallory created a session in alice's workspace: %v", err)
	}
	mallory := domain.Viewer{UserID: "usr_mallory"}
	listed, err := store.ListAccessibleInterpretationSessionsFiltered(ctx, mallory, testNow, AccessibleSessionFilter{WorkspaceID: "wsp_alice"}, 50, 0)
	if err != nil || len(listed) != 0 {
		t.Fatalf("mallory listed alice's workspace: %#v %v", listed, err)
	}
}

func TestDeletingAWorkspaceMovesItsSessionsFirst(t *testing.T) {
	ctx := context.Background()
	store, _ := newTestStore(t)
	mustCreateUser(t, store, testUser("usr_alice", "alice", domain.RoleUser))
	mustCreateWorkspace(t, store, "wsp_old", "usr_alice", "Old", testNow)
	mustCreateWorkspace(t, store, "wsp_new", "usr_alice", "New", testNow)
	for _, id := range []string{"int_1", "int_2"} {
		if err := store.CreateInterpretationSession(ctx, testSession(id, "usr_alice", "wsp_old")); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.DeleteWorkspace(ctx, "usr_alice", "wsp_old", ""); !errors.Is(err, ErrWorkspaceNotEmpty) {
		t.Fatalf("deleted a workspace holding sessions without moving them: %v", err)
	}
	if _, err := store.DeleteWorkspace(ctx, "usr_alice", "wsp_old", "wsp_old"); !errors.Is(err, ErrConflict) {
		t.Fatalf("moved sessions into the workspace being deleted: %v", err)
	}
	if kept, _ := store.GetWorkspace(ctx, "usr_alice", "wsp_old"); kept.SessionCount != 2 {
		t.Fatalf("a refused deletion changed the workspace: %#v", kept)
	}
	moved, err := store.DeleteWorkspace(ctx, "usr_alice", "wsp_old", "wsp_new")
	if err != nil || moved != 2 {
		t.Fatalf("delete with move = %d %v", moved, err)
	}
	if _, err := store.GetWorkspace(ctx, "usr_alice", "wsp_old"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("workspace still there: %v", err)
	}
	if kept, _ := store.GetWorkspace(ctx, "usr_alice", "wsp_new"); kept.SessionCount != 2 {
		t.Fatalf("sessions did not arrive: %#v", kept)
	}
	// The last workspace stays, empty or not.
	if _, err := store.DeleteWorkspace(ctx, "usr_alice", "wsp_new", ""); !errors.Is(err, ErrLastWorkspace) {
		t.Fatalf("deleted the last workspace: %v", err)
	}
	// An empty one goes without a destination.
	mustCreateWorkspace(t, store, "wsp_empty", "usr_alice", "Empty", testNow)
	if moved, err := store.DeleteWorkspace(ctx, "usr_alice", "wsp_empty", ""); err != nil || moved != 0 {
		t.Fatalf("delete empty = %d %v", moved, err)
	}
}

func TestSessionListsNarrowToAWorkspaceOrToWhatWasShared(t *testing.T) {
	ctx := context.Background()
	store, _ := newTestStore(t)
	mustCreateUser(t, store, testUser("usr_alice", "alice", domain.RoleUser))
	mustCreateUser(t, store, testUser("usr_bob", "bob", domain.RoleUser))
	mustCreateWorkspace(t, store, "wsp_a", "usr_alice", "A", testNow)
	mustCreateWorkspace(t, store, "wsp_b", "usr_alice", "B", testNow)
	mustCreateWorkspace(t, store, "wsp_bob", "usr_bob", "Bob", testNow)
	for _, session := range []domain.InterpretationSession{testSession("int_a", "usr_alice", "wsp_a"), testSession("int_b", "usr_alice", "wsp_b"), testSession("int_bob", "usr_bob", "wsp_bob")} {
		if err := store.CreateInterpretationSession(ctx, session); err != nil {
			t.Fatal(err)
		}
	}
	recipient := "usr_alice"
	if err := store.CreateSessionShare(ctx, "usr_bob", domain.SessionShare{ID: "shr_bob", SessionID: "int_bob", OwnerUserID: "usr_bob", Kind: domain.ShareUser, Permission: domain.ShareView, RecipientUserID: &recipient, CreatedAt: testNow}, nil, nil); err != nil {
		t.Fatal(err)
	}
	alice := domain.Viewer{UserID: "usr_alice"}
	ids := func(filter AccessibleSessionFilter) []string {
		t.Helper()
		items, err := store.ListAccessibleInterpretationSessionsFiltered(ctx, alice, testNow, filter, 50, 0)
		if err != nil {
			t.Fatal(err)
		}
		result := make([]string, 0, len(items))
		for _, item := range items {
			result = append(result, item.ID)
		}
		return result
	}
	if got := ids(AccessibleSessionFilter{WorkspaceID: "wsp_a"}); len(got) != 1 || got[0] != "int_a" {
		t.Fatalf("workspace A lists %v", got)
	}
	if got := ids(AccessibleSessionFilter{SharedOnly: true}); len(got) != 1 || got[0] != "int_bob" {
		t.Fatalf("shared lists %v", got)
	}
	if got := ids(AccessibleSessionFilter{}); len(got) != 3 {
		t.Fatalf("everything lists %v", got)
	}
}

func TestWorkspacesAreCapped(t *testing.T) {
	ctx := context.Background()
	store, _ := newTestStore(t)
	mustCreateUser(t, store, testUser("usr_alice", "alice", domain.RoleUser))
	for index := 0; index < MaxWorkspacesPerUser; index++ {
		mustCreateWorkspace(t, store, "wsp_"+string(rune('a'+index%26))+string(rune('a'+index/26)), "usr_alice", "W", testNow)
	}
	err := store.CreateWorkspace(ctx, domain.Workspace{ID: "wsp_overflow", UserID: "usr_alice", Name: "W", CreatedAt: testNow, UpdatedAt: testNow, LastUsedAt: testNow})
	if !errors.Is(err, ErrCapacity) {
		t.Fatalf("workspace beyond the limit: %v", err)
	}
}
