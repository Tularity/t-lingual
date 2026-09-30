import { render, screen, waitFor } from '@testing-library/react'
import type { AnchorHTMLAttributes } from 'react'
import { ToastProvider } from '../../design-system'
import { LivePage } from './LivePage'

const mocks = vi.hoisted(() => ({ admission: vi.fn() }))
const live = vi.hoisted(() => ({
  session: { id: 'session_1', title: 'Weekly sync', sourceLanguage: 'en', targetLanguage: 'fr', status: 'completed' as const, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', startedAt: null, endedAt: null },
  segments: [] as unknown[], gaps: [] as unknown[],
  recording: { active: false } as { active: boolean; recognitionPaused?: boolean },
  access: { viewerId: 'user:test', displayName: 'Test', isOwner: true, permission: 'record', targetLanguage: 'fr' },
  languageBusy: false, changeLanguage: vi.fn(), stopOtherRecorder: vi.fn(), partial: '',
  state: 'idle' as 'idle' | 'live', paused: false, togglePause: vi.fn(), error: '', elapsedMs: 0, autoStart: false, compact: false,
  start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), retryLoad: vi.fn(),
}))

vi.mock('../../api/client', () => ({ api: { mode: 'http', sessions: { recordingAdmission: mocks.admission }, audio: { list: async () => ({ parts: [], durationMs: 0 }), partUrl: () => '', bundleUrl: () => '' } } }))
vi.mock('./useLiveInterpretation', () => ({ useLiveInterpretation: () => live }))
vi.mock('../../app/router', () => ({ Link: ({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a> }))

const renderPage = () => render(<ToastProvider><LivePage sessionId="session_1" /></ToastProvider>)

describe('whether a session can be recorded now', () => {
  beforeEach(() => {
    mocks.admission.mockReset()
    Object.assign(live, { state: 'idle', recording: { active: false }, access: { ...live.access, isOwner: true } })
  })

  it('does not offer to start recording while recognition can’t take it', async () => {
    mocks.admission.mockResolvedValue({ allowed: false, reason: 'recognition_unavailable' })
    renderPage()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue recording' })).toBeDisabled())
    expect(screen.getByText(/so recording can’t start/u)).toBeInTheDocument()
    expect(mocks.admission).toHaveBeenCalledWith('session_1')
  })

  it('offers to start once the session can be recorded', async () => {
    mocks.admission.mockResolvedValue({ allowed: true })
    renderPage()
    await waitFor(() => expect(mocks.admission).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'Continue recording' })).toBeEnabled()
    expect(screen.queryByText(/can’t start/u)).not.toBeInTheDocument()
  })

  it('tells the owner their storage is full, and where to see it', async () => {
    mocks.admission.mockResolvedValue({ allowed: false, reason: 'storage_full' })
    renderPage()
    expect(await screen.findByText(/Your storage is full, so recording can’t start/u)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'See your usage' })).toHaveAttribute('href', '/usage')
    expect(screen.getByRole('button', { name: 'Continue recording' })).toBeDisabled()
  })

  it('tells someone recording a shared session that its owner has no storage left', async () => {
    Object.assign(live, { access: { ...live.access, isOwner: false } })
    mocks.admission.mockResolvedValue({ allowed: false, reason: 'storage_full' })
    renderPage()
    expect(await screen.findByText(/This session’s owner has no storage left/u)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'See your usage' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue recording' })).toBeDisabled()
  })

  it('keeps a recording going when recognition drops out, and says the audio is still saved', () => {
    Object.assign(live, { state: 'live', recording: { active: true, recognitionPaused: true } })
    renderPage()
    expect(screen.getByText(/Recording goes on and the audio is saved/u)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop recording' })).toBeEnabled()
    expect(mocks.admission).not.toHaveBeenCalled()
  })
})
