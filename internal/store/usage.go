package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// UsageQuery chooses whose use to add up, over which days. Days are the
// reader's own: OffsetMinutes is their distance from UTC.
type UsageQuery struct {
	// UserID limits the report to one account; empty means everyone.
	UserID        string
	WorkspaceID   string
	From, To      time.Time
	OffsetMinutes int
}

// UsageDay is one local day's use.
type UsageDay struct {
	Date                  string  `json:"date"`
	RecordedSeconds       float64 `json:"recordedSeconds"`
	SpeechSeconds         float64 `json:"speechSeconds"`
	Sessions              int     `json:"sessions"`
	Segments              int     `json:"segments"`
	SourceCharacters      int     `json:"sourceCharacters"`
	Translations          int     `json:"translations"`
	TranslationCharacters int     `json:"translationCharacters"`
	TranslationFailures   int     `json:"translationFailures"`
	Shares                int     `json:"shares"`
	// Only in reports on everyone.
	ActiveUsers int `json:"activeUsers,omitempty"`
	SignIns     int `json:"signIns,omitempty"`
	NewUsers    int `json:"newUsers,omitempty"`
	GuestViews  int `json:"guestViews,omitempty"`
}

// Labeled is one slice of a breakdown.
type Labeled struct {
	Key   string  `json:"key"`
	Label string  `json:"label,omitempty"`
	Value float64 `json:"value"`
	Count int     `json:"count,omitempty"`
}

// SessionUsage is one session's share of the recording.
type SessionUsage struct {
	ID              string    `json:"id"`
	Title           string    `json:"title"`
	OwnerName       string    `json:"ownerName,omitempty"`
	RecordedSeconds float64   `json:"recordedSeconds"`
	Segments        int       `json:"segments"`
	CreatedAt       time.Time `json:"createdAt"`
}

// UserUsage is one account's use, for the administrators' ranking.
type UserUsage struct {
	ID              string     `json:"id"`
	DisplayName     string     `json:"displayName"`
	Username        string     `json:"username"`
	AvatarVersion   int64      `json:"avatarVersion,omitempty"`
	RecordedSeconds float64    `json:"recordedSeconds"`
	Sessions        int        `json:"sessions"`
	Translations    int        `json:"translations"`
	StorageBytes    int64      `json:"storageBytes"`
	LastSeen        *time.Time `json:"lastSeen"`
}

// UsageReport is everything the usage pages draw.
type UsageReport struct {
	From        time.Time      `json:"from"`
	To          time.Time      `json:"to"`
	Days        []UsageDay     `json:"days"`
	Languages   []Labeled      `json:"languages"`
	Targets     []Labeled      `json:"targets"`
	Workspaces  []Labeled      `json:"workspaces"`
	Hours       [7][24]float64 `json:"hours"`
	TopSessions []SessionUsage `json:"topSessions"`
	Speakers    []Labeled      `json:"speakers"`
	// Kept, whatever the range.
	AudioBytes      int64 `json:"audioBytes"`
	TranscriptBytes int64 `json:"transcriptBytes"`
	// Only in reports on everyone.
	Users               []UserUsage `json:"users,omitempty"`
	TranslationFailures []Labeled   `json:"translationFailures,omitempty"`
	SessionStatuses     []Labeled   `json:"sessionStatuses,omitempty"`
}

const maxUsageDays = 366

