package rooms

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// The recognizer settles how an utterance ends only once the next one has
// begun, so the mark that closes a line — a comma, a full stop, a question
// mark — arrives at the start of the next line instead of the end of its own.
const closingMarks = "，。？！、；：,.?!;:…"

// splitLeadingMark returns the closing marks a line begins with, and the rest
// of the line after them and any space.
func splitLeadingMark(text string) (mark, rest string) {
	trimmed := strings.TrimLeftFunc(text, unicode.IsSpace)
	end := 0
	for end < len(trimmed) {
		r, size := utf8.DecodeRuneInString(trimmed[end:])
		if !strings.ContainsRune(closingMarks, r) {
			break
		}
		end += size
	}
	if end == 0 {
		return "", text
	}
	return trimmed[:end], strings.TrimLeftFunc(trimmed[end:], unicode.IsSpace)
}

// endsWithMark reports whether a line already ends with a closing mark.
func endsWithMark(text string) bool {
	r, _ := utf8.DecodeLastRuneInString(strings.TrimRightFunc(text, unicode.IsSpace))
	return r != utf8.RuneError && strings.ContainsRune(closingMarks, r)
}

// lastFinal is the line a recognition stream saved last, which a closing mark
// at the start of its next line belongs to.
type lastFinal struct {
	id   string
	text string
}

// returnMark gives a stream's previous line the closing mark its next line
// began with, unless it already ends with one, and tells everyone watching.
// It returns the previous line's text afterwards.
func (s *Service) returnMark(sessionID, ownerID string, previous lastFinal, mark string) lastFinal {
	if previous.id == "" || mark == "" || endsWithMark(previous.text) {
		return previous
	}
	ctx, cancel := asrPersistenceContext(s.ctx)
	defer cancel()
	text := strings.TrimRightFunc(previous.text, unicode.IsSpace) + mark
	if err := s.store.ReplaceSegmentSource(ctx, ownerID, sessionID, previous.id, previous.text, text); err != nil {
		s.logger.Warn("return closing mark", "session_id", sessionID, "segment_id", previous.id, "error", err)
		return previous
	}
	s.broadcast(sessionID, roomEvent{data: map[string]any{"type": "source_text", "segmentId": previous.id, "sourceText": text}})
	return lastFinal{id: previous.id, text: text}
}
