import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AnchorHTMLAttributes } from 'react'
import { ToastProvider } from '../../design-system'
import { SessionDetailPage } from './SessionDetailPage'

const mocks = vi.hoisted(() => ({ get: vi.fn(), segments: vi.fn(), update: vi.fn(), archive: vi.fn(), unarchive: vi.fn(), navigate: vi.fn() }))

vi.mock('../../api/client', () => ({
  api: { audio:{list:async()=>({parts:[],durationMs:0}),partUrl:()=>'',bundleUrl:()=>''}, sessions: { get: mocks.get, segments: mocks.segments, update: mocks.update, archive: mocks.archive, unarchive: mocks.unarchive } },
}))
vi.mock('../../app/router', () => ({
  useRouter: () => ({ navigate: mocks.navigate }),
  Link: ({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a>,
}))

describe('persisted transcript directionality', () => {
  beforeEach(() => {
    mocks.update.mockReset()
    mocks.archive.mockReset()
    mocks.unarchive.mockReset()
    mocks.navigate.mockReset()
    mocks.segments.mockReset().mockResolvedValue({ items: [], nextAfter: 1, hasMore: false, limit: 100 })
    mocks.get.mockReset().mockResolvedValue({
      session: {
        id: 'session_rtl', title: 'جلسة محفوظة', sourceLanguage: 'ar', targetLanguage: 'he', status: 'completed',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:01:00Z', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:01:00Z',
      },
      access: {viewerId:'user:test',displayName:'Test',isOwner:true,permission:'record',targetLanguage:'he'},
    segments: [{
        id: 'segment_rtl', sessionId: 'session_rtl', sequence: 1, sourceText: 'مرحبا بالعالم', translation: 'שלום עולם',
        translationStatus: 'succeeded', final: true, startMs: 0, endMs: 1_000, createdAt: '2026-01-01T00:00:00Z',
      }],
      segmentPage: { nextAfter: 1, hasMore: false, limit: 50 },
    })
  })

  it('isolates user titles and provider transcript text from surrounding layout direction', async () => {
    render(<ToastProvider><SessionDetailPage sessionId="session_rtl" /></ToastProvider>)

    expect(await screen.findByRole('heading', { name: 'جلسة محفوظة' })).toHaveAttribute('dir', 'auto')
    expect(screen.getByText('مرحبا بالعالم')).toHaveAttribute('dir', 'auto')
    expect(screen.getByText('שלום עולם')).toHaveAttribute('dir', 'auto')
  })

  it('ignores a stale detail failure after navigating to another session', async () => {
    let rejectOld!: (reason: Error) => void
    const oldRequest = new Promise<never>((_resolve, reject) => { rejectOld = reject })
    const nextDetail = {
      session: {
        id: 'session_new', title: 'New session', sourceLanguage: 'en', targetLanguage: 'fr', status: 'completed' as const,
        createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:01:00Z', startedAt: '2026-01-02T00:00:00Z', endedAt: '2026-01-02T00:01:00Z',
      },
      access: {viewerId:'user:test',displayName:'Test',isOwner:true,permission:'record',targetLanguage:'he'},
    segments: [],
      segmentPage: { nextAfter: 0, hasMore: false, limit: 50 },
    }
    mocks.get.mockImplementation((id: string) => id === 'session_old' ? oldRequest : Promise.resolve(nextDetail))
    const { rerender } = render(<ToastProvider><SessionDetailPage sessionId="session_old" /></ToastProvider>)
    expect(mocks.get).toHaveBeenCalledWith('session_old')

    rerender(<ToastProvider><SessionDetailPage sessionId="session_new" /></ToastProvider>)
    expect(await screen.findByRole('heading', { name: 'New session' })).toBeInTheDocument()
    await act(async () => rejectOld(new Error('Old request failed')))

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Session unavailable' })).not.toBeInTheDocument())
    expect(screen.getByRole('heading', { name: 'New session' })).toBeInTheDocument()
  })

  it('does not append an old load-more page after navigating to another session', async () => {
    const timestamp = '2026-01-03T00:00:00Z'
    const oldDetail = {
      session: { id: 'session_old', title: 'Old session', sourceLanguage: 'en', targetLanguage: 'fr', status: 'completed' as const, createdAt: timestamp, updatedAt: timestamp, startedAt: timestamp, endedAt: timestamp },
      access: {viewerId:'user:test',displayName:'Test',isOwner:true,permission:'record',targetLanguage:'he'},
    segments: [{ id: 'old_1', sessionId: 'session_old', sequence: 1, sourceText: 'Old first', translation: 'Ancien', translationStatus: 'succeeded' as const, final: true, startMs: 0, endMs: 1_000, createdAt: timestamp }],
      segmentPage: { nextAfter: 1, hasMore: true, limit: 50 },
    }
    const newDetail = {
      session: { id: 'session_new', title: 'New session', sourceLanguage: 'en', targetLanguage: 'fr', status: 'completed' as const, createdAt: timestamp, updatedAt: timestamp, startedAt: timestamp, endedAt: timestamp },
      access: {viewerId:'user:test',displayName:'Test',isOwner:true,permission:'record',targetLanguage:'he'},
    segments: [{ id: 'new_1', sessionId: 'session_new', sequence: 1, sourceText: 'New first', translation: 'Nouveau', translationStatus: 'succeeded' as const, final: true, startMs: 0, endMs: 1_000, createdAt: timestamp }],
      segmentPage: { nextAfter: 1, hasMore: false, limit: 50 },
    }
    let resolvePage!: (value: { items: typeof oldDetail.segments; nextAfter: number; hasMore: boolean; limit: number }) => void
    const pageRequest = new Promise<{ items: typeof oldDetail.segments; nextAfter: number; hasMore: boolean; limit: number }>((resolve) => { resolvePage = resolve })
    mocks.get.mockImplementation((id: string) => Promise.resolve(id === 'session_old' ? oldDetail : newDetail))
    mocks.segments.mockReturnValue(pageRequest)
    const { rerender } = render(<ToastProvider><SessionDetailPage sessionId="session_old" /></ToastProvider>)
    expect(await screen.findByRole('heading', { name: 'Old session' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Newer phrases' }))

    rerender(<ToastProvider><SessionDetailPage sessionId="session_new" /></ToastProvider>)
    expect(await screen.findByRole('heading', { name: 'New session' })).toBeInTheDocument()
    await act(async () => resolvePage({ items: [{ ...oldDetail.segments[0]!, id: 'old_2', sequence: 2, sourceText: 'Old tail' }], nextAfter: 2, hasMore: false, limit: 100 }))

    expect(screen.getByText('New first')).toBeInTheDocument()
    expect(screen.queryByText('Old tail')).not.toBeInTheDocument()
  })

  it('renames the current session through the API and filters visible phrases', async () => {
    const original = await mocks.get()
    mocks.update.mockImplementation(async (_id: string, input: { title: string }) => ({
      ...original.session,
      title: input.title,
    }))
    render(<ToastProvider><SessionDetailPage sessionId="session_rtl" /></ToastProvider>)
    expect(await screen.findByRole('heading', { name: 'جلسة محفوظة' })).toBeInTheDocument()
    // The name is what renames it.
    await userEvent.click(screen.getByRole('button', { name: 'جلسة محفوظة' }))
    const title = screen.getByRole('textbox', { name: 'Session title' })
    await userEvent.clear(title)
    await userEvent.type(title, 'Interpreted discussion')
    await userEvent.click(screen.getByRole('button', { name: 'Save name' }))
    expect(mocks.update).toHaveBeenCalledWith('session_rtl', { title: 'Interpreted discussion', sourceLanguage: 'ar', targetLanguage: 'he' })
    expect(await screen.findByRole('heading', { name: 'Interpreted discussion' })).toBeInTheDocument()

    await userEvent.type(screen.getByRole('textbox', { name: 'Search transcript' }), 'unmatched')
    expect(await screen.findByText('No matching phrases')).toBeInTheDocument()
    await userEvent.clear(screen.getByRole('textbox', { name: 'Search transcript' }))
    await userEvent.click(screen.getByRole('radio', { name: 'Translation' }))
    expect(screen.getByText('שלום עולם')).toBeInTheDocument()
    expect(screen.queryByText('مرحبا بالعالم')).not.toBeInTheDocument()
  })

  it('fetches remaining transcript pages before exporting', async () => {
    const detail = await mocks.get()
    mocks.get.mockResolvedValue({ ...detail, segmentPage: { nextAfter: 1, hasMore: true, limit: 50 } })
    mocks.segments.mockResolvedValue({ items: [{ ...detail.segments[0], id: 'segment_2', sequence: 2, sourceText: 'Second phrase', translation: 'Deuxième phrase' }], nextAfter: 2, hasMore: false, limit: 200 })
    const createObjectURL = vi.fn(() => 'blob:transcript')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    try {
      render(<ToastProvider><SessionDetailPage sessionId="session_rtl" /></ToastProvider>)
      expect(await screen.findByRole('heading', { name: 'جلسة محفوظة' })).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'More actions' }))
      await userEvent.click(screen.getByRole('menuitem', { name: 'Export transcript' }))
      await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce())
      expect(mocks.segments).toHaveBeenCalledWith('session_rtl', { after: 0, limit: 200 })
      expect(click).toHaveBeenCalledOnce()
      expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
    } finally { click.mockRestore() }
  })

  it('checks server state before continuing a saved recording', async () => {
    render(<ToastProvider><SessionDetailPage sessionId="session_rtl" /></ToastProvider>)
    expect(await screen.findByRole('button', { name: 'Continue recording' })).toBeInTheDocument()
    expect(screen.getByText('Saved')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Continue recording' }))
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2))
    expect(mocks.navigate).toHaveBeenCalledWith('/live/session_rtl')
  })

  it('keeps archived records read only until restored, including inactivity reason', async () => {
    const original = await mocks.get()
    const archived = { ...original.session, archivedAt: '2026-01-03T00:00:00Z', archiveReason: 'inactivity' as const }
    mocks.get.mockResolvedValue({ ...original, session: archived })
    mocks.unarchive.mockResolvedValue({ ...archived, archivedAt: null, archiveReason: undefined })
    render(<ToastProvider><SessionDetailPage sessionId="session_rtl" /></ToastProvider>)
    expect(await screen.findByText(/Archived · read only · After inactivity/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Continue recording' })).not.toBeInTheDocument()
    // Read only: the name is not a way to rename it.
    expect(screen.queryByRole('button', { name: 'جلسة محفوظة' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Unarchive session' }))
    await waitFor(() => expect(mocks.unarchive).toHaveBeenCalledWith('session_rtl'))
    expect(await screen.findByRole('button', { name: 'Continue recording' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'جلسة محفوظة' })).toBeEnabled()
  })

  it('does not navigate when inactivity archived the session before continue', async () => {
    const original = await mocks.get()
    mocks.get.mockResolvedValueOnce(original).mockResolvedValueOnce({ ...original, session: { ...original.session, archivedAt: '2026-01-03T00:00:00Z', archiveReason: 'inactivity' } })
    render(<ToastProvider><SessionDetailPage sessionId="session_rtl" /></ToastProvider>)
    await userEvent.click(await screen.findByRole('button', { name: 'Continue recording' }))
    expect(await screen.findByText(/Archived · read only/)).toBeInTheDocument()
    expect(mocks.navigate).not.toHaveBeenCalled()
  })
})
