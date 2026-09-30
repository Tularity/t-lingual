import { act, renderHook, waitFor } from '@testing-library/react'
import type { InterpretationStatus, SessionDetailResponse } from '../../api/contracts'

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  getSettings: vi.fn(),
  segments: vi.fn(),
  language: vi.fn(),
}))

vi.mock('../../api/client', () => ({
  api: {
    mode: 'http',
    sessions: { get: apiMocks.get, segments: apiMocks.segments, language: apiMocks.language },
    settings: { get: apiMocks.getSettings },
    liveSocketUrl: (sessionId: string, takeover = false, resume = false) => `ws://local.test/${sessionId}${takeover ? '?takeover=true' : resume ? '?resume=true' : ''}`,
    eventsUrl: (sessionId: string) => `http://local.test/${sessionId}/events`,
  },
}))

import { ensureAudioContextRunning, liveTiming, makeLiveHello, useLiveInterpretation } from './useLiveInterpretation'
import { toPcm16 } from './audioCapture'

/** The samples of a frame as sent: 16-bit. */
const samples16 = (frame: unknown) => [...new Int16Array(frame as ArrayBuffer)]
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

function fakeAudioNode() {
  return { connect: vi.fn((destination: unknown) => destination), disconnect: vi.fn(),
    gain: { value: 1 }, frequency: { value: 0 }, Q: { value: 0 }, type: '',
    threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 } }
}
class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  constructor() { FakeAudioContext.instances.push(this) }
  state: AudioContextState = 'running'
  sampleRate = 48_000
  destination = {}
  audioWorklet = { addModule: vi.fn(async () => undefined) }
  resume = vi.fn(async () => undefined)
  close = vi.fn(async () => undefined)
  createMediaStreamSource = vi.fn(() => fakeAudioNode())
  createBiquadFilter = vi.fn(() => fakeAudioNode())
  createDynamicsCompressor = vi.fn(() => fakeAudioNode())
  createGain = vi.fn(() => fakeAudioNode())
}

