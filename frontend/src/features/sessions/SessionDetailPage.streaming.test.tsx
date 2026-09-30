import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AnchorHTMLAttributes } from 'react'
import type { Segment } from '../../api/contracts'
import { ToastProvider } from '../../design-system'
import { SessionDetailPage } from './SessionDetailPage'

const mocks = vi.hoisted(() => ({ get: vi.fn(), segments: vi.fn(), language: vi.fn(), eventsUrl: vi.fn(), freezeWindow: false }))

vi.mock('../../api/client', () => ({ api: { audio:{list:async()=>({parts:[],durationMs:0}),partUrl:()=>'',bundleUrl:()=>''}, mode: 'http', sessions: { get: mocks.get, segments: mocks.segments, language: mocks.language }, eventsUrl: mocks.eventsUrl } }))
vi.mock('../../app/router', () => ({
  useRouter: () => ({ navigate: vi.fn() }),
  Link: ({ href, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a>,
}))
vi.mock('../languages', () => ({
  languageDisplayName:(code:string)=>code,languageFlag:()=>'/flags/globe.svg',
  LanguageLabel: ({ code }: { code: string }) => <span>{code}</span>,
  LanguageSelect: ({ onChange }: { onChange: (value: string) => void }) => <button type="button" onClick={() => onChange('ja')}>Switch target</button>,
}))
vi.mock('../transcript/TranscriptViewport', async () => {
  const React = await import('react')
  return { TranscriptViewport: ({ segments, onWindowChange }: { segments: Segment[]; onWindowChange?: (segments: Segment[]) => void }) => {
    React.useEffect(() => { if (!mocks.freezeWindow) onWindowChange?.(segments) }, [segments, onWindowChange])
    return <div data-testid="transcript-projection">{segments.map(segment => <span key={segment.id}>{segment.translationStatus}:{segment.translation || '[empty]'}</span>)}</div>
  } }
})
vi.mock('../transcript/useTranscriptPiP', () => ({ TranscriptPiPButton: () => null, useTranscriptPiP: () => ({ supported: false, isOpen: false, toggle: () => {}, error: '', portal: null }) }))

class FakeEventSource {
  static instances: FakeEventSource[] = []
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(readonly url: string) { FakeEventSource.instances.push(this) }
  emit(value: unknown) { this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(value) })) }
  close() { this.closed = true }
}

const segment = (translation = '', status: Segment['translationStatus'] = 'pending', revision = 0): Segment => ({
  id: 'seg_1', sessionId: 'ses_1', sequence: 1, sourceText: 'Hello', translation,
  translationStatus: status, translationRevision: revision, final: true,
  startMs: 0, endMs: 900, createdAt: '2026-01-01T00:00:00Z',
})

const detail = (target: string, row = segment()) => ({
  session: { id: 'ses_1', title: 'Discussion', sourceLanguage: 'en', targetLanguage: target, status: 'completed' as const,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:01:00Z', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:01:00Z' },
  access: { viewerId: 'user:alice', displayName: 'Alice', isOwner: true, permission: 'record' as const, targetLanguage: target },
  segments: [row], segmentPage: { nextAfter: 1, hasMore: false, limit: 50 },
})

