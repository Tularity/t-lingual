import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AnchorHTMLAttributes } from 'react'
import type { InterpretationSession, ViewerAccess } from '../../api/contracts'
import { LivePage } from './LivePage'

const mocks = vi.hoisted(() => ({ useLive: vi.fn(), start: vi.fn(), stop: vi.fn(), stopOther: vi.fn(), changeLanguage: vi.fn() }))

vi.mock('./useLiveInterpretation', () => ({ useLiveInterpretation: mocks.useLive }))
vi.mock('../../api/client', () => ({ api: { audio:{list:async()=>({parts:[],durationMs:0}),partUrl:()=>'',bundleUrl:()=>''}, mode: 'http' } }))
vi.mock('../../app/router', () => ({
  Link: ({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a>,
}))
vi.mock('../sessions/SharingDialog', () => ({ SharingDialog: ({ open }: { open: boolean }) => open ? <div>Share dialog open</div> : null }))
vi.mock('../transcript/useTranscriptPiP', () => ({ TranscriptPiPButton: () => <button type="button">Picture in picture</button> }))
vi.mock('../transcript/TranscriptViewport', () => ({ TranscriptViewport: () => <div role="region" aria-label="Transcript entries" /> }))

const session: InterpretationSession = {
  id: 'session_collaboration', title: 'Team conversation', sourceLanguage: 'en', targetLanguage: 'fr',
  recognitionLanguages: ['en', 'ja'], diarization: true, status: 'completed',
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
  startedAt: '2026-09-01T00:00:00Z', endedAt: '2026-09-01T00:01:00Z',
}

function view(access: ViewerAccess, recording = { active: false, holderName: '' }, overrides: Record<string, unknown> = {}) {
  return {
    session: { ...session }, access, recording, segments: [], state: 'ended', paused: false,
    partial: '', error: '', elapsedMs: 60_000, autoStart: false, compact: false, languageBusy: false,
    start: mocks.start, stop: mocks.stop, stopOtherRecorder: mocks.stopOther, changeLanguage: mocks.changeLanguage,
    retryLoad: vi.fn(), unarchive: vi.fn(), archiveBusy: false, togglePause: vi.fn(),
    ...overrides,
  }
}

describe('shared live session controls', () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset())
  })

  it('keeps a read-only viewer out of recorder and owner actions while allowing personal language choice', async () => {
    const user = userEvent.setup()
    mocks.useLive.mockReturnValue(view({ viewerId: 'guest:1', displayName: 'Guest', isOwner: false, permission: 'view', targetLanguage: 'fr' }))
    render(<LivePage sessionId={session.id} guest />)

    expect(screen.getByText('Read only')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Start recording' })).not.toBeInTheDocument()
    await act(async()=>{})
    expect(screen.queryByRole('button', { name: 'Continue recording' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop recording' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Share' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Take over recording' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Your translation French' }))
    await user.click(await screen.findByRole('menuitemradio', { name: /Japanese/u }))
    expect(mocks.changeLanguage).toHaveBeenCalledWith('ja')
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('does not give a non-owner recorder takeover rights when another viewer is recording', async () => {
    mocks.useLive.mockReturnValue(view(
      { viewerId: 'user:recipient', displayName: 'Recipient', isOwner: false, permission: 'record', targetLanguage: 'fr' },
      { active: true, holderName: 'Morgan' }, { state: 'idle' },
    ))
    render(<LivePage sessionId={session.id} />)

    expect(screen.getByText('Morgan is recording')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop their recording' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Take over recording' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Start recording' })).not.toBeInTheDocument()
    await act(async()=>{})
  })

  it('lets the owner stop or explicitly take over an occupied recorder', async () => {
    const user = userEvent.setup()
    mocks.useLive.mockReturnValue(view(
      { viewerId: 'user:owner', displayName: 'Owner', isOwner: true, permission: 'record', targetLanguage: 'fr' },
      { active: true, holderName: 'Morgan' }, { state: 'idle' },
    ))
    render(<LivePage sessionId={session.id} />)

    await user.click(screen.getByRole('button', { name: 'Stop their recording' }))
    expect(mocks.stopOther).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('button', { name: 'Take over recording' }))
    expect(mocks.start).toHaveBeenCalledWith(true)
    await user.click(screen.getByRole('button', { name: 'Share' }))
    expect(screen.getByText('Share dialog open')).toBeInTheDocument()
  })
})
