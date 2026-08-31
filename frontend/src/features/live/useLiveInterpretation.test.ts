import { act, renderHook, waitFor } from '@testing-library/react'
import type { InterpretationStatus, SessionDetailResponse } from '../../api/contracts'

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  getSettings: vi.fn(),
  segments: vi.fn(),
}))

vi.mock('../../api/client', () => ({
  api: {
    mode: 'http',
    sessions: { get: apiMocks.get, segments: apiMocks.segments },
    settings: { get: apiMocks.getSettings },
    liveSocketUrl: (sessionId: string) => `ws://local.test/${sessionId}`,
  },
}))

import { ensureAudioContextRunning, makeLiveHello, useLiveInterpretation } from './useLiveInterpretation'
import { AUTH_SESSION_INVALID_EVENT, type AuthSessionInvalidDetail } from '../../api/sessionInvalid'

class FakeTrack {
  private readonly ended = new Set<EventListenerOrEventListenerObject>()
  stop = vi.fn()
  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    if (type === 'ended') this.ended.add(listener)
  }
  end() {
    const event = new Event('ended')
    this.ended.forEach((listener) => typeof listener === 'function' ? listener(event) : listener.handleEvent(event))
  }
}

class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeSocket[] = []
  binaryType: BinaryType = 'blob'
  bufferedAmount = 0
  readyState = FakeSocket.CONNECTING
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  send = vi.fn()
  close = vi.fn(() => {
    this.readyState = FakeSocket.CLOSED
    this.onclose?.(new CloseEvent('close', { code: 1000 }))
  })
  constructor(readonly url: string) { FakeSocket.instances.push(this) }
  open() { this.readyState = FakeSocket.OPEN; this.onopen?.(new Event('open')) }
  message(value: unknown) { this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(value) })) }
}

class FakeAudioContext {
  state: AudioContextState = 'running'
  sampleRate = 48_000
  destination = {}
  audioWorklet = { addModule: vi.fn(async () => undefined) }
  resume = vi.fn(async () => undefined)
  close = vi.fn(async () => undefined)
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }))
  createGain = vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn() }))
}

class FakeWorkletNode {
  port = { onmessage: null as ((event: MessageEvent<ArrayBuffer>) => void) | null }
  connect = vi.fn()
  disconnect = vi.fn()
}

function sessionDetail(status: InterpretationStatus = 'created', sessionId = 'ses_1'): SessionDetailResponse {
  const now = '2026-01-01T00:00:00Z'
  return {
    session: { id: sessionId, title: 'Live test', sourceLanguage: 'en', targetLanguage: 'fr', status, createdAt: now, updatedAt: now, startedAt: null, endedAt: null },
    segments: [],
    segmentPage: { nextAfter: 0, hasMore: false, limit: 50 },
  }
}

function persistedSegment(sessionId: string, sequence: number) {
  return {
    id: `${sessionId}_segment_${sequence}`,
    sessionId,
    sequence,
    sourceText: `Source ${sequence}`,
    translation: `Translation ${sequence}`,
    translationStatus: 'succeeded' as const,
    final: true,
    startMs: sequence * 1_000,
    endMs: sequence * 1_000 + 900,
    createdAt: '2026-01-01T00:00:00Z',
  }
}

function installLivePlatform() {
  const tracks: FakeTrack[] = []
  const streams: Array<MediaStream & { active: boolean }> = []
  const getUserMedia = vi.fn(async () => {
    const track = new FakeTrack()
    const stream = { active: true, getTracks: () => [track] } as unknown as MediaStream & { active: boolean }
    tracks.push(track); streams.push(stream)
    return stream
  })
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } })
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode)
  return { tracks, streams, getUserMedia }
}

