package api

import "sync"

// authenticatedAdmission bounds all ordinary cookie-authenticated work before
// it can queue on SQLite's single connection. Prefix and global admission are
// acquired atomically, so a busy prefix cannot reserve slots while waiting for
// global capacity. Entries exist only while requests are active and are deleted
// when their reference count returns to zero.
type authenticatedAdmission struct {
	mu sync.Mutex

	globalActive int
	globalLimit  int

	clients          map[string]int
	perClientLimit   int
	maxClientEntries int

	users          map[string]int
	perUserLimit   int
	maxUserEntries int
}

type authenticatedAdmissionRejection uint8

const (
	authenticatedAdmitted authenticatedAdmissionRejection = iota
	authenticatedClientBusy
	authenticatedUserBusy
	authenticatedServiceBusy
)

func newAuthenticatedAdmission(
	globalLimit int,
	perClientLimit int,
	perUserLimit int,
	maxClientEntries int,
	maxUserEntries int,
) *authenticatedAdmission {
	if globalLimit <= 0 {
		globalLimit = 1
	}
	if perClientLimit <= 0 || perClientLimit > globalLimit {
		perClientLimit = globalLimit
	}
	if perUserLimit <= 0 || perUserLimit > globalLimit {
		perUserLimit = globalLimit
	}
	if maxClientEntries <= 0 || maxClientEntries > globalLimit {
		maxClientEntries = globalLimit
	}
	if maxUserEntries <= 0 || maxUserEntries > globalLimit {
		maxUserEntries = globalLimit
	}
	return &authenticatedAdmission{
		globalLimit:      globalLimit,
		clients:          make(map[string]int),
		perClientLimit:   perClientLimit,
		maxClientEntries: maxClientEntries,
		users:            make(map[string]int),
		perUserLimit:     perUserLimit,
		maxUserEntries:   maxUserEntries,
	}
}

// acquireClient reserves one global and one client-prefix slot without
// waiting. The per-prefix check deliberately happens before the global check:
// repeated work from one source is rejected locally and cannot fill the global
// handler budget.
func (a *authenticatedAdmission) acquireClient(key string) (func(), authenticatedAdmissionRejection) {
	if key == "" {
		key = "unknown"
	}
	a.mu.Lock()
	if a.clients[key] >= a.perClientLimit {
		a.mu.Unlock()
		return nil, authenticatedClientBusy
	}
	if a.globalActive >= a.globalLimit {
		a.mu.Unlock()
		return nil, authenticatedServiceBusy
	}
	if a.clients[key] == 0 && len(a.clients) >= a.maxClientEntries {
		a.mu.Unlock()
		return nil, authenticatedServiceBusy
	}
	a.clients[key]++
	a.globalActive++
	a.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			a.mu.Lock()
			defer a.mu.Unlock()
			if active := a.clients[key]; active <= 1 {
				delete(a.clients, key)
			} else {
				a.clients[key] = active - 1
			}
			if a.globalActive > 0 {
				a.globalActive--
			}
		})
	}, authenticatedAdmitted
}

// acquireUser adds a second fairness boundary after a cookie resolves to a
// user. It stops one valid account from consuming the global budget through
// many source addresses. It does not reserve another global slot.
func (a *authenticatedAdmission) acquireUser(userID string) (func(), authenticatedAdmissionRejection) {
	if userID == "" {
		return nil, authenticatedServiceBusy
	}
	a.mu.Lock()
	if a.users[userID] >= a.perUserLimit {
		a.mu.Unlock()
		return nil, authenticatedUserBusy
	}
	if a.users[userID] == 0 && len(a.users) >= a.maxUserEntries {
		a.mu.Unlock()
		return nil, authenticatedServiceBusy
	}
	a.users[userID]++
	a.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			a.mu.Lock()
			defer a.mu.Unlock()
			if active := a.users[userID]; active <= 1 {
				delete(a.users, userID)
			} else {
				a.users[userID] = active - 1
			}
		})
	}, authenticatedAdmitted
}
