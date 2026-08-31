import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AnchorHTMLAttributes } from 'react'
import { LivePage } from './LivePage'

const live = vi.hoisted(() => ({
  session: {
    id: 'session_rtl', title: 'جلسة الفريق', sourceLanguage: 'ar', targetLanguage: 'he', status: 'live' as const,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', startedAt: '2026-01-01T00:00:00Z', endedAt: null,
  },
  segments: [{
    id: 'segment_rtl', sessionId: 'session_rtl', sequence: 1, sourceText: 'مرحبا بالعالم', translation: 'שלום עולם',
    translationStatus: 'succeeded' as const, final: true, startMs: 0, endMs: 1_000, createdAt: '2026-01-01T00:00:00Z',
  }],
  partial: 'در حال صحبت',
  state: 'live' as const,
  error: '',
  elapsedMs: 1_000,
  autoStart: false,
  compact: false,
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
  retryLoad: vi.fn(),
}))

vi.mock('./useLiveInterpretation', () => ({ useLiveInterpretation: () => live }))
vi.mock('../../app/router', () => ({
  Link: ({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a>,
}))

describe('live transcript directionality', () => {
  const initialSession = live.session
  beforeEach(() => {
    live.session = initialSession
    live.state = 'live'
    live.error = ''
    live.retryLoad.mockReset()
  })

  it('lets session, source, translation and partial text establish their own direction', () => {
    render(<LivePage sessionId="session_rtl" />)

    expect(screen.getByRole('heading', { name: 'جلسة الفريق' })).toHaveAttribute('dir', 'auto')
    expect(screen.getByText('مرحبا بالعالم')).toHaveAttribute('dir', 'auto')
    expect(screen.getByText('שלום עולם')).toHaveAttribute('dir', 'auto')
    const partial = screen.getByText('در حال صحبت')
    expect(partial).toHaveAttribute('dir', 'auto')
    expect(partial.closest('article')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByRole('log', { name: 'Live transcript entries' })).toHaveAttribute('aria-relevant', 'additions')
  })

  it('offers a functional data retry when initial session loading fails', async () => {
    Object.assign(live, { session: null, state: 'error', error: 'Service unavailable.' })
    render(<LivePage sessionId="session_rtl" />)

    expect(screen.getByRole('heading', { name: 'Live session unavailable' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Try loading again' }))
    expect(live.retryLoad).toHaveBeenCalledOnce()
  })
})
