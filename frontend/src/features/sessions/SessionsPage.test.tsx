import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AnchorHTMLAttributes } from 'react'
import { ThemeProvider, ToastProvider } from '../../design-system'
import { SessionsPage, type SessionScope } from './SessionsPage'
import { WorkspacesProvider } from '../../app/workspaces'
import { removeBrowserStorage } from '../../platform/storage'
import { AccountStorageProvider } from '../../app/accountStorage'

const mocks = vi.hoisted(() => ({ list: vi.fn(), getSettings: vi.fn(), navigate: vi.fn(), archive: vi.fn(), unarchive: vi.fn(), move: vi.fn(), workspaces: vi.fn(), useWorkspace: vi.fn(), removeWorkspace: vi.fn(), updateWorkspace: vi.fn(), storage: vi.fn() }))

vi.mock('../../api/client', () => ({
  api: {
    mode: 'http',
    sessions: {
      list: mocks.list,
      create: vi.fn(),
      remove: vi.fn(),
      archive: mocks.archive,
      unarchive: mocks.unarchive,
      move: mocks.move,
    },
    settings: {
      get: mocks.getSettings,
    },
    usage: { storage: mocks.storage },
    workspaces: {
      list: mocks.workspaces,
      use: mocks.useWorkspace,
      remove: mocks.removeWorkspace,
      update: mocks.updateWorkspace,
    },
  },
}))

