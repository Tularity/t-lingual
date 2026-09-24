package rooms

import (
	"context"

	"github.com/Tularity/t-lingual/internal/domain"
	"github.com/Tularity/t-lingual/internal/store"
)

// UpdateIdleSession serializes configuration changes against recording
// reservations, including the period before the WebSocket hello is received.
func (s *Service) UpdateIdleSession(ctx context.Context, viewer domain.Viewer, sessionID string,
	change func(domain.SessionAccess) (domain.InterpretationSession, error),
) (domain.InterpretationSession, error) {
	access, err := s.resolve(ctx, viewer, sessionID)
	if err != nil {
		return domain.InterpretationSession{}, err
	}
	if !access.IsOwner {
		return domain.InterpretationSession{}, store.ErrForbidden
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if current := s.rooms[sessionID]; current != nil && current.recorder != nil {
		return domain.InterpretationSession{}, ErrOccupied
	}
	return change(access)
}

// RefreshSession asks current viewers to bootstrap the latest session metadata.
func (s *Service) RefreshSession(sessionID string) {
	s.mu.Lock()
	var callbacks []context.CancelFunc
	if room := s.rooms[sessionID]; room != nil {
		for _, watch := range room.watches {
			callbacks = append(callbacks, watch.cancel)
		}
	}
	s.mu.Unlock()
	for _, cancel := range callbacks {
		cancel()
	}
}
