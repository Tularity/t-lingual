package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/workspace"
)

func TestSegmentWindowAPIPaginationSearchAndIsolation(t *testing.T) {
	fixture := newAPIFixture(t)
	ctx := context.Background()
	owner := fixture.users["alice"]
	session, err := fixture.workspace.Create(ctx, owner.ID, workspace.CreateInput{
		Title: "Private transcript", SourceLanguage: "en", TargetLanguage: "fr",
	})
	if err != nil {
		t.Fatal(err)
	}
	for index, item := range []struct {
		sequence int64
		source   string
		text     string
	}{
		{10, "100% clear", "Un"}, {20, "under_score", "Deux"},
		{30, "Ordinary", "Bonjour"}, {40, "Bonjour", "Quatre"}, {50, "Last", "Cinq"},
	} {
		if err := fixture.store.AppendSegment(ctx, owner.ID, domain.Segment{
			ID: fmt.Sprintf("seg_window_api_%d", index), SessionID: session.ID, UserID: owner.ID,
			Sequence: item.sequence, SourceText: item.source, Translation: item.text,
			TranslationStatus: domain.TranslationSucceeded, Final: true,
			StartMS: item.sequence * 100, EndMS: item.sequence*100 + 50,
			CreatedAt: time.Now().UTC().Add(time.Duration(index) * time.Second),
		}); err != nil {
			t.Fatal(err)
		}
	}
	base := "/api/v1/sessions/" + session.ID + "/segments"
	type pageResponse struct {
		Items         []domain.Segment `json:"items"`
		NextAfter     int64            `json:"nextAfter"`
		HasMore       bool             `json:"hasMore"`
		HasEarlier    bool             `json:"hasEarlier"`
		HasLater      bool             `json:"hasLater"`
		FirstSequence int64            `json:"firstSequence"`
		LastSequence  int64            `json:"lastSequence"`
		Limit         int              `json:"limit"`
	}
	getPage := func(t *testing.T, suffix string) pageResponse {
		t.Helper()
		response := fixture.request(t, http.MethodGet, base+suffix, "", "alice", false)
		if response.Code != http.StatusOK {
			t.Fatalf("page %s = %d: %s", suffix, response.Code, response.Body.String())
		}
		var page pageResponse
		if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
			t.Fatal(err)
		}
		return page
	}
	for _, test := range []struct {
		suffix   string
		sequence []int64
		earlier  bool
		later    bool
		more     bool
	}{
		{"?after=20&limit=2", []int64{30, 40}, true, true, true},
		{"?before=40&limit=2", []int64{20, 30}, true, true, true},
		{"?tail=true&limit=2", []int64{40, 50}, true, false, true},
		{"?before=10&limit=2", nil, false, true, false},
		{"?tail=true&limit=2&search=" + url.QueryEscape("100%"), []int64{10}, false, false, false},
		{"?search=" + url.QueryEscape("_") + "&limit=2", []int64{20}, false, false, false},
		{"?search=Bonjour&limit=2", []int64{30, 40}, false, false, false},
	} {
		page := getPage(t, test.suffix)
		if len(page.Items) != len(test.sequence) || page.Limit != 2 ||
			page.HasEarlier != test.earlier || page.HasLater != test.later || page.HasMore != test.more {
			t.Fatalf("page %s = %#v", test.suffix, page)
		}
		for index, sequence := range test.sequence {
			if page.Items[index].Sequence != sequence {
				t.Fatalf("page %s item %d sequence = %d, want %d", test.suffix, index, page.Items[index].Sequence, sequence)
			}
		}
		if len(test.sequence) > 0 {
			if page.FirstSequence != test.sequence[0] || page.LastSequence != test.sequence[len(test.sequence)-1] || page.NextAfter != page.LastSequence {
				t.Fatalf("page %s metadata = %#v", test.suffix, page)
			}
		} else if page.FirstSequence != 0 || page.LastSequence != 0 || page.NextAfter != 0 {
			t.Fatalf("empty page %s metadata = %#v", test.suffix, page)
		}
	}
	for _, suffix := range []string{"?after=0", "?before=10", "?tail=true", "?tail=true&search=absent"} {
		response := fixture.request(t, http.MethodGet, base+suffix, "", "bob", false)
		if response.Code != http.StatusNotFound || strings.Contains(response.Body.String(), "Private transcript") {
			t.Fatalf("cross-owner page %s = %d: %s", suffix, response.Code, response.Body.String())
		}
	}
	for _, suffix := range []string{
		"?after=-1", "?before=-1", "?before=wat", "?limit=201", "?tail=maybe",
		"?after=10&before=20", "?after=10&tail=true", "?before=20&tail=true",
		"?after=10&after=20", "?search=" + url.QueryEscape(strings.Repeat("a", 121)),
	} {
		response := fixture.request(t, http.MethodGet, base+suffix, "", "alice", false)
		if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), `"code":"INVALID_PAGINATION"`) {
			t.Fatalf("invalid query %s = %d: %s", suffix, response.Code, response.Body.String())
		}
	}
}