vi.mock('../../app/router', () => ({
  useRouter: () => ({ navigate: mocks.navigate }),
  Link: ({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a>,
}))

function session(index: number) {
  const timestamp = new Date(Date.UTC(2026, 8, 1, 0, 0, index % 60)).toISOString()
  return {
    id: `session_${index}`, title: `Interpretation ${index}`, sourceLanguage: 'en', targetLanguage: 'fr',
    status: 'completed' as const, createdAt: timestamp, updatedAt: timestamp, startedAt: timestamp, endedAt: timestamp,
  }
}

const workspace = (id: string, name: string, sessionCount: number, lastUsedAt: string) => ({ id, name, icon: '', sessionCount, lastUsedAt, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' })
function renderPage(scope: SessionScope = { workspaceId: 'wsp_a' }) {
  return render(<ThemeProvider><ToastProvider><WorkspacesProvider userId="usr_1"><SessionsPage scope={scope} /></WorkspacesProvider></ToastProvider></ThemeProvider>)
}

/** A stand-in for IntersectionObserver that the test drives by hand. */
const observers: Array<{ callback: IntersectionObserverCallback; targets: Element[]; live: boolean }> = []
class ManualObserver {
  record: { callback: IntersectionObserverCallback; targets: Element[]; live: boolean }
  constructor(callback: IntersectionObserverCallback) {
    this.record = { callback, targets: [], live: true }
    observers.push(this.record)
  }
  observe(target: Element) { this.record.targets.push(target) }
  unobserve() {}
  disconnect() { this.record.live = false }
}
/** Brings the end of the list into view. */
function reachListEnd() {
  const watcher = observers.filter((entry) => entry.live && entry.targets.some((target) => target.classList.contains('session-more'))).at(-1)
  if (!watcher) throw new Error('Nothing is watching the end of the list')
  act(() => watcher.callback([{ isIntersecting: true, target: watcher.targets[0] } as IntersectionObserverEntry], {} as IntersectionObserver))
}

describe('session catalogue pagination', () => {
  beforeEach(() => {
    observers.length = 0
    vi.stubGlobal('IntersectionObserver', ManualObserver)
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }))
    mocks.navigate.mockReset()
    mocks.archive.mockReset()
    mocks.unarchive.mockReset()
    mocks.move.mockReset()
    mocks.useWorkspace.mockReset().mockResolvedValue(undefined)
    mocks.removeWorkspace.mockReset().mockResolvedValue({ moved: 1 })
    mocks.workspaces.mockReset().mockResolvedValue({ items: [workspace('wsp_a', '', 1, '2026-09-02T00:00:00Z'), workspace('wsp_b', 'Research', 0, '2026-09-01T00:00:00Z')], hasShared: false })
    mocks.getSettings.mockReset().mockResolvedValue({
      defaultSourceLanguage: 'en', defaultTargetLanguage: 'fr', autoStartMicrophone: false,
      showPartialTranscripts: true, compactTranscriptLayout: false,
    })
    mocks.list.mockReset().mockImplementation(({ offset = 0 }: { offset?: number }) => Promise.resolve({
      items: offset === 0 ? Array.from({ length: 200 }, (_, index) => session(index)) : [session(200)],
      offset,
      limit: 200,
    }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    removeBrowserStorage('local', 't-lingual:session-view')
  })

  it('makes no new session once the account’s storage is full, and says why', async () => {
    const GB = 1024 ** 3
    mocks.storage.mockResolvedValue({ usedBytes: 6 * GB, audioBytes: 6 * GB, transcriptBytes: 0, limitBytes: 5 * GB, availableBytes: 0, sessions: 3, archivedSessions: 0, sessionsWithAudio: 3, workspaces: 2, workspaceLimit: 100 })
    render(<ThemeProvider><ToastProvider><AccountStorageProvider userId="usr_1"><WorkspacesProvider userId="usr_1"><SessionsPage scope={{ workspaceId: 'wsp_a' }} /></WorkspacesProvider></AccountStorageProvider></ToastProvider></ThemeProvider>)
    expect(await screen.findByText(/Your storage is full, so you can’t create sessions/u)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New interpretation' })).toBeDisabled()
    expect(screen.getByRole('link', { name: 'See your usage' })).toHaveAttribute('href', '/usage')
  })

  it('shows the cards a batch at a time as the end of the list comes into view', async () => {
    renderPage()

    expect(await screen.findAllByRole('article')).toHaveLength(6)
    expect(screen.getAllByRole('heading', { name: /^Interpretation / })[0]).toHaveAttribute('dir', 'auto')
    expect(screen.getByText('Loading more sessions')).toBeInTheDocument()
    reachListEnd()
    expect(screen.getAllByRole('article')).toHaveLength(12)
    expect(mocks.list).toHaveBeenCalledTimes(1)
  })

  it('loads the next page, once every loaded card is out, without replacing the ones shown', async () => {
    renderPage()
    expect(await screen.findAllByRole('article')).toHaveLength(6)
    const shown = () => document.querySelectorAll('article.session-card').length
    while (shown() < 200) reachListEnd()
    expect(mocks.list).toHaveBeenCalledTimes(1)

    reachListEnd()
    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith({ workspace: 'wsp_a', limit: 200, offset: 200 }))
    expect(await screen.findByText('Interpretation 200')).toBeInTheDocument()
    expect(screen.getByText('Interpretation 0')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('Loading more sessions')).not.toBeInTheDocument())
  }, 20_000)

  it('uses the default view and still switches views when storage is blocked', async () => {
    mocks.list.mockResolvedValue({ items: [session(0)], offset: 0, limit: 200 })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError') })
    renderPage()

    expect(await screen.findByText('Interpretation 0')).toBeInTheDocument()
    expect(document.querySelector('.session-results--grid')).not.toBeNull()
    // Order and layout share one menu, in sections.
    await userEvent.click(screen.getByRole('button', { name: 'View options' }))
    expect(screen.getByRole('menuitemradio', { name: 'Recently updated' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('menuitemradio', { name: 'Grid view' })).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'List view' }))
    expect(document.querySelector('.session-results--list')).not.toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'View options' }))
    expect(screen.getByRole('menuitemradio', { name: 'List view' })).toHaveAttribute('aria-checked', 'true')
  })

  it('lists one workspace, marks it used, and moves a session out of it', async () => {
    mocks.list.mockResolvedValue({ items: [session(0)], offset: 0, limit: 200 })
    mocks.move.mockResolvedValue({ ...session(0), workspaceId: 'wsp_b' })
    renderPage()
    expect(await screen.findByText('Interpretation 0')).toBeInTheDocument()
    expect(mocks.list).toHaveBeenCalledWith({ workspace: 'wsp_a', limit: 200 })
    expect(mocks.useWorkspace).toHaveBeenCalledWith('wsp_a')

    await userEvent.click(screen.getByRole('button', { name: 'Actions for Interpretation 0' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Move to another workspace' }))
    const move = await screen.findByRole('button', { name: 'Move session' })
    expect(move).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: /^Move to/ }))
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Research' }))
    // The session's own workspace is not somewhere to move it to.
    expect(screen.queryByRole('menuitemradio', { name: 'My workspace' })).not.toBeInTheDocument()
    await userEvent.click(move)
    await waitFor(() => expect(mocks.move).toHaveBeenCalledWith('session_0', 'wsp_b'))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Interpretation 0' })).not.toBeInTheDocument())
  })

  it('deletes its workspace only once the sessions have somewhere to go', async () => {
    mocks.list.mockResolvedValue({ items: [session(0)], offset: 0, limit: 200 })
    renderPage()
    expect(await screen.findByText('Interpretation 0')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Workspace options' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete workspace' }))
    const confirm = await screen.findByRole('button', { name: 'Delete workspace' })
    expect(confirm).toBeDisabled()
    expect(screen.getByText('Its sessions are kept: choose the workspace they move to.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^Move its sessions to/ }))
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Research' }))
    expect(confirm).toBeEnabled()
    await userEvent.click(confirm)
    await waitFor(() => expect(mocks.removeWorkspace).toHaveBeenCalledWith('wsp_a', 'wsp_b'))
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/workspaces/wsp_b', { replace: true }))
  })

  it('edits the name and the icon together, the unnamed first one included', async () => {
    mocks.list.mockResolvedValue({ items: [session(0)], offset: 0, limit: 200 })
    mocks.updateWorkspace.mockImplementation(async (id: string, input: { name: string; icon: string }) => ({ ...workspace(id, input.name, 1, '2026-09-02T00:00:00Z'), icon: input.icon }))
    renderPage()
    expect(await screen.findByText('Interpretation 0')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Workspace options' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Edit workspace' }))
    expect(await screen.findByLabelText('Workspace name')).toHaveValue('My workspace')
    expect(screen.getByRole('radio', { name: 'Folder' })).toBeChecked()
    await userEvent.click(screen.getByRole('radio', { name: 'Globe' }))
    expect(screen.getByRole('radio', { name: 'Globe' })).toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(mocks.updateWorkspace).toHaveBeenCalledWith('wsp_a', { name: 'My workspace', icon: 'globe' }))
  })

  it('refuses to delete the last workspace, and says why', async () => {
    mocks.workspaces.mockResolvedValue({ items: [workspace('wsp_a', '', 1, '2026-09-02T00:00:00Z')], hasShared: false })
    mocks.list.mockResolvedValue({ items: [session(0)], offset: 0, limit: 200 })
    renderPage()
    expect(await screen.findByText('Interpretation 0')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Workspace options' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete workspace' }))
    expect(await screen.findByText('Keep at least one workspace')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete workspace' })).not.toBeInTheDocument()
    expect(mocks.removeWorkspace).not.toHaveBeenCalled()
  })

  it('shows what others shared without offering to create or manage anything', async () => {
    mocks.list.mockResolvedValue({ items: [{ ...session(0), isOwner: false }], offset: 0, limit: 200 })
    renderPage({ shared: true })
    expect(await screen.findByText('Interpretation 0')).toBeInTheDocument()
    expect(mocks.list).toHaveBeenCalledWith({ shared: true, limit: 200 })
    expect(screen.queryByRole('button', { name: 'New interpretation' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Workspace options' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Actions for Interpretation 0' })).not.toBeInTheDocument()
    expect(mocks.useWorkspace).not.toHaveBeenCalled()
  })

  it('archives and restores a saved session from its action menu', async () => {
    mocks.list.mockResolvedValue({ items: [session(0)], offset: 0, limit: 200 })
    const archived = { ...session(0), archivedAt: '2026-09-03T00:00:00Z', archiveReason: 'manual' as const }
    mocks.archive.mockResolvedValue(archived)
    mocks.unarchive.mockResolvedValue({ ...session(0), archivedAt: null })
    renderPage()
    expect(await screen.findByText('Interpretation 0')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Interpretation 0' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Archive session' }))
    await waitFor(() => expect(mocks.archive).toHaveBeenCalledWith('session_0'))
    expect(screen.getAllByText('Archived').length).toBeGreaterThan(1)
    await userEvent.click(screen.getByRole('button', { name: /^Archived/ }))
    expect(screen.getByRole('heading', { name: 'Interpretation 0' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Interpretation 0' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Unarchive session' }))
    await waitFor(() => expect(mocks.unarchive).toHaveBeenCalledWith('session_0'))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Interpretation 0' })).not.toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: /^Saved/ }))
    expect(screen.getByRole('heading', { name: 'Interpretation 0' })).toBeInTheDocument()
  })
})