describe('persisted transcript streaming events', () => {
  beforeEach(() => {
    FakeEventSource.instances = []
    mocks.freezeWindow = false
    mocks.get.mockReset().mockResolvedValue(detail('fr'))
    mocks.segments.mockReset().mockResolvedValue({ items: [], nextAfter: 1, hasMore: false, limit: 50 })
    mocks.language.mockReset().mockResolvedValue({ targetLanguage: 'ja' })
    mocks.eventsUrl.mockReset().mockReturnValue('/api/v1/view/sessions/ses_1/events')
    vi.stubGlobal('EventSource', FakeEventSource)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('replaces provisional text, ignores stale revisions and clears rejected output', async () => {
    render(<ToastProvider><SessionDetailPage sessionId="ses_1" /></ToastProvider>)
    await screen.findByRole('heading', { name: 'Discussion' })
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    const source = FakeEventSource.instances[0]!
    act(() => source.emit({ type: 'translation', segmentId: 'seg_1', targetLanguage: 'fr', translation: 'Bon', status: 'pending', revision: 2 }))
    expect(screen.getByText('pending:Bon')).toBeInTheDocument()
    act(() => source.emit({ type: 'translation', segmentId: 'seg_1', targetLanguage: 'fr', translation: 'B', status: 'pending', revision: 1 }))
    expect(screen.getByText('pending:Bon')).toBeInTheDocument()
    act(() => source.emit({ type: 'translation', segmentId: 'seg_1', targetLanguage: 'ja', translation: '漏れ', status: 'pending', revision: 9 }))
    expect(screen.queryByText('pending:漏れ')).not.toBeInTheDocument()
    act(() => source.emit({ type: 'translation', segmentId: 'seg_1', targetLanguage: 'fr', translation: '', status: 'failed', error: 'output_validation_failed', revision: 3 }))
    expect(screen.getByText('failed:[empty]')).toBeInTheDocument()
    act(() => source.emit({ type: 'translation', segmentId: 'seg_1', targetLanguage: 'fr', translation: 'Bon', status: 'pending', revision: 2 }))
    expect(screen.getByText('failed:[empty]')).toBeInTheDocument()
  })

  it('shows who else has the session open as they come and go', async () => {
    render(<ToastProvider><SessionDetailPage sessionId="ses_1" /></ToastProvider>)
    await screen.findByRole('heading', { name: 'Discussion' })
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    const source = FakeEventSource.instances[0]!
    const me = { key: 'me', name: 'Alice', kind: 'user', userId: 'alice', isMe: true }
    expect(screen.queryByRole('button', { name: /people here/u })).not.toBeInTheDocument()
    act(() => source.emit({ type: 'presence', presence: { people: [me, { key: 'guest', name: 'Guest', kind: 'guest', isMe: false }], total: 2 } }))
    expect(screen.getByRole('button', { name: '2 people here' })).toBeInTheDocument()
    act(() => source.emit({ type: 'presence', presence: { people: [me], total: 1 } }))
    expect(screen.queryByRole('button', { name: /people here/u })).not.toBeInTheDocument()
  })

  it('never merges an old-language reader window into the new target after switching', async () => {
    mocks.get.mockResolvedValueOnce(detail('fr', segment('Bonjour', 'succeeded', 12))).mockResolvedValueOnce(detail('ja'))
    render(<ToastProvider><SessionDetailPage sessionId="ses_1" /></ToastProvider>)
    expect(await screen.findByText('succeeded:Bonjour')).toBeInTheDocument()
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    mocks.freezeWindow = true
    await userEvent.click(screen.getByRole('button', { name: 'Switch target' }))
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2))
    expect(screen.getByText('pending:[empty]')).toBeInTheDocument()
    const previous = FakeEventSource.instances[0]!
    const current = FakeEventSource.instances[1]!
    expect(previous.closed).toBe(true)
    act(() => previous.emit({ type: 'translation', segmentId: 'seg_1', targetLanguage: 'fr', translation: 'Ancien', status: 'succeeded', revision: 13 }))
    act(() => current.emit({ type: 'translation', segmentId: 'seg_1', targetLanguage: 'ja', translation: 'こん', status: 'pending', revision: 1 }))
    expect(screen.queryByText('succeeded:Bonjour')).not.toBeInTheDocument()
    expect(screen.getByText('pending:こん')).toBeInTheDocument()
  })

  it('reconciles a visible provisional row after a recoverable EventSource interruption', async () => {
    mocks.get.mockResolvedValueOnce(detail('fr', segment('Bon', 'pending', 2)))
      .mockResolvedValueOnce(detail('fr', segment('', 'failed', 3)))
    render(<ToastProvider><SessionDetailPage sessionId="ses_1" /></ToastProvider>)
    expect(await screen.findByText('pending:Bon')).toBeInTheDocument()
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1))
    act(() => FakeEventSource.instances[0]!.onerror?.())
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText('pending:Bon')).not.toBeInTheDocument())
    expect(await screen.findByText('failed:[empty]')).toBeInTheDocument()
  })
})
