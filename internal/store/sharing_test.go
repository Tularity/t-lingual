package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/Tularity/t-lingual/internal/domain"
)

func TestRecognitionAndSpeakerMetadataPersistence(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	user := testUser("usr_source_metadata", "source-metadata", domain.RoleUser)
	mustCreateUser(t, database, user)
	session := archiveTestSession("session_source_metadata", user.ID, testNow, domain.InterpretationCreated)
	session.SourceLanguage = "auto"
	session.RecognitionLanguages = []string{"en", "fr"}
	session.Diarization = true
	if err := database.CreateInterpretationSession(ctx, session); err != nil {
		t.Fatal(err)
	}
	got, err := database.GetInterpretationSession(ctx, user.ID, session.ID)
	if err != nil || !got.Diarization || len(got.RecognitionLanguages) != 2 || got.RecognitionLanguages[1] != "fr" {
		t.Fatalf("recognition setup = %#v, %v", got, err)
	}
	segment := domain.Segment{ID: "segment_speaker", SessionID: session.ID, UserID: user.ID,
		Sequence: 1, SourceText: "bonjour", Final: true, StartMS: 1000, EndMS: 1500,
		DetectedLanguage: "fr", SpeakerID: "speaker_1", Wall0MS: 1800, Wall1MS: 2300, CreatedAt: testNow}
	if err := database.AppendSegment(ctx, user.ID, segment); err != nil {
		t.Fatal(err)
	}
	items, err := database.ListSegments(ctx, user.ID, session.ID)
	if err != nil || len(items) != 1 || items[0].DetectedLanguage != "fr" || items[0].SpeakerID != "speaker_1" || items[0].Wall0MS != 1800 || items[0].Wall1MS != 2300 {
		t.Fatalf("source metadata = %#v, %v", items, err)
	}
	page, err := database.ListSegmentsPage(ctx, user.ID, session.ID, -1, 20)
	if err != nil || len(page.Items) != 1 || page.Items[0].Wall1MS != 2300 {
		t.Fatalf("source page = %#v, %v", page, err)
	}
}

func TestProviderEndpointsStayOwnerScopedAndHideCredentialJSON(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	alice := testUser("usr_endpoint_alice", "endpoint-alice", domain.RoleUser)
	bob := testUser("usr_endpoint_bob", "endpoint-bob", domain.RoleUser)
	mustCreateUser(t, database, alice)
	mustCreateUser(t, database, bob)
	endpoint := domain.ProviderEndpoint{
		ID: "endpoint_1", UserID: alice.ID, Provider: "asr", Name: "ASR primary",
		BaseURL: "https://asr.example.invalid", CredentialSealed: []byte("sealed-secret"),
		Configuration: json.RawMessage(`{"timeout":30}`), Enabled: true, CreatedAt: testNow, UpdatedAt: testNow,
	}
	if err := database.UpsertProviderEndpoint(ctx, alice.ID, endpoint); err != nil {
		t.Fatal(err)
	}
	if _, err := database.GetProviderEndpoint(ctx, bob.ID, endpoint.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign endpoint lookup = %v", err)
	}
	endpoint.UserID = bob.ID
	endpoint.BaseURL = "https://overwrite.example.invalid"
	if err := database.UpsertProviderEndpoint(ctx, bob.ID, endpoint); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign endpoint overwrite = %v", err)
	}
	items, err := database.ListProviderEndpoints(ctx, alice.ID)
	if err != nil || len(items) != 1 || items[0].BaseURL != "https://asr.example.invalid" || !items[0].HasCredential {
		t.Fatalf("owner endpoints = %#v, %v", items, err)
	}
	payload, err := json.Marshal(items[0])
	if err != nil || bytes.Contains(payload, []byte("sealed-secret")) {
		t.Fatalf("credential leaked into endpoint JSON: %s, %v", payload, err)
	}
	if err := database.DeleteProviderEndpoint(ctx, bob.ID, endpoint.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign endpoint delete = %v", err)
	}
}