// Usage adds up one account's, or everyone's, use over a range of days.
func (s *Store) Usage(ctx context.Context, query UsageQuery) (UsageReport, error) {
	if !query.To.After(query.From) || query.To.Sub(query.From) > maxUsageDays*24*time.Hour ||
		query.OffsetMinutes < -14*60 || query.OffsetMinutes > 14*60 {
		return UsageReport{}, errors.New("store: invalid usage range")
	}
	report := UsageReport{From: query.From, To: query.To, Days: make([]UsageDay, 0), Languages: make([]Labeled, 0),
		Targets: make([]Labeled, 0), Workspaces: make([]Labeled, 0), TopSessions: make([]SessionUsage, 0), Speakers: make([]Labeled, 0)}
	offset := int64(query.OffsetMinutes) * 60
	from, to := encodeTime(query.From), encodeTime(query.To)
	everyone := query.UserID == ""
	// Every table here reaches its session; the filters are on the session.
	scope := func(alias string) (string, []any) {
		clause, args := "", []any{}
		if !everyone {
			clause += " AND " + alias + ".user_id = ?"
			args = append(args, query.UserID)
		}
		if query.WorkspaceID != "" {
			clause += " AND " + alias + ".workspace_id = ?"
			args = append(args, query.WorkspaceID)
		}
		return clause, args
	}
	day := func(column string) string {
		return "strftime('%Y-%m-%d', " + column + " / 1000000000 + ?, 'unixepoch')"
	}
	days := map[string]*UsageDay{}
	at := func(date string) *UsageDay {
		if days[date] == nil {
			days[date] = &UsageDay{Date: date}
		}
		return days[date]
	}
	collect := func(sqlText string, args []any, apply func(*sql.Rows) error) error {
		rows, err := s.db.QueryContext(ctx, sqlText, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			if err := apply(rows); err != nil {
				return err
			}
		}
		return rows.Err()
	}
	sessionScope, sessionArgs := scope("session")
	perDay := []struct {
		sql  string
		args func() []any
		set  func(*UsageDay, float64, int)
	}{
		{`SELECT ` + day("part.created_at") + ` AS day, SUM(part.frames * 1.0 / part.sample_rate), 0 FROM recording_parts part
			JOIN interpretation_sessions session ON session.id = part.session_id
			WHERE part.created_at >= ? AND part.created_at < ?` + sessionScope + ` GROUP BY day`,
			func() []any { return append([]any{offset, from, to}, sessionArgs...) },
			func(d *UsageDay, v float64, _ int) { d.RecordedSeconds = v }},
		{`SELECT ` + day("segment.created_at") + ` AS day, SUM((segment.end_ms - segment.start_ms) / 1000.0), COUNT(*),
			SUM(length(segment.source_text)) FROM segments segment
			JOIN interpretation_sessions session ON session.id = segment.session_id
			WHERE segment.created_at >= ? AND segment.created_at < ?` + sessionScope + ` GROUP BY day`,
			func() []any { return append([]any{offset, from, to}, sessionArgs...) }, nil},
		{`SELECT ` + day("session.created_at") + ` AS day, 0, COUNT(*) FROM interpretation_sessions session
			WHERE session.created_at >= ? AND session.created_at < ?` + sessionScope + ` GROUP BY day`,
			func() []any { return append([]any{offset, from, to}, sessionArgs...) },
			func(d *UsageDay, _ float64, n int) { d.Sessions = n }},
		{`SELECT ` + day("translation.updated_at") + ` AS day, SUM(CASE WHEN translation.status = 'succeeded' THEN length(translation.text) ELSE 0 END),
			SUM(translation.status = 'succeeded'), SUM(translation.status = 'failed') FROM segment_translations translation
			JOIN interpretation_sessions session ON session.id = translation.session_id
			WHERE translation.updated_at >= ? AND translation.updated_at < ?` + sessionScope + ` GROUP BY day`,
			func() []any { return append([]any{offset, from, to}, sessionArgs...) }, nil},
		{`SELECT ` + day("share.created_at") + ` AS day, 0, COUNT(*) FROM session_shares share
			JOIN interpretation_sessions session ON session.id = share.session_id
			WHERE share.created_at >= ? AND share.created_at < ?` + sessionScope + ` GROUP BY day`,
			func() []any { return append([]any{offset, from, to}, sessionArgs...) },
			func(d *UsageDay, _ float64, n int) { d.Shares = n }},
	}
	for index, item := range perDay {
		index, item := index, item
		err := collect(item.sql, item.args(), func(rows *sql.Rows) error {
			var date string
			switch index {
			case 1:
				var seconds sql.NullFloat64
				var count int
				var characters sql.NullInt64
				if err := rows.Scan(&date, &seconds, &count, &characters); err != nil {
					return err
				}
				entry := at(date)
				entry.SpeechSeconds, entry.Segments, entry.SourceCharacters = seconds.Float64, count, int(characters.Int64)
			case 3:
				var characters, succeeded, failed sql.NullInt64
				if err := rows.Scan(&date, &characters, &succeeded, &failed); err != nil {
					return err
				}
				entry := at(date)
				entry.TranslationCharacters, entry.Translations, entry.TranslationFailures = int(characters.Int64), int(succeeded.Int64), int(failed.Int64)
			default:
				var value sql.NullFloat64
				var count int
				if err := rows.Scan(&date, &value, &count); err != nil {
					return err
				}
				item.set(at(date), value.Float64, count)
			}
			return nil
		})
		if err != nil {
			return UsageReport{}, fmt.Errorf("store: usage by day: %w", err)
		}
	}
	if everyone && query.WorkspaceID == "" {
		extra := []struct {
			sql string
			set func(*UsageDay, int)
		}{
			{`SELECT ` + day("created_at") + ` AS day, COUNT(DISTINCT user_id) FROM segments
				WHERE created_at >= ? AND created_at < ? GROUP BY day`, func(d *UsageDay, n int) { d.ActiveUsers = n }},
			{`SELECT ` + day("created_at") + ` AS day, COUNT(*) FROM browser_sessions
				WHERE created_at >= ? AND created_at < ? GROUP BY day`, func(d *UsageDay, n int) { d.SignIns = n }},
			{`SELECT ` + day("created_at") + ` AS day, COUNT(*) FROM users
				WHERE created_at >= ? AND created_at < ? GROUP BY day`, func(d *UsageDay, n int) { d.NewUsers = n }},
			{`SELECT ` + day("created_at") + ` AS day, COUNT(*) FROM guest_sessions
				WHERE created_at >= ? AND created_at < ? GROUP BY day`, func(d *UsageDay, n int) { d.GuestViews = n }},
		}
		for _, item := range extra {
			item := item
			err := collect(item.sql, []any{offset, from, to}, func(rows *sql.Rows) error {
				var date string
				var count int
				if err := rows.Scan(&date, &count); err != nil {
					return err
				}
				item.set(at(date), count)
				return nil
			})
			if err != nil {
				return UsageReport{}, fmt.Errorf("store: site activity by day: %w", err)
			}
		}
	}
	for date := query.From.Add(time.Duration(offset) * time.Second); date.Before(query.To.Add(time.Duration(offset) * time.Second)); date = date.Add(24 * time.Hour) {
		key := date.UTC().Format("2006-01-02")
		report.Days = append(report.Days, *at(key))
	}

	labeled := func(sqlText string, args []any) ([]Labeled, error) {
		rows, err := s.db.QueryContext(ctx, sqlText, args...)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		items := make([]Labeled, 0)
		for rows.Next() {
			var item Labeled
			var label sql.NullString
			if err := rows.Scan(&item.Key, &label, &item.Value, &item.Count); err != nil {
				return nil, err
			}
			item.Label = label.String
			items = append(items, item)
		}
		return items, rows.Err()
	}
	var err error
	rangeArgs := append([]any{from, to}, sessionArgs...)
	if report.Languages, err = labeled(`SELECT CASE WHEN segment.detected_language = '' THEN 'unknown' ELSE segment.detected_language END AS language,
		NULL, SUM((segment.end_ms - segment.start_ms) / 1000.0), COUNT(*) FROM segments segment
		JOIN interpretation_sessions session ON session.id = segment.session_id
		WHERE segment.created_at >= ? AND segment.created_at < ?`+sessionScope+`
		GROUP BY language ORDER BY 3 DESC LIMIT 12`, rangeArgs); err != nil {
		return UsageReport{}, fmt.Errorf("store: usage by language: %w", err)
	}
	if report.Targets, err = labeled(`SELECT translation.target_language, NULL, SUM(length(translation.text)), COUNT(*)
		FROM segment_translations translation JOIN interpretation_sessions session ON session.id = translation.session_id
		WHERE translation.status = 'succeeded' AND translation.updated_at >= ? AND translation.updated_at < ?`+sessionScope+`
		GROUP BY translation.target_language ORDER BY 4 DESC LIMIT 12`, rangeArgs); err != nil {
		return UsageReport{}, fmt.Errorf("store: usage by target: %w", err)
	}
	if report.Speakers, err = labeled(`SELECT CASE WHEN segment.speaker_id = '' THEN 'none' ELSE segment.speaker_id END AS speaker,
		NULL, SUM((segment.end_ms - segment.start_ms) / 1000.0), COUNT(*) FROM segments segment
		JOIN interpretation_sessions session ON session.id = segment.session_id
		WHERE segment.created_at >= ? AND segment.created_at < ?`+sessionScope+`
		GROUP BY speaker ORDER BY 3 DESC LIMIT 8`, rangeArgs); err != nil {
		return UsageReport{}, fmt.Errorf("store: usage by speaker: %w", err)
	}
	if !everyone && query.WorkspaceID == "" {
		if report.Workspaces, err = labeled(`SELECT COALESCE(session.workspace_id, ''), MAX(workspace.name),
			SUM(part.frames * 1.0 / part.sample_rate), COUNT(DISTINCT session.id) FROM recording_parts part
			JOIN interpretation_sessions session ON session.id = part.session_id
			LEFT JOIN workspaces workspace ON workspace.id = session.workspace_id
			WHERE part.created_at >= ? AND part.created_at < ? AND session.user_id = ?
			GROUP BY session.workspace_id ORDER BY 3 DESC LIMIT 12`, []any{from, to, query.UserID}); err != nil {
			return UsageReport{}, fmt.Errorf("store: usage by workspace: %w", err)
		}
	}
	hours, err := s.db.QueryContext(ctx, `SELECT CAST(strftime('%w', segment.created_at / 1000000000 + ?, 'unixepoch') AS INTEGER),
		CAST(strftime('%H', segment.created_at / 1000000000 + ?, 'unixepoch') AS INTEGER),
		SUM((segment.end_ms - segment.start_ms) / 1000.0) FROM segments segment
		JOIN interpretation_sessions session ON session.id = segment.session_id
		WHERE segment.created_at >= ? AND segment.created_at < ?`+sessionScope+` GROUP BY 1, 2`,
		append([]any{offset, offset, from, to}, sessionArgs...)...)
	if err != nil {
		return UsageReport{}, fmt.Errorf("store: usage by hour: %w", err)
	}
	for hours.Next() {
		var weekday, hour int
		var seconds float64
		if err := hours.Scan(&weekday, &hour, &seconds); err != nil {
			hours.Close()
			return UsageReport{}, fmt.Errorf("store: scan usage hour: %w", err)
		}
		if weekday >= 0 && weekday < 7 && hour >= 0 && hour < 24 {
			report.Hours[weekday][hour] = seconds
		}
	}
	hours.Close()
	top, err := s.db.QueryContext(ctx, `SELECT session.id, session.title, owner.display_name,
		SUM(part.frames * 1.0 / part.sample_rate), session.segment_count, session.created_at
		FROM recording_parts part JOIN interpretation_sessions session ON session.id = part.session_id
		JOIN users owner ON owner.id = session.user_id
		WHERE part.created_at >= ? AND part.created_at < ?`+sessionScope+`
		GROUP BY session.id ORDER BY 4 DESC LIMIT 8`, rangeArgs...)
	if err != nil {
		return UsageReport{}, fmt.Errorf("store: top sessions: %w", err)
	}
	for top.Next() {
		var item SessionUsage
		var created int64
		if err := top.Scan(&item.ID, &item.Title, &item.OwnerName, &item.RecordedSeconds, &item.Segments, &created); err != nil {
			top.Close()
			return UsageReport{}, fmt.Errorf("store: scan top session: %w", err)
		}
		item.CreatedAt = decodeTime(created)
		if !everyone {
			item.OwnerName = ""
		}
		report.TopSessions = append(report.TopSessions, item)
	}
	top.Close()
	storageScope, storageArgs := scope("session")
	var audio, transcripts sql.NullInt64
	if err := s.db.QueryRowContext(ctx, `SELECT
		(SELECT SUM(part.bytes) FROM recording_parts part JOIN interpretation_sessions session ON session.id = part.session_id WHERE 1 = 1`+storageScope+`),
		(SELECT SUM(session.transcript_bytes) FROM interpretation_sessions session WHERE 1 = 1`+storageScope+`)`,
		append(append([]any{}, storageArgs...), storageArgs...)...).Scan(&audio, &transcripts); err != nil {
		return UsageReport{}, fmt.Errorf("store: usage storage: %w", err)
	}
	report.AudioBytes, report.TranscriptBytes = audio.Int64, transcripts.Int64
	if everyone {
		if report.Users, err = s.usageByUser(ctx, from, to); err != nil {
			return UsageReport{}, err
		}
		if report.TranslationFailures, err = labeled(`SELECT CASE WHEN error = '' THEN 'unknown' ELSE error END, NULL, 0, COUNT(*)
			FROM segment_translations WHERE status = 'failed' AND updated_at >= ? AND updated_at < ?
			GROUP BY 1 ORDER BY 4 DESC LIMIT 12`, []any{from, to}); err != nil {
			return UsageReport{}, fmt.Errorf("store: translation failures: %w", err)
		}
		if report.SessionStatuses, err = labeled(`SELECT CASE WHEN archived_at IS NOT NULL THEN 'archived' ELSE status END, NULL, 0, COUNT(*)
			FROM interpretation_sessions WHERE created_at >= ? AND created_at < ? GROUP BY 1 ORDER BY 4 DESC`, []any{from, to}); err != nil {
			return UsageReport{}, fmt.Errorf("store: session statuses: %w", err)
		}
	}
	return report, nil
}

