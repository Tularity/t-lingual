import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AnchorHTMLAttributes } from 'react'
import { ToastProvider } from '../../design-system'
import { SessionDetailPage } from './SessionDetailPage'

const mocks = vi.hoisted(() => ({ get: vi.fn(), segments: vi.fn() }))

vi.mock('../../api/client', () => ({
  api: { sessions: { get: mocks.get, segments: mocks.segments } },
}))
vi.mock('../../app/router', () => ({
  Link: ({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a>,
}))

describe('persisted transcript directionality', () => {
  beforeEach(() => {
    mocks.segments.mockReset().mockResolvedValue({ items: [], nextAfter: 1, hasMore: false, limit: 100 })
    mocks.get.mockReset().mockResolvedValue({
      session: {
        id: 'session_rtl', title: 'جلسة محفوظة', sourceLanguage: 'ar', targetLanguage: 'he', status: 'completed',
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:01:00Z', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:01:00Z',
      },
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
      segments: [{ id: 'old_1', sessionId: 'session_old', sequence: 1, sourceText: 'Old first', translation: 'Ancien', translationStatus: 'succeeded' as const, final: true, startMs: 0, endMs: 1_000, createdAt: timestamp }],
      segmentPage: { nextAfter: 1, hasMore: true, limit: 50 },
    }
    const newDetail = {
      session: { id: 'session_new', title: 'New session', sourceLanguage: 'en', targetLanguage: 'fr', status: 'completed' as const, createdAt: timestamp, updatedAt: timestamp, startedAt: timestamp, endedAt: timestamp },
      segments: [{ id: 'new_1', sessionId: 'session_new', sequence: 1, sourceText: 'New first', translation: 'Nouveau', translationStatus: 'succeeded' as const, final: true, startMs: 0, endMs: 1_000, createdAt: timestamp }],
      segmentPage: { nextAfter: 1, hasMore: false, limit: 50 },
    }
    let resolvePage!: (value: { items: typeof oldDetail.segments; nextAfter: number; hasMore: boolean; limit: number }) => void
    const pageRequest = new Promise<{ items: typeof oldDetail.segments; nextAfter: number; hasMore: boolean; limit: number }>((resolve) => { resolvePage = resolve })
    mocks.get.mockImplementation((id: string) => Promise.resolve(id === 'session_old' ? oldDetail : newDetail))
    mocks.segments.mockReturnValue(pageRequest)
    const { rerender } = render(<ToastProvider><SessionDetailPage sessionId="session_old" /></ToastProvider>)
    expect(await screen.findByRole('heading', { name: 'Old session' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Load more transcript' }))

    rerender(<ToastProvider><SessionDetailPage sessionId="session_new" /></ToastProvider>)
    expect(await screen.findByRole('heading', { name: 'New session' })).toBeInTheDocument()
    await act(async () => resolvePage({ items: [{ ...oldDetail.segments[0]!, id: 'old_2', sequence: 2, sourceText: 'Old tail' }], nextAfter: 2, hasMore: false, limit: 100 }))

    expect(screen.getByText('New first')).toBeInTheDocument()
    expect(screen.queryByText('Old tail')).not.toBeInTheDocument()
  })
})