describe('live audio handshake', () => {
  beforeEach(() => {
    FakeSocket.instances = []
    apiMocks.get.mockReset().mockResolvedValue(sessionDetail())
    apiMocks.getSettings.mockReset().mockResolvedValue({ autoStartMicrophone: false, compactTranscriptLayout: false, showPartialTranscripts: true })
    apiMocks.segments.mockReset().mockResolvedValue({ items: [], nextAfter: 0, hasMore: false, limit: 100 })
  })

  it('reports raw native Float32 mono audio', () => {
    expect(makeLiveHello(48_000)).toEqual({
      type: 'start', audio: { encoding: 'pcm32f', sampleRate: 48_000, channels: 1 },
    })
  })

  it('refuses to connect when browser audio remains suspended', async () => {
    const context = { state: 'suspended' as AudioContextState, resume: vi.fn().mockResolvedValue(undefined) }
    await expect(ensureAudioContextRunning(context)).rejects.toThrow('audio is suspended')
    expect(context.resume).toHaveBeenCalledOnce()
  })

  it('continues after the audio context resumes', async () => {
    const context = { state: 'suspended' as AudioContextState, resume: vi.fn(async () => { context.state = 'running' }) }
    await expect(ensureAudioContextRunning(context)).resolves.toBeUndefined()
  })

  it('retries initial session loading without requiring a page refresh', async () => {
    apiMocks.get.mockReset().mockRejectedValueOnce(new Error('Temporary failure')).mockResolvedValueOnce(sessionDetail())
    const { result } = renderHook(() => useLiveInterpretation('ses_1'))
    await waitFor(() => expect(result.current.state).toBe('error'))
    expect(result.current.session).toBeNull()

    act(() => result.current.retryLoad())

    await waitFor(() => expect(result.current.session?.id).toBe('ses_1'))
    expect(result.current.state).toBe('idle')
    expect(apiMocks.get).toHaveBeenCalledTimes(2)
  })

  it('loads every persisted transcript page instead of stopping after the first 50 or five pages', async () => {
    const total = 1_251
    const detail = sessionDetail()
    detail.segments = Array.from({ length: 50 }, (_, index) => persistedSegment('ses_1', index + 1))
    detail.segmentPage = { nextAfter: 50, hasMore: true, limit: 50 }
    apiMocks.get.mockResolvedValue(detail)
    apiMocks.segments.mockImplementation(async (_sessionId: string, query: { after?: number; limit?: number }) => {
      const first = (query.after ?? -1) + 1
      const last = Math.min(total, first + (query.limit ?? 100) - 1)
      const items = first <= total ? Array.from({ length: last - first + 1 }, (_, index) => persistedSegment('ses_1', first + index)) : []
      return { items, nextAfter: items.at(-1)?.sequence ?? (query.after ?? -1), hasMore: last < total, limit: query.limit ?? 100 }
    })

    const { result } = renderHook(() => useLiveInterpretation('ses_1'))

    await waitFor(() => expect(result.current.segments).toHaveLength(total))
    expect(result.current.segments[50]?.sequence).toBe(51)
    expect(result.current.segments.at(-1)?.sequence).toBe(total)
    expect(apiMocks.segments).toHaveBeenCalledTimes(7)
  })

  it('discards an old session transcript page after the route changes', async () => {
    let resolveOldPage!: (value: { items: ReturnType<typeof persistedSegment>[]; nextAfter: number; hasMore: boolean; limit: number }) => void
    const oldPage = new Promise<{ items: ReturnType<typeof persistedSegment>[]; nextAfter: number; hasMore: boolean; limit: number }>((resolve) => { resolveOldPage = resolve })
    apiMocks.get.mockImplementation(async (id: string) => {
      const detail = sessionDetail()
      detail.session.id = id
      detail.session.title = id
      detail.segments = []
      detail.segmentPage = { nextAfter: 50, hasMore: id === 'ses_a', limit: 50 }
      return detail
    })
    apiMocks.segments.mockImplementation((id: string) => id === 'ses_a' ? oldPage : Promise.resolve({ items: [], nextAfter: 0, hasMore: false, limit: 200 }))
    const { result, rerender } = renderHook(({ id }) => useLiveInterpretation(id), { initialProps: { id: 'ses_a' } })
    await waitFor(() => expect(result.current.session?.id).toBe('ses_a'))

    rerender({ id: 'ses_b' })
    await waitFor(() => expect(result.current.session?.id).toBe('ses_b'))
    await act(async () => resolveOldPage({ items: [persistedSegment('ses_a', 51)], nextAfter: 51, hasMore: false, limit: 200 }))

    expect(result.current.segments).toEqual([])
  })

  it('keeps a persisted terminal session terminal and refuses to restart it', async () => {
    const platform = installLivePlatform()
    const detail = sessionDetail()
    detail.session.status = 'completed'
    apiMocks.get.mockResolvedValue(detail)
    const { result } = renderHook(() => useLiveInterpretation('ses_1'))
    await waitFor(() => expect(result.current.state).toBe('ended'))

    await act(async () => result.current.start())

    expect(platform.getUserMedia).not.toHaveBeenCalled()
    expect(FakeSocket.instances).toHaveLength(0)
  })

  it('cancels a connecting socket before it can send the live start message', async () => {
    installLivePlatform()
    const { result } = renderHook(() => useLiveInterpretation('ses_1'))
    await waitFor(() => expect(result.current.session).not.toBeNull())
    await act(async () => result.current.start())
    const socket = FakeSocket.instances[0]
    const staleOpen = socket?.onopen
    expect(result.current.state).toBe('connecting')

    await act(async () => result.current.stop())
    expect(result.current.state).toBe('idle')
    expect(socket?.close).toHaveBeenCalled()
    act(() => staleOpen?.(new Event('open')))
    expect(socket?.send).not.toHaveBeenCalled()
  })

  it('uses the persisted server outcome when stopping during a disconnected reconnect', async () => {
    installLivePlatform()
    apiMocks.get.mockResolvedValueOnce(sessionDetail()).mockResolvedValueOnce(sessionDetail('failed'))
    const { result } = renderHook(() => useLiveInterpretation('ses_1'))
    await waitFor(() => expect(result.current.session).not.toBeNull())
    await act(async () => result.current.start())
    const socket = FakeSocket.instances[0]
    act(() => { socket?.open(); socket?.message({ type: 'ready', sessionId: 'ses_1', runId: 'run_1', chunkMs: 100 }) })
    expect(result.current.state).toBe('live')

    act(() => {
      if (socket) socket.readyState = FakeSocket.CLOSED
      socket?.onclose?.(new CloseEvent('close', { code: 1006 }))
    })
    expect(result.current.state).toBe('reconnecting')

    await act(async () => result.current.stop())

    expect(apiMocks.get).toHaveBeenCalledTimes(2)
    expect(result.current.session?.status).toBe('failed')
    expect(result.current.state).toBe('error')
    expect(result.current.error).toContain('recorded by the server')
  })

  it('keeps a server-stopped session terminal when the socket closes afterwards', async () => {
    installLivePlatform()
    const { result } = renderHook(() => useLiveInterpretation('ses_1'))
    await waitFor(() => expect(result.current.session).not.toBeNull())
    await act(async () => result.current.start())
    const socket = FakeSocket.instances[0]
    expect(socket).toBeDefined()
    act(() => { socket?.open(); socket?.message({ type: 'ready', sessionId: 'ses_1', runId: 'run_1', chunkMs: 100 }) })
    expect(result.current.state).toBe('live')

    const staleClose = socket?.onclose
    act(() => socket?.message({ type: 'stopped', status: 'completed' }))
    expect(result.current.state).toBe('ended')
    act(() => staleClose?.(new CloseEvent('close', { code: 1000 })))
    expect(result.current.state).toBe('ended')
  })

  it('ignores callbacks from a retired socket after a retry starts a new generation', async () => {
    installLivePlatform()
    const { result } = renderHook(() => useLiveInterpretation('ses_1'))
    await waitFor(() => expect(result.current.session).not.toBeNull())
    await act(async () => result.current.start())
    const first = FakeSocket.instances[0]
    act(() => { first?.open(); first?.message({ type: 'ready', sessionId: 'ses_1', runId: 'run_1', chunkMs: 100 }) })
    const staleClose = first?.onclose
    act(() => first?.message({ type: 'error', code: 'PROVIDER_FAILED', message: 'Provider failed.' }))
    expect(result.current.state).toBe('error')

    await act(async () => result.current.start())
    const second = FakeSocket.instances[1]
    act(() => { second?.open(); second?.message({ type: 'ready', sessionId: 'ses_1', runId: 'run_2', chunkMs: 100 }) })
    expect(result.current.state).toBe('live')
    act(() => staleClose?.(new CloseEvent('close', { code: 1006 })))
    expect(result.current.state).toBe('live')
  })

  it('moves to an actionable error and retires the socket when the microphone ends', async () => {
    const platform = installLivePlatform()
    const { result } = renderHook(() => useLiveInterpretation('ses_1'))
    await waitFor(() => expect(result.current.session).not.toBeNull())
    await act(async () => result.current.start())
    const socket = FakeSocket.instances[0]
    act(() => { socket?.open(); socket?.message({ type: 'ready', sessionId: 'ses_1', runId: 'run_1', chunkMs: 100 }) })

    act(() => { if (platform.streams[0]) platform.streams[0].active = false; platform.tracks[0]?.end() })
    expect(result.current.state).toBe('error')
    expect(result.current.error).toContain('microphone stopped unexpectedly')
    expect(socket?.close).toHaveBeenCalled()
  })

  it('invalidates the browser auth state when the live service revokes it', async () => {
    installLivePlatform()
    const invalidations: AuthSessionInvalidDetail[] = []
    const listener = (event: Event) => invalidations.push((event as CustomEvent<AuthSessionInvalidDetail>).detail)
    window.addEventListener(AUTH_SESSION_INVALID_EVENT, listener)
    const { result } = renderHook(() => useLiveInterpretation('ses_1'))
    await waitFor(() => expect(result.current.session).not.toBeNull())
    await act(async () => result.current.start())
    const socket = FakeSocket.instances[0]
    act(() => {
      socket?.open()
      socket?.message({ type: 'error', code: 'AUTH_REVOKED', message: 'This browser session was revoked.' })
    })

    expect(invalidations).toEqual([{ reason: 'expired', message: 'This browser session was revoked.' }])
    expect(result.current.state).toBe('error')
    window.removeEventListener(AUTH_SESSION_INVALID_EVENT, listener)
  })
})