func (s *Store) usageByUser(ctx context.Context, from, to int64) ([]UserUsage, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT u.id, u.display_name, u.username, u.avatar_version,
		COALESCE((SELECT SUM(part.frames * 1.0 / part.sample_rate) FROM recording_parts part
			WHERE part.user_id = u.id AND part.created_at >= ? AND part.created_at < ?), 0),
		(SELECT COUNT(*) FROM interpretation_sessions session WHERE session.user_id = u.id AND session.created_at >= ? AND session.created_at < ?),
		(SELECT COUNT(*) FROM segment_translations translation JOIN interpretation_sessions session ON session.id = translation.session_id
			WHERE session.user_id = u.id AND translation.status = 'succeeded' AND translation.updated_at >= ? AND translation.updated_at < ?),
		COALESCE((SELECT SUM(bytes) FROM recording_parts WHERE user_id = u.id), 0)
			+ COALESCE((SELECT SUM(transcript_bytes) FROM interpretation_sessions WHERE user_id = u.id), 0),
		(SELECT MAX(last_seen) FROM browser_sessions WHERE user_id = u.id)
		FROM users u ORDER BY 5 DESC, u.created_at DESC LIMIT 200`, from, to, from, to, from, to)
	if err != nil {
		return nil, fmt.Errorf("store: usage by user: %w", err)
	}
	defer rows.Close()
	users := make([]UserUsage, 0)
	for rows.Next() {
		var item UserUsage
		var lastSeen sql.NullInt64
		if err := rows.Scan(&item.ID, &item.DisplayName, &item.Username, &item.AvatarVersion, &item.RecordedSeconds,
			&item.Sessions, &item.Translations, &item.StorageBytes, &lastSeen); err != nil {
			return nil, fmt.Errorf("store: scan usage by user: %w", err)
		}
		item.LastSeen = decodeOptionalTime(lastSeen)
		users = append(users, item)
	}
	return users, rows.Err()
}
