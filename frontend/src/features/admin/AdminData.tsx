import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '../../api/client'
import type { AuditEvent, Invitation, User } from '../../api/contracts'
import { errorMessage } from '../../app/utils'

/** The server hands out at most this many records a request. */
const PAGE = 200
/** How many records a list reads before it stops and says so. */
export const ADMIN_LIST_LIMIT = 2000

type Kind = 'users' | 'invites' | 'audit'
type Item = { users: User; invites: Invitation; audit: AuditEvent }

export interface AdminList<T> {
  status: 'idle' | 'loading' | 'ready' | 'error'
  items: T[]
  /** False while later pages are still arriving, or once the limit stopped them. */
  complete: boolean
  /** True when the limit stopped the list before the server ran out. */
  truncated: boolean
  error: string
}

const empty = <T,>(): AdminList<T> => ({ status: 'idle', items: [], complete: false, truncated: false, error: '' })

const fetchers: { [K in Kind]: (query: { limit: number; offset: number }) => Promise<Item[K][]> } = {
  users: (query) => api.admin.users(query),
  invites: (query) => api.admin.invitations(query),
  audit: (query) => api.admin.audit(query),
}

interface AdminDataValue {
  lists: { [K in Kind]: AdminList<Item[K]> }
  /** Starts reading a list the first time a page needs it; again after a failure. */
  load: (kind: Kind) => void
  /** Reads a list again from the start. */
  reload: (kind: Kind) => Promise<void>
  update: <K extends Kind>(kind: K, change: (items: Item[K][]) => Item[K][]) => void
  /** Reads a list again only if a page has already asked for it: activity after a change, say. */
  refresh: (kind: Kind) => void
}

const Context = createContext<AdminDataValue | null>(null)

/**
 * What the administration pages share: the people, the access codes and the
 * activity, each read once and kept while the administrator moves between
 * the pages. A list arrives a page at a time — usable from its first page —
 * up to ADMIN_LIST_LIMIT records. Nothing is read until a page asks, and
 * nothing at all for an account that is not an administrator (`userId` empty).
 */
export function AdminDataProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const [state, setState] = useState<{ userId: string; lists: AdminDataValue['lists'] }>(() => ({ userId, lists: { users: empty(), invites: empty(), audit: empty() } }))
  const generation = useRef<Record<Kind, number>>({ users: 0, invites: 0, audit: 0 })
  // Another account's lists are never shown while this one's load.
  const lists = useMemo(() => state.userId === userId ? state.lists : { users: empty<User>(), invites: empty<Invitation>(), audit: empty<AuditEvent>() }, [state, userId])
  const listsRef = useRef(lists)
  useEffect(() => { listsRef.current = lists })

  const set = useCallback(<K extends Kind>(kind: K, change: (list: AdminList<Item[K]>) => AdminList<Item[K]>) => {
    setState((current) => {
      const base = current.userId === userId ? current.lists : { users: empty<User>(), invites: empty<Invitation>(), audit: empty<AuditEvent>() }
      return { userId, lists: { ...base, [kind]: change(base[kind] as AdminList<Item[K]>) } }
    })
  }, [userId])

  const read = useCallback(async (kind: Kind) => {
    if (!userId) return
    const run = ++generation.current[kind]
    set(kind, (list) => ({ ...list, status: list.items.length ? list.status : 'loading', error: '' }))
    try {
      let items: Item[typeof kind][] = []
      for (let offset = 0; offset < ADMIN_LIST_LIMIT; offset += PAGE) {
        const page = await fetchers[kind]({ limit: PAGE, offset })
        if (run !== generation.current[kind]) return
        items = [...items, ...page] as typeof items
        const more = page.length === PAGE
        const truncated = more && offset + PAGE >= ADMIN_LIST_LIMIT
        set(kind, () => ({ status: 'ready', items, complete: !more || truncated, truncated, error: '' }))
        if (!more) break
      }
    } catch (caught) {
      if (run !== generation.current[kind]) return
      set(kind, (list) => list.items.length ? { ...list, complete: true } : { ...list, status: 'error', error: errorMessage(caught) })
    }
  }, [set, userId])

  const load = useCallback((kind: Kind) => {
    const list = listsRef.current[kind]
    if (list.status === 'idle' || list.status === 'error') void read(kind)
  }, [read])

  const update = useCallback(<K extends Kind>(kind: K, change: (items: Item[K][]) => Item[K][]) => {
    set(kind, (list) => ({ ...list, items: change(list.items) }))
  }, [set])

  const refresh = useCallback((kind: Kind) => {
    if (listsRef.current[kind].status !== 'idle') void read(kind)
  }, [read])

  const value = useMemo<AdminDataValue>(() => ({ lists, load, reload: read, update, refresh }), [lists, load, read, update, refresh])
  return <Context.Provider value={value}>{children}</Context.Provider>
}

function useAdminData() {
  const value = useContext(Context)
  if (!value) throw new Error('useAdminData must be used inside AdminDataProvider')
  return value
}

/** Reads a list again if it has been read at all. */
export function useAdminRefresh() {
  return useAdminData().refresh
}

/** One of the shared lists, read when the calling page first shows. */
export function useAdminList<K extends Kind>(kind: K) {
  const data = useAdminData()
  const { load } = data
  useEffect(() => { load(kind) }, [kind, load])
  return {
    ...(data.lists[kind] as AdminList<Item[K]>),
    reload: () => data.reload(kind),
    update: (change: (items: Item[K][]) => Item[K][]) => data.update(kind, change),
  }
}
