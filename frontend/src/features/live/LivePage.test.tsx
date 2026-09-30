import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AnchorHTMLAttributes } from 'react'
import { ToastProvider } from '../../design-system'
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
  recording: { active: false }, access: {viewerId:'user:test',displayName:'Test',isOwner:true,permission:'record',targetLanguage:'he'}, languageBusy: false, changeLanguage: vi.fn(), stopOtherRecorder: vi.fn(),
  partial: 'در حال صحبت',
  state: 'live' as const,
  paused: false,
  togglePause: vi.fn(),
  error: '',
  elapsedMs: 1_000,
  autoStart: false,
  compact: false,
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
  retryLoad: vi.fn(),
}))

vi.mock('../../api/client',()=>({api:{mode:'http',audio:{list:async()=>({parts:[],durationMs:0}),partUrl:()=>'',bundleUrl:()=>''}}}))
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
    live.paused = false
    live.retryLoad.mockReset()
    live.togglePause.mockReset()
  })

  it('lets session, source, translation and partial text establish their own direction', async () => {
    render(<ToastProvider><LivePage sessionId="session_rtl" /></ToastProvider>)

    expect(screen.getByRole('heading', { name: 'جلسة الفريق' })).toHaveAttribute('dir', 'auto')
    expect(screen.getByText('مرحبا بالعالم')).toHaveAttribute('dir', 'auto')
    expect(screen.getByText('שלום עולם')).toHaveAttribute('dir', 'auto')
    expect(screen.getByRole('region', { name: 'Transcript entries' })).toBeInTheDocument()
    await act(async()=>{})

  })

  it('offers a functional data retry when initial session loading fails', async () => {
    Object.assign(live, { session: null, state: 'error', error: 'Service unavailable.' })
    render(<ToastProvider><LivePage sessionId="session_rtl" /></ToastProvider>)

    expect(screen.getByRole('heading', { name: 'Live session unavailable' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Try loading again' }))
    expect(live.retryLoad).toHaveBeenCalledOnce()
  })

  it('exposes a real audio pause control separately from scroll following', async () => {
    render(<ToastProvider><LivePage sessionId="session_rtl" /></ToastProvider>)
    await userEvent.click(screen.getByRole('button', { name: 'Pause audio' }))
    expect(live.togglePause).toHaveBeenCalledOnce()
    await userEvent.click(screen.getByRole('button', { name: 'Focus view' }))
    expect(screen.getByRole('button', { name: 'Exit focus' })).toHaveAttribute('aria-pressed', 'true')

  })
})
