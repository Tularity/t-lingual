package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/Tularity/t-lingual/internal/domain"
)

func TestSegmentWindowModesSearchAndOwnership(t *testing.T) {
	database, _ := newTestStore(t)
	ctx := context.Background()
	owner := testUser("usr_window_owner", "window-owner", domain.RoleUser)
	mustCreateUser(t, database, owner)
	session := domain.InterpretationSession{
		ID: "session_window", UserID: owner.ID, Title: "Transcript window",
		SourceLanguage: "en", TargetLanguage: "fr", Status: domain.InterpretationCompleted,
		CreatedAt: testNow, UpdatedAt: testNow,
	}
	if err := database.CreateInterpretationSession(ctx, session); err != nil {
		t.Fatal(err)
	}
	for index, item := range []struct {
		sequence int64
		source   string
		text     string
	}{
		{10, "Percent 100%", "Un"},
		{20, "under_score", "Deux"},
		{30, `slash\test`, "Trois"},
		{40, "Ordinary", "Bonjour"},
		{50, "Bonjour", "Cinq"},
		{60, "Last", "Six"},
	} {
		if err := database.AppendSegment(ctx, owner.ID, domain.Segment{
			ID: "segment_window_" + string(rune('a'+index)), SessionID: session.ID,
			UserID: owner.ID, Sequence: item.sequence, SourceText: item.source,
			Translation: item.text, TranslationStatus: domain.TranslationSucceeded,
			Final: true, StartMS: item.sequence * 100, EndMS: item.sequence*100 + 50,
			CreatedAt: testNow.Add(time.Duration(index) * time.Second),
		}); err != nil {
			t.Fatal(err)
		}
	}

	tests := []struct {
		name      string
		query     SegmentPageQuery
		sequences []int64
		earlier   bool
		later     bool
		more      bool
		next      int64
	}{
		{"forward", SegmentPageQuery{Mode: SegmentPageAfter, Sequence: -1, Limit: 2}, []int64{10, 20}, false, true, true, 20},
		{"before", SegmentPageQuery{Mode: SegmentPageBefore, Sequence: 50, Limit: 2}, []int64{30, 40}, true, true, true, 40},
		{"tail", SegmentPageQuery{Mode: SegmentPageTail, Limit: 2}, []int64{50, 60}, true, false, true, 60},
		{"before empty", SegmentPageQuery{Mode: SegmentPageBefore, Sequence: 10, Limit: 2}, nil, false, true, false, 0},
		{"after empty", SegmentPageQuery{Mode: SegmentPageAfter, Sequence: 60, Limit: 2}, nil, true, false, false, 0},
		{"literal percent", SegmentPageQuery{Mode: SegmentPageAfter, Sequence: -1, Limit: 2, Search: "%"}, []int64{10}, false, false, false, 10},
		{"literal underscore", SegmentPageQuery{Mode: SegmentPageAfter, Sequence: -1, Limit: 2, Search: "_"}, []int64{20}, false, false, false, 20},
		{"literal slash", SegmentPageQuery{Mode: SegmentPageAfter, Sequence: -1, Limit: 2, Search: `\`}, []int64{30}, false, false, false, 30},
		{"source and translation", SegmentPageQuery{Mode: SegmentPageTail, Limit: 1, Search: "Bonjour"}, []int64{50}, true, false, true, 50},
		{"no matches", SegmentPageQuery{Mode: SegmentPageTail, Limit: 2, Search: "no match"}, nil, false, false, false, 0},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			page, err := database.ListSegmentsWindow(ctx, owner.ID, session.ID, test.query)
			if err != nil {
				t.Fatal(err)
			}
			if len(page.Items) != len(test.sequences) {
				t.Fatalf("items = %#v, want sequences %v", page.Items, test.sequences)
			}
			for index, sequence := range test.sequences {
				if page.Items[index].Sequence != sequence {
					t.Fatalf("sequence %d = %d, want %d", index, page.Items[index].Sequence, sequence)
				}
			}
			first := int64(0)
			if len(test.sequences) > 0 {
				first = test.sequences[0]
			}
			if page.HasEarlier != test.earlier || page.HasLater != test.later || page.HasMore != test.more ||
				page.FirstSequence != first || page.LastSequence != test.next || page.NextAfter != test.next {
				t.Fatalf("page metadata = %#v", page)
			}
		})
	}
	for _, query := range []SegmentPageQuery{
		{Mode: SegmentPageBefore, Sequence: 10, Limit: 2},
		{Mode: SegmentPageTail, Limit: 2, Search: "no match"},
	} {
		if _, err := database.ListSegmentsWindow(ctx, "usr_other", session.ID, query); !errors.Is(err, ErrNotFound) {
			t.Fatalf("cross-owner window query = %v, want not found", err)
		}
	}
	for _, query := range []SegmentPageQuery{
		{Mode: SegmentPageAfter, Sequence: -2, Limit: 2},
		{Mode: SegmentPageBefore, Sequence: -1, Limit: 2},
		{Mode: SegmentPageTail, Sequence: 1, Limit: 2},
		{Mode: SegmentPageTail, Limit: 201},
		{Mode: SegmentPageTail, Limit: 2, Search: "line\nbreak"},
	} {
		if _, err := database.ListSegmentsWindow(ctx, owner.ID, session.ID, query); err == nil {
			t.Fatalf("accepted invalid query %#v", query)
		}
	}
}
