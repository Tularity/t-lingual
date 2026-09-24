import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AnchorHTMLAttributes } from 'react'
import { ThemeProvider, ToastProvider } from '../../design-system'
import { SessionsPage } from './SessionsPage'
import { removeBrowserStorage } from '../../platform/storage'

const mocks = vi.hoisted(() => ({ list: vi.fn(), getSettings: vi.fn(), navigate: vi.fn(), archive: vi.fn(), unarchive: vi.fn() }))

vi.mock('../../api/client', () => ({
  api: {
    mode: 'http',
    sessions: {
      list: mocks.list,
      create: vi.fn(),
      remove: vi.fn(),
      archive: mocks.archive,
      unarchive: mocks.unarchive,
    },
    settings: {
      get: mocks.getSettings,
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

describe('session catalogue pagination', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }))
    mocks.navigate.mockReset()
    mocks.archive.mockReset()
    mocks.unarchive.mockReset()
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

  it('loads the next page without replacing already visible sessions', async () => {
    render(<ThemeProvider><ToastProvider><SessionsPage /></ToastProvider></ThemeProvider>)

    expect(await screen.findByText('Interpretation 0')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Interpretation 0' })).toHaveAttribute('dir', 'auto')
    await userEvent.click(screen.getByText('Load more sessions'))

    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith({ limit: 200, offset: 200 }))
    expect(await screen.findByText('Interpretation 200')).toBeInTheDocument()
    expect(screen.getByText('Interpretation 0')).toBeInTheDocument()
    expect(screen.queryByText('Load more sessions')).not.toBeInTheDocument()
  }, 10_000)

  it('uses the default view and still switches views when storage is blocked', async () => {
    mocks.list.mockResolvedValue({ items: [session(0)], offset: 0, limit: 200 })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError') })
    render(<ThemeProvider><ToastProvider><SessionsPage /></ToastProvider></ThemeProvider>)

    expect(await screen.findByText('Interpretation 0')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Grid view' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'List view' }))
    expect(screen.getByRole('button', { name: 'List view' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('resets a route-specific status filter when switching to history', async () => {
    mocks.list.mockResolvedValue({ items: [session(0)], offset: 0, limit: 200 })
    const { rerender } = render(<ThemeProvider><ToastProvider><SessionsPage /></ToastProvider></ThemeProvider>)
    expect(await screen.findByText('Interpretation 0')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^Live/ }))
    expect(screen.getByRole('button', { name: /^Live/ })).toHaveAttribute('aria-pressed', 'true')

    rerender(<ThemeProvider><ToastProvider><SessionsPage historyOnly /></ToastProvider></ThemeProvider>)

    await waitFor(() => expect(screen.getByRole('button', { name: /^All history/ })).toHaveAttribute('aria-pressed', 'true'))
    expect(screen.getByText('Interpretation 0')).toBeInTheDocument()
  })

  it('archives and restores a saved session from its action menu', async () => {
    mocks.list.mockResolvedValue({ items: [session(0)], offset: 0, limit: 200 })
    const archived = { ...session(0), archivedAt: '2026-09-03T00:00:00Z', archiveReason: 'manual' as const }
    mocks.archive.mockResolvedValue(archived)
    mocks.unarchive.mockResolvedValue({ ...session(0), archivedAt: null })
    render(<ThemeProvider><ToastProvider><SessionsPage /></ToastProvider></ThemeProvider>)
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