class FakeWorkletNode {
  static instances: FakeWorkletNode[] = []
  port = {
    onmessage: null as ((event: MessageEvent<ArrayBuffer | { type: 'flushed'; requestId: number }>) => void) | null,
    postMessage: vi.fn((message: { type: string; requestId: number }) => {
      if (message.type === 'flush') queueMicrotask(() => this.port.onmessage?.(new MessageEvent('message', { data: { type: 'flushed', requestId: message.requestId } })))
    }),
  }
  connect = vi.fn((destination: unknown) => destination)
  disconnect = vi.fn()
  constructor() { FakeWorkletNode.instances.push(this) }
}
function sessionDetail(status: InterpretationStatus = 'created', sessionId = 'ses_1'): SessionDetailResponse {
  const now = '2026-01-01T00:00:00Z'
  return {
    session: { id: sessionId, title: 'Live test', sourceLanguage: 'en', targetLanguage: 'fr', status, createdAt: now, updatedAt: now, startedAt: null, endedAt: null },
    access: { viewerId:'user:test',displayName:'Test',isOwner:true,permission:'record',targetLanguage:'fr' },
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
    FakeWorkletNode.instances = []
    FakeAudioContext.instances = []
    apiMocks.get.mockReset().mockResolvedValue(sessionDetail())
    apiMocks.getSettings.mockReset().mockResolvedValue({ autoStartMicrophone: false, compactTranscriptLayout: false, showPartialTranscripts: true })
    apiMocks.segments.mockReset().mockResolvedValue({ items: [], nextAfter: 0, hasMore: false, limit: 100 })
    apiMocks.language.mockReset().mockResolvedValue({ viewerId: 'user:test', displayName: 'Test', isOwner: true, permission: 'record', targetLanguage: 'ja' })
  })

  it('reports native-rate 16-bit mono audio', () => {
    expect(makeLiveHello(48_000)).toEqual({
      type: 'start', audio: { encoding: 'pcm16', sampleRate: 48_000, channels: 1 },
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

  it('loads only the latest bounded page and leaves older history to the viewport', async () => {
    const detail = sessionDetail()
    detail.segments = Array.from({ length: 50 }, (_, index) => persistedSegment('ses_1', index + 1))
    detail.segmentPage = { nextAfter: 50, hasMore: true, limit: 50 }
    apiMocks.get.mockResolvedValue(detail)
    apiMocks.segments.mockResolvedValue({ items: Array.from({ length: 80 }, (_, index) => persistedSegment('ses_1', 1172 + index)), nextAfter: 1251, hasMore: false, hasEarlier: true, limit: 80 })
    const { result } = renderHook(() => useLiveInterpretation('ses_1'))
    await waitFor(() => expect(result.current.segments.at(-1)?.sequence).toBe(1251))
    expect(result.current.segments).toHaveLength(80)
    expect(apiMocks.segments).toHaveBeenCalledWith('ses_1', { tail: true, limit: 80 })
    expect(apiMocks.segments).toHaveBeenCalledTimes(1)
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

  it('ignores a previous target language tail that arrives after switching translations', async () => {
    let resolveFrench!: (value: { items: ReturnType<typeof persistedSegment>[]; nextAfter: number; hasMore: boolean; limit: number }) => void
    const frenchPage = new Promise<{ items: ReturnType<typeof persistedSegment>[]; nextAfter: number; hasMore: boolean; limit: number }>(resolve => { resolveFrench = resolve })
    const detail = sessionDetail()
    detail.segments = [persistedSegment('ses_1', 1)]
    detail.segmentPage = { nextAfter: 1, hasMore: true, limit: 50 }
    apiMocks.get.mockResolvedValue(detail)
    const japanese = { ...persistedSegment('ses_1', 75), translation: '日本語の訳' }
    apiMocks.segments.mockReset().mockReturnValueOnce(frenchPage).mockResolvedValueOnce({ items: [japanese], nextAfter: 75, hasMore: false, limit: 80 })

    const { result } = renderHook(() => useLiveInterpretation('ses_1'))
    await waitFor(() => expect(apiMocks.segments).toHaveBeenCalledTimes(1))
    await act(async () => result.current.changeLanguage('ja'))
    expect(result.current.session?.targetLanguage).toBe('ja')
    expect(result.current.segments.at(-1)?.translation).toBe('日本語の訳')

    const lateFrench = { ...persistedSegment('ses_1', 75), translation: 'Ancienne traduction' }
    await act(async () => resolveFrench({ items: [lateFrench], nextAfter: 75, hasMore: false, limit: 80 }))

    expect(result.current.segments.at(-1)?.translation).toBe('日本語の訳')
    expect(apiMocks.segments).toHaveBeenCalledTimes(2)
  })

  it('does not request a microphone when record access is downgraded during the start preflight', async () => {
    const platform = installLivePlatform()
    const readOnly = sessionDetail()
    readOnly.access = { viewerId: 'user:test', displayName: 'Test', isOwner: false, permission: 'view', targetLanguage: 'fr' }
    apiMocks.get.mockResolvedValueOnce(sessionDetail()).mockResolvedValueOnce(readOnly)

    const { result } = renderHook(() => useLiveInterpretation('ses_1'))
    await waitFor(() => expect(result.current.access?.permission).toBe('record'))
    await act(async () => result.current.start())

    expect(apiMocks.get).toHaveBeenCalledTimes(2)
    expect(result.current.state).toBe('error')
    expect(result.current.error).toContain('read-only')
    expect(platform.getUserMedia).not.toHaveBeenCalled()
    expect(FakeSocket.instances).toHaveLength(0)
  })

  it('keeps an archived session read-only until it is unarchived', async () => {
    const platform = installLivePlatform()
    const detail = sessionDetail()
    detail.session.status = 'completed'
    detail.session.archivedAt = new Date().toISOString()
    apiMocks.get.mockResolvedValue(detail)
    const { result } = renderHook(() => useLiveInterpretation('ses_1'))
    await waitFor(() => expect(result.current.state).toBe('ended'))

    await act(async () => result.current.start())

    expect(platform.getUserMedia).not.toHaveBeenCalled()
    expect(FakeSocket.instances).toHaveLength(0)
  })

  it.each(['completed', 'failed'] as const)('continues a %s recording without dropping saved phrases', async status => {
    const platform = installLivePlatform()
    const detail = sessionDetail(status)
    detail.segments = [persistedSegment('ses_1', 1)]
    apiMocks.get.mockResolvedValue(detail)
    const { result } = renderHook(() => useLiveInterpretation('ses_1'))
    await waitFor(() => expect(result.current.session).not.toBeNull())
    await act(async () => result.current.start())
    expect(platform.getUserMedia).toHaveBeenCalledOnce()
    const socket = FakeSocket.instances[0]
    await act(async () => { socket?.open(); socket?.message({ type: 'ready', sessionId: 'ses_1', runId: 'resumed', chunkMs: 100, offsetMs: 1900 }) })
    expect(result.current.elapsedMs).toBe(1900)
    await act(async () => socket?.message({ type: 'final', segment: persistedSegment('ses_1', 2), upstreamSequence: 1 }))
    expect(result.current.segments.map(segment => segment.sequence)).toEqual([1, 2])
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
    await act(async () => staleOpen?.(new Event('open')))
    expect(socket?.send).not.toHaveBeenCalled()
  })

  it('does not report a clean cancel when microphone frames were captured before the socket became ready', async () => {
    installLivePlatform()
    const { result } = renderHook(() => useLiveInterpretation('ses_1'))
    await waitFor(() => expect(result.current.session).not.toBeNull())
    await act(async () => result.current.start())
    const worklet = FakeWorkletNode.instances[0]!
    act(() => worklet.port.onmessage?.(new MessageEvent('message', { data: new Float32Array([0.2, 0]).buffer })))
    await act(async () => result.current.stop())
    expect(result.current.state).toBe('error')
    expect(result.current.error).toContain('could not be saved')
    expect(FakeSocket.instances[0]?.send).not.toHaveBeenCalled()
  })
  it('finishes sending what was kept once the connection is back after a stop while it was down', async () => {
    installLivePlatform()
    const { result } = renderHook(() => useLiveInterpretation('ses_1'))
    await waitFor(() => expect(result.current.session).not.toBeNull())
    await act(async () => result.current.start())
    const first = FakeSocket.instances[0]!
    const worklet = FakeWorkletNode.instances[0]!
    await act(async () => { first.open(); first.message({ type: 'ready', sessionId: 'ses_1', runId: 'run_1', chunkMs: 100, offsetMs: 0 }) })
    const sent = new Float32Array(48).fill(0.1).buffer
    act(() => worklet.port.onmessage?.(new MessageEvent('message', { data: sent })))
    expect(samples16(first.send.mock.calls.at(-1)?.[0])).toEqual(samples16(toPcm16(sent)))

    await act(async () => { first.readyState = FakeSocket.CLOSED; first.onclose?.(new CloseEvent('close', { code: 1006 })) })
    expect(result.current.state).toBe('reconnecting')
    const kept = new Float32Array(48).fill(0.2).buffer
    act(() => worklet.port.onmessage?.(new MessageEvent('message', { data: kept })))

    await act(async () => result.current.stop())
    expect(result.current.state).toBe('stopping')
    const second = FakeSocket.instances[1]!
    expect(second.url).toContain('resume=true')
    // The server saved the first frame (1 ms at 48 kHz): the kept one follows, then the end.
    await act(async () => { second.open(); second.message({ type: 'ready', sessionId: 'ses_1', runId: 'run_2', chunkMs: 100, offsetMs: 1 }) })
    const payloads = second.send.mock.calls.map(([payload]) => payload)
    expect(payloads.slice(1, -1).map(samples16)).toEqual([samples16(toPcm16(kept))])
    expect(JSON.parse(String(payloads.at(-1)))).toEqual({ type: 'end' })
    await act(async () => second.message({ type: 'stopped', status: 'completed' }))
    expect(result.current.state).toBe('ended')
  })

  it('reports what the server saved when the connection does not come back after a stop', async () => {
    installLivePlatform()
    const grace = liveTiming.stopGraceMs
    liveTiming.stopGraceMs = 30
    try {
      apiMocks.get.mockResolvedValueOnce(sessionDetail()).mockResolvedValueOnce(sessionDetail()).mockResolvedValueOnce(sessionDetail('failed'))
      const { result } = renderHook(() => useLiveInterpretation('ses_1'))
      await waitFor(() => expect(result.current.session).not.toBeNull())
      await act(async () => result.current.start())
      const socket = FakeSocket.instances[0]!
      const worklet = FakeWorkletNode.instances[0]!
      await act(async () => { socket.open(); socket.message({ type: 'ready', sessionId: 'ses_1', runId: 'run_1', chunkMs: 100, offsetMs: 0 }) })
      await act(async () => { socket.readyState = FakeSocket.CLOSED; socket.onclose?.(new CloseEvent('close', { code: 1006 })) })
      act(() => worklet.port.onmessage?.(new MessageEvent('message', { data: new Float32Array(480).buffer })))
      await act(async () => result.current.stop())
      await waitFor(() => expect(result.current.state).toBe('error'))
      expect(result.current.session?.status).toBe('failed')
      expect(result.current.error).toContain('couldn’t be saved')
    } finally { liveTiming.stopGraceMs = grace }
  })

  it('keeps a server-stopped session terminal when the socket closes afterwards', async () => {
    installLivePlatform()
    const { result } = renderHook(() => useLiveInterpretation('ses_1'))
    await waitFor(() => expect(result.current.session).not.toBeNull())
    await act(async () => result.current.start())
    const socket = FakeSocket.instances[0]
    expect(socket).toBeDefined()
    await act(async () => { socket?.open(); socket?.message({ type: 'ready', sessionId: 'ses_1', runId: 'run_1', chunkMs: 100 }) })
    expect(result.current.state).toBe('live')

    const staleClose = socket?.onclose
    await act(async () => socket?.message({ type: 'stopped', status: 'completed' }))
    expect(result.current.state).toBe('ended')
    await act(async () => staleClose?.(new CloseEvent('close', { code: 1000 })))
    expect(result.current.state).toBe('ended')
  })

  it('ignores callbacks from a retired socket after a retry starts a new generation', async () => {
    installLivePlatform()
    const { result } = renderHook(() => useLiveInterpretation('ses_1'))
    await waitFor(() => expect(result.current.session).not.toBeNull())
    await act(async () => result.current.start())
    const first = FakeSocket.instances[0]
    await act(async () => { first?.open(); first?.message({ type: 'ready', sessionId: 'ses_1', runId: 'run_1', chunkMs: 100 }) })
    const staleClose = first?.onclose
    act(() => first?.message({ type: 'error', code: 'PROVIDER_FAILED', message: 'Provider failed.' }))
    expect(result.current.state).toBe('error')

    await act(async () => result.current.start())
    const second = FakeSocket.instances[1]
    await act(async () => { second?.open(); second?.message({ type: 'ready', sessionId: 'ses_1', runId: 'run_2', chunkMs: 100 }) })
    expect(result.current.state).toBe('live')
    await act(async () => staleClose?.(new CloseEvent('close', { code: 1006 })))
    expect(result.current.state).toBe('live')
  })

  it('announces the actual native rate and preserves PCM captured before readiness and while paused', async () => {
    const platform = installLivePlatform()
    const { result } = renderHook(() => useLiveInterpretation('ses_1'))
    await waitFor(() => expect(result.current.session).not.toBeNull())
    await act(async () => result.current.start())
    expect(platform.getUserMedia).toHaveBeenCalledWith({ audio: expect.objectContaining({
      sampleRate: { ideal: 48_000 }, channelCount: { ideal: 1 },
      echoCancellation: false, noiseSuppression: false, autoGainControl: false,
    }) })
    const socket = FakeSocket.instances[0]!
    const worklet = FakeWorkletNode.instances[0]!
    const first = new Float32Array([0, 0, 0]).buffer
    const second = new Float32Array([0.2, 0.3]).buffer
    act(() => worklet.port.onmessage?.(new MessageEvent('message', { data: first })))
    await act(async () => { socket.open(); await Promise.resolve() })
    expect(JSON.parse(String(socket.send.mock.calls[0]?.[0]))).toMatchObject({ type: 'start', audio: { sampleRate: 48_000 } })
    act(() => worklet.port.onmessage?.(new MessageEvent('message', { data: second })))
    expect(socket.send).toHaveBeenCalledTimes(1)
    await act(async () => { socket.message({ type: 'ready', sessionId: 'ses_1', runId: 'run_a', chunkMs: 100 }); await Promise.resolve() })
    expect(socket.send.mock.calls.slice(1).map(([frame]) => samples16(frame))).toEqual([[0, 0, 0], samples16(toPcm16(second))])
    act(() => result.current.togglePause())
    act(() => worklet.port.onmessage?.(new MessageEvent('message', { data: second })))
    const pausedFrame = socket.send.mock.calls.at(-1)?.[0] as ArrayBuffer
    expect(pausedFrame.byteLength).toBe(second.byteLength / 2)
    expect(samples16(pausedFrame)).toEqual([0, 0])
  })

  it('flushes the worklet tail to the socket before sending end', async () => {
    installLivePlatform()
    const { result } = renderHook(() => useLiveInterpretation('ses_1'))
    await waitFor(() => expect(result.current.session).not.toBeNull())
    await act(async () => result.current.start())
    const socket = FakeSocket.instances[0]!
    const worklet = FakeWorkletNode.instances[0]!
    act(() => { socket.open(); socket.message({ type: 'ready', sessionId: 'ses_1', runId: 'run_b', chunkMs: 100 }) })
    const tail = new Float32Array([0.25, 0.5]).buffer
    worklet.port.postMessage.mockImplementation((message) => {
      if (message.type !== 'flush') return
      queueMicrotask(() => {
        worklet.port.onmessage?.(new MessageEvent('message', { data: tail }))
        worklet.port.onmessage?.(new MessageEvent('message', { data: { type: 'flushed', requestId: message.requestId } }))
      })
    })
    await act(async () => result.current.stop())
    expect(worklet.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'flush' }))
    const sent = socket.send.mock.calls.map(([payload]) => payload)
    expect(samples16(sent.at(-2))).toEqual(samples16(toPcm16(tail)))
    expect(JSON.parse(String(sent.at(-1)))).toEqual({ type: 'end' })
  })

  it('keeps audio under sustained backpressure and makes a stalled connection again', async () => {
    installLivePlatform()
    const timing = { ...liveTiming }
    liveTiming.stallMs = -1; liveTiming.reconnectFirstMs = 0
    try {
      const { result } = renderHook(() => useLiveInterpretation('ses_1'))
      await waitFor(() => expect(result.current.session).not.toBeNull())
      await act(async () => result.current.start())
      const socket = FakeSocket.instances[0]!
      const worklet = FakeWorkletNode.instances[0]!
      await act(async () => { socket.open(); socket.message({ type: 'ready', sessionId: 'ses_1', runId: 'run_c', chunkMs: 100, offsetMs: 0 }); await Promise.resolve() })
      socket.bufferedAmount = 1_000_000
      const frame = new Float32Array([0.2]).buffer
      act(() => worklet.port.onmessage?.(new MessageEvent('message', { data: frame })))
      // Nothing is thrown away and nothing ends: the connection is made again.
      expect(socket.send).toHaveBeenCalledTimes(1)
      expect(socket.close).toHaveBeenCalled()
      expect(result.current.state).toBe('reconnecting')
      expect(result.current.error).toBe('')
      await waitFor(() => expect(FakeSocket.instances[1]).toBeDefined())
      const again = FakeSocket.instances[1]!
      expect(again.url).toContain('resume=true')
      liveTiming.stallMs = timing.stallMs
      await act(async () => { again.open(); again.message({ type: 'ready', sessionId: 'ses_1', runId: 'run_d', chunkMs: 100, offsetMs: 0 }) })
      expect(result.current.state).toBe('live')
      expect(again.send.mock.calls.slice(1).map(([payload]) => samples16(payload))).toEqual([samples16(toPcm16(frame))])
    } finally { Object.assign(liveTiming, timing) }
  })

  it('takes the microphone back without ending the recording when the system stops it', async () => {
    const platform = installLivePlatform()
    const { result } = renderHook(() => useLiveInterpretation('ses_1'))
    await waitFor(() => expect(result.current.session).not.toBeNull())
    await act(async () => result.current.start())
    const socket = FakeSocket.instances[0]!
    await act(async () => { socket.open(); socket.message({ type: 'ready', sessionId: 'ses_1', runId: 'run_1', chunkMs: 100 }) })
    const context = FakeAudioContext.instances[0]!

    await act(async () => { platform.streams[0]!.active = false; platform.tracks[0]!.end(); await Promise.resolve() })
    await waitFor(() => expect(platform.getUserMedia).toHaveBeenCalledTimes(2))
    // The new microphone feeds the same recording: same context, same connection.
    await waitFor(() => expect(context.createMediaStreamSource).toHaveBeenCalledTimes(2))
    expect(result.current.state).toBe('live')
    expect(result.current.error).toBe('')
    expect(result.current.microphoneBlocked).toBe(false)
    expect(socket.close).not.toHaveBeenCalled()
    expect(platform.tracks[0]!.stop).toHaveBeenCalled()
    const notes = socket.send.mock.calls.map(([payload]) => payload).filter((payload): payload is string => typeof payload === 'string').map(payload => JSON.parse(payload) as { type: string; event?: string })
    expect(notes).toContainEqual({ type: 'note', event: 'microphone_restarted' })
  })

  it('keeps recording and asks for a tap when the microphone cannot be taken back', async () => {
    const platform = installLivePlatform()
    const { result } = renderHook(() => useLiveInterpretation('ses_1'))
    await waitFor(() => expect(result.current.session).not.toBeNull())
    await act(async () => result.current.start())
    const socket = FakeSocket.instances[0]!
    await act(async () => { socket.open(); socket.message({ type: 'ready', sessionId: 'ses_1', runId: 'run_1', chunkMs: 100 }) })
    platform.getUserMedia.mockRejectedValueOnce(new DOMException('Not now', 'NotAllowedError'))

    await act(async () => { platform.streams[0]!.active = false; platform.tracks[0]!.end(); await Promise.resolve() })
    await waitFor(() => expect(result.current.microphoneBlocked).toBe(true))
    expect(result.current.state).toBe('live')
    expect(socket.close).not.toHaveBeenCalled()
    // The tap tries again.
    await act(async () => { result.current.resumeMicrophone(); await Promise.resolve() })
    await waitFor(() => expect(result.current.microphoneBlocked).toBe(false))
    expect(platform.getUserMedia).toHaveBeenCalledTimes(3)
  })

  it('tells the server when the page goes to the background and says why it reconnects', async () => {
    installLivePlatform()
    const timing = { ...liveTiming }
    liveTiming.reconnectFirstMs = 0
    const visibility = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')
    let visible: DocumentVisibilityState = 'visible'
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visible })
    try {
      const { result } = renderHook(() => useLiveInterpretation('ses_1'))
      await waitFor(() => expect(result.current.session).not.toBeNull())
      await act(async () => result.current.start())
      const socket = FakeSocket.instances[0]!
      await act(async () => { socket.open(); socket.message({ type: 'ready', sessionId: 'ses_1', runId: 'run_1', chunkMs: 100, offsetMs: 0 }) })
      const hello = JSON.parse(String(socket.send.mock.calls[0]![0])) as { client: { reason: string } }
      expect(hello.client.reason).toBe('start')

      await act(async () => { visible = 'hidden'; document.dispatchEvent(new Event('visibilitychange')) })
      expect(JSON.parse(String(socket.send.mock.calls.at(-1)![0]))).toEqual({ type: 'note', event: 'hidden' })
      // The system closes the connection while the page is away.
      await act(async () => { socket.readyState = FakeSocket.CLOSED; socket.onclose?.(new CloseEvent('close', { code: 1006, reason: '' })) })
      expect(result.current.state).toBe('reconnecting')
      await act(async () => { visible = 'visible'; document.dispatchEvent(new Event('visibilitychange')) })
      await waitFor(() => expect(FakeSocket.instances[1]).toBeDefined())
      const again = FakeSocket.instances[1]!
      await act(async () => again.open())
      const resumed = JSON.parse(String(again.send.mock.calls[0]![0])) as { client: { reason: string; lastClose: { code: number }; hiddenMs: number } }
      expect(resumed.client.reason).toBe('reconnect')
      expect(resumed.client.lastClose.code).toBe(1006)
      expect(resumed.client.hiddenMs).toBeGreaterThanOrEqual(0)
    } finally {
      Object.assign(liveTiming, timing)
      if (visibility) Object.defineProperty(document, 'visibilityState', visibility)
      else delete (document as { visibilityState?: unknown }).visibilityState
    }
  })

  it('goes on recording when the conversation says a failed run of its own recording stopped', async () => {
    installLivePlatform()
    const streams: Array<{ onmessage: ((event: MessageEvent) => void) | null }> = []
    vi.stubGlobal('EventSource', class { onmessage: ((event: MessageEvent) => void) | null = null; onerror = null; constructor() { streams.push(this) } close() {} })
    const { result } = renderHook(() => useLiveInterpretation('ses_1'))
    await waitFor(() => expect(result.current.session).not.toBeNull())
    await act(async () => result.current.start())
    const socket = FakeSocket.instances[0]!
    await act(async () => { socket.open(); socket.message({ type: 'ready', sessionId: 'ses_1', runId: 'run_1', chunkMs: 100, offsetMs: 0 }) })
    await waitFor(() => expect(streams.length).toBeGreaterThan(0))
    // The server ended a run while this browser's connection was held up; the connection decides.
    await act(async () => { streams.at(-1)!.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'stopped', status: 'failed' }) })) })
    expect(result.current.state).toBe('live')
    expect(result.current.error).toBe('')
    expect(socket.close).not.toHaveBeenCalled()
    // A recording someone stopped still stops here.
    await act(async () => { streams.at(-1)!.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'stopped', status: 'completed' }) })) })
    expect(result.current.state).toBe('ended')
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
    await act(async () => {
      socket?.open()
      socket?.message({ type: 'error', code: 'AUTH_REVOKED', message: 'This browser session was revoked.' })
    })

    expect(invalidations).toEqual([{ reason: 'expired', message: 'This browser session was revoked.' }])
    expect(result.current.state).toBe('error')
    window.removeEventListener(AUTH_SESSION_INVALID_EVENT, listener)
  })
})
