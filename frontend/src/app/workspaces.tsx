import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from '../api/client'
import { WORKSPACE_ICONS, type Workspace, type WorkspaceIcon, type WorkspaceInput } from '../api/contracts'
import { useI18n } from './i18n'

/** The icon a workspace is shown with: the one chosen, or a folder. */
export function workspaceIcon(workspace: Pick<Workspace, 'icon'> | undefined): WorkspaceIcon {
  const icon = workspace?.icon
  return (WORKSPACE_ICONS as readonly string[]).includes(icon ?? '') ? icon as WorkspaceIcon : 'folder'
}

/** How many workspaces the sidebar lists before it offers the full list instead. */
export const SIDEBAR_WORKSPACES = 4

/** The pinned workspaces, in the order they were pinned. */
function pinned(items: readonly Workspace[]): Workspace[] {
  return items.filter(item => item.pinnedAt).sort((a, b) => a.pinnedAt!.localeCompare(b.pinnedAt!))
}

/**
 * The workspaces the sidebar lists: every pinned one first, then the ones
 * used most recently, up to its limit, in the order they were created — so
 * the list only changes when a workspace outside it is used, never by
 * clicking the ones already in it.
 */
export function sidebarWorkspaces(items: readonly Workspace[], limit = SIDEBAR_WORKSPACES): Workspace[] {
  const first = pinned(items)
  const chosen = new Set(items.filter(item => !item.pinnedAt).sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
    .slice(0, Math.max(0, limit - first.length)).map(item => item.id))
  return [...first, ...items.filter(item => chosen.has(item.id))]
}

/** Every workspace, pinned ones first, then the rest in the order they were created. */
export function pinnedFirst(items: readonly Workspace[]): Workspace[] {
  return [...pinned(items), ...items.filter(item => !item.pinnedAt)]
}

/** The workspace used most recently. */
export function recentWorkspace(items: readonly Workspace[]): Workspace | undefined {
  return [...items].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))[0]
}

/** Where the page being shown belongs: one of the user's workspaces, or what was shared with them. */
export type PageWorkspace = { id: string } | { shared: true } | null

export interface WorkspacesValue {
  status: 'loading' | 'ready' | 'error'
  /** Oldest first. */
  items: Workspace[]
  hasShared: boolean
  recent: Workspace | undefined
  /** What the sidebar lists, and whether there are more than it can. */
  sidebar: Workspace[]
  overflow: boolean
  /** Every workspace, pinned ones first. */
  ordered: Workspace[]
  /** A workspace's name as shown: the first one is named by the interface until it is renamed. */
  name(workspace: Pick<Workspace, 'name'> | undefined): string
  find(id: string | undefined): Workspace | undefined
  /** Where the page being shown belongs, for the breadcrumb and the sidebar. */
  page: PageWorkspace
  setPage(page: PageWorkspace): void
  refresh(): Promise<void>
  create(input: WorkspaceInput): Promise<Workspace>
  update(id: string, input: WorkspaceInput): Promise<Workspace>
  remove(id: string, moveTo?: string): Promise<void>
  /** The user has just opened this workspace. */
  use(id: string): void
  /** Pins a workspace above the rest, or unpins it. */
  pin(id: string, pinned: boolean): Promise<Workspace>
}

const Context = createContext<WorkspacesValue | null>(null)

export function useWorkspaces(): WorkspacesValue {
  const value = useContext(Context)
  if (!value) throw new Error('useWorkspaces must be used inside WorkspacesProvider')
  return value
}

/** The workspaces, where a page can also be shown on its own — to a guest, say. */
export function useOptionalWorkspaces(): WorkspacesValue | null {
  return useContext(Context)
}

/** Tells the breadcrumb and the sidebar which workspace the current page belongs to, while it is shown. */
export function usePageWorkspace(page: PageWorkspace) {
  const setPage = useContext(Context)?.setPage
  const key = page === null ? '' : 'shared' in page ? 'shared' : page.id
  useEffect(() => {
    if (!setPage) return
    setPage(key === '' ? null : key === 'shared' ? { shared: true } : { id: key })
    return () => setPage(null)
  }, [key, setPage])
}

/** The signed-in user's workspaces; none while `userId` is empty. A new `userId` starts over. */
export function WorkspacesProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const { t } = useI18n()
  const [state, setState] = useState<{ userId: string; status: WorkspacesValue['status']; items: Workspace[]; hasShared: boolean }>({ userId, status: 'loading', items: [], hasShared: false })
  const [page, setPage] = useState<PageWorkspace>(null)
  const [attempt, setAttempt] = useState(0)
  // Another account's list is never shown while this one's loads.
  const current = useMemo(() => state.userId === userId ? state : { userId, status: 'loading' as const, items: [], hasShared: false }, [state, userId])

  useEffect(() => {
    if (!userId) return
    let active = true
    api.workspaces.list().then(
      (result) => { if (active) setState({ userId, status: 'ready', items: result.items, hasShared: result.hasShared }) },
      () => { if (active) setState(previous => ({ ...previous, userId, status: 'error' })) },
    )
    return () => { active = false }
  }, [userId, attempt])

  const refresh = useCallback(async () => {
    if (!userId) return
    const result = await api.workspaces.list()
    setState({ userId, status: 'ready', items: result.items, hasShared: result.hasShared })
  }, [userId])
  const create = useCallback(async (input: WorkspaceInput) => {
    const created = await api.workspaces.create(input)
    setState(previous => ({ ...previous, items: [...previous.items, created] }))
    return created
  }, [])
  const update = useCallback(async (id: string, input: WorkspaceInput) => {
    const updated = await api.workspaces.update(id, input)
    setState(previous => ({ ...previous, items: previous.items.map(item => item.id === id ? { ...item, name: updated.name, icon: updated.icon, updatedAt: updated.updatedAt } : item) }))
    return updated
  }, [])
  const remove = useCallback(async (id: string, moveTo?: string) => {
    const { moved } = await api.workspaces.remove(id, moveTo)
    setState(previous => ({ ...previous, items: previous.items.filter(item => item.id !== id).map(item => item.id === moveTo ? { ...item, sessionCount: item.sessionCount + moved } : item) }))
  }, [])
  const pin = useCallback(async (id: string, pinned: boolean) => {
    const updated = await api.workspaces.pin(id, pinned)
    setState(previous => ({ ...previous, items: previous.items.map(item => item.id === id ? { ...item, pinnedAt: updated.pinnedAt } : item) }))
    return updated
  }, [])
  const use = useCallback((id: string) => {
    const usedAt = new Date().toISOString()
    setState(previous => ({ ...previous, items: previous.items.map(item => item.id === id ? { ...item, lastUsedAt: usedAt } : item) }))
    void api.workspaces.use(id).catch(() => undefined)
  }, [])

  const value = useMemo<WorkspacesValue>(() => {
    const sidebar = sidebarWorkspaces(current.items)
    return {
      status: current.status,
      items: current.items,
      hasShared: current.hasShared,
      recent: recentWorkspace(current.items),
      sidebar,
      overflow: current.items.length > sidebar.length,
      ordered: pinnedFirst(current.items),
      name: (workspace) => workspace?.name || t('My workspace'),
      find: (id) => current.items.find(item => item.id === id),
      page,
      setPage,
      refresh: async () => { if (current.status === 'error') setAttempt(value => value + 1); else await refresh() },
      create,
      update,
      remove,
      use,
      pin,
    }
  }, [current, page, refresh, create, update, remove, use, pin, t])

  return <Context.Provider value={value}>{children}</Context.Provider>
}
